import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";

/**
 * §3/§5~§7/§16~§30/§43~§45/§59~§62 GenerationPipeline。
 * v0.5.0：Save Story → Review → Save Review（§18）。
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

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

interface PlanCall { config: StoryConfig; temperature: number }
interface GenCall { config: StoryConfig; plan: BeatPlan; temperature: number }
interface ReviewCall { config: StoryConfig; story: string; temperature: number }

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
  override putStory(runId: string, title: string, story: string): string {
    throw new Error(`EACCES: permission denied, open '${join("D:", "secret", "runs", runId, "story.md")}'`);
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
  it("Planner → Generator → Save Story → Reviewer → Save Review → Complete", async () => {
    const dir = withTmpDir();
    const order: string[] = [];
    const pipeline = new GenerationPipeline(
      { plan: async () => { order.push("plan"); return plan; } } as never,
      { generate: async () => { order.push("generate"); return "正文内容"; } } as never,
      { review: async () => { order.push("review"); return review; } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    expect(order).toEqual(["plan", "generate", "review"]);
    expect(result.run_id).toMatch(RUN_ID);
    expect(result.status).toBe("completed");
    expect(result.story).toBe("正文内容");
    expect(result.beat_plan).toEqual(plan);
    expect(result.config).toEqual(config);
    expect(result.review).toEqual(review);
    expect(result.review_status).toBe("completed");
    expect(result.review_error).toBeNull();
    expect(result.artifacts).toEqual({
      config: "config.json", beat_plan: "beats.json", story: "story.md",
      metadata: "metadata.json", review: "review.json",
    });

    const runDir = join(dir, "runs", result.run_id);
    expect(readdirSync(runDir).sort()).toEqual([
      "beats.json", "config.json", "metadata.json", "review.json", "story.md",
    ]);
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");
    expect(JSON.parse(readFileSync(join(runDir, "review.json"), "utf8"))).toEqual(review);

    const meta = readMeta(dir, result.run_id);
    expect(meta.run_id).toBe(result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.current_stage).toBe("completed");
    expect(meta.project_version).toBe("0.5.0");
    expect(meta.finished_at).toBeTruthy();
    // §17/§24：metadata 单独记录 review 状态与基础总分
    expect(meta.review_status).toBe("completed");
    expect(meta.review_score).toBe(74);
    expect(meta.review_error).toBeUndefined();
  });

  it("§45 review.json 内容与 GenerationResult.review 一致", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("正文") as never,
      fakeReviewer(review) as never,
      new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    const saved = JSON.parse(readFileSync(join(dir, "runs", result.run_id, "review.json"), "utf8"));
    expect(saved).toEqual(result.review);
    expect(saved.score).toBe(result.review?.score);
  });

  it("§18 Story 在 Review 之前就已落盘（save story 先于 review 调用）", async () => {
    withTmpDir();
    const events: string[] = [];
    const store = new ArtifactStore();
    const originalPutStory = store.putStory.bind(store);
    store.putStory = (runId: string, title: string, story: string) => {
      events.push("save-story");
      return originalPutStory(runId, title, story);
    };
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("正文") as never,
      { review: async () => { events.push("review"); return review; } } as never,
      store,
    );
    await pipeline.run(config);
    expect(events.indexOf("save-story")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("save-story")).toBeLessThan(events.indexOf("review"));
  });

  it("§20 GenerationResult 只含约定字段（含 review，不含未来能力字段）", async () => {
    withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, fakeReviewer(review) as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(Object.keys(result).sort()).toEqual([
      "artifacts", "beat_plan", "config", "finished_at", "review", "review_error",
      "review_status", "run_id", "started_at", "status", "story",
    ]);
    for (const forbidden of ["validation", "repair", "retry", "attempt", "dimension"]) {
      for (const key of Object.keys(result)) {
        expect(key.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("§30 只暴露 run() / runWithPlan()，没有未来能力入口", () => {
    const names = Object.getOwnPropertyNames(GenerationPipeline.prototype);
    expect(names).toContain("run");
    expect(names).toContain("runWithPlan");
    for (const name of names) {
      for (const forbidden of ["validate", "repair", "retry", "experiment", "benchmark", "observe"]) {
        expect(name.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("§19 构造器只接受 planner / generator / reviewer / artifactStore", () => {
    // 第 5 个参数 projectVersion 有默认值，不计入 length
    expect(GenerationPipeline.length).toBe(4);
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
      fakeGenerator("正文", genCalls) as never,
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

  it("Reviewer 收到的是生成的正文与本次 config", async () => {
    withTmpDir();
    const reviewCalls: ReviewCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      fakeGenerator("正文——陈岚走进雨夜。") as never,
      fakeReviewer(review, reviewCalls) as never,
      new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(reviewCalls[0].story).toBe("正文——陈岚走进雨夜。");
    expect(reviewCalls[0].config).toEqual(config);
  });

  it("metadata 记录运行时 model", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, fakeReviewer(review) as never, new ArtifactStore(),
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
      planner as never, fakeGenerator("正文", genCalls) as never, fakeReviewer(review) as never, new ArtifactStore(),
    );

    const result = await pipeline.runWithPlan(config, plan);
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0].plan).toEqual(plan);
    expect(result.run_id).toMatch(RUN_ID);
    // run_id 一致性：响应 / beats.json / metadata.json 三处同一个值
    expect(JSON.parse(readFileSync(join(dir, "runs", result.run_id, "beats.json"), "utf8")).beats).toHaveLength(2);
    expect(readMeta(dir, result.run_id).run_id).toBe(result.run_id);
  });

  it("手动模式同样走完整 Review 阶段", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, fakeReviewer(review) as never, new ArtifactStore(),
    );
    const result = await pipeline.runWithPlan(config, plan);
    expect(result.artifacts.story).toBe("story.md");
    expect(result.artifacts.review).toBe("review.json");
    expect(existsSync(join(dir, "runs", result.run_id, "review.json"))).toBe(true);
  });
});

describe("GenerationPipeline — planning failure（§18/§60）", () => {
  it("status=failed，current_stage=planning，config+metadata 保留，beats/story 缺失", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      { plan: async () => { throw new Error("Planner 输出不是合法 JSON"); } } as never,
      fakeGenerator("正文") as never,
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
      fakePlanner(plan) as never, fakeGenerator("正文") as never, fakeReviewer(review) as never, new FailingStore(),
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
      fakeGenerator("正文——陈岚走进雨夜。") as never,
      { review: async () => { throw new Error("Reviewer 输出不是合法 JSON"); } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    // §16：Story 成功生成，Run 本身不算失败
    expect(result.status).toBe("completed");
    expect(result.story).toBe("正文——陈岚走进雨夜。");
    expect(result.review).toBeNull();
    expect(result.review_status).toBe("failed");
    expect(result.review_error).toContain("Reviewer 输出不是合法 JSON");
    // §44：review.json 不出现，artifacts 里也没有 review 条目
    expect(result.artifacts.review).toBeUndefined();
    expect(result.artifacts.story).toBe("story.md");

    const runDir = join(dir, "runs", result.run_id);
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "review.json"))).toBe(false);

    const meta = readMeta(dir, result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.review_status).toBe("failed");
    expect(meta.review_error).toContain("Reviewer 输出不是合法 JSON");
    expect(meta.review_score).toBeUndefined();
  });

  it("review.json 写入失败同样只算 Review 失败，不丢正文", async () => {
    const dir = withTmpDir();
    class FailingReviewStore extends ArtifactStore {
      override putReview(runId: string, r: ReviewResult): string {
        throw new Error(`EACCES: permission denied, open '${join("D:", "secret", "runs", runId, "review.json")}'`);
      }
    }
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, fakeReviewer(review) as never, new FailingReviewStore(),
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
      fakeGenerator("正文", genCalls) as never,
      { review: async () => { throw new Error("Reviewer 输出不是合法 JSON"); } } as never,
      new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(genCalls).toHaveLength(1);
  });

  it("§69 不存在 PASS/FAIL 阈值：低分也只是普通 completed", async () => {
    withTmpDir();
    const lowScore = fakeReviewer({ ...review, score: 3 });
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, lowScore as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(result.status).toBe("completed");
    expect(result.review_status).toBe("completed");
    expect(result.review?.score).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/pass|fail|needs.?retry|threshold/i);
  });
});
