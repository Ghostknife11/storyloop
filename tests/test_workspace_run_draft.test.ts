import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDocument,
  createDocumentFromRun,
  deleteDocument,
  getDocument,
  listDocuments,
  saveDocument,
  setDocumentFavorite,
  setDocumentStatus,
} from "@/application/workspace-documents";
import {
  createProject,
  getProject,
  groupRunsByProject,
  listProjects,
  setCurrentDocument,
  setProjectFavorite,
  setProjectStatus,
  updateProject,
} from "@/application/workspace-projects";
import type { RunManifest } from "@/domain/run-manifest";
import { WorkspaceNotFoundError, WorkspaceValidationError } from "@/domain/workspace";
import { DEFAULT_RETRY_POLICY } from "@/domain/retry-policy";
import { FileDocumentRepository, DocumentHashError } from "@/infrastructure/storage/document-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import type { DocumentRepository } from "@/ports/document-store";
import type { ProjectRepository } from "@/ports/project-store";
import { FileRevisionRepository, RevisionWriteError } from "@/infrastructure/storage/revision-store";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { generateRevisionId } from "@/infrastructure/id/workspace-id";
import { buildRunManifest } from "@/infrastructure/tracking/manifest-builder";
import { sha256Hex } from "@/infrastructure/tracking/digest";
import { wordCountOf } from "@/domain/story-document";

/**
 * v2.2.0 Run→Draft 与项目归纳（TASK §8/§19/§20/§48）。
 *
 * 重点不是「功能能不能用」，而是那几条一旦破了就很难收拾的边界：
 *   1. §48 Release Blocker：编辑一个稿件绝不修改 run/story.md。这里用「整棵 Run 目录
 *      的字节与 mtime 前后快照」来证明——比断言单个文件更强，因为任何一次意外的写回
 *      （软链、缓存、临时文件）都会让快照不一致。
 *   2. §19 单一事实源：项目名下的 Run 靠扫 run-manifest.json 归纳，project.json 里
 *      不存 runId 列表。所以「归档一个项目」也必须是一个只写 projects/ 的动作。
 *   3. 跨项目搬运要明说：Manifest 已经声明了项目的 Run，不许悄悄进另一个项目。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function roots(): { runs: string; projects: string } {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-draft-"));
  return { runs: join(tmp, "runs"), projects: join(tmp, "projects") };
}

/**
 * 只改列举顺序的稿件仓储：其余全部转交真实现。
 *
 * 列表顺序必须是**规则**决定的，不能是"磁盘恰好按什么顺序 readdir 回来"决定的。
 * 现在的 FileDocumentRepository 自己按字典序返回，所以这条 seam 上换个顺序，
 * 才能证明用例层真的排过序，而不是白捡了一个排好序的输入。
 */
class ReverseOrderDocuments implements DocumentRepository {
  constructor(private readonly inner: FileDocumentRepository) {}
  get root(): string { return this.inner.root; }
  listDocumentIds(projectId: string): string[] { return [...this.inner.listDocumentIds(projectId)].reverse(); }
  exists(projectId: string, documentId: string): boolean { return this.inner.exists(projectId, documentId); }
  resolveDocumentsDir(projectId: string): string { return this.inner.resolveDocumentsDir(projectId); }
  putDocument(document: Parameters<DocumentRepository["putDocument"]>[0]): void { this.inner.putDocument(document); }
  deleteDocument(projectId: string, documentId: string): void { this.inner.deleteDocument(projectId, documentId); }
  readDocument(projectId: string, documentId: string) { return this.inner.readDocument(projectId, documentId); }
}

/** 同上，项目版。 */
class ReverseOrderProjects implements ProjectRepository {
  constructor(private readonly inner: FileProjectRepository) {}
  get root(): string { return this.inner.root; }
  exists(projectId: string): boolean { return this.inner.exists(projectId); }
  resolveProjectDir(projectId: string): string { return this.inner.resolveProjectDir(projectId); }
  createProjectDirectory(projectId: string): string { return this.inner.createProjectDirectory(projectId); }
  putProject(project: Parameters<ProjectRepository["putProject"]>[0]): void { this.inner.putProject(project); }
  readProject(projectId: string) { return this.inner.readProject(projectId); }
  listProjectIds(): string[] { return [...this.inner.listProjectIds()].reverse(); }
}

/** 一棵目录树的快照：相对路径 → 内容 + mtime。用来证明「一个字都没动」。 */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(dir, full), `${readFileSync(full)}|${statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

function putRun(store: ArtifactStore, runId: string, story: string, projectId?: string): void {
  store.createRunDirectory(runId);
  // story.md 原样写：要精确控制「有没有 H1」「H1 在不在开头」，不想让 putStory 再加一个标题
  writeFileSync(join(store.resolveRunDir(runId), "story.md"), story, "utf8");
  if (projectId !== undefined) {
    // 先装配一份真 Manifest，再补上 workspace——顺带把「additive 字段透传」也走到
    const base = buildRunManifest(
      {
        runId,
        startedAt: "2026-09-27T10:00:00.000Z",
        policy: DEFAULT_RETRY_POLICY,
        attempts: [],
        selectedAttemptNumber: null,
      },
      store,
      () => new Date("2026-09-27T10:00:01.000Z"),
    );
    store.putManifest(runId, { ...base, workspace: { projectId } });
  }
}

const STORY = "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n\n第二天，报上只有一行寻人启事。";

describe("Run → Draft（§8/§22/§48）", () => {
  it("从一次 Run 复制出可编辑稿件：H1 变标题，剩下的全部是正文", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    putRun(artifactStore, "20260927_100000_ab12cd", STORY);

    const project = await createProject({ name: "夜行列车" }, { projects: projects_ });
    const document = await createDocumentFromRun(project.id, { runId: "20260927_100000_ab12cd" }, {
      projects: projects_,
      documents,
      artifactStore,
    });

    expect(document.title).toBe("夜行列车");
    expect(document.content).toBe("她从最后一节车厢走进了雨里。\n\n第二天，报上只有一行寻人启事。");
    expect(document.source).toBe("generated");
    expect(document.sourceRunId).toBe("20260927_100000_ab12cd");
    expect(document.status).toBe("draft");
    expect(document.contentHash).toBe(sha256Hex(document.content));
    // 新建的稿件自动成为当前稿件：不然用户复制完还得到列表里再点一次
    expect(projects_.readProject(project.id)?.currentDocumentId).toBe(document.id);
    // 稿件是原件的一份拷贝，不是原件的另一个入口
    expect(documents.readDocument(project.id, document.id)?.content).toBe(document.content);
  });

  it("H1 不在正文开头时它不是标题：不猜，退回「未命名」，正文原样保留", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const story = "开头一句闲话。\n\n# 车厢里\n\n她坐到了终点。";
    putRun(artifactStore, "20260927_100000_cd34ef", story);
    const project = await createProject({ name: "p" }, { projects: projects_ });

    const document = await createDocumentFromRun(project.id, { runId: "20260927_100000_cd34ef" }, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });

    expect(document.title).toBe("未命名");
    expect(document.content).toBe(story.trim());
  });

  it("§48：Run→Draft、保存、删除稿件之后，Run 目录一个字节都没变", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    // 先建项目再把 Run 归到它名下：这一串动作里被反复读写的只有 projects/
    const project = await createProject({ name: "p" }, { projects: projects_ });
    const runId = "20260927_100000_ef56ab";
    putRun(artifactStore, runId, STORY, project.id);
    const before = snapshotTree(runs);
    const deps = { projects: projects_, documents, artifactStore };

    const document = await createDocumentFromRun(project.id, { runId }, deps);
    await saveDocument(project.id, document.id, { content: "我把她改写成了另一个人。" }, deps);
    await saveDocument(project.id, document.id, { status: "final" }, deps);
    await deleteDocument(project.id, document.id, deps);

    expect(snapshotTree(runs)).toEqual(before);
  });

  it("跨项目搬运要明说：Manifest 归属别处的 Run 不许悄悄进这个项目", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    putRun(artifactStore, "20260927_100000_ab78cd", STORY, "prj_20260927_100000_000000");

    const mine = await createProject({ name: "我的项目" }, { projects: projects_ });
    await expect(
      createDocumentFromRun(mine.id, { runId: "20260927_100000_ab78cd" }, {
        projects: projects_,
        documents: new FileDocumentRepository(projects),
        artifactStore,
      }),
    ).rejects.toThrow(/已经属于另一个项目/);
  });

  it("同一个项目里复制自己的 Run 允许；v2.2.0 之前生成的 Run 没有归属，可以进任何项目", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);

    const owned = await createProject({ name: "归属我的" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, owned.id);
    const fromOwn = await createDocumentFromRun(owned.id, { runId: "20260927_100000_ab12cd" }, {
      projects: projects_,
      documents,
      artifactStore,
    });
    expect(fromOwn.sourceRunId).toBe("20260927_100000_ab12cd");

    // 没有 workspace 块的旧 Run：不拦
    putRun(artifactStore, "20260101_090000_zz9999", "# 去年写的\n\n旧正文。");
    const anywhere = await createProject({ name: "另一个项目" }, { projects: projects_ });
    const legacy = await createDocumentFromRun(anywhere.id, { runId: "20260101_090000_zz9999" }, {
      projects: projects_,
      documents,
      artifactStore,
    });
    expect(legacy.sourceRunId).toBe("20260101_090000_zz9999");
    expect(legacy.content).toBe("旧正文。");
  });

  it("Run 没有正文 / 项目不存在 / 字段不合法：NotFound、NotFound、Validation 三种口径分清", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);

    // 硬失败的 Run 只留下一个空 story.md——Run 本身不动，只是无从复制（404）
    const emptyRun = "20260927_100000_0000ff";
    artifactStore.createRunDirectory(emptyRun);
    writeFileSync(join(runs, emptyRun, "story.md"), "   \n", "utf8");
    const snapshot = snapshotTree(runs);
    const project = await createProject({ name: "p" }, { projects: projects_ });
    await expect(
      createDocumentFromRun(project.id, { runId: emptyRun }, { projects: projects_, documents, artifactStore }),
    ).rejects.toThrow(WorkspaceNotFoundError);
    expect(snapshotTree(runs)).toEqual(snapshot);

    await expect(
      createDocumentFromRun("prj_20260927_100000_missing", { runId: emptyRun }, {
        projects: projects_,
        documents,
        artifactStore,
      }),
    ).rejects.toThrow(WorkspaceNotFoundError);
    // 一个根本不存在的 Run 也是 404，不是 500
    await expect(
      createDocumentFromRun(project.id, { runId: "20260927_100000_missing" }, {
        projects: projects_,
        documents,
        artifactStore,
      }),
    ).rejects.toThrow(WorkspaceNotFoundError);

    // 请求本身的毛病：三条都要在碰存储之前就被挡掉
    await expect(createDocumentFromRun(project.id, {}, { projects: projects_, documents, artifactStore })).rejects.toThrow(
      /必须带 runId/,
    );
    await expect(
      createDocumentFromRun(project.id, { runId: "../etc" }, { projects: projects_, documents, artifactStore }),
    ).rejects.toThrow(WorkspaceValidationError);
    await expect(
      createDocumentFromRun(project.id, { runId: emptyRun, author: "我" }, {
        projects: projects_,
        documents,
        artifactStore,
      }),
    ).rejects.toThrow(/不支持字段/);
    await expect(
      createDocumentFromRun(project.id, { runId: emptyRun, api_key: "sk-x" }, {
        projects: projects_,
        documents,
        artifactStore,
      }),
    ).rejects.toThrow(/不允许出现在工作区请求里/);
  });

  it("可以直接要一份 final 稿件：status 由请求显式给，缺省永远是 draft", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    putRun(artifactStore, "20260927_100000_fd01ea", STORY);
    const project = await createProject({ name: "p" }, { projects: projects_ });

    const final = await createDocumentFromRun(project.id, { runId: "20260927_100000_fd01ea", status: "final" }, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });
    expect(final.status).toBe("final");

    const draft = await createDocumentFromRun(project.id, { runId: "20260927_100000_fd01ea", status: "不合法" }, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });
    expect(draft.status).toBe("draft");
  });
});

describe("项目名下的 Run 怎么来（§19 单一事实源）", () => {
  it("扫 Manifest 分组，新的在前；没有 workspace 块的不进任何项目", () => {
    const grouped = groupRunsByProject(
      ["20260901_100000_aaaaaa", "20260927_100000_bbbbbb", "20260930_100000_cccccc", "20260928_100000_dddddd"],
      (runId) => {
        if (runId.endsWith("cccccc")) return { workspace: { projectId: "prj_other" } } as unknown as RunManifest;
        if (runId.endsWith("aaaaaa") || runId.endsWith("bbbbbb")) {
          return { workspace: { projectId: "prj_a" } } as unknown as RunManifest;
        }
        // 返回 null = 这个 run_id 下没有 Manifest（旧 Run / 被删过）
        return null;
      },
    );
    expect(grouped.get("prj_a")).toEqual(["20260927_100000_bbbbbb", "20260901_100000_aaaaaa"]);
    expect(grouped.get("prj_other")).toEqual(["20260930_100000_cccccc"]);
    // 旧 Run（没有 Manifest）不进任何桶，也不会凭空多出一个项目
    expect([...grouped.keys()].sort()).toEqual(["prj_a", "prj_other"]);
  });

  it("Manifest 里的 projectId 不是合法 id 时，这条 Run 被跳过而不是被拼成路径", () => {
    const grouped = groupRunsByProject(["20260927_100000_bbbbbb"], () => {
      return { workspace: { projectId: "../../etc" } } as unknown as RunManifest;
    });
    expect(grouped.size).toBe(0);
  });

  it("listProjects / getProject 只读 runs/，不改写任何一个 Run", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "p" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, project.id);
    putRun(artifactStore, "20260927_100000_cd34ef", "# 另一篇\n\n别的内容。", project.id);
    const before = snapshotTree(runs);

    const list = await listProjects({
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });
    expect(list).toHaveLength(1);
    expect(list[0].runCount).toBe(2);

    const detail = await getProject(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });
    expect(detail.runIds).toEqual(["20260927_100000_cd34ef", "20260927_100000_ab12cd"]);
    expect(detail.documentIds).toEqual([]);
    expect(snapshotTree(runs)).toEqual(before);
  });

  it("时间戳打平时列表顺序仍然稳定：比较器是自洽的", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const deps = { projects: projects_, documents: new FileDocumentRepository(projects) };
    // 固定时钟：一批项目的 updatedAt 一字不差。真实场景里同一毫秒连续建几个项目、
    // 或者旧数据缺 updatedAt，都会走到这条路上。
    const frozen = { now: () => new Date("2026-09-27T10:00:00.000Z") };
    const made: string[] = [];
    for (const name of ["甲", "乙", "丙", "丁", "戊", "己"]) {
      made.push((await createProject({ name }, { ...deps, ...frozen })).id);
    }

    // id 倒序收尾（id 自带时间戳，倒序与「新的在前」同向）。不按建成顺序推期望值——
    // 后缀是随机的，只按规则算。
    const expected = [...made].sort((a, b) => (a < b ? 1 : -1));
    expect((await listProjects({ ...deps, ...frozen })).map((item) => item.project.id)).toEqual(expected);

    // 列举顺序反过来，结论不能变：顺序是用例排出来的，不是磁盘白送的
    const reversed = new ReverseOrderProjects(projects_);
    expect((await listProjects({ ...deps, projects: reversed, ...frozen })).map((item) => item.project.id)).toEqual(expected);
  });

  it("归档一个项目只改 projects/：Run 的 Manifest 不改口，归档后仍归纳得到", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "p" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, project.id);
    const before = snapshotTree(runs);

    const archived = await setProjectStatus(project.id, "archived", { projects: projects_ });
    expect(archived.status).toBe("archived");
    const restored = await setProjectStatus(project.id, "active", { projects: projects_ });
    expect(restored.status).toBe("active");
    const faved = await setProjectFavorite(project.id, true, { projects: projects_ });
    expect(faved.isFavorite).toBe(true);
    await updateProject(project.id, { name: "改名了" }, { projects: projects_ });

    expect(snapshotTree(runs)).toEqual(before);
    const detail = await getProject(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      artifactStore,
    });
    expect(detail.runIds).toEqual(["20260927_100000_ab12cd"]);
    await expect(setProjectStatus(project.id, "deleted", { projects: projects_ })).rejects.toThrow(/status 只能是/);
  });
});

describe("稿件保存与删除（§20/§48）", () => {
  it("保存走 documents/：contentHash 由新正文现算，id / createdAt / sourceRunId 不动", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const project = await createProject({ name: "p" }, { projects: projects_ });

    const created = await createDocument(project.id, { title: "空白稿", content: "" }, {
      projects: projects_,
      documents,
    });
    expect(created.contentHash).toBe(sha256Hex(""));

    const saved = await saveDocument(project.id, created.id, { content: "第一段。\n\n第二段。" }, {
      projects: projects_,
      documents,
    });
    expect(saved.contentHash).toBe(sha256Hex(saved.content));
    expect(saved.id).toBe(created.id);
    expect(saved.createdAt).toBe(created.createdAt);
    expect(saved.sourceRunId).toBeNull();

    // 请求体里带的 contentHash 一概不被采信（§20）——连「收下再忽略」都不是，是直接拒绝
    await expect(
      saveDocument(project.id, created.id, { content: "又一次改动。", contentHash: "0".repeat(64) }, {
        projects: projects_,
        documents,
      }),
    ).rejects.toThrow(/不支持字段 contentHash/);
  });

  it("哈希与正文对不上的稿件不许落盘：DocumentRepository 自己会拦（§20）", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const project = await createProject({ name: "p" }, { projects: projects_ });
    const good = await createDocument(project.id, { content: "正文。" }, { projects: projects_, documents });
    expect(() =>
      documents.putDocument({ ...good, content: "被偷偷换掉的正文", contentHash: good.contentHash }),
    ).toThrow(DocumentHashError);
    expect(documents.readDocument(good.projectId, good.id)?.content).toBe("正文。");
  });

  it("状态、收藏、当前稿指针各自只改自己那一格", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const deps = { projects: projects_, documents };
    const project = await createProject({ name: "p" }, { projects: projects_ });
    const document = await createDocument(project.id, { content: "正文。" }, deps);

    const final = await setDocumentStatus(project.id, document.id, { status: "final" }, deps);
    expect(final.status).toBe("final");
    // 改状态不动正文，哈希也不该变——否则「编辑过没有」的判定会被一次收藏误触
    expect(final.contentHash).toBe(document.contentHash);

    const faved = await setDocumentFavorite(project.id, document.id, true, deps);
    expect(faved.isFavorite).toBe(true);
    expect(faved.status).toBe("final");

    await expect(setDocumentStatus(project.id, document.id, { status: "已定稿" }, deps)).rejects.toThrow(
      /status 只能是/,
    );

    const other = await createDocument(project.id, { content: "另一篇。" }, deps);
    const pointed = await setCurrentDocument(project.id, other.id, deps);
    expect(pointed.currentDocumentId).toBe(other.id);
    const cleared = await setCurrentDocument(project.id, null, deps);
    expect(cleared.currentDocumentId).toBeNull();
    await expect(setCurrentDocument(project.id, "../escape", deps)).rejects.toThrow(WorkspaceValidationError);
  });

  it("删除稿件：连修订目录一起消失，项目的 currentDocumentId 一并清掉", async () => {
    const { runs, projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const revisions = new FileRevisionRepository(projects);
    const artifactStore = new ArtifactStore(runs);
    const project = await createProject({ name: "p" }, { projects: projects_ });
    const document = await createDocument(project.id, { content: "会被删掉的一篇。" }, {
      projects: projects_,
      documents,
    });
    expect(projects_.readProject(project.id)?.currentDocumentId).toBe(document.id);

    revisions.putRevision(project.id, revisionOf(document.id, "会被删掉的一篇。", "2026-09-27T11:00:00.000Z"), "会被删掉的一篇。");
    expect(revisions.countRevisions(project.id, document.id)).toBe(1);

    await deleteDocument(project.id, document.id, { projects: projects_, documents, artifactStore });

    expect(documents.readDocument(project.id, document.id)).toBeNull();
    expect(documents.listDocumentIds(project.id)).toEqual([]);
    expect(revisions.countRevisions(project.id, document.id)).toBe(0);
    expect(revisions.listRevisions(project.id, document.id)).toEqual([]);
    expect(projects_.readProject(project.id)?.currentDocumentId).toBeNull();
  });

  it("listDocuments 不带正文，按最近修改倒序", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const deps = { projects: projects_, documents };
    const project = await createProject({ name: "p" }, { projects: projects_ });
    const old = await createDocument(project.id, { title: "旧的", content: "一二三" }, deps);
    // 同一秒内建的两篇无法靠时钟分辨，所以显式隔开几毫秒
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createDocument(project.id, { title: "新的", content: "四五六" }, deps);

    const list = await listDocuments(project.id, deps);
    expect(list.map((item) => item.id)).toEqual([newer.id, old.id]);
    expect(list.every((item) => !("content" in item))).toBe(true);
    expect(list[1].wordCount).toBe(wordCountOf("一二三"));
  });

  it("时间戳打平时稿件顺序仍然稳定：比较器是自洽的", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const frozen = { now: () => new Date("2026-09-27T10:00:00.000Z") };
    const deps = { projects: projects_, documents, ...frozen };
    const project = await createProject({ name: "p" }, { projects: projects_, ...frozen });
    // 同一毫秒建的几篇：updatedAt 一字不差
    const made: string[] = [];
    for (const title of ["一", "二", "三", "四", "五", "六"]) {
      made.push((await createDocument(project.id, { title, content: "正文" }, deps)).id);
    }

    // id 倒序收尾；后缀随机，所以按规则算期望值，不按建成顺序推
    const expected = [...made].sort((a, b) => (a < b ? 1 : -1));
    expect((await listDocuments(project.id, deps)).map((item) => item.id)).toEqual(expected);

    // 列举顺序反过来，结论不能变
    const reversed = new ReverseOrderDocuments(documents);
    expect((await listDocuments(project.id, { ...deps, documents: reversed })).map((item) => item.id)).toEqual(expected);
  });

  it("getDocument / listDocuments 对不存在的项目是 404，对不合法 id 是 400——都不是 500", async () => {
    const { projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const deps = { projects: projects_, documents };
    const project = await createProject({ name: "p" }, { projects: projects_ });

    await expect(listDocuments("prj_20260927_100000_missing", deps)).rejects.toThrow(WorkspaceNotFoundError);
    await expect(getDocument("prj_20260927_100000_missing", "doc_20260927_100000_ab12cd", deps)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    // 项目在，稿件不在 / 稿件 id 带 ../ —— 前一个 404，后一个 400
    await expect(getDocument(project.id, "doc_20260927_100000_ab12cd", deps)).rejects.toThrow(WorkspaceNotFoundError);
    await expect(getDocument(project.id, "../escape", deps)).rejects.toThrow(WorkspaceValidationError);
    await expect(getDocument("../escape", "doc_20260927_100000_ab12cd", deps)).rejects.toThrow(
      WorkspaceValidationError,
    );
    await expect(listDocuments("../escape", deps)).rejects.toThrow(WorkspaceValidationError);
  });
});

describe("FileRevisionRepository（§31）", () => {
  it("存一条读一条，索引与正文对得上", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    const docId = "doc_20260927_100000_ab12cd";
    const body = "第一版。";
    const first = revisionOf(docId, body, "2026-09-27T10:00:00.000Z");
    store.putRevision("prj_20260927_100000_ab12cd", first, body);

    expect(store.countRevisions("prj_20260927_100000_ab12cd", docId)).toBe(1);
    const read = store.readRevision("prj_20260927_100000_ab12cd", docId, first.id);
    expect(read?.content).toBe(body);
    expect(read?.revision.origin).toBe("manual");
    expect(read?.revision.contentHash).toBe(sha256Hex(body));
    expect(read?.revision.wordCount).toBe(wordCountOf(body));
  });

  it("同一个 revision id 不许覆盖：改历史比不记历史更糟", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    const docId = "doc_20260927_100000_ab12cd";
    const rev = revisionOf(docId, "第一版。", "2026-09-27T10:00:00.000Z");
    store.putRevision("prj_20260927_100000_ab12cd", rev, "第一版。");
    expect(() => store.putRevision("prj_20260927_100000_ab12cd", rev, "被换掉的历史")).toThrow(RevisionWriteError);
    expect(store.readRevision("prj_20260927_100000_ab12cd", docId, rev.id)?.content).toBe("第一版。");
  });

  it("索引按写入顺序追加，列出的是全部", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    const docId = "doc_20260927_100000_ab12cd";
    store.putRevision("prj_20260927_100000_ab12cd", revisionOf(docId, "一", "2026-09-27T10:00:00.000Z"), "一");
    store.putRevision("prj_20260927_100000_ab12cd", revisionOf(docId, "二", "2026-09-27T10:05:00.000Z", "autosave"), "二");
    const all = store.listRevisions("prj_20260927_100000_ab12cd", docId);
    expect(all.map((r) => r.origin)).toEqual(["manual", "autosave"]);
    expect(store.countRevisions("prj_20260927_100000_ab12cd", docId)).toBe(2);
  });

  it("索引被手改坏时按「没有修订」处理，读接口不 500", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    const docId = "doc_20260927_100000_ab12cd";
    const rev = revisionOf(docId, "一", "2026-09-27T10:00:00.000Z");
    store.putRevision("prj_20260927_100000_ab12cd", rev, "一");
    writeFileSync(join(projects, "prj_20260927_100000_ab12cd", "revisions", docId, "revisions.json"), "{ 这不是 JSON", "utf8");
    expect(store.listRevisions("prj_20260927_100000_ab12cd", docId)).toEqual([]);
    // 索引坏了的条目也读不出来：索引是唯一一份「哪一版在哪」的记录
    expect(store.readRevision("prj_20260927_100000_ab12cd", docId, rev.id)).toBeNull();
  });

  it("从没存过修订的稿件列空数组，不抛", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    expect(store.listRevisions("prj_20260927_100000_ab12cd", "doc_20260927_100000_ab12cd")).toEqual([]);
    expect(store.countRevisions("prj_20260927_100000_ab12cd", "doc_20260927_100000_ab12cd")).toBe(0);
    expect(store.readRevision("prj_20260927_100000_ab12cd", "doc_20260927_100000_ab12cd", "rev_x")).toBeNull();
  });

  it("不合法 id 一律抛错，消息里没有绝对路径（§42/§67）", () => {
    const { projects } = roots();
    const store = new FileRevisionRepository(projects);
    for (const bad of ["../escape", "a/b", "..", ""]) {
      expect(() => store.listRevisions(bad, "doc_20260927_100000_ab12cd"), bad).toThrow(RevisionWriteError);
      expect(() => store.listRevisions("prj_20260927_100000_ab12cd", bad), bad).toThrow(RevisionWriteError);
    }
    try {
      store.listRevisions("../escape", "doc_20260927_100000_ab12cd");
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as Error).message).not.toContain(projects);
    }
    // 没有建目录却往里写：给出的是写入失败，不是一份凭空出现的成功
    expect(() => store.putRevision("prj_不存在", revisionOf("doc_x", "x", "2026-09-27T10:00:00.000Z"), "x")).toThrow(
      RevisionWriteError,
    );
  });
});

/** 造一条合法修订：哈希与字数由正文现算，id 用真实生成器。 */
function revisionOf(documentId: string, body: string, createdAt: string, origin: "manual" | "autosave" = "manual") {
  return {
    schemaVersion: "1",
    id: generateRevisionId(new Date(createdAt)),
    documentId,
    contentHash: sha256Hex(body),
    origin,
    createdAt,
    wordCount: wordCountOf(body),
  };
}
