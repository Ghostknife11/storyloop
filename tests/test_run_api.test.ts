import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRuns } from "@/app/api/runs/route";
import { POST as postRunsFromPlan } from "@/app/api/runs/from-plan/route";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/**
 * §31~§33 HTTP 路由层：只验证「JSON 解析 → 委托 service → 响应形状」，
 * LLM 用 stubGlobal("fetch") 冒充，绝不访问真实付费 API。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
});

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  vi.unstubAllGlobals();
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-runs-api-"));
  process.chdir(tmp);
  return tmp;
}

/**
 * 冒充 OpenAI-compatible /chat/completions：
 * BeatPlanner 的 system 里带「只输出 JSON」，据此决定返回 BeatPlan 还是正文。
 */
function stubLLM() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
    const isPlanner = (body.messages ?? []).some((m) => m.content.includes("只输出 JSON"));
    const content = isPlanner ? JSON.stringify(plan) : "正文——陈岚走进雨夜。";
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function post(url: string, payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function readJson(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/runs（§32）", () => {
  it("完整 Automatic Run：200 + run_id + runs/<run_id>/ 四件产物", async () => {
    const dir = withTmpDir();
    stubLLM();
    const res = await postRuns(post("/api/runs", { config }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(String(body.run_id)).toMatch(RUN_ID);
    expect(body.status).toBe("completed");
    expect(String(body.story)).toContain("正文");

    const runDir = join(dir, "runs", String(body.run_id));
    expect(readdirSync(runDir).sort()).toEqual(["beats.json", "config.json", "metadata.json", "story.md"]);
    // §16/§17 metadata 与响应一致
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(body.run_id);
    expect(meta.status).toBe("completed");
  });

  it("请求体不是合法 JSON → 400", async () => {
    withTmpDir();
    const res = await postRuns(post("/api/runs", "{not json"));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("JSON");
  });

  it("config 非法 → 400（不创建 Run 目录）", async () => {
    const dir = withTmpDir();
    stubLLM();
    const res = await postRuns(post("/api/runs", { config: { title: "", genre: "悬疑", premise: "x", target_words: 5000 } }));
    expect(res.status).toBe(400);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("§67 响应不含本地绝对路径", async () => {
    withTmpDir();
    stubLLM();
    const res = await postRuns(post("/api/runs", { config }));
    const text = JSON.stringify(await readJson(res));
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toContain("/runs/");
    expect(text).not.toContain("config.json\":\"");
  });
});

describe("POST /api/runs/from-plan（§33）", () => {
  it("完整 Manual Run：run_id 与 metadata / beats.json 完全一致", async () => {
    const dir = withTmpDir();
    const fetchMock = stubLLM();
    const res = await postRunsFromPlan(post("/api/runs/from-plan", { config, beat_plan: plan }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(String(body.run_id)).toMatch(RUN_ID);

    const runDir = join(dir, "runs", String(body.run_id));
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    const savedBeats = JSON.parse(readFileSync(join(runDir, "beats.json"), "utf8")) as BeatPlan;
    // 三处 run_id 同一个值（from-plan 一致性）
    expect(meta.run_id).toBe(body.run_id);
    // §29：用户 BeatPlan 原样落盘，Planner 未被调用
    expect(savedBeats).toEqual(plan);
    const plannerCalls = fetchMock.mock.calls.filter(([, init]) => {
      const b = JSON.parse(String((init as RequestInit | undefined)?.body)) as { messages?: Array<{ content: string }> };
      return (b.messages ?? []).some((m) => m.content.includes("只输出 JSON"));
    });
    expect(plannerCalls).toHaveLength(0);
  });

  it("缺 beat_plan → 400，并指引先规划", async () => {
    withTmpDir();
    stubLLM();
    const res = await postRunsFromPlan(post("/api/runs/from-plan", { config }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("beat_plan is required");
  });

  it("beat_plan 非法 → 400", async () => {
    withTmpDir();
    stubLLM();
    const res = await postRunsFromPlan(post("/api/runs/from-plan", { config, beat_plan: { beats: [] } }));
    expect(res.status).toBe(400);
  });

  it("请求体不是合法 JSON → 400", async () => {
    withTmpDir();
    const res = await postRunsFromPlan(post("/api/runs/from-plan", "nope"));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("JSON");
  });

  it("LLM 失败 → 502，body 带 run_id 与 stage（§28）", async () => {
    const dir = withTmpDir();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await postRunsFromPlan(post("/api/runs/from-plan", { config, beat_plan: plan }));
    expect(res.status).toBe(502);
    const body = await readJson(res);
    expect(String(body.error)).toContain("500");
    expect(String(body.run_id)).toMatch(RUN_ID);
    expect(body.stage).toBe("generating");
    // §19：失败也留下 metadata
    const meta = JSON.parse(readFileSync(join(dir, "runs", String(body.run_id), "metadata.json"), "utf8"));
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("generating");
  });
});
