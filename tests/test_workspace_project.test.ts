import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_STATUSES,
  WorkspaceValidationError,
  projectListItemOf,
  projectOf,
  validateProject,
  validateProjectPatch,
  withProjectPatch,
  type Project,
} from "@/domain/project";
import { isWorkspaceId } from "@/domain/workspace";
import { FileProjectRepository, ProjectWriteError } from "@/infrastructure/storage/project-store";
import {
  generateDocumentId,
  generateExportId,
  generateProjectId,
  generateRevisionId,
} from "@/infrastructure/id/workspace-id";

/**
 * v2.2.0 项目生命周期（TASK §46）。
 *
 * 覆盖建 / 列 / 读 / 改 / 归档 / 收藏，以及两件安全上必须成立的事：
 *   1. 不合法 id 一律当不存在（404），绝不把用户给的串拼进路径；
 *   2. 项目名是自由文本——它可以含 `../`，因为它永远不参与路径拼接（§42）。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function projectsRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-projects-"));
  return tmp as string;
}

function projectOf_(overrides: Record<string, unknown> = {}): Project {
  return validateProject({
    schemaVersion: "1",
    id: "prj_20260927_101500_ab12cd",
    name: "夜行列车",
    status: "active",
    createdAt: "2026-09-27T10:15:00.000Z",
    updatedAt: "2026-09-27T10:15:00.000Z",
    storyConfigRef: null,
    currentDocumentId: null,
    isFavorite: false,
    ...overrides,
  });
}

describe("Project 领域模型（§3/§46）", () => {
  it("合法项目原样通过，可空字段归一成 null", () => {
    const project = projectOf_();
    expect(project.status).toBe("active");
    expect(project.storyConfigRef).toBeNull();
    expect(project.currentDocumentId).toBeNull();
    expect(project.isFavorite).toBe(false);
    expect(PROJECT_STATUSES).toContain(project.status);
  });

  it("id 不接受路径分隔符与 `..`——它要当目录名用", () => {
    for (const bad of ["../secret", "a/b", "a\\b", ".", "..", "", "_x", "项目一"]) {
      expect(isWorkspaceId(bad), bad).toBe(false);
    }
    for (const good of ["prj_20260927_101500_ab12cd", "a", "A.b-c_d", "0"]) {
      expect(isWorkspaceId(good), good).toBe(true);
    }
  });

  it("项目名是不可信输入：含 `../` 也照收，因为它不进路径", () => {
    const project = projectOf_({ name: "  ../../etc/passwd  " });
    expect(project.name).toBe("../../etc/passwd");
  });

  it("项目名不能是空的、超长的、或带控制字符", () => {
    expect(() => projectOf_({ name: "   " })).toThrow(WorkspaceValidationError);
    expect(() => projectOf_({ name: "x".repeat(121) })).toThrow(/不能超过 120/);
    expect(() => projectOf_({ name: "坏\u0000名" })).toThrow(/控制字符/);
  });

  it("status 只认 active / archived", () => {
    expect(() => projectOf_({ status: "deleted" })).toThrow(/status 只能是/);
    expect(() => projectOf_({ status: "archived" })).not.toThrow();
  });

  it("凭据形状的键名一律拒绝，不猜用途", () => {
    expect(() => projectOf_({ api_key: "sk-xxx" })).toThrow(/不允许出现在工作区请求里/);
    expect(() => projectOf_({ headers: { Authorization: "Bearer x" } })).toThrow(/不允许出现在工作区请求里/);
  });

  it("未知字段拒绝（白名单之外的东西不是「先存着」）", () => {
    expect(() => projectOf_({ runIds: ["a"] })).toThrow(/不支持字段 runIds/);
  });

  it("时间戳必须是 ISO 8601", () => {
    expect(() => projectOf_({ createdAt: "昨天" })).toThrow(/ISO 8601/);
    expect(() => projectOf_({ updatedAt: 1759000000 })).toThrow(/ISO 8601/);
  });

  it("PATCH 只改白名单内的五个字段，且至少带一个", () => {
    const patch = validateProjectPatch({ name: "新名字", isFavorite: true });
    expect(patch).toEqual({ name: "新名字", isFavorite: true });
    expect(() => validateProjectPatch({})).toThrow(/至少要带一个可改字段/);
    expect(() => validateProjectPatch({ id: "prj_other" })).toThrow(/不支持字段 id/);
    expect(() => validateProjectPatch({ status: "removed" })).toThrow(/status 只能是/);
  });

  it("PATCH 之后 id 与 createdAt 不变，updatedAt 由调用方给", () => {
    const base = projectOf_();
    const next = withProjectPatch(base, { name: "改名了", isFavorite: true }, "2026-09-28T09:00:00.000Z");
    expect(next.id).toBe(base.id);
    expect(next.createdAt).toBe(base.createdAt);
    expect(next.updatedAt).toBe("2026-09-28T09:00:00.000Z");
    expect(next.isFavorite).toBe(true);
  });

  it("列表项不带正文，只带导航要的那几样", () => {
    const item = projectListItemOf(projectOf_());
    expect(Object.keys(item).sort()).toEqual([
      "createdAt", "currentDocumentId", "id", "isFavorite", "name", "status", "updatedAt",
    ]);
  });

  it("projectOf 对坏数据返回 null，不抛", () => {
    expect(projectOf(null)).toBeNull();
    expect(projectOf({ schemaVersion: "9" })).toBeNull();
    expect(projectOf("nope")).toBeNull();
  });
});

describe("FileProjectRepository（§5/§46）", () => {
  it("create / get / list 三件事闭环", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    expect(store.listProjectIds()).toEqual([]);
    expect(store.root).toBe(root);

    const first = projectOf_();
    store.createProjectDirectory(first.id);
    store.putProject(first);
    const second = projectOf_({
      id: "prj_20260927_101600_cd34ef",
      name: "第二个项目",
      createdAt: "2026-09-27T10:16:00.000Z",
      updatedAt: "2026-09-27T10:16:00.000Z",
    });
    store.createProjectDirectory(second.id);
    store.putProject(second);

    expect(store.listProjectIds()).toEqual([first.id, second.id]);
    expect(store.exists(first.id)).toBe(true);
    expect(store.exists("prj_nope")).toBe(false);
    expect(store.readProject(first.id)?.name).toBe("夜行列车");
  });

  it("projects/ 目录不存在时列空列表，不抛（全新部署，TASK §55）", () => {
    const root = join(projectsRoot(), "does-not-exist-yet");
    const store = new FileProjectRepository(root);
    expect(store.listProjectIds()).toEqual([]);
    expect(store.exists("prj_whatever")).toBe(false);
  });

  it("update：整对象覆盖写，读回来就是写进去的那一份", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    const base = projectOf_();
    store.putProject(base);
    const next = withProjectPatch(base, { status: "archived" }, "2026-09-28T09:00:00.000Z");
    store.putProject(next);
    expect(store.readProject(base.id)?.status).toBe("archived");
    // 归档不删数据：目录与文件都还在
    expect(store.exists(base.id)).toBe(true);
  });

  it("favorite：只翻开关，其余字段不动", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    const base = projectOf_();
    store.putProject(base);
    store.putProject(withProjectPatch(base, { isFavorite: true }, "2026-09-28T09:00:00.000Z"));
    const read = store.readProject(base.id);
    expect(read?.isFavorite).toBe(true);
    expect(read?.name).toBe("夜行列车");
    expect(read?.status).toBe("active");
  });

  it("project.json 被手改坏时按不存在处理，不让坏数据进响应体", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    const base = projectOf_();
    store.putProject(base);
    writeFileSync(join(store.resolveProjectDir(base.id), "project.json"), "{ 这不是 JSON", "utf8");
    expect(store.readProject(base.id)).toBeNull();
    expect(store.exists(base.id)).toBe(false);
    expect(store.listProjectIds()).toEqual([]);
  });

  it("不合法 id 一律抛 ProjectWriteError，拼不出路径（§42）", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    for (const bad of ["../escape", "a/b", ".", "..", ""]) {
      expect(() => store.resolveProjectDir(bad), bad).toThrow(ProjectWriteError);
      expect(() => store.readProject(bad), bad).toThrow(ProjectWriteError);
      expect(store.exists(bad), bad).toBe(false);
    }
    // 错误消息里不出现服务器绝对路径（§67）
    try {
      store.resolveProjectDir("../escape");
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as Error).message).not.toContain(root);
    }
  });

  it("手放进来的非法目录名列不出来，也不参与路径拼接", () => {
    const root = projectsRoot();
    const store = new FileProjectRepository(root);
    const good = projectOf_();
    store.putProject(good);
    mkdirSync(join(root, "not-an-id"), { recursive: true });
    expect(store.listProjectIds()).toEqual([good.id]);
  });
});

describe("工作区标识生成（§5）", () => {
  it("四类标识都满足 isWorkspaceId，且同一秒连建也不重名", () => {
    // 本地时间构造：时间戳打头是为了目录按创建顺序排，与机器时区无关
    const now = new Date(2026, 8, 27, 10, 15, 0);
    const stamp = "prj_20260927_101500";
    expect(generateProjectId(now)).toMatch(new RegExp(`^${stamp}_[a-z0-9]{6}$`));
    expect(generateDocumentId(now)).toMatch(/^doc_20260927_101500_[a-z0-9]{6}$/);
    expect(generateExportId(now)).toMatch(/^out_20260927_101500_[a-z0-9]{6}$/);
    expect(generateRevisionId(now)).toMatch(/^rev_20260927_101500_[a-z0-9]{6}$/);
    for (const id of [generateProjectId(now), generateDocumentId(), generateExportId(), generateRevisionId()]) {
      expect(isWorkspaceId(id), id).toBe(true);
    }
    const ids = new Set([generateProjectId(now), generateProjectId(now), generateProjectId(now)]);
    expect(ids.size).toBe(3);
  });
});
