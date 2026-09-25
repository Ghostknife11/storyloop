import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listExperiments, POST as postExperiment } from "@/app/api/experiments/route";
import { GET as getExperiment } from "@/app/api/experiments/[experiment_id]/route";
import { POST as runExperiment } from "@/app/api/experiments/[experiment_id]/run/route";
import { SAMPLE_BEAT_PLAN } from "./helpers/fixtures";
import type { StoryConfig } from "@/types/story-config";

/**
 * v1.7.0 实验 API：先建、再跑、只读三条链路。
 *
 * 这里只打「拒绝」分支，所以不需要假模型——四种拒绝全部发生在任何 LLM
 * 请求之前：结构不合法 400、不存在 404、跑过了 409、没配密钥 400。
 * 绝不调用真实付费端点（TASK §47）。
 */

const CONFIG: StoryConfig = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

/** 一个凭据形状的值：拼起来写，源码里不留完整的密钥样式字符串。 */
const FAKE_SECRET = "sk-" + "this-is-not-a-real-key";

function body(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    name: "模型对比",
    experimentId: id,
    base: { storyConfig: CONFIG, beatPlanMode: "fixed", beatPlan: SAMPLE_BEAT_PLAN },
    variants: [
      { id: "model-a", name: "模型 A" },
      { id: "model-b", name: "模型 B" },
    ],
    repetitions: 1,
    ...patch,
  };
}

const realCwd = process.cwd();
const realKey = process.env.LLM_API_KEY;
let tmp: string | null = null;

beforeEach(() => {
  // 这个文件只测拒绝分支：开跑前没有密钥就必须先被 400 挡住
  delete process.env.LLM_API_KEY;
});

afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
  if (realKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = realKey;
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-exp-api-"));
  process.chdir(tmp);
  return tmp;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function post(url: string, payload: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

/** 路由的第二个参数：动态段 params（v15+ 起是 Promise）。 */
function ctx(experiment_id: string): { params: Promise<{ experiment_id: string }> } {
  return { params: Promise.resolve({ experiment_id }) };
}

describe("POST /api/experiments", () => {
  it("合法定义 → 201，磁盘上留下 definition.json", async () => {
    const dir = withTmpDir();
    const res = await postExperiment(post("http://localhost/api/experiments", body("exp-create")));
    expect(res.status).toBe(201);
    const json = await readJson(res);
    expect(json).toMatchObject({ experimentId: "exp-create", schemaVersion: "1", repetitions: 1 });
    // 响应里没有本地绝对路径（§67）
    expect(JSON.stringify(json)).not.toContain("\\");

    expect(existsSync(join(dir, "experiments", "exp-create", "definition.json"))).toBe(true);
    // 刚建好的实验还没跑：results.json 不存在
    expect(existsSync(join(dir, "experiments", "exp-create", "results.json"))).toBe(false);
  });

  it("请求体不是 JSON → 400", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/experiments", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await postExperiment(req);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatchObject({ code: "EXPERIMENT_INVALID" });
  });

  it("结构不合法 → 400，且磁盘上什么都不会多出来", async () => {
    const dir = withTmpDir();
    const res = await postExperiment(
      post("http://localhost/api/experiments", body("exp-bad", { repetitions: 9 })),
    );
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toMatchObject({ code: "EXPERIMENT_INVALID" });
    expect(String((json.error as { message: string }).message)).toContain("repetitions");
    expect(existsSync(join(dir, "experiments", "exp-bad"))).toBe(false);
  });

  it("重复 id → 409 EXPERIMENT_CONFLICT（定义不可变）", async () => {
    withTmpDir();
    await postExperiment(post("http://localhost/api/experiments", body("exp-dup")));
    const res = await postExperiment(post("http://localhost/api/experiments", body("exp-dup")));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toMatchObject({ code: "EXPERIMENT_CONFLICT" });
  });

  it("凭据形状的字段一律拒收，不回显（§68）", async () => {
    withTmpDir();
    const res = await postExperiment(
      post(
        "http://localhost/api/experiments",
        body("exp-secret", {
          base: {
            storyConfig: { ...CONFIG, api_key: FAKE_SECRET },
            beatPlanMode: "fixed",
            beatPlan: SAMPLE_BEAT_PLAN,
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const text = JSON.stringify(await readJson(res));
    expect(text).not.toContain(FAKE_SECRET);
  });
});

describe("GET /api/experiments", () => {
  it("空列表返回 {experiments:[]}，建过之后按创建时间新的在前", async () => {
    withTmpDir();
    expect((await readJson(await listExperiments())).experiments).toEqual([]);

    await postExperiment(
      post("http://localhost/api/experiments", body("exp-one", { createdAt: "2026-09-25T00:00:00.000Z" })),
    );
    await postExperiment(
      post("http://localhost/api/experiments", body("exp-two", { createdAt: "2026-09-26T00:00:00.000Z" })),
    );
    const json = await readJson(await listExperiments());
    const items = json.experiments as Array<Record<string, unknown>>;
    expect(items.map((i) => i.experimentId)).toEqual(["exp-two", "exp-one"]);
    expect(items[0]).toMatchObject({ status: "pending", successCount: 0, failureCount: 0, totalRuns: 2 });
    // 列表不带样本详情，也不给绝对路径
    expect(Object.keys(items[0]).sort()).toEqual([
      "createdAt", "experimentId", "failureCount", "name", "repetitions",
      "status", "successCount", "totalRuns", "variantCount",
    ]);
  });
});

describe("GET /api/experiments/<id>", () => {
  it("没跑过的实验 runs 与 result 都是 null", async () => {
    withTmpDir();
    await postExperiment(post("http://localhost/api/experiments", body("exp-fresh")));
    const res = await getExperiment(
      new Request("http://localhost/api/experiments/exp-fresh"),
      ctx("exp-fresh"),
    );
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.runs).toBeNull();
    expect(json.result).toBeNull();
    expect(json.definition).toMatchObject({ experimentId: "exp-fresh" });
  });

  it("不存在的 id → 404 EXPERIMENT_NOT_FOUND", async () => {
    withTmpDir();
    const res = await getExperiment(new Request("http://localhost/api/experiments/nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toMatchObject({ code: "EXPERIMENT_NOT_FOUND" });
  });
});

describe("POST /api/experiments/<id>/run", () => {
  it("没配 LLM_API_KEY → 400，一个请求都不发", async () => {
    withTmpDir();
    await postExperiment(post("http://localhost/api/experiments", body("exp-nokey")));
    const res = await runExperiment(
      new Request("http://localhost/api/experiments/exp-nokey/run", { method: "POST" }),
      ctx("exp-nokey"),
    );
    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toMatchObject({ code: "EXPERIMENT_INVALID" });
    expect(String((json.error as { message: string }).message)).toContain("LLM_API_KEY");
  });

  it("不存在的实验 → 404", async () => {
    withTmpDir();
    const res = await runExperiment(
      new Request("http://localhost/api/experiments/ghost/run", { method: "POST" }),
      ctx("ghost"),
    );
    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toMatchObject({ code: "EXPERIMENT_NOT_FOUND" });
  });

  it("跑过的实验再跑 → 409（定义与结果都不可变）", async () => {
    const dir = withTmpDir();
    await postExperiment(post("http://localhost/api/experiments", body("exp-done")));
    // 手写一份结果，等价于「已经跑完过一次」——重跑必须挡在 LLM 之前
    mkdirSync(join(dir, "experiments", "exp-done"), { recursive: true });
    writeFileSync(
      join(dir, "experiments", "exp-done", "results.json"),
      JSON.stringify({
        experimentId: "exp-done",
        status: "completed",
        runs: [],
        summary: { runCount: 0, successCount: 0, failureCount: 0, variants: [] },
        startedAt: "2026-09-26T00:00:00.000Z",
        completedAt: "2026-09-26T00:01:00.000Z",
      }),
      "utf8",
    );
    const res = await runExperiment(
      new Request("http://localhost/api/experiments/exp-done/run", { method: "POST" }),
      ctx("exp-done"),
    );
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toMatchObject({ code: "EXPERIMENT_CONFLICT" });
  });
});
