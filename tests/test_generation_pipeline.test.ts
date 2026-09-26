import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { StoryValidator } from "@/lib/story-validator";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import { repoVersion } from "./helpers/fixtures";

/**
 * §3/§5~§7/§16~§30/§38~§40/§43~§45/§59~§62 GenerationPipeline。
 * v0.5.0：Save Story → Review → Save Review（§18）。
 * v0.6.0：Save Story → Validate → Save Validation → Review → Save Review（§17）。
 * 只用 Mock / Fake / Fixture，绝不打真实付费 API。
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

/** target_words=5000 时长度下限为 750：这里远超下限，含主角名、以句号结尾，可通过全部硬规则。 */
const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

const passed: ValidationResult = { passed: true, issues: [] };
const failed: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度 12 明显短于目标字数（下限 750）。" }],
};

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

interface PlanCall { config: StoryConfig; temperature: number }
interface GenCall { config: StoryConfig; plan: BeatPlan; temperature: number }
interface ReviewCall { config: StoryConfig; story: string; temperature: number }
interface ValidateCall { config: StoryConfig; story: string }

function fakePlanner(out: BeatPlan, calls: PlanCall[] = []) {
  return {
    plan: async (c: StoryConfig, temperature = 0.7) => {
      calls.push({ config: c, temperature });
      return out;
    },
  };
}

function fakeGenerator(story: string, calls: GenCall[] = []) {
  return {
    generate: async (c: StoryConfig, p: BeatPlan, temperature = 0.8) => {
      calls.push({ config: c, plan: p, temperature });
      return story;
    },
  };
}

function fakeValidator(out: ValidationResult, calls: ValidateCall[] = []) {
  return {
    validate: async (c: StoryConfig, story: string) => {
      calls.push({ config: c, story });
      return out;
    },
  };
}

function fakeReviewer(out: ReviewResult, calls: ReviewCall[] = []) {
  return {
    review: async (c: StoryConfig, story: string, temperature = 0.3) => {
      calls.push({ config: c, story, temperature });
      return out;
    },
  };
}

/** 落盘阶段注入失败：模拟磁盘错误，且不让内部路径泄漏给用户。 */
class FailingStore extends ArtifactStore {
  override putAttemptStory(runId: string, attemptNumber: number, title: string, story: string): string {
    throw new Error(`EACCES: permission denied, open '${join("D:", "secret", "runs", runId, "attempts", `0${attemptNumber}`, "story.md")}'`);
  }
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-pipeline-"));
  process.chdir(tmp);
  return tmp;
}

function readMeta(dir: string, runId: string) {
  return JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8"));
}

describe("GenerationPipeline — successful full run（§43/§45/§59）", () => {
  it("Planner → Generator → Save Story → Validator → Save Validation → Reviewer → Save Review → Complete", async () => {
    const dir = withTmpDir();
    const order: string[] = [];
    const pipeline = new GenerationPipeline(
      { plan: async () => { order.push("plan"); return plan; } } as never,
      { generate: async () => { order.push("generate"); return STORY; } } as never,
      { validate: async () => { order.push("validate"); return passed; } } as never,
      { review: async () => { order.push("review"); return review; } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    expect(order).toEqual(["plan", "generate", "validate", "review"]);
    expect(result.run_id).toMatch(RUN_ID);
    expect(result.status).toBe("completed");
    expect(result.story).toBe(STORY);
    expect(result.beat_plan).toEqual(plan);
    expect(result.config).toEqual(config);
    expect(result.validation).toEqual(passed);
    expect(result.validation_status).toBe("completed");
    expect(result.validation_error).toBeNull();
    expect(result.review).toEqual(review);
    expect(result.review_status).toBe("completed");
    expect(result.review_error).toBeNull();
    expect(result.artifacts).toEqual({
      config: "config.json", beat_plan: "beats.json", story: "story.md",
      validation: "validation.json", metadata: "metadata.json", review: "review.json",
      quality: "quality.json",
    });

    const runDir = join(dir, "runs", result.run_id);
    expect(readdirSync(runDir).sort()).toEqual([
      "attempts", "beats.json", "config.json", "failure-analysis.json", "metadata.json", "quality.json",
      "review.json", "run-manifest.json", "story.md", "telemetry.json", "validation.json",
    ]);
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");
    expect(JSON.parse(readFileSync(join(runDir, "review.json"), "utf8"))).toEqual(review);
    expect(JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8"))).toEqual(passed);

    const meta = readMeta(dir, result.run_id);
    expect(meta.run_id).toBe(result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.current_stage).toBe("completed");
    expect(meta.project_version).toBe(repoVersion());
    expect(meta.finished_at).toBeTruthy();
    // §17/§24：metadata 单独记录校验与审阅状态
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(true);
    expect(meta.validation_issue_count).toBe(0);
    expect(meta.validation_error).toBeUndefined();
    expect(meta.review_status).toBe("completed");
    expect(meta.review_score).toBe(74);
    expect(meta.review_error).toBeUndefined();
    // §25：metadata 记录当时生效的策略与 Attempt 结论
    expect(meta.max_attempts).toBe(2);
    expect(meta.min_review_score).toBe(70);
    expect(meta.attempt_count).toBe(1);
    expect(meta.selected_attempt).toBe(1);
    expect(meta.quality_status).toBe("accepted");
    // §18：Repair 开关与上限同样落 metadata；这一跑没有修订，count 为 0
    expect(meta.enable_repair).toBe(true);
    expect(meta.max_repairs_per_attempt).toBe(1);
    expect(meta.repair_count).toBe(0);
  });

  it("§45 review.json / validation.json 内容与 GenerationResult 一致", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      fakeValidator(passed) as never,
      fakeReviewer(review) as never,
      new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    const runDir = join(dir, "runs", result.run_id);
    const savedReview = JSON.parse(readFileSync(join(runDir, "review.json"), "utf8"));
    const savedValidation = JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8"));
    expect(savedReview).toEqual(result.review);
    expect(savedReview.score).toBe(result.review?.score);
    expect(savedValidation).toEqual(result.validation);
    expect(savedValidation.passed).toBe(result.validation?.passed);
  });

  it("§17 Story 在 Validate 之前落盘，Validate 又在 Review 之前", async () => {
    withTmpDir();
    const events: string[] = [];
    const store = new ArtifactStore();
    const originalPutStory = store.putAttemptStory.bind(store);
    store.putAttemptStory = (runId: string, n: number, title: string, story: string) => {
      events.push("save-story");
      return originalPutStory(runId, n, title, story);
    };
    const originalPutValidation = store.putAttemptValidation.bind(store);
    store.putAttemptValidation = (runId: string, n: number, v: ValidationResult) => {
      events.push("save-validation");
      return originalPutValidation(runId, n, v);
    };
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      { validate: async () => { events.push("validate"); return passed; } } as never,
      { review: async () => { events.push("review"); return review; } } as never,
      store,
    );
    await pipeline.run(config);
    // §23/§19：Attempt 内的顺序不变——Generate → Save Story → Validate → Save Validation → Review
    expect(events).toEqual(["save-story", "validate", "save-validation", "review"]);
  });

  it("§20 GenerationResult 只含约定字段（含 validation，不含未来能力字段）", async () => {
    withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(Object.keys(result).sort()).toEqual([
      "artifacts", "attempt_count", "attempts", "beat_plan",
      // v1.4.0：BeatPlan 结构校验结论同样是正式字段
      "beat_validation", "beat_validation_error", "beat_validation_status",
      // v1.5.0：商业可读性结论同样是正式字段，与 review 完全并列
      "commercial_review", "commercial_review_error", "commercial_review_status",
      "config", "finished_at",
      // v1.6.0：出身清单同样是正式字段，内容等于落盘的 run-manifest.json
      "manifest",
      "quality", "quality_status", "review", "review_error", "review_status", "run_id",
      "selected_attempt", "started_at", "status", "story",
      "validation", "validation_error", "validation_status",
    ]);
    // repair / retry / attempt 是 v0.7.0~v0.8.0 的正式能力；下面这些仍然一个都不许出现
    for (const forbidden of ["dimension", "benchmark", "causal", "attribution", "policy"]) {
      for (const key of Object.keys(result)) {
        expect(key.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("§65 只暴露 run() / runWithPlan()，没有未来能力入口", () => {
    const names = Object.getOwnPropertyNames(GenerationPipeline.prototype);
    expect(names).toContain("run");
    expect(names).toContain("runWithPlan");
    // repair 已是 v0.8.0 正式能力（内部私有方法也算实现细节，不算对外入口）；
    // 真正禁止的是这些还没做的能力名。
    for (const name of names) {
      for (const forbidden of [
        "experiment", "benchmark", "observe", "dimension", "causal", "attribution",
        "optimize", "learn", "foreshadow",
      ]) {
        expect(name.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("§19 构造器接受 planner / generator / validator / reviewer / artifactStore / retryPolicy", () => {
    // retryPolicy / repairer / repairStrategy / projectVersion 都有默认值，不计入 length
    expect(GenerationPipeline.length).toBe(5);
    const names = Object.getOwnPropertyNames(GenerationPipeline.prototype);
    expect(names).toContain("run");
    expect(names).toContain("runWithPlan");
  });

  it("temperature 缺省 0.7 / 0.8，Reviewer 使用自己的默认温度", async () => {
    withTmpDir();
    const planCalls: PlanCall[] = [];
    const genCalls: GenCall[] = [];
    const reviewCalls: ReviewCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan, planCalls) as never,
      fakeGenerator(STORY, genCalls) as never,
      fakeValidator(passed) as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(planCalls[0].temperature).toBe(0.7);
    expect(genCalls[0].temperature).toBe(0.8);
    expect(reviewCalls[0].temperature).toBe(0.3);

    planCalls.length = 0;
    genCalls.length = 0;
    reviewCalls.length = 0;
    // §26：全局 temperature 只影响规划与写作，Reviewer 保持内部较低值
    await pipeline.run(config, { temperature: 0.25, model: "m" });
    expect(planCalls[0].temperature).toBe(0.25);
    expect(genCalls[0].temperature).toBe(0.25);
    expect(reviewCalls[0].temperature).toBe(0.3);
  });

  it("Validator / Reviewer 收到的是生成的正文与本次 config", async () => {
    withTmpDir();
    const validateCalls: ValidateCall[] = [];
    const reviewCalls: ReviewCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      fakeValidator(passed, validateCalls) as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(validateCalls[0].story).toBe(STORY);
    expect(validateCalls[0].config).toEqual(config);
    expect(reviewCalls[0].story).toBe(STORY);
    expect(reviewCalls[0].config).toEqual(config);
  });

  it("metadata 记录运行时 model", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config, { model: "gpt-4o-mini" });
    expect(readMeta(dir, result.run_id).model).toBe("gpt-4o-mini");
  });
});

describe("GenerationPipeline — runWithPlan（§29 Manual Run）", () => {
  it("supplied BeatPlan 直接进入生成，Planner 不被调用", async () => {
    const dir = withTmpDir();
    const genCalls: GenCall[] = [];
    const planner = {
      plan: async () => {
        throw new Error("Manual Run 不得调用 Planner");
      },
    };
    const pipeline = new GenerationPipeline(
      planner as never, fakeGenerator(STORY, genCalls) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new ArtifactStore(),
    );

    const result = await pipeline.runWithPlan(config, plan);
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0].plan).toEqual(plan);
    expect(result.run_id).toMatch(RUN_ID);
    // run_id 一致性：响应 / beats.json / metadata.json 三处同一个值
    expect(JSON.parse(readFileSync(join(dir, "runs", result.run_id, "beats.json"), "utf8")).beats).toHaveLength(2);
    expect(readMeta(dir, result.run_id).run_id).toBe(result.run_id);
  });

  it("手动模式同样走完整 Validate + Review 阶段", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new ArtifactStore(),
    );
    const result = await pipeline.runWithPlan(config, plan);
    expect(result.artifacts.story).toBe("story.md");
    expect(result.artifacts.validation).toBe("validation.json");
    expect(result.artifacts.review).toBe("review.json");
    expect(existsSync(join(dir, "runs", result.run_id, "validation.json"))).toBe(true);
    expect(existsSync(join(dir, "runs", result.run_id, "review.json"))).toBe(true);
  });
});

describe("GenerationPipeline — planning failure（§18/§60）", () => {
  it("status=failed，current_stage=planning，config+metadata 保留，beats/story 缺失", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      { plan: async () => { throw new Error("Planner 输出不是合法 JSON"); } } as never,
      fakeGenerator(STORY) as never,
      fakeValidator(passed) as never,
      fakeReviewer(review) as never,
      new ArtifactStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.name).toBe("PipelineError");
    expect(pe.stage).toBe("planning");
    expect(pe.runId).toMatch(RUN_ID);
    expect(pe.message).toContain("failed at planning");

    const runDir = join(dir, "runs", pe.runId);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(false);
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    const meta = readMeta(dir, pe.runId);
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("planning");
    expect(meta.error).toContain("Planner 输出不是合法 JSON");
  });
});

describe("GenerationPipeline — generation failure（§19/§61）", () => {
  it("status=failed，current_stage=generating，config+beats+metadata 保留，story 缺失", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      { generate: async () => { throw new Error("LLM API 返回 500"); } } as never,
      fakeValidator(passed) as never,
      fakeReviewer(review) as never,
      new ArtifactStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.stage).toBe("generating");

    const runDir = join(dir, "runs", pe.runId);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    const meta = readMeta(dir, pe.runId);
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("500");
  });
});

describe("GenerationPipeline — persistence failure（§20/§62）", () => {
  it("save 失败：status=failed，current_stage=saving，错误信息不含内部路径", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new FailingStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.stage).toBe("saving");
    // §28：只回安全错误，不透出服务器绝对路径
    expect(pe.message).not.toContain("secret");
    expect(pe.message).not.toMatch(/[A-Za-z]:\\/);
    expect(readMeta(dir, pe.runId).status).toBe("failed");
  });
});

describe("GenerationPipeline — review failure（§16/§44）", () => {
  it("Reviewer 抛错：Run 仍 completed，story.md 保留，review.json 缺失，review_status=failed", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      fakeValidator(passed) as never,
      { review: async () => { throw new Error("Reviewer 输出不是合法 JSON"); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    // §16：Story 成功生成，Run 本身不算失败
    expect(result.status).toBe("completed");
    expect(result.story).toBe(STORY);
    expect(result.validation).toEqual(passed);
    expect(result.validation_status).toBe("completed");
    expect(result.review).toBeNull();
    expect(result.review_status).toBe("failed");
    expect(result.review_error).toContain("Reviewer 输出不是合法 JSON");
    // §44：review.json 不出现，artifacts 里也没有 review 条目；validation.json 仍在
    expect(result.artifacts.review).toBeUndefined();
    expect(result.artifacts.validation).toBe("validation.json");
    expect(result.artifacts.story).toBe("story.md");

    const runDir = join(dir, "runs", result.run_id);
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "validation.json"))).toBe(true);
    expect(existsSync(join(runDir, "review.json"))).toBe(false);

    const meta = readMeta(dir, result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(true);
    expect(meta.review_status).toBe("failed");
    expect(meta.review_error).toContain("Reviewer 输出不是合法 JSON");
    expect(meta.review_score).toBeUndefined();
  });

  it("review.json 写入失败同样只算 Review 失败，不丢正文", async () => {
    const dir = withTmpDir();
    class FailingReviewStore extends ArtifactStore {
      override putAttemptReview(runId: string, attemptNumber: number, r: ReviewResult): string {
        throw new Error(`EACCES: permission denied, open '${join("D:", "secret", "runs", runId, "attempts", `0${attemptNumber}`, "review.json")}'`);
      }
    }
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, fakeReviewer(review) as never, new FailingReviewStore(),
    );

    const result = await pipeline.run(config);
    expect(result.status).toBe("completed");
    expect(result.review).toBeNull();
    expect(result.review_status).toBe("failed");
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);
    // §28：错误信息不含服务器绝对路径
    expect(result.review_error).not.toMatch(/[A-Za-z]:\\/);
  });

  it("§3/§67 Review 失败不会触发重新生成：Generator 只被调用一次", async () => {
    withTmpDir();
    const genCalls: GenCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY, genCalls) as never,
      fakeValidator(passed) as never,
      { review: async () => { throw new Error("Reviewer 输出不是合法 JSON"); } } as never,
      new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(genCalls).toHaveLength(1);
  });

  it("§69 不存在 PASS/FAIL 阈值：低分也只是普通 completed，且不影响 validation", async () => {
    withTmpDir();
    const lowScore = fakeReviewer({ ...review, score: 3 });
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator(STORY) as never,
      fakeValidator(passed) as never, lowScore as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(result.status).toBe("completed");
    expect(result.review_status).toBe("completed");
    expect(result.review?.score).toBe(3);
    // §59：Review 分数不参与 validation 判定，validation 仍是独立结论
    expect(result.validation?.passed).toBe(true);
    // §69：Review 侧不出现 PASS / FAIL / 等级 / 阈值
    expect(
      JSON.stringify({ review: result.review, review_status: result.review_status }),
    ).not.toMatch(/pass|fail|needs.?retry|threshold|grade|tier/i);
  });
});

describe("GenerationPipeline — validation stage（§17/§38/§39）", () => {
  it("§38 调用顺序：Planner → Generator → Save Story → Validator → Save Validation → Reviewer → Save Review", async () => {
    withTmpDir();
    const events: string[] = [];
    const store = new ArtifactStore();
    const putStory = store.putAttemptStory.bind(store);
    const putValidation = store.putAttemptValidation.bind(store);
    const putReview = store.putAttemptReview.bind(store);
    store.putAttemptStory = (r, n, t, s) => { events.push("save-story"); return putStory(r, n, t, s); };
    store.putAttemptValidation = (r, n, v) => { events.push("save-validation"); return putValidation(r, n, v); };
    store.putAttemptReview = (r, n, rv) => { events.push("save-review"); return putReview(r, n, rv); };

    const pipeline = new GenerationPipeline(
      { plan: async () => { events.push("plan"); return plan; } } as never,
      { generate: async () => { events.push("generate"); return STORY; } } as never,
      { validate: async () => { events.push("validate"); return passed; } } as never,
      { review: async () => { events.push("review"); return review; } } as never,
      store,
    );
    await pipeline.run(config);
    expect(events).toEqual([
      "plan", "generate", "save-story", "validate", "save-validation", "review", "save-review",
    ]);
  });

  it("§39 Validation Failed + 默认策略：story.md / validation.json 都在，Review 仍执行，Run 仍 completed，并按策略重试一次", async () => {
    const dir = withTmpDir();
    const genCalls: GenCall[] = [];
    const reviewCalls: ReviewCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("太短", genCalls) as never,
      fakeValidator(failed) as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    // §18/§39：Validation Failed 是业务结果，不是 Pipeline Crash
    expect(result.status).toBe("completed");
    expect(result.validation).toEqual(failed);
    expect(result.validation?.passed).toBe(false);
    expect(result.validation_status).toBe("completed");
    // 正文与校验结果都保留
    expect(result.story).toBe("太短");
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);
    expect(existsSync(join(dir, "runs", result.run_id, "validation.json"))).toBe(true);
    // Review 照常执行
    expect(reviewCalls).toHaveLength(2);
    expect(result.review).toEqual(review);
    expect(result.review_status).toBe("completed");
    // §14/§39：默认 retry_on_validation_failure=true，max_attempts=2 → 重试一次后仍不过 → exhausted
    expect(genCalls).toHaveLength(2);
    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.quality_status).toBe("exhausted");
    expect(result.attempts.map((a) => a.retry_reason)).toEqual(["validation_failed", "validation_failed"]);

    const meta = readMeta(dir, result.run_id);
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(false);
    expect(meta.validation_issue_count).toBe(1);
    expect(meta.status).toBe("completed");
  });

  it("§39 Validation Failed + 关闭 retry_on_validation_failure：只生成一次，仍是 exhausted 语义之外的 accepted", async () => {
    withTmpDir();
    const genCalls: GenCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("太短", genCalls) as never,
      fakeValidator(failed) as never,
      fakeReviewer(review) as never,
      new ArtifactStore(),
      { ...DEFAULT_RETRY_POLICY, max_attempts: 3, retry_on_validation_failure: false },
    );

    const result = await pipeline.run(config, undefined, {
      ...DEFAULT_RETRY_POLICY, max_attempts: 3, retry_on_validation_failure: false,
    });
    // §14：校验失败但不是重试触发条件 → 直接采纳这一次
    expect(genCalls).toHaveLength(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(1);
    expect(result.attempts[0].accepted).toBe(true);
  });

  it("§18 EMPTY_CONTENT 时跳过 Review，Run 仍 completed", async () => {
    const dir = withTmpDir();
    const reviewCalls: ReviewCall[] = [];
    const emptyFailed: ValidationResult = {
      passed: false,
      issues: [{ code: "EMPTY_CONTENT", severity: "error", message: "正文为空，没有可校验的内容。" }],
    };
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("") as never,
      fakeValidator(emptyFailed) as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    expect(result.status).toBe("completed");
    expect(result.validation?.issues[0]?.code).toBe("EMPTY_CONTENT");
    expect(result.validation_status).toBe("completed");
    // §18：没有可审阅的正文，跳过 Review
    expect(reviewCalls).toHaveLength(0);
    expect(result.review).toBeNull();
    expect(result.review_status).toBe("not_started");
    expect(result.artifacts.review).toBeUndefined();
    expect(existsSync(join(dir, "runs", result.run_id, "review.json"))).toBe(false);
    // 空正文本身仍然落盘
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);
  });

  it("§40 Validator 自身异常：正文保留，metadata.validation_status=failed，Story 非空时仍继续 Review", async () => {
    const dir = withTmpDir();
    const reviewCalls: ReviewCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      { validate: async () => { throw new Error("Validator 内部规则崩溃"); } } as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    // §25：Validator Error ≠ Validation Failed，Run 不受影响
    expect(result.status).toBe("completed");
    expect(result.validation).toBeNull();
    expect(result.validation_status).toBe("failed");
    expect(result.validation_error).toContain("Validator 内部规则崩溃");
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);
    expect(existsSync(join(dir, "runs", result.run_id, "validation.json"))).toBe(false);
    expect(result.artifacts.validation).toBeUndefined();
    // §40：Story 存在时推荐仍继续 Review
    expect(reviewCalls).toHaveLength(1);
    expect(result.review_status).toBe("completed");

    const meta = readMeta(dir, result.run_id);
    expect(meta.validation_status).toBe("failed");
    expect(meta.validation_error).toContain("Validator 内部规则崩溃");
    expect(meta.validation_passed).toBeUndefined();
  });

  it("§59 Review 分数再低也不会改变 validation 结论（Validator 与 Reviewer 独立）", async () => {
    withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      fakeValidator(failed) as never,
      fakeReviewer({ ...review, score: 0 }) as never,
      new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(result.validation?.passed).toBe(false);
    expect(result.review?.score).toBe(0);
    expect(result.review_status).toBe("completed");
    // 反向：高分也不会让失败的校验通过
    const second = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator(STORY) as never,
      fakeValidator(passed) as never,
      fakeReviewer({ ...review, score: 100 }) as never,
      new ArtifactStore(),
    );
    const r2 = await second.run(config);
    expect(r2.validation?.passed).toBe(true);
  });

  it("真实 StoryValidator：过短正文 → TOO_SHORT error，validation.json 落盘", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("只有一句话。") as never,
      new StoryValidator(),
      fakeReviewer(review) as never,
      new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(result.validation?.passed).toBe(false);
    expect(result.validation?.issues.map((i) => i.code)).toContain("TOO_SHORT");
    expect(existsSync(join(dir, "runs", result.run_id, "validation.json"))).toBe(true);
    // §39：Review 仍然执行
    expect(result.review_status).toBe("completed");
  });
});
