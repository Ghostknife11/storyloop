import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRuns } from "@/app/api/runs/route";
import { POST as postRunsFromPlan } from "@/app/api/runs/from-plan/route";
import { POST as postReview } from "@/app/api/review/route";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §31~§33/§46 HTTP 路由层：只验证「JSON 解析 → 委托 service → 响应形状」，
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

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
};

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

/** target_words=5000 时长度下限为 750：这里远超下限、含主角名、以句号结尾，可通过全部硬规则。 */
const LONG_STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

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
 * system 消息区分三种角色——剧情策划（Planner）/ 基础审阅者（Reviewer）/ 作者（Generator）。
 */
function stubLLM(reviewerOutput?: string, story = LONG_STORY) {
  const reviewerText = reviewerOutput ?? JSON.stringify(review);
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
    const system = (body.messages ?? []).map((m) => m.content).join("\n");
    const content = system.includes("剧情策划")
      ? JSON.stringify(plan)
      : system.includes("审阅")
        ? reviewerText
        : story;
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

describe("POST /api/runs（§32/§46）", () => {
  it("完整 Automatic Run：200 + run_id + validation + review + runs/<run_id>/ 六件产物", async () => {
    const dir = withTmpDir();
    stubLLM();
    const res = await postRuns(post("/api/runs", { config }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(String(body.run_id)).toMatch(RUN_ID);
    expect(body.status).toBe("completed");
    expect(String(body.story)).toContain("陈岚");
    // §27：成功响应包含 review
    expect(body.review).toEqual(review);
    expect(body.review_status).toBe("completed");
    // §26：成功响应同时包含 validation（硬性检查与审阅分开）
    expect(body.validation).toEqual({ passed: true, issues: [] });
    expect(body.validation_status).toBe("completed");
    expect(body.validation_error).toBeUndefined();

    const runDir = join(dir, "runs", String(body.run_id));
    expect(readdirSync(runDir).sort()).toEqual([
      "beats.json", "config.json", "metadata.json", "review.json", "story.md", "validation.json",
    ]);
    expect(JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8"))).toEqual({ passed: true, issues: [] });
    // §16/§17/§24 metadata 与响应一致
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(body.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(true);
    expect(meta.validation_issue_count).toBe(0);
    expect(meta.review_status).toBe("completed");
    expect(meta.review_score).toBe(74);
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

describe("POST /api/runs — validation failed（§26/§42/§44）", () => {
  it("§44B 极短 Story：HTTP 仍 200，story 保留，validation.passed=false + TOO_SHORT", async () => {
    const dir = withTmpDir();
    stubLLM(undefined, "只有一句话。");
    const res = await postRuns(post("/api/runs", { config }));
    // §26：Validation Failed 是业务结果，不是服务器异常
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe("completed");
    expect(String(body.story)).toBe("只有一句话。");
    const validation = body.validation as ValidationResult;
    expect(validation.passed).toBe(false);
    expect(validation.issues.map((i) => i.code)).toContain("TOO_SHORT");
    // §39：Review 仍然执行
    expect(body.review).toEqual(review);
    expect(body.review_status).toBe("completed");

    const runDir = join(dir, "runs", String(body.run_id));
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "validation.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8")) as ValidationResult;
    expect(saved.passed).toBe(false);
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.validation_passed).toBe(false);
    expect(meta.validation_issue_count).toBe(saved.issues.length);
  });

  it("§18/§44C 空正文是 LLM 层先拦截，EMPTY_CONTENT 只作为 Validator 兜底规则", async () => {
    // §16：真正的 LLM 请求失败仍属于 Generation Error，不属于 Validator。
    // 空串 / 纯空白都会被 LLMClient 拦截成 502，因此 EMPTY_CONTENT 在真实 HTTP 链路上不可达，
    // 它兜底的是「注入了假 Generator」或未来放宽 LLM 层拦截的情况——
    // 该路径由 test_generation_pipeline.test.ts 与 test_story_validator.test.ts 覆盖。
    const dir = withTmpDir();
    for (const empty of ["", "   "]) {
      stubLLM(undefined, empty);
      const res = await postRuns(post("/api/runs", { config }));
      expect(res.status).toBe(502);
      const body = await readJson(res);
      expect(body.stage).toBe("generating");
      expect(String(body.error)).toContain("LLM 返回内容为空");
      // 没有进入 Validate 阶段，因此不产生 validation.json
      expect(existsSync(join(dir, "runs", String(body.run_id), "validation.json"))).toBe(false);
      expect(existsSync(join(dir, "runs", String(body.run_id), "story.md"))).toBe(false);
    }
  });

  it("§44D 主角缺失：MISSING_PROTAGONIST，且不因此重新生成", async () => {
    const dir = withTmpDir();
    const fetchMock = stubLLM(undefined, `${"林述安走在长长的走廊里。".repeat(90)}`);
    const res = await postRuns(post("/api/runs", { config }));
    const body = await readJson(res);
    const validation = body.validation as ValidationResult;
    expect(validation.issues.map((i) => i.code)).toContain("MISSING_PROTAGONIST");
    expect(validation.passed).toBe(false);
    // §58：Generator 只被调用一次，绝不自动重试
    const genCalls = fetchMock.mock.calls.filter(([, init]) => {
      const b = JSON.parse(String((init as RequestInit | undefined)?.body)) as { messages?: Array<{ content: string }> };
      const system = (b.messages ?? []).map((m) => m.content).join("\n");
      return !system.includes("剧情策划") && !system.includes("审阅");
    });
    expect(genCalls).toHaveLength(1);
    expect(existsSync(join(dir, "runs", String(body.run_id), "story.md"))).toBe(true);
  });
});

describe("POST /api/runs — review failure（§28/§34/§46）", () => {
  it("Reviewer 返回非法 JSON：仍 200 + story，review 为 null，review_status=failed", async () => {
    const dir = withTmpDir();
    stubLLM("我觉得这篇故事还不错，但没法给 JSON。");
    const res = await postRuns(post("/api/runs", { config }));
    // §28：不得因为 Review 失败丢弃成功生成的正文
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe("completed");
    expect(String(body.story)).toContain("陈岚");
    expect(body.review).toBeNull();
    expect(body.review_status).toBe("failed");
    expect(String(body.review_error)).toContain("Reviewer 输出不是合法 JSON");

    const runDir = join(dir, "runs", String(body.run_id));
    // §49：Story 仍可见，Run 仍保留 Story Artifact；§17 validation 与 review 互不影响
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "validation.json"))).toBe(true);
    expect(existsSync(join(runDir, "review.json"))).toBe(false);
    expect(readdirSync(runDir).sort()).toEqual([
      "beats.json", "config.json", "metadata.json", "story.md", "validation.json",
    ]);
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.status).toBe("completed");
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(true);
    expect(meta.review_status).toBe("failed");
  });

  it("Review 分数越界（101）同样只算 Review 失败", async () => {
    const dir = withTmpDir();
    stubLLM(JSON.stringify({ ...review, score: 101 }));
    const res = await postRuns(post("/api/runs", { config }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.review).toBeNull();
    expect(body.review_status).toBe("failed");
    expect(String(body.review_error)).toContain("score 必须在 0 ~ 100");
    expect(existsSync(join(dir, "runs", String(body.run_id), "story.md"))).toBe(true);
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
    expect(body.review).toEqual(review);

    const runDir = join(dir, "runs", String(body.run_id));
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    const savedBeats = JSON.parse(readFileSync(join(runDir, "beats.json"), "utf8")) as BeatPlan;
    // 三处 run_id 同一个值（from-plan 一致性）
    expect(meta.run_id).toBe(body.run_id);
    // §29：用户 BeatPlan 原样落盘，Planner 未被调用
    expect(savedBeats).toEqual(plan);
    const plannerCalls = fetchMock.mock.calls.filter(([, init]) => {
      const b = JSON.parse(String((init as RequestInit | undefined)?.body)) as { messages?: Array<{ content: string }> };
      return (b.messages ?? []).some((m) => m.content.includes("剧情策划"));
    });
    expect(plannerCalls).toHaveLength(0);
    // §25：Reviewer 与 Generator 使用同一个 LLM 端点（无 Model Router）
    const reviewerCalls = fetchMock.mock.calls.filter(([, init]) => {
      const b = JSON.parse(String((init as RequestInit | undefined)?.body)) as { messages?: Array<{ content: string }> };
      return (b.messages ?? []).some((m) => m.content.includes("审阅"));
    });
    expect(reviewerCalls).toHaveLength(1);
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

describe("POST /api/review（§29/§46）", () => {
  it("valid request → review", async () => {
    withTmpDir();
    stubLLM();
    const res = await postReview(post("/api/review", { config, story: "陈岚走进雨夜。" }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual(review);
  });

  it("§30 带 run_id 时覆盖该 Run 的 review.json", async () => {
    const dir = withTmpDir();
    // 先跑一次完整 Run，让 runs/<run_id>/ 存在
    stubLLM();
    const runRes = await postRuns(post("/api/runs", { config }));
    const runId = String((await readJson(runRes)).run_id);

    // 再手动审阅同一个正文，分数不同
    stubLLM(JSON.stringify({ ...review, score: 88, summary: "重审后的总结。" }));
    const res = await postReview(post("/api/review", { config, story: "正文——陈岚走进雨夜。", run_id: runId }));
    expect(res.status).toBe(200);

    const saved = JSON.parse(readFileSync(join(dir, "runs", runId, "review.json"), "utf8")) as ReviewResult;
    expect(saved.score).toBe(88);
    // §30：只覆盖，不建立 review_v1 / review_history
    expect(readdirSync(join(dir, "runs", runId)).filter((f) => f.startsWith("review"))).toEqual(["review.json"]);
  });

  it("§29 story 缺失 → 400", async () => {
    withTmpDir();
    stubLLM();
    const res = await postReview(post("/api/review", { config }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("story is required");
  });

  it("config 非法 → 400", async () => {
    withTmpDir();
    stubLLM();
    const res = await postReview(post("/api/review", {
      config: { title: "", genre: "悬疑", premise: "x", target_words: 5000 },
      story: "正文",
    }));
    expect(res.status).toBe(400);
  });

  it("§46 invalid reviewer JSON → 明确错误（502）", async () => {
    withTmpDir();
    stubLLM("这不是 JSON");
    const res = await postReview(post("/api/review", { config, story: "正文" }));
    expect(res.status).toBe(502);
    expect((await readJson(res)).error).toContain("Reviewer 输出不是合法 JSON");
  });

  it("请求体不是合法 JSON → 400", async () => {
    withTmpDir();
    const res = await postReview(post("/api/review", "{oops"));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("JSON");
  });

  it("run_id 越界（..）被拒绝，不会写到 runs 之外", async () => {
    withTmpDir();
    stubLLM();
    const res = await postReview(post("/api/review", { config, story: "正文", run_id: "../../evil" }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("run_id 非法");
    expect(existsSync(join(tmp as string, "evil"))).toBe(false);
    expect(existsSync(join(tmp as string, "..", "evil"))).toBe(false);
  });

  it("run_id 不存在 → 400（不静默丢弃）", async () => {
    withTmpDir();
    stubLLM();
    const res = await postReview(post("/api/review", { config, story: "正文", run_id: "20260101_000000_zzzzzz" }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("run_id 不存在");
  });
});
