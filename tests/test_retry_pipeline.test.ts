import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { RetryPolicy } from "@/core/retry-policy";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §19/§20/§45~§49/§53 重试 Pipeline：Evaluation → Decision → Automatic Retry。
 * 这里的所有用例都不注入 Repairer，用来锁死「没有 Repair 时的重试行为」
 * ——与 v0.7.0 逐字一致；Repair 相关流程见 tests/test_repair_pipeline.test.ts。
 * 只用 Fake 组件 + Fixture，绝不打真实付费 API。
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
const STORY_2 = `第二次尝试：陈岚拐进巷口，${"霓虹在水洼里碎成两半。".repeat(80)}`;

const passed: ValidationResult = { passed: true, issues: [] };
const failed: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度 12 明显短于目标字数（下限 750）。" }],
};

function review(score: number): ReviewResult {
  return { score, summary: "总结。", strengths: ["强"], problems: ["弱"] };
}

function policy(patch: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...patch };
}

/** 每次 generate 返回下一段正文：第 n 次 Attempt 拿到 stories[n-1]。 */
function storyScript(stories: string[]) {
  let i = 0;
  return { generate: async () => stories[Math.min(i++, stories.length - 1)] };
}

interface Recorder { plan: number; generate: number; validate: number; review: number }

function record(): Recorder {
  const r: Recorder = { plan: 0, generate: 0, validate: 0, review: 0 };
  return r;
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-retry-"));
  process.chdir(tmp);
  return tmp;
}

function readMeta(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8"));
}

function attemptDir(dir: string, runId: string, n: number): string {
  return join(dir, "runs", runId, "attempts", String(n).padStart(2, "0"));
}

describe("§46 Pipeline Test — First Attempt Accepted", () => {
  it("Attempt 1 校验通过、Review 80：只跑一次，quality_status=accepted", async () => {
    const dir = withTmpDir();
    const calls = record();
    const gen = storyScript([STORY]);
    const pipeline = new GenerationPipeline(
      { plan: async () => { calls.plan++; return plan; } } as never,
      { generate: async () => { calls.generate++; return gen.generate(); } } as never,
      { validate: async () => { calls.validate++; return passed; } } as never,
      { review: async () => { calls.review++; return review(80); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    expect(calls).toEqual({ plan: 1, generate: 1, validate: 1, review: 1 });
    expect(result.attempt_count).toBe(1);
    expect(result.selected_attempt).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toEqual({
      attempt_number: 1,
      story: STORY,
      validation: passed,
      review: review(80),
      accepted: true,
      retry_reason: null,
      error: null,
      // §17：这个 Pipeline 没有注入 Repairer，Attempt 与 v0.7.0 逐字一致
      repairs: [],
    });
    // §23：attempt 1 已 promote，根目录产物与 selected attempt 一致
    expect(readFileSync(join(dir, "runs", result.run_id, "story.md"), "utf8")).toBe(
      `# ${config.title}\n\n${STORY}\n`,
    );
    expect(readMeta(dir, result.run_id).quality_status).toBe("accepted");
  });
});

describe("§47 Pipeline Test — Validation Retry", () => {
  it("Attempt 1 校验失败、Attempt 2 通过（75）：自动重试后 accepted", async () => {
    const dir = withTmpDir();
    const calls = record();
    const gen = storyScript([STORY, STORY_2]);
    const validateResults = [failed, passed];
    let vi = 0;
    const pipeline = new GenerationPipeline(
      { plan: async () => { calls.plan++; return plan; } } as never,
      { generate: async () => { calls.generate++; return gen.generate(); } } as never,
      { validate: async () => { calls.validate++; return validateResults[Math.min(vi++, 1)]; } } as never,
      { review: async () => { calls.review++; return review(75); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    expect(calls).toEqual({ plan: 1, generate: 2, validate: 2, review: 2 });
    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts.map((a) => a.retry_reason)).toEqual(["validation_failed", null]);
    expect(result.attempts.map((a) => a.accepted)).toEqual([false, true]);
    // §23：每个 attempt 目录五件产物都在
    for (const n of [1, 2]) {
      const d = attemptDir(dir, result.run_id, n);
      expect(readdirSync(d).sort()).toEqual([
        "metadata.json", "quality.json", "review.json", "story.md", "validation.json",
      ]);
    }
    // §17：select 的是 attempt 2 的正文
    expect(readFileSync(join(dir, "runs", result.run_id, "story.md"), "utf8")).toBe(
      `# ${config.title}\n\n${STORY_2}\n`,
    );
    // §23：两次 attempt 的正文分别归档，不互相覆盖
    expect(readFileSync(join(attemptDir(dir, result.run_id, 1), "story.md"), "utf8")).toBe(
      `# ${config.title}\n\n${STORY}\n`,
    );
    expect(readFileSync(join(attemptDir(dir, result.run_id, 2), "story.md"), "utf8")).toBe(
      `# ${config.title}\n\n${STORY_2}\n`,
    );
  });

  it("retry_on_validation_failure=false：校验失败也不重试", async () => {
    withTmpDir();
    const gen = storyScript([STORY]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => failed } as never,
      { review: async () => review(80) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy({ retry_on_validation_failure: false }));
    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts[0].retry_reason).toBeNull();
  });
});

describe("§48 Pipeline Test — Review Score Retry", () => {
  it("Attempt 1 校验通过 / 60 分、Attempt 2 / 76 分：自动重试", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY, STORY_2]);
    const scores = [60, 76];
    let si = 0;
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => passed } as never,
      { review: async () => review(scores[Math.min(si++, 1)]) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts.map((a) => a.retry_reason)).toEqual([
      "review_score_below_threshold",
      null,
    ]);
    expect(result.attempts.map((a) => a.review?.score)).toEqual([60, 76]);
    expect(readFileSync(join(dir, "runs", result.run_id, "review.json"), "utf8")).toContain("76");
  });

  it("§53A min_review_score=70、Attempt 1 得 65：必须自动执行 Attempt 2", async () => {
    withTmpDir();
    const gen = storyScript([STORY]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => passed } as never,
      { review: async () => review(65) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    expect(result.attempt_count).toBe(2);
    expect(result.attempts.every((a) => a.retry_reason === "review_score_below_threshold")).toBe(true);
    expect(result.quality_status).toBe("exhausted");
  });
});

describe("§49 Pipeline Test — Exhausted", () => {
  it("每个 Attempt 都不合格：跑到 max_attempts 才停，quality_status=exhausted", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY, "第二次的正文还是太短", "第三次也一样不合格"]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => failed } as never,
      { review: async () => review(40) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy({ max_attempts: 3 }));
    expect(result.status).toBe("completed");
    // §15：硬上限来自策略，不是「不满意就继续」
    expect(result.attempt_count).toBe(3);
    expect(result.selected_attempt).toBe(3);
    expect(result.quality_status).toBe("exhausted");
    // §17：exhausted 时选最后一次 attempt；§42 CLI 也据此输出
    expect(result.story).toBe("第三次也一样不合格");
    expect(result.attempts[2].accepted).toBe(false);
    expect(result.attempts[2].retry_reason).toBe("validation_failed");
    // §15：目录里只有策略允许的这几次 attempt
    expect(readdirSync(join(dir, "runs", result.run_id, "attempts")).sort()).toEqual(["01", "02", "03"]);
  });

  it("§53D 两个 Attempt 都失败时不得出现 Attempt 3", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => passed } as never,
      { review: async () => review(0) } as never,
      new ArtifactStore(),
    );

    await pipeline.run(config, undefined, policy({ max_attempts: 2, min_review_score: 90 }));
    runDirGuard(dir);
  });

  it("§53E max_attempts=1：即使校验失败也不生成第二次", async () => {
    withTmpDir();
    const gen = storyScript([STORY, STORY_2]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => failed } as never,
      { review: async () => review(80) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy({ max_attempts: 1 }));
    expect(result.attempt_count).toBe(1);
    expect(result.selected_attempt).toBe(1);
    expect(result.quality_status).toBe("exhausted");
    expect(result.attempts[0].retry_reason).toBe("validation_failed");
  });
});

/** §53D 守卫：attempt 目录只应该有 max_attempts 指定的那么多。 */
function runDirGuard(dir: string) {
  const runsRoot = join(dir, "runs");
  const runId = readdirSync(runsRoot)[0];
  expect(readdirSync(join(runsRoot, runId, "attempts")).sort()).toEqual(["01", "02"]);
}describe("§8/§9/§70 重试复用 Config 与 BeatPlan", () => {
  it("Plan 只调用一次，BeatPlan 与 StoryConfig 原样传给每一次 generate", async () => {
    withTmpDir();
    const gen = storyScript([STORY, STORY_2]);
    const plans: BeatPlan[] = [];
    const genConfigs: StoryConfig[] = [];
    const genPlans: BeatPlan[] = [];
    let v = 0;
    const validateResults = [failed, passed];
    const pipeline = new GenerationPipeline(
      { plan: async () => { plans.push(plan); return plan; } } as never,
      {
        generate: async (c: StoryConfig, p: BeatPlan) => {
          genConfigs.push(c);
          genPlans.push(p);
          return gen.generate();
        },
      } as never,
      { validate: async () => validateResults[Math.min(v++, 1)] } as never,
      { review: async () => review(80) } as never,
      new ArtifactStore(),
    );

    await pipeline.run(config, undefined, policy());
    expect(plans).toHaveLength(1);
    expect(genConfigs).toHaveLength(2);
    expect(genConfigs.every((c) => c.title === config.title && c.premise === config.premise)).toBe(true);
    // §70：不自动换 Model / Temperature / Prompt——plan 就是同一个对象
    expect(genPlans).toHaveLength(2);
    expect(genPlans[0]).toBe(plan);
    expect(genPlans[1]).toBe(plan);
  });

  it("Temperature 缺省在每一个 Attempt 都是 0.8，不随重试变化", async () => {
    withTmpDir();
    const gen = storyScript([STORY]);
    const temps: number[] = [];
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async (_c: StoryConfig, _p: BeatPlan, t = 0.8) => { temps.push(t); return gen.generate(); } } as never,
      { validate: async () => passed } as never,
      { review: async () => review(10) } as never,
      new ArtifactStore(),
    );

    await pipeline.run(config, undefined, policy());
    expect(temps).toEqual([0.8, 0.8]);
  });
});

describe("§12 组件异常不触发重试", () => {
  it("Reviewer 自己抛异常：只跑一次 Attempt，Run 仍 completed", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY]);
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => passed } as never,
      { review: async () => { throw new Error("Reviewer 输出不是合法 JSON"); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.review_status).toBe("failed");
    expect(result.review).toBeNull();
    expect(String(result.review_error)).toContain("Reviewer 输出不是合法 JSON");
    // §49：正文没有因为 Review 失败被丢掉
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);
  });

  it("Validator 自己抛异常：不算 Story Failed，仍继续 Review，只跑一次", async () => {
    withTmpDir();
    const gen = storyScript([STORY]);
    let reviews = 0;
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => { throw new Error("Validator 内部规则崩溃"); } } as never,
      { review: async () => { reviews++; return review(80); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    expect(reviews).toBe(1);
    expect(result.attempt_count).toBe(1);
    expect(result.validation_status).toBe("failed");
    expect(result.validation).toBeNull();
    expect(result.quality_status).toBe("accepted");
  });
});

describe("§29 Network Retry 不算 GenerationAttempt", () => {
  it("网络层重试在组件内部消化：Pipeline 只看到一次成功的尝试", async () => {
    withTmpDir();
    const networkCalls: string[] = [];
    // 网络重试的语义：LLMClient / transport 自己重试超时、429、5xx，
    // 对业务的表现就是「generate 返回了正文」，不抛给 Pipeline。
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      {
        generate: async () => {
          networkCalls.push("network");
          networkCalls.push("network");
          return STORY;
        },
      } as never,
      { validate: async () => passed } as never,
      { review: async () => review(80) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy({ max_attempts: 2 }));
    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts).toHaveLength(1);
  });

  it("生成阶段抛错才算 generation_error，按策略重试到上限后 Run 失败", async () => {
    withTmpDir();
    let n = 0;
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => { n++; throw new Error("LLM API 返回 500"); } } as never,
      { validate: async () => passed } as never,
      { review: async () => review(80) } as never,
      new ArtifactStore(),
    );

    await expect(pipeline.run(config, undefined, policy({ max_attempts: 2 }))).rejects.toThrow(/failed at generating/);
    expect(n).toBe(2);
  });
});

describe("§25 metadata 记录策略与 Attempt 结论", () => {
  it("策略字段与 attempt 结论都写进 metadata.json", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY, STORY_2]);
    let v = 0;
    const validateResults = [failed, passed];
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => validateResults[Math.min(v++, 1)] } as never,
      { review: async () => review(72) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy({ max_attempts: 3, min_review_score: 65 }));
    const meta = readMeta(dir, result.run_id);
    expect(meta.max_attempts).toBe(3);
    expect(meta.min_review_score).toBe(65);
    expect(meta.attempt_count).toBe(2);
    expect(meta.selected_attempt).toBe(2);
    expect(meta.quality_status).toBe("accepted");
    // §26：metadata 不提前塞任何高级分析字段
    expect(Object.keys(meta)).not.toContain("retry_efficiency");
    expect(Object.keys(meta)).not.toContain("average_attempt_score");
    expect(Object.keys(meta)).not.toContain("quality_curve");
  });

  it("§24 每个 attempt 的 metadata 记录 accepted / retry_reason / 分数 / 校验结论", async () => {
    const dir = withTmpDir();
    const gen = storyScript([STORY, STORY_2]);
    let v = 0;
    const validateResults = [failed, passed];
    const pipeline = new GenerationPipeline(
      { plan: async () => plan } as never,
      { generate: async () => gen.generate() } as never,
      { validate: async () => validateResults[Math.min(v++, 1)] } as never,
      { review: async () => review(72) } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config, undefined, policy());
    const one = JSON.parse(readFileSync(join(attemptDir(dir, result.run_id, 1), "metadata.json"), "utf8"));
    const two = JSON.parse(readFileSync(join(attemptDir(dir, result.run_id, 2), "metadata.json"), "utf8"));
    expect(one).toMatchObject({ attempt_number: 1, accepted: false, retry_reason: "validation_failed" });
    expect(two).toMatchObject({ attempt_number: 2, accepted: true, retry_reason: null, review_score: 72 });
    expect(two.validation_passed).toBe(true);
  });
});
