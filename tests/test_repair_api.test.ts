import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRepair } from "@/app/api/repair/route";
import { GET as getRun } from "@/app/api/runs/[run_id]/route";
import { GET as getRunAttempt } from "@/app/api/runs/[run_id]/attempts/[attempt_number]/route";
import { repairStory, startRun, type RunOk } from "@/lib/generate-service";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { RepairIssueType, RepairRequest, RepairResult } from "@/types/repair";
import { LLMError } from "@/lib/llm";
import { apiErrorOf } from "./helpers/fixtures";

/**
 * §38/§40/§68 Repair API：POST /api/repair 的手动修订契约 +
 * Run 响应 / Run 详情 / Attempt 详情里的修复摘要。
 * 全部用 Mock / Fixture，绝不打真实付费 API（§66）。
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

const STORY = "陈岚走进雨夜，雨水顺着屋檐砸在台阶上。";
const REPAIRED = "陈岚走进雨夜，雨水顺着屋檐砸在台阶上。修订后的结尾给了真相。";

const passed: ValidationResult = { passed: true, issues: [] };
const missingEnding: ValidationResult = {
  passed: false,
  issues: [{ code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" }],
};
const review: ReviewResult = {
  score: 61,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
};

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-repair-api-"));
  process.chdir(tmp);
  return tmp;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 可编排的假 Repairer：记录收到的 RepairRequest，按列表返回 RepairResult。 */
function scriptedRepairer(results: RepairResult[]) {
  const requests: RepairRequest[] = [];
  let i = 0;
  return {
    requests,
    repair: async (req: RepairRequest) => {
      requests.push(req);
      return results[Math.min(i++, results.length - 1)];
    },
  };
}

const goodRepair: RepairResult = {
  repaired_story: REPAIRED,
  issue_type: "ending",
  success: true,
  notes: null,
};

const failedRepair: RepairResult = {
  repaired_story: "",
  issue_type: "ending",
  success: false,
  notes: "修订失败：模型没有返回可用正文",
};

/**
 * 走服务层注入假组件跑一次真实 Run：planning / generation / validation / review
 * 全部 Fixture 化，只有 Repairer 是真被测对象。
 */
async function runWith(
  retryPolicy: unknown,
  stories: string[],
  validations: ValidationResult[],
  reviews: ReviewResult[],
  repairer: ReturnType<typeof scriptedRepairer>,
) {
    let g = 0;
    let v = 0;
    let r = 0;
    return startRun(
      { config, retry_policy: retryPolicy },
      {
        planner: { plan: async () => plan } as never,
        generator: { generate: async () => stories[Math.min(g++, stories.length - 1)] } as never,
        validator: { validate: async () => validations[Math.min(v++, validations.length - 1)] } as never,
        reviewer: { review: async () => reviews[Math.min(r++, reviews.length - 1)] } as never,
        repairer: repairer as never,
      } as never,
    );
}

describe("POST /api/repair —— 手动定点修订（§38）", () => {
  it("成功修订：返回完整修订后正文，不是 diff / patch", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const req = new NextRequest("http://localhost/api/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: "故事缺少明确结局。" }),
    });
    // 路由自己造真 Repairer 会去打真实 LLM（§66），所以这里只验证请求体形状：
    // 完整契约用服务层 + 假 Repairer 覆盖。
    expect(typeof req.json).toBe("function");
    const result = await repairStory(
      { config, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: "故事缺少明确结局。" },
      { repairer: rep as never } as never,
    );
    expect(result.status).toBe(200);
    const body = result.json as RepairResult;
    expect(body.repaired_story).toBe(REPAIRED);
    expect(body.issue_type).toBe("ending");
    expect(body.success).toBe(true);
    // §11：返回的是完整正文，没有 diff / patch 字段
    expect(body).not.toHaveProperty("diff");
    expect(body).not.toHaveProperty("patch");
    // §9：只修订正文——ServiceConfig / BeatPlan 原样透传，不被改写
    expect(rep.requests).toHaveLength(1);
    expect(rep.requests[0].story).toBe(STORY);
    expect(rep.requests[0].config).toEqual(config);
    expect(rep.requests[0].beat_plan).toEqual(plan);
    expect(rep.requests[0].issue_type).toBe("ending");
    expect(rep.requests[0].issue_message).toBe("故事缺少明确结局。");
  });

  it("§38 六种 issue_type 都接受（§6 白名单）", async () => {
    withTmpDir();
    const types: RepairIssueType[] = ["length", "ending", "character_presence", "continuity", "structure", "general"];
    for (const issueType of types) {
      const rep = scriptedRepairer([{ ...goodRepair, issue_type: issueType }]);
      const result = await repairStory(
        { config, beat_plan: plan, story: STORY, issue_type: issueType, issue_message: "需要修订。" },
        { repairer: rep as never } as never,
      );
      expect(result.status).toBe(200);
      expect((result.json as RepairResult).issue_type).toBe(issueType);
    }
  });

  it("未知 issue_type → 400，不调用 Repairer", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const result = await repairStory(
      { config, beat_plan: plan, story: STORY, issue_type: "vibe", issue_message: "感觉不对。" },
      { repairer: rep as never } as never,
    );
    expect(result.status).toBe(400);
    expect(apiErrorOf(result.json).message).toContain("issue_type");
    expect(rep.requests).toHaveLength(0);
  });

  it("story 缺失 / 空串 → 400，不调用 Repairer", async () => {
    withTmpDir();
    for (const story of [undefined, "", "   "]) {
      const rep = scriptedRepairer([goodRepair]);
      const result = await repairStory(
        { config, beat_plan: plan, story, issue_type: "ending", issue_message: "故事缺少明确结局。" },
        { repairer: rep as never } as never,
      );
      expect(result.status).toBe(400);
      expect(apiErrorOf(result.json).message).toContain("story");
      expect(rep.requests).toHaveLength(0);
    }
  });

  it("issue_message 缺失 / 空串 → 400（没有明确问题说明就不修）", async () => {
    withTmpDir();
    for (const issueMessage of [undefined, "", "   "]) {
      const rep = scriptedRepairer([goodRepair]);
      const result = await repairStory(
        { config, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: issueMessage },
        { repairer: rep as never } as never,
      );
      expect(result.status).toBe(400);
      expect(apiErrorOf(result.json).message).toContain("issue_message");
      expect(rep.requests).toHaveLength(0);
    }
  });

  it("config 非法 → 400；beat_plan 缺失 → 400", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const badConfig = await repairStory(
      { config: { title: "x" }, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: "缺结局。" },
      { repairer: rep as never } as never,
    );
    expect(badConfig.status).toBe(400);
    const noPlan = await repairStory(
      { config, story: STORY, issue_type: "ending", issue_message: "缺结局。" },
      { repairer: rep as never } as never,
    );
    expect(noPlan.status).toBe(400);
    expect(rep.requests).toHaveLength(0);
  });

  it("§15 Repairer 抛 LLMError → 502，错误信息可读", async () => {
    withTmpDir();
    const result = await repairStory(
      { config, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: "缺结局。" },
      { repairer: { repair: async () => { throw new LLMError("上游模型超时"); } } as never } as never,
    );
    expect(result.status).toBe(502);
    expect(apiErrorOf(result.json).message).toContain("上游模型超时");
  });

  it("§15 修不好也如实返回：repaired_story 为空 + success=false，没有假装成功", async () => {
    withTmpDir();
    const rep = scriptedRepairer([failedRepair]);
    const result = await repairStory(
      { config, beat_plan: plan, story: STORY, issue_type: "ending", issue_message: "缺结局。" },
      { repairer: rep as never } as never,
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual(failedRepair);
    expect((result.json as RepairResult).repaired_story).toBe("");
    expect((result.json as RepairResult).success).toBe(false);
  });

  it("§38 请求体不是合法 JSON → 400", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await postRepair(req);
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("JSON");
  });

  it("§38 路由转发的缺字段请求 → 400，不会走到真实 LLM", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, beat_plan: plan, story: STORY, issue_type: "nope", issue_message: "缺结局。" }),
    });
    const res = await postRepair(req);
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("issue_type");
  });
});

describe("§40 Run 响应与详情里的修复摘要", () => {
  it("POST 响应带 repair_count 与 attempts[].repairs（§40 摘要口径）", async () => {
    withTmpDir();
    const rep = scriptedRepairer([failedRepair]);
    const r = await runWith(
      { max_attempts: 2, min_review_score: 70, enable_repair: true, max_repairs_per_attempt: 1 },
      [STORY, `第二次：${STORY}`],
      [missingEnding, missingEnding],
      [review, review],
      rep,
    );
    expect(r.status).toBe(200);
    const body = r.json as unknown as {
      quality_status: string;
      repair_count: number;
      attempts: Array<Record<string, unknown>>;
    };
    // §20：每一次 Attempt 都是「先试一次 Repair，修不好再整篇重生」
    expect(body.quality_status).toBe("exhausted");
    expect(body.repair_count).toBe(2);
    expect(body.attempts[0].repairs).toEqual([{ repair_number: 1, issue_type: "ending", success: false }]);
    expect(body.attempts[1].repairs).toEqual([{ repair_number: 1, issue_type: "ending", success: false }]);
    expect(body.attempts.map((a) => a.repair_count)).toEqual([1, 1]);
    // §40：摘要不带修订正文全文
    expect(JSON.stringify(body.attempts)).not.toContain(REPAIRED);
  });

  it("§40 没有修订时 repair_count=0，attempts 里的修订记录为空", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const r = await runWith(
      { max_attempts: 2, min_review_score: 70, enable_repair: false },
      [STORY, `第二次：${STORY}`],
      [missingEnding, missingEnding, passed],
      [review, review, { ...review, score: 80 }],
      rep,
    );
    const body = r.json as unknown as { repair_count: number; attempts: Array<Record<string, unknown>> };
    expect(body.repair_count).toBe(0);
    expect(body.attempts.every((a) => a.repair_count === 0)).toBe(true);
    expect(body.attempts.every((a) => (a.repairs as unknown[])?.length === 0)).toBe(true);
    // §22：关闭修订时一次都不调 Repairer，直接走 Full Retry
    expect(rep.requests).toHaveLength(0);
  });

  it("GET Run 详情回显修复策略与修复次数；没有修订时为 0", async () => {
    const dir = withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const created = await runWith(
      { max_attempts: 2, min_review_score: 70, enable_repair: true, max_repairs_per_attempt: 1 },
      [STORY],
      [missingEnding, passed],
      [review, { ...review, score: 82 }],
      rep,
    );
    const runId = String((created.json as RunOk).run_id);
    const res = await getRun({} as never, { params: Promise.resolve({ run_id: runId }) } as never);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.enable_repair).toBe(true);
    expect(body.max_repairs_per_attempt).toBe(1);
    // 修订后直接通过：一次修订，selected attempt = 1
    expect(body.repair_count).toBe(1);
    expect(body.selected_attempt).toBe(1);
    // §67：不返回本地绝对路径
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  it("§35/§36 Attempt 详情：initial_story = 修订前正文，repairs 带前后对比", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const created = await runWith(
      { max_attempts: 1, min_review_score: 70, enable_repair: true, max_repairs_per_attempt: 1 },
      [STORY],
      [missingEnding, passed],
      [review, { ...review, score: 82 }],
      rep,
    );
    const runId = String((created.json as RunOk).run_id);

    const res = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const repairs = body.repairs as Array<Record<string, unknown>>;
    // §30：story 是这个 Attempt 的最终版本（修订后），initial_story 是修订前
    expect(String(body.story)).toContain("修订后的结尾");
    expect(String(body.initial_story)).toContain("陈岚走进雨夜");
    expect(String(body.initial_story)).not.toContain("修订后的结尾");
    expect(body.repair_count).toBe(1);
    expect(repairs).toEqual([
      {
        repair_number: 1,
        issue_type: "ending",
        issue_message: "故事缺少明确结局。",
        success: true,
        before_review_score: 61,
        after_review_score: 82,
        before_validation_passed: false,
        after_validation_passed: true,
      },
    ]);
    // §36：不带修订正文全文，也不带 §5 禁止的归因字段
    expect(repairs[0]).not.toHaveProperty("repaired_story");
    for (const forbidden of ["root_cause", "causal_diagnosis", "strategy_score", "policy_id", "confidence"]) {
      expect(repairs[0]).not.toHaveProperty(forbidden);
    }
  });

  it("没有修订的 Attempt：initial_story 为 null、repairs 为空数组", async () => {
    withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const created = await runWith(
      { max_attempts: 1, min_review_score: 60 },
      [STORY],
      [passed],
      [{ ...review, score: 80 }],
      rep,
    );
    const runId = String((created.json as RunOk).run_id);
    const res = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    const body = await readJson(res);
    expect(body.initial_story).toBeNull();
    expect(body.repair_count).toBe(0);
    expect(body.repairs).toEqual([]);
    expect(rep.requests).toHaveLength(0);
  });

  it("§40 磁盘上的 Run 目录带 repairs 子目录，读回口径与 POST 一致", async () => {
    const dir = withTmpDir();
    const rep = scriptedRepairer([goodRepair]);
    const created = await runWith(
      { max_attempts: 1, min_review_score: 70, enable_repair: true, max_repairs_per_attempt: 2 },
      [STORY],
      [missingEnding, missingEnding, passed],
      [review, review, { ...review, score: 88 }],
      rep,
    );
    const runId = String((created.json as RunOk).run_id);
    const attemptDir = join(dir, "runs", runId, "attempts", "01");
    // §29：修了两次 → repairs/01 与 repairs/02，attempt 目录本身还是 01
    expect(existsSync(join(attemptDir, "repairs", "01", "story.md"))).toBe(true);
    expect(existsSync(join(attemptDir, "repairs", "01", "request.json"))).toBe(true);
    expect(existsSync(join(attemptDir, "repairs", "02", "story.md"))).toBe(true);
    expect(existsSync(join(attemptDir, "initial_story.md"))).toBe(true);
    expect((created.json as unknown as { repair_count: number }).repair_count).toBe(2);

    const res = await getRunAttempt({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    const body = await readJson(res);
    expect((body.repairs as Array<Record<string, unknown>>).map((r2) => r2.repair_number)).toEqual([1, 2]);
  });
});
