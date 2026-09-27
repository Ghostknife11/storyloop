import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listDocumentsRoute, POST as postDocument } from "@/app/api/projects/[id]/documents/route";
import { PATCH as patchDocument } from "@/app/api/projects/[id]/documents/[docId]/route";
import { POST as postExport } from "@/app/api/projects/[id]/exports/route";
import { PATCH as patchProject } from "@/app/api/projects/[id]/route";
import { POST as postProject } from "@/app/api/projects/route";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { buildRunManifest } from "@/infrastructure/tracking/manifest-builder";
import { DEFAULT_RETRY_POLICY } from "@/domain/retry-policy";

/**
 * v2.2.0 §45 Security Regression：工作区这一条边界上，一次外联都不该发生。
 *
 * 为什么值得单独立一个文件：安全扫描按模块导入图报过七条工作区路由「2 跳到达 SSRF」
 * （createDocumentFromRun / updateProject / exportDocument / saveDocument）。
 * 调用图是过近似——它只回答「有没有一条 import 路走到 fetch」，不回答
 * 「请求体的字段能不能变成那个 URL」。拆开组合根之前它抓到的路是真的：
 * `@/composition` 这一个模块同时挂着生成管线（createStoryLoop → buildPipeline →
 * 模型客户端 → 本仓唯一一处 fetch），于是每个工作区路由的导入图里都有那个客户端。
 *
 * v2.2.0 把组合根按能力拆成 `@/composition`（管线）与 `@/composition/workspace`
 * （纯文件读写），工作区路由只 import 后者。于是这里两层都能当真话讲：
 *
 *   1. 静态：七条路由的导入闭包里，LLM 客户端与生成管线整个不可达。
 *   2. 行为：把 globalThis.fetch 换成「一被调用就失败并计数」的桩，照常打建稿 /
 *      改名收藏 / 存稿 / 导出四个写接口。计数必须是 0，状态码必须照旧。
 *
 * 两层都要：静态层挡「不小心把模型客户端引回来」，行为层挡「依赖图干净但代码里
 * 还是发了请求」。少任何一层，另一层都能被单独骗过去。
 *
 * 那次误报的完整形状，写在这里省得下一个人再查一遍：扫描报告说的是
 * 「saveDocument → requestJson → send(sink:ssrf)」，即它把路由里的
 * `createWorkspace().saveDocument(...)`（服务端用例）认成了
 * `src/interface/api.ts` 里同名的浏览器函数。根子是两侧共用函数名，
 * 已经改成浏览器侧按 HTTP 动词命名，并由 test_architecture 的
 * 「两边不共用函数名」守着。静态层这边也补上：注释里长得像导入的字符串
 * 一样算导入边（llm-errors.ts 因此改过措辞）。
 *
 * 铁律同全仓（§47）：这里不建模型客户端、不配真密钥，Run 是手工搭的。
 */

const realCwd = process.cwd();
let tmp: string | null = null;
let fetchCalls = 0;

beforeEach(() => {
  // 每个用例前重装一遍：桩必须在**每个**用例期间都生效，只在 import 时装一次的话，
  // 第一个 afterEach 一还原，后面的断言就全是在对真 fetch 说话（虚警就是这么来的，
  // 这个坑本次自己踩过：变异检查一度没让它红，才看出还原时机写错了）。
  fetchCalls = 0;
  globalThis.fetch = ((): never => {
    fetchCalls += 1;
    throw new Error("工作区这一层不许发外联请求");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.chdir(realCwd);
  globalThis.fetch = realFetch;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** 服务端唯一一处 fetch 的落点：工作区的依赖图里不许出现它。 */
const NETWORK_MODULES = /infrastructure\/(llm|security\/url-guard)|generate-service/;

/** 七条工作区路由。 */
const WORKSPACE_ROUTES = [
  "src/app/api/projects/route.ts",
  "src/app/api/projects/[id]/route.ts",
  "src/app/api/projects/[id]/documents/route.ts",
  "src/app/api/projects/[id]/documents/[docId]/route.ts",
  "src/app/api/projects/[id]/exports/route.ts",
  "src/app/api/projects/[id]/exports/[exportId]/route.ts",
  "src/app/api/projects/[id]/health/route.ts",
];

const toPosix = (p: string): string => p.split("\\").join("/");

/** `@/x/y` → src/x/y.ts 的真实路径；包内引用返回 null。路径一律归一成 `/`。 */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = join("src", spec.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return toPosix(candidate);
  }
  return null;
}

/**
 * 从若干入口出发，沿 `@/...` 导入闭包走一遍，返回走到的全部源码文件。
 *
 * 两点都得说清楚，否则这个函数会自己骗自己：
 *  - 路径必须归一成 `/`：Windows 上 join() 给的是 `src\app\...`，而
 *    NETWORK_MODULES 写的是 `infrastructure/llm`——不归一的话，Windows 上
 *    这条规则对 LLM 客户端与 url-guard 恒真却恒不报警（本次自己踩过：
 *    变异检查只因 generate-service 那一段没带斜杠才红）。
 *  - 正则不跳过注释：注释里出现 `from "@/..."` 也会被当成一条导入边。这不是
 *     bug 而是本文件要的性质——安全扫描器就是这么走的，所以注释里也不能留
 *    指向 HTTP 客户端的假导入边（见 llm-errors.ts 的说明）。
 */
function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries].map(toPosix);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from "(@\/[^"]+)"/g)) {
      const next = resolveAlias(m[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen].sort();
}

describe("§45 工作区自己的代码够不着网络", () => {
  it("用例与存储/导出的导入闭包里没有 LLM 客户端、没有生成管线、没有请求门", () => {
    const reached = reachable([
      "src/application/workspace-projects.ts",
      "src/application/workspace-documents.ts",
      "src/application/workspace-exports.ts",
      "src/application/workspace-health.ts",
      "src/infrastructure/storage/project-store.ts",
      "src/infrastructure/storage/document-store.ts",
      "src/infrastructure/storage/export-store.ts",
    ]);
    const offenders = reached.filter((file) => NETWORK_MODULES.test(file));
    expect(offenders, `这些文件会发外联请求: ${offenders.join(", ")}`).toEqual([]);
    // 顺带确认闭包里真的含两个导出器：DOCX / EPUB 是纯本地拼字节，这条才有意义
    expect(reached).toContain("src/infrastructure/export/docx-exporter.ts");
    expect(reached).toContain("src/infrastructure/export/epub-exporter.ts");
  });

  it("七条路由的导入闭包里，LLM 客户端与生成管线整个不可达", () => {
    const reached = reachable(WORKSPACE_ROUTES);
    const offenders = reached.filter((file) => NETWORK_MODULES.test(file));
    expect(offenders, `这些文件会发外联请求: ${offenders.join(", ")}`).toEqual([]);
    // 这条断言之所以可能成立，全拜组合根按能力拆开（@/composition/workspace）：
    // 拆之前每条路由的闭包里都有模型客户端。所以再确认一句闭包确实走到了工作区那半边，
    // 否则空闭包也能让上面的断言通过。
    expect(reached).toContain("src/composition/workspace.ts");
    expect(reached).toContain("src/infrastructure/storage/project-store.ts");
  });

  it("七条路由只向组合根要 createWorkspace，不碰生成管线那三个出口", () => {
    const generation = ["createDependencies", "createStoryLoopApplication", "createStoryLoop", "buildPipeline"];
    for (const route of WORKSPACE_ROUTES) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route} 应该经 createWorkspace 拿用例`).toContain("createWorkspace");
      for (const name of generation) {
        expect(src, `${route} 不该出现 ${name}`).not.toContain(name);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 行为层：fetch 桩
// ---------------------------------------------------------------------------

/** 服务端真实 fetch：每个用例结束后还原，别把别的测试文件带下水。 */
const realFetch = globalThis.fetch;

function workspaceRoot(): { runs: string; projects: string } {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-ws-net-"));
  process.chdir(tmp);
  return { runs: join(tmp, "runs"), projects: join(tmp, "projects") };
}

function request(url: string, method: "POST" | "PATCH", payload: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function projectCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function documentCtx(id: string, docId: string): { params: Promise<{ id: string; docId: string }> } {
  return { params: Promise.resolve({ id, docId }) };
}

/** 一次干净的成功 Run：story.md + 一份真 Manifest，声明归属到 projectId。 */
function putRun(runs: string, runId: string, projectId: string): void {
  const store = new ArtifactStore(runs);
  store.createRunDirectory(runId);
  writeFileSync(join(runs, runId, "story.md"), "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n", "utf8");
  store.putManifest(runId, {
    ...buildRunManifest(
      {
        runId,
        startedAt: "2026-09-27T10:00:00.000Z",
        policy: DEFAULT_RETRY_POLICY,
        attempts: [{ attemptNumber: 1, accepted: true, retryReason: null, repairs: [] }],
        selectedAttemptNumber: 1,
      },
      store,
      () => new Date("2026-09-27T10:00:01.000Z"),
    ),
    workspace: { projectId },
  });
}

describe("§45 四个写接口在 fetch 被禁的情况下照旧工作", () => {
  it("建稿 / 改名收藏 / 存稿 / 导出：一次外联都没有，状态码照旧", async () => {
    const { runs } = workspaceRoot();
    const created = await jsonOf<{ id: string }>(
      await postProject(request("http://localhost/api/projects", "POST", { name: "夜行列车" })),
    );
    const projectId = created.id;
    const runId = "20260927_100000_ab12cd";
    putRun(runs, runId, projectId);

    // 1. Run → Draft（扫描点 #1）
    const doc = await jsonOf<{ id: string; title: string }>(
      await postDocument(
        request(`http://localhost/api/projects/${projectId}/documents`, "POST", { runId }),
        documentCtx(projectId, ""),
      ),
    );
    expect(doc.title).toBe("夜行列车");

    // 2. 改名 + 收藏（扫描点 #2）
    const renamed = await jsonOf<{ name: string; isFavorite: boolean }>(
      await patchProject(
        request(`http://localhost/api/projects/${projectId}`, "PATCH", { name: "夜行列车·二稿", isFavorite: true }),
        projectCtx(projectId),
      ),
    );
    expect(renamed.name).toBe("夜行列车·二稿");
    expect(renamed.isFavorite).toBe(true);

    // 3. 存稿 + 标定稿（扫描点 #3）
    const saved = await jsonOf<{ status: string }>(
      await patchDocument(
        request(`http://localhost/api/projects/${projectId}/documents/${doc.id}`, "PATCH", {
          title: "雨里下车的人",
          content: "她从最后一节车厢走进了雨里。",
          status: "final",
        }),
        documentCtx(projectId, doc.id),
      ),
    );
    expect(saved.status).toBe("final");

    // 4. 导出 Word 与 EPUB（扫描点 #4）
    for (const format of ["docx", "epub"] as const) {
      const outcome = await jsonOf<{ byteSize: number; result: { filename: string } }>(
        await postExport(
          request(`http://localhost/api/projects/${projectId}/exports`, "POST", { documentId: doc.id, format }),
          projectCtx(projectId),
        ),
      );
      expect(outcome.result.filename.endsWith(`.${format}`)).toBe(true);
      expect(outcome.byteSize).toBeGreaterThan(0);
    }

    // 读接口也一起过：它们同样不许外联
    const list = await listDocumentsRoute(new NextRequest(`http://localhost/api/projects/${projectId}/documents`), documentCtx(projectId, ""));
    expect(list.status).toBe(200);

    expect(fetchCalls, "工作区这一层发生了外联请求——除非这是真的有意的能力，否则就是回归").toBe(0);
  });

  it("resolve() 出来的项目目录就在 runs/ 旁边，不指向任何远端地址", () => {
    const { runs, projects } = workspaceRoot();
    expect(resolve(projects)).toBe(join(resolve(tmp as string), "projects"));
    expect(resolve(runs)).toBe(join(resolve(tmp as string), "runs"));
  });
});
