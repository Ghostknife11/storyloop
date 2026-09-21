import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRuns } from "@/app/api/runs/route";
import { POST as postRunsFromPlan } from "@/app/api/runs/from-plan/route";
import { GET as getRun } from "@/app/api/runs/[run_id]/route";
import { GET as getRunAttempt } from "@/app/api/runs/[run_id]/attempts/[attempt_number]/route";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §37~§39/§51 Retry API：请求体带 retry_policy、响应带 Attempt 摘要、
 * 支持读回单个 Run 与单个 Attempt；不提供 GET /api/runs 全局历史（§40）。
 * 全部用 Mock / Fixture，绝不打真实付费 API。
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

/** target_words=5000 长度下限 750：超出下限、含主角名、以句号结尾，可通过全部硬规则。 */
const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

const passed: ValidationResult = { passed: true, issues: [] };

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
};

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-retry-api-"));
  process.chdir(tmp);
  return tmp;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 复用一个可编排的假 Generator：按列表依次返回正文，越界复用最后一段。 */
function scriptedGenerator(stories: string[]) {
  let i = 0;
  return { generate: async () => stories[Math.min(i++, stories.length - 1)] };
}

/** 复用一个可编排的假 Validator / Reviewer。 */
function scriptedValidator(results: ValidationResult[]) {
  let i = 0;
  return { validate: async () => results[Math.min(i++, results.length - 1)] };
}

function scriptedReviewer(results: ReviewResult[]) {
  let i = 0;
  return { review: async () => results[Math.min(i++, results.length - 1)] };
}

/** 走服务层直接注入假组件：测试聚焦 HTTP 契约，不打真实 API。 */
async function runWith(
  body: unknown,
  stories: string[],
  validations: ValidationResult[],
  reviews: ReviewResult[],
) {
  const { startRun } = await import("@/lib/generate-service");
  return startRun(body, {
    planner: { plan: async () => plan } as never,
    generator: scriptedGenerator(stories) as never,
    validator: scriptedValidator(validations) as never,
    reviewer: scriptedReviewer(reviews) as never,
  } as never);
}

describe("POST /api/runs — retry policy（§37/§51）", () => {
  it("custom retry policy accepted：max_attempts=3 全部用尽才停", async () => {
    const dir = withTmpDir();
    const r = await runWith(
      { config, retry_policy: { max_attempts: 3, min_review_score: 70, retry_on_validation_failure: true } },
      [STORY, "第二次：还是不合格的正文", "第三次：仍然不合格"],
      [passed, passed, passed],
      [{ ...review, score: 40 }, { ...review, score: 50 }, { ...review, score: 60 }],
    );
    expect(r.status).toBe(200);
    const body = r.json as unknown as Record<string, unknown>;
    expect(body.attempt_count).toBe(3);
    expect(body.selected_attempt).toBe(3);
    expect(body.quality_status).toBe("exhausted");
    expect((body.attempts as Array<Record<string, unknown>>).map((a) => a.retry_reason)).toEqual([
      "review_score_below_threshold",
      "review_score_below_threshold",
      "review_score_below_threshold",
    ]);
    expect(existsSync(join(dir, "runs", String(body.run_id), "attempts", "03", "story.md"))).toBe(true);
  });

  it("invalid max_attempts rejected → 400，不落任何 Run", async () => {
    const dir = withTmpDir();
    for (const bad of [0, 6, 2.5, "2"]) {
      const r = await runWith({ config, retry_policy: { max_attempts: bad } }, [STORY], [passed], [review]);
      expect(r.status).toBe(400);
      expect(String((r.json as unknown as { error?: string }).error)).toContain("max_attempts");
    }
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("invalid score threshold rejected → 400", async () => {
    withTmpDir();
    for (const bad of [-1, 101, "70", NaN]) {
      const r = await runWith({ config, retry_policy: { min_review_score: bad } }, [STORY], [passed], [review]);
      expect(r.status).toBe(400);
      expect(String((r.json as unknown as { error?: string }).error)).toContain("min_review_score");
    }
  });

  it("§37 retry_policy 不属于 StoryConfig：config.json 里没有策略字段", async () => {
    const dir = withTmpDir();
    const r = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 80 } },
      [STORY],
      [passed],
      [{ ...review, score: 74 }],
    );
    const saved = JSON.parse(
      readFileSync(join(dir, "runs", String((r.json as unknown as { run_id: string }).run_id), "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved.max_attempts).toBeUndefined();
    expect(saved.min_review_score).toBeUndefined();
    // 策略记录在 metadata（§25），不在 StoryConfig 里
    const meta = JSON.parse(
      readFileSync(join(dir, "runs", String((r.json as unknown as { run_id: string }).run_id), "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.max_attempts).toBe(2);
    expect(meta.min_review_score).toBe(80);
  });

  it("response includes attempt_count / selected_attempt / quality_status / attempts[]（§38）", async () => {
    withTmpDir();
    const r = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 70 } },
      [STORY, `第二次：${STORY}`],
      [passed, passed],
      [{ ...review, score: 61 }, { ...review, score: 88 }],
    );
    const body = r.json as unknown as {
      attempt_count: number;
      selected_attempt: number;
      quality_status: string;
      attempts: Array<Record<string, unknown>>;
      story: string;
    };
    expect(body.attempt_count).toBe(2);
    expect(body.selected_attempt).toBe(2);
    expect(body.quality_status).toBe("accepted");
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]).toEqual({
      attempt_number: 1,
      accepted: false,
      retry_reason: "review_score_below_threshold",
      review_score: 61,
      validation_passed: true,
    });
    // §36：正文默认来自 selected attempt
    expect(body.story).toContain("第二次");
    // §38：摘要里不带完整正文
    expect(JSON.stringify(body.attempts)).not.toContain(STORY);
  });

  it("Manual Run 也接受 retry_policy", async () => {
    withTmpDir();
    const r = await runWith(
      { config, beat_plan: plan, retry_policy: { max_attempts: 1, min_review_score: 90 } },
      [STORY],
      [passed],
      [review],
    );
    const body = r.json as unknown as { attempt_count: number; quality_status: string };
    expect(body.attempt_count).toBe(1);
    expect(body.quality_status).toBe("exhausted");
  });
});

describe("GET /api/runs/{run_id}（§39）", () => {
  it("读回一次 Run 的 Attempt 摘要与 selected attempt", async () => {
    const dir = withTmpDir();
    const created = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 70 } },
      [STORY, `第二次：${STORY}`],
      [passed, passed],
      [{ ...review, score: 61 }, { ...review, score: 88 }],
    );
    const runId = String((created.json as { run_id: string }).run_id);
    expect(runId).toMatch(RUN_ID);

    const res = await getRun({} as never, { params: Promise.resolve({ run_id: runId }) } as never);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.run_id).toBe(runId);
    expect(body.status).toBe("completed");
    expect(body.quality_status).toBe("accepted");
    expect(body.attempt_count).toBe(2);
    expect(body.selected_attempt).toBe(2);
    expect(body.max_attempts).toBe(2);
    expect(body.min_review_score).toBe(70);
    expect(String(body.story)).toContain("第二次");
    expect((body.attempts as Array<Record<string, unknown>>).map((a) => a.accepted)).toEqual([false, true]);
    // §67：不返回本地绝对路径
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  it("run_id 不存在 → 404；非法 run_id → 400（路径穿越）", async () => {
    withTmpDir();
    const missing = await getRun({} as never, { params: Promise.resolve({ run_id: "20260101_000000_zzzzzz" }) } as never);
    expect(missing.status).toBe(404);
    for (const bad of ["..", ".", "a/b", "..\\.."]) {
      const res = await getRun({} as never, { params: Promise.resolve({ run_id: bad }) } as never);
      expect(res.status).toBe(400);
    }
    // 编码后的穿越不解析成目录，只会得到「不存在」
    const encoded = await getRun({} as never, { params: Promise.resolve({ run_id: "..%2f.." }) } as never);
    expect(encoded.status).toBe(404);
  });

  it("§40 没有 GET /api/runs 全局历史列表", async () => {
    withTmpDir();
    const route = await import("@/app/api/runs/route");
    // 该路由只导出 POST：GET 不存在即代表没有历史浏览器
    expect((route as Record<string, unknown>).GET).toBeUndefined();
  });
});

describe("GET /api/runs/{run_id}/attempts/{attempt_number}（§39）", () => {
  it("读回指定 Attempt 的正文与独立结论", async () => {
    const dir = withTmpDir();
    const created = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 70 } },
      [STORY, `第二次：${STORY}`],
      [passed, passed],
      [{ ...review, score: 61 }, { ...review, score: 88 }],
    );
    const runId = String((created.json as { run_id: string }).run_id);

    const res = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.attempt_number).toBe(1);
    expect(body.accepted).toBe(false);
    expect(body.retry_reason).toBe("review_score_below_threshold");
    expect(body.selected).toBe(false);
    // §35：这一次 Attempt 自己的 Review 分数，不是 select 那次
    expect((body.review as { score: number }).score).toBe(61);
    expect(String(body.story)).toContain("陈岚");

    const second = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "2" }),
    } as never);
    const secondBody = await readJson(second);
    expect(secondBody.selected).toBe(true);
    expect(secondBody.accepted).toBe(true);
    expect(secondBody.retry_reason).toBeNull();
    expect((secondBody.review as { score: number }).score).toBe(88);
  });

  it("attempt_number 不存在 → 404；非法编号 → 400", async () => {
    withTmpDir();
    const created = await runWith({ config }, [STORY], [passed], [{ ...review, score: 88 }]);
    const runId = String((created.json as { run_id: string }).run_id);
    const missing = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "7" }),
    } as never);
    expect(missing.status).toBe(404);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await getRunAttempt({} as never, {
        params: Promise.resolve({ run_id: runId, attempt_number: bad }),
      } as never);
      expect(res.status).toBe(400);
    }
  });
});

describe("§41/§42 CLI 上报用的响应字段", () => {
  it("重试链路：attempt 摘要能拼出 Attempt 1 → retry / Attempt 2 → accepted", async () => {
    withTmpDir();
    const r = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 70 } },
      [STORY, `第二次：${STORY}`],
      [passed, passed],
      [{ ...review, score: 64 }, { ...review, score: 75 }],
    );
    const body = r.json as unknown as { attempts: Array<Record<string, unknown>>; quality_status: string; selected_attempt: number };
    const lines = (body.attempts as Array<Record<string, unknown>>).map((a) =>
      a.retry_reason === null ? `Attempt ${a.attempt_number} → accepted` : `Attempt ${a.attempt_number} → retry`,
    );
    expect(lines).toEqual(["Attempt 1 → retry", "Attempt 2 → accepted"]);
    expect(body.quality_status).toBe("accepted");
    expect(body.selected_attempt).toBe(2);
  });

  it("耗尽链路：attempt 摘要能拼出 exhausted 与 Selected Attempt", async () => {
    withTmpDir();
    const r = await runWith(
      { config, retry_policy: { max_attempts: 2, min_review_score: 95 } },
      [STORY, `第二次：${STORY}`],
      [passed, passed],
      [review, review],
    );
    const body = r.json as unknown as { attempts: Array<Record<string, unknown>>; quality_status: string; selected_attempt: number };
    expect(body.quality_status).toBe("exhausted");
    expect(body.selected_attempt).toBe(2);
    expect((body.attempts as Array<Record<string, unknown>>).every((a) => a.accepted === false)).toBe(true);
  });
});

describe("HTTP 路由本身（§37）", () => {
  it("POST /api/runs 带 retry_policy 的请求体能被路由解析", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, retry_policy: { max_attempts: 9 } }),
    });
    const res = await postRuns(req);
    // 没有注入假组件 → 不会走到真实 LLM：策略在校验阶段就被拒
    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error)).toContain("max_attempts");
  });

  it("POST /api/runs/from-plan 的 beat_plan 缺失仍优先报 400", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/runs/from-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, retry_policy: { max_attempts: 2 } }),
    });
    const res = await postRunsFromPlan(req);
    expect(res.status).toBe(400);
    expect(String((await readJson(res)).error)).toContain("beat_plan");
  });

  it("fetch 注入只被使用一次也能跑通（无真实网络）", async () => {
    withTmpDir();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const req = new NextRequest("http://localhost/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    const res = await postRuns(req);
    // 客户端构造失败：没有 API Key，不会发起真实请求
    expect([400, 500, 502]).toContain(res.status);
    vi.unstubAllGlobals();
  });
});
