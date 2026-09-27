import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listProjectsRoute, POST as postProject } from "@/app/api/projects/route";
import { GET as getProjectRoute, PATCH as patchProject } from "@/app/api/projects/[id]/route";
import { GET as listDocumentsRoute, POST as postDocument } from "@/app/api/projects/[id]/documents/route";
import { GET as getDocumentRoute, PATCH as patchDocument } from "@/app/api/projects/[id]/documents/[docId]/route";
import { GET as listExportsRoute, POST as postExport } from "@/app/api/projects/[id]/exports/route";
import { GET as getExportRoute } from "@/app/api/projects/[id]/exports/[exportId]/route";
import { GET as getHealthRoute } from "@/app/api/projects/[id]/health/route";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { buildRunManifest } from "@/infrastructure/tracking/manifest-builder";
import { DEFAULT_RETRY_POLICY } from "@/domain/retry-policy";

/**
 * v2.2.0 Workspace API（TASK §30/§31/§32/§35）。
 *
 * 这一份只打三件事：路由够不够薄、状态码分不分得清、响应里干不干净。
 *   1. **薄**：每个路由只 import @/composition，不拼路径、不写 project.json、
 *      不自己生成 DOCX（§35）。架构测试已在源码层断言"import 组合根"这一条，
 *      这里从行为上补另一半：换个目录 root，路由照旧走得通。
 *   2. **400 / 404 分清**：请求不对是 400，东西不在是 404，不许糊成一个 500。
 *   3. **干净**：任何 JSON 响应里不出现服务器绝对路径（§67）；
 *      二进制下载只带该带的三个头，且长度头与真实字节数一致。
 *
 * 铁律同全仓（§47）：这里不建模型客户端、不发任何请求，Run 是手工搭的。
 */

/** 各路由的响应体形状：用例自己声明要哪些字段，少一个就编译不过。 */
interface CreatedProject {
  id: string;
  name: string;
  schemaVersion: string;
  status: string;
}
interface ProjectListItem extends Record<string, unknown> {
  project: CreatedProject;
  runCount: number;
}
interface ProjectDetail extends Record<string, unknown> {
  runIds: string[];
  documentIds: string[];
}
interface CreatedDocument {
  id: string;
  title: string;
  status: string;
  content: string;
  sourceRunId: string;
  contentHash: string;
}
interface ListPage extends Record<string, unknown> {
  documents: Array<Record<string, unknown>>;
  exports: Array<Record<string, unknown>>;
}
interface ExportOutcome extends Record<string, unknown> {
  download: string;
  byteSize: number;
  result: { id: string; filename: string; bytes?: unknown };
}
interface HealthBody extends Record<string, unknown> {
  status: string;
  updatedAt: string;
  signals: Array<{ code: string }>;
}

const realCwd = process.cwd();
let tmp: string | null = null;

afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** 目录根：runs/ 与 projects/ 同级，与生产环境的默认布局一致。 */
function workspace(): { runs: string; projects: string } {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-ws-api-"));
  process.chdir(tmp);
  return { runs: join(tmp, "runs"), projects: join(tmp, "projects") };
}

function post(url: string, payload: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

function patch(url: string, payload: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

function notJson(url: string, method: "POST" | "PATCH"): NextRequest {
  return new NextRequest(url, { method, body: "{ 这不是 JSON", headers: { "content-type": "application/json" } });
}

function projectCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function documentCtx(id: string, docId: string): { params: Promise<{ id: string; docId: string }> } {
  return { params: Promise.resolve({ id, docId }) };
}

function exportCtx(id: string, exportId: string): { params: Promise<{ id: string; exportId: string }> } {
  return { params: Promise.resolve({ id, exportId }) };
}

function get(url: string): NextRequest {
  return new NextRequest(url);
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 错误码：四个 4xx 用例都要确认「错在哪一类」而不只是「失败了」。 */
async function codeOf(res: Response): Promise<string> {
  const body = await jsonOf<{ error: { code: string } }>(res);
  return body.error.code;
}

/** 一次干净的成功 Run：story.md + 一份真 Manifest，声明归属到 projectId。 */
function putRun(runs: string, runId: string, projectId: string): void {
  const store = new ArtifactStore(runs);
  store.createRunDirectory(runId);
  writeFileSync(join(runs, runId, "story.md"), "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n", "utf8");
  // 先装配一份真 Manifest 再补 workspace：字段透传也一并走到
  const base = buildRunManifest(
    {
      runId,
      startedAt: "2026-09-27T10:00:00.000Z",
      policy: DEFAULT_RETRY_POLICY,
      attempts: [{ attemptNumber: 1, accepted: true, retryReason: null, repairs: [] }],
      selectedAttemptNumber: 1,
    },
    store,
    () => new Date("2026-09-27T10:00:01.000Z"),
  );
  store.putManifest(runId, { ...base, workspace: { projectId } });
}

interface Seeded {
  projectId: string;
  runId: string;
  documentId: string;
  runs: string;
  projects: string;
}

/** 新目录 + 一个项目 + 一次 Run + 一篇稿：后面几组用例都要这一套。 */
async function seeded(opts: { withDocument?: boolean } = {}): Promise<Seeded> {
  const { runs, projects } = workspace();
  const created = await jsonOf<CreatedProject>(
    await postProject(post("http://localhost/api/projects", { name: "夜行列车" })),
  );
  const runId = "20260927_100000_ab12cd";
  putRun(runs, runId, created.id);
  let documentId = "";
  if (opts.withDocument !== false) {
    const doc = await jsonOf<CreatedDocument>(
      await postDocument(
        post(`http://localhost/api/projects/${created.id}/documents`, { runId }),
        documentCtx(created.id, ""),
      ),
    );
    documentId = doc.id;
  }
  return { projectId: created.id, runId, documentId, runs, projects };
}

describe("§30 项目 API", () => {
  it("建项目 → 201，列表里看得见，磁盘上留下 project.json", async () => {
    const { projects } = workspace();
    const res = await postProject(post("http://localhost/api/projects", { name: "消失的目击者" }));
    expect(res.status).toBe(201);
    const json = await jsonOf<CreatedProject>(res);
    expect(json).toMatchObject({ schemaVersion: "1", name: "消失的目击者", status: "active" });
    // §67：响应里没有服务器绝对路径
    expect(JSON.stringify(json)).not.toContain(projects);
    expect(existsSync(join(projects, json.id, "project.json"))).toBe(true);

    const list = await jsonOf<{ projects: ProjectListItem[] }>(await listProjectsRoute());
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ project: { id: json.id }, runCount: 0 });
  });

  it("请求体不合法 → 400，且磁盘上什么都不会多出来", async () => {
    const { projects } = workspace();
    for (const body of [
      { name: "x", status: "published" },
      { name: "x", runIds: ["20260927_100000_ab12cd"] },
      { name: "x", llm_api_key: "sk-" + "not-a-real-key" },
    ]) {
      const res = await postProject(post("http://localhost/api/projects", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
    }
    expect(existsSync(projects)).toBe(false);
  });

  it("请求体不是 JSON → 400", async () => {
    workspace();
    const res = await postProject(notJson("http://localhost/api/projects", "POST"));
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
  });

  it("详情：归这个项目的 Run 靠扫 Manifest 归纳，不是一张缓存列表", async () => {
    const { runs, projects } = workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "有 Run 的项目" })),
    );
    putRun(runs, "20260927_100000_ab12cd", created.id);
    putRun(runs, "20260927_110000_cd34ef", created.id);
    putRun(runs, "20260927_120000_ef56ab", "prj_20260927_120000_other0");

    const detail = await jsonOf<ProjectDetail>(
      await getProjectRoute(get("http://localhost/api/x"), projectCtx(created.id)),
    );
    // 新的在前；别项目的 Run 一条都不进来（第三条挂在另一个项目名下）
    expect(detail.runIds).toEqual(["20260927_110000_cd34ef", "20260927_100000_ab12cd"]);
    expect(detail.documentIds).toEqual([]);
    // §67：详情里也不出现 runs/ 与 projects/ 的绝对路径
    expect(JSON.stringify(detail)).not.toContain(runs);
    expect(JSON.stringify(detail)).not.toContain(projects);
  });

  it("项目不存在 / id 不合法：404 与 400 分清，不 500", async () => {
    workspace();
    const missing = await getProjectRoute(get("http://localhost/api/x"), projectCtx("prj_20260927_101500_nosuch"));
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe("WORKSPACE_NOT_FOUND");

    const bad = await getProjectRoute(get("http://localhost/api/x"), projectCtx("../escape"));
    expect(bad.status).toBe(400);
    expect(await codeOf(bad)).toBe("WORKSPACE_INVALID");
  });

  it("PATCH：改名成功；白名单与空字段之外一律 400", async () => {
    workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "旧名字" })),
    );
    const renamed = await patchProject(
      patch(`http://localhost/api/projects/${created.id}`, { name: "新名字", isFavorite: true }),
      projectCtx(created.id),
    );
    expect(renamed.status).toBe(200);
    expect(await jsonOf<CreatedProject>(renamed)).toMatchObject({ name: "新名字", isFavorite: true });

    for (const body of [{ runIds: [] }, { id: "prj_20260927_101500_j442h6" }, {}]) {
      const res = await patchProject(patch(`http://localhost/api/projects/${created.id}`, body), projectCtx(created.id));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
    }
  });
});

describe("§31 稿件 API", () => {
  it("从 Run 建稿 → 201，标题取自 story.md 的 H1，其余进正文", async () => {
    const { runs, projects } = workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "建稿的项目" })),
    );
    putRun(runs, "20260927_100000_ab12cd", created.id);

    const res = await postDocument(
      post(`http://localhost/api/projects/${created.id}/documents`, { runId: "20260927_100000_ab12cd" }),
      documentCtx(created.id, ""),
    );
    expect(res.status).toBe(201);
    const doc = await jsonOf<CreatedDocument>(res);
    expect(doc).toMatchObject({
      title: "夜行列车",
      status: "draft",
      sourceRunId: "20260927_100000_ab12cd",
    });
    // 正文里不含标题行：H1 被拆成独立字段了
    expect(doc.content.startsWith("她从最后一节车厢")).toBe(true);
    expect(existsSync(join(projects, created.id, "documents", `${doc.id}.json`))).toBe(true);

    const list = await jsonOf<ListPage>(
      await listDocumentsRoute(get("http://localhost/api/x"), documentCtx(created.id, "")),
    );
    expect(list.documents).toHaveLength(1);
    // 列表项不带正文（§35 边界）
    expect(list.documents[0].content).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(projects);
  });

  it("跨项目搬运要明说：把别项目的 Run 搬过来 → 400，不是悄悄建一篇", async () => {
    const { runs, projects } = workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "甲" })),
    );
    putRun(runs, "20260927_100000_ab12cd", "prj_20260927_100000_zz9999");
    const res = await postDocument(
      post(`http://localhost/api/projects/${created.id}/documents`, { runId: "20260927_100000_ab12cd" }),
      documentCtx(created.id, ""),
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
    // 一篇都没建出来
    expect(existsSync(join(projects, created.id, "documents"))).toBe(false);
  });

  it("Run 不存在 → 404；没有 runId → 400", async () => {
    workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "空 Run" })),
    );
    const missing = await postDocument(
      post(`http://localhost/api/projects/${created.id}/documents`, { runId: "20260927_100000_ab12cd" }),
      documentCtx(created.id, ""),
    );
    expect(missing.status).toBe(404);

    const empty = await postDocument(
      post(`http://localhost/api/projects/${created.id}/documents`, {}),
      documentCtx(created.id, ""),
    );
    expect(empty.status).toBe(400);
  });

  it("GET/PATCH 一篇稿：正文读得回来，保存后哈希跟着新正文走", async () => {
    const s = await seeded();
    const read = await getDocumentRoute(get("http://localhost/api/x"), documentCtx(s.projectId, s.documentId));
    expect(read.status).toBe(200);
    const before = await jsonOf<CreatedDocument>(read);

    const res = await patchDocument(
      patch(`http://localhost/api/projects/${s.projectId}/documents/${s.documentId}`, {
        title: "夜行列车·改",
        content: "两行。\n\n三行。",
        status: "final",
      }),
      documentCtx(s.projectId, s.documentId),
    );
    expect(res.status).toBe(200);
    const after = await jsonOf<CreatedDocument>(res);
    expect(after.title).toBe("夜行列车·改");
    expect(after.status).toBe("final");
    expect(after.contentHash).not.toBe(before.contentHash);

    // §48：保存绝不回写 Run 的 story.md
    expect(readFileSync(join(s.runs, s.runId, "story.md"), "utf8")).toBe(
      "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n",
    );
  });

  it("contentHash 不在保存白名单里：声明一个哈希是无效的", async () => {
    const s = await seeded();
    const res = await patchDocument(
      patch(`http://localhost/api/projects/${s.projectId}/documents/${s.documentId}`, {
        content: "新正文",
        contentHash: "0".repeat(64),
      }),
      documentCtx(s.projectId, s.documentId),
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
  });

  it("稿件不存在 → 404", async () => {
    workspace();
    const created = await jsonOf<CreatedProject>(
      await postProject(post("http://localhost/api/projects", { name: "没有稿" })),
    );
    const res = await getDocumentRoute(
      get("http://localhost/api/x"),
      documentCtx(created.id, "doc_20260927_101500_nosuch"),
    );
    expect(res.status).toBe(404);
  });
});

describe("§32 导出 API", () => {
  it("导出 → 201，带上 Content-Disposition；历史里多一条；文件能原样下回来", async () => {
    const s = await seeded();
    const res = await postExport(
      post(`http://localhost/api/projects/${s.projectId}/exports`, { documentId: s.documentId, format: "docx" }),
      exportCtx(s.projectId, ""),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const outcome = await jsonOf<ExportOutcome>(res);
    expect(outcome.result.filename.endsWith(".docx")).toBe(true);
    // 响应体里没有字节本身，也没有绝对路径（§67）
    expect(outcome.result.bytes).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain(s.projects);

    const list = await jsonOf<ListPage>(await listExportsRoute(get("http://localhost/api/x"), exportCtx(s.projectId, "")));
    expect(list.exports).toHaveLength(1);
    expect(list.exports[0].id).toBe(outcome.result.id);

    const download = await getExportRoute(get("http://localhost/api/x"), exportCtx(s.projectId, outcome.result.id));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(download.headers.get("content-disposition")).toBe(outcome.download);
    const body = new Uint8Array(await download.arrayBuffer());
    expect(body.byteLength).toBe(Number(download.headers.get("content-length")));
    expect(body.byteLength).toBe(outcome.byteSize);
    // ZIP 容器：DOCX 与 EPUB 都是
    expect(new TextDecoder().decode(body.subarray(0, 2))).toBe("PK");
  });

  it("format 不对 / 缺 documentId / 多带 runId → 400；documentId 不是这个项目的 → 404", async () => {
    const s = await seeded();
    for (const body of [
      { documentId: s.documentId, format: "pdf" },
      { format: "docx" },
      { documentId: s.documentId, format: "docx", runId: s.runId },
    ]) {
      const res = await postExport(
        post(`http://localhost/api/projects/${s.projectId}/exports`, body),
        exportCtx(s.projectId, ""),
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await codeOf(res)).toBe("WORKSPACE_INVALID");
    }
    const notMine = await postExport(
      post(`http://localhost/api/projects/${s.projectId}/exports`, {
        documentId: "doc_20260927_101500_nosuch",
        format: "docx",
      }),
      exportCtx(s.projectId, ""),
    );
    expect(notMine.status).toBe(404);
  });

  it("下载：id 不存在 → 404；文件被删了 → 404（不拿别的文件顶上）", async () => {
    const s = await seeded();
    const created = await jsonOf<ExportOutcome>(
      await postExport(
        post(`http://localhost/api/projects/${s.projectId}/exports`, { documentId: s.documentId, format: "epub" }),
        exportCtx(s.projectId, ""),
      ),
    );
    const missing = await getExportRoute(
      get("http://localhost/api/x"),
      exportCtx(s.projectId, "out_20260927_101500_zz9999"),
    );
    expect(missing.status).toBe(404);

    rmSync(join(s.projects, s.projectId, "exports", created.result.filename));
    const gone = await getExportRoute(get("http://localhost/api/x"), exportCtx(s.projectId, created.result.id));
    expect(gone.status).toBe(404);
    // 账上那条还在：历史只说导出过，不说文件还在（§24）
    const list = await jsonOf<ListPage>(await listExportsRoute(get("http://localhost/api/x"), exportCtx(s.projectId, "")));
    expect(list.exports).toHaveLength(1);
  });
});

describe("§16/§18 项目健康 API", () => {
  it("有 Run 没有稿：attention，信号指出该建一篇；两次请求逐字相同", async () => {
    const s = await seeded({ withDocument: false });
    const url = `http://localhost/api/projects/${s.projectId}/health`;
    const first = await jsonOf<HealthBody>(await getHealthRoute(get(url), projectCtx(s.projectId)));
    expect(first.status).toBe("attention");
    expect(first.signals.map((x) => x.code)).toEqual(["no_current_document"]);
    expect(typeof first.updatedAt).toBe("string");

    // updatedAt 之外逐字相同（时间戳来自服务器时钟）
    const second = await jsonOf<HealthBody>(await getHealthRoute(get(url), projectCtx(s.projectId)));
    expect({ ...second, updatedAt: "" }).toEqual({ ...first, updatedAt: "" });
  });

  it("建了稿：healthy，只留一条「还没导出过」的 info", async () => {
    const s = await seeded();
    const res = await getHealthRoute(get("http://localhost/api/x"), projectCtx(s.projectId));
    const health = await jsonOf<HealthBody>(res);
    expect(health.status).toBe("healthy");
    expect(health.signals.map((x) => x.code)).toEqual(["no_exports"]);
  });

  it("项目不存在 / id 不合法：404 与 400 分清", async () => {
    workspace();
    const missing = await getHealthRoute(get("http://localhost/api/x"), projectCtx("prj_20260927_101500_nosuch"));
    expect(missing.status).toBe(404);
    const bad = await getHealthRoute(get("http://localhost/api/x"), projectCtx("../escape"));
    expect(bad.status).toBe(400);
  });
});
