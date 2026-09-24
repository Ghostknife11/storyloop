import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { qualityResultOf, type QualityResult } from "@/types/quality";
import type { QualityDimensions } from "@/types/quality-dimensions";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_STORY,
  FakeLLM,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.3.0 §39 多维度审阅在真实管道里的落点。
 *
 * Reviewer 换成会返回四维评分的假客户端，其余全是真组件。重点验证四件事：
 *   1. 维度一路带到 quality.json，overall_score 就是四维均分（§18/§38）
 *   2. 重试门槛比的是均分，不是任何一个维度（§40）
 *   3. 修订后重新审阅得到新的维度，快照取修订后那一份（§35）
 *   4. 没有维度时（旧格式）行为与 v1.2.x 逐字一致（§37）
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);

const HIGH_DIMENSIONS: QualityDimensions = {
  coherence: { score: 84, summary: "设定与称呼前后一致。" },
  narrative: { score: 80, summary: "结构完整，中段略慢。" },
  character: { score: 81, summary: "主角目标清楚，高潮处动机交代到位。" },
  causality: { score: 83, summary: "事件推进都有前因。" },
};

const LOW_DIMENSIONS: QualityDimensions = {
  coherence: { score: 62, summary: "后段称呼前后不一致。" },
  narrative: { score: 59, summary: "起承转合缺高潮。" },
  character: { score: 63, summary: "主角中途换了目标。" },
  causality: { score: 56, summary: "配角的反水没有铺垫。" },
};

/** 均分：(84+80+81+83)/4 = 82 */
const HIGH_REVIEW = JSON.stringify({
  score: 82,
  dimensions: HIGH_DIMENSIONS,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
  suggestions: ["压缩重复线索，让中段事件承担新的推进功能。"],
});

/** 均分：(62+59+63+56)/4 = 60 */
const LOW_REVIEW = JSON.stringify({
  score: 60,
  dimensions: LOW_DIMENSIONS,
  summary: "高潮冲突没有展开。",
  strengths: ["开篇有画面感"],
  problems: ["高潮缺失"],
});

const LEGACY_HIGH_REVIEW = JSON.stringify({
  score: 82,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
  suggestions: ["压缩重复线索，让中段事件承担新的推进功能。"],
});

function pipelineWith(
  llm: FakeLLM,
  store: ArtifactStore,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator(),
    new BasicReviewer(client),
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function qualityAt(path: string): QualityResult {
  const parsed = qualityResultOf(readJson(path));
  expect(parsed, `${path} 应是合法的 QualityResult`).not.toBeNull();
  return parsed as QualityResult;
}

describe("§39 Happy Path：维度一路带到快照与 metadata", () => {
  it("Reviewer 返回四维评分 → quality.json 带维度，overall_score 是均分", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, HIGH_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("accepted");
    expect(result.quality.overall_score).toBe(82);
    expect(result.quality.dimensions).toEqual(HIGH_DIMENSIONS);

    const onDisk = qualityAt(join(runDir, "quality.json"));
    expect(onDisk.dimensions).toEqual(HIGH_DIMENSIONS);
    expect(qualityAt(join(runDir, "attempts", "01", "quality.json"))).toEqual(onDisk);
    // 键集在有维度时多一个 dimensions，其余与 v1.2.0 一致
    expect(Object.keys(onDisk).sort()).toEqual([
      "accepted", "dimensions", "issues", "overall_score", "suggestions", "summary",
      "validation_passed",
    ]);

    // metadata 与快照同口径：总分是均分，review.json 是原始审阅结论（带维度）
    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.overall_score).toBe(82);
    expect(meta.review_score).toBe(82);
    expect(readJson(join(runDir, "review.json")).score).toBe(82);
  });

  it("没有维度的旧格式审阅：行为与 v1.2.x 一致，快照里没有 dimensions 键", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LEGACY_HIGH_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    const onDisk = qualityAt(join(runDir, "quality.json"));
    expect(onDisk.overall_score).toBe(82);
    expect(onDisk).not.toHaveProperty("dimensions");
    expect(Object.keys(onDisk).sort()).toEqual([
      "accepted", "issues", "overall_score", "suggestions", "summary", "validation_passed",
    ]);
  });
});

describe("§40 Retry Path：门槛比的是均分", () => {
  it("第一次均分 60（低于 70）→ 重试；第二次均分 82 → 采纳", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW,
      SAMPLE_STORY, HIGH_REVIEW,
    ]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(2);
    expect(result.attempts[0].retry_reason).toBe("review_score_below_threshold");

    const first = qualityAt(join(runDir, "attempts", "01", "quality.json"));
    expect(first.overall_score).toBe(60);
    expect(readJson(join(runDir, "attempts", "01", "metadata.json")).review_score).toBe(60);
    expect(first.overall_score).toBe(60);
    expect(first.dimensions).toEqual(LOW_DIMENSIONS);
    expect(first.accepted).toBe(false);

    const second = qualityAt(join(runDir, "attempts", "02", "quality.json"));
    expect(second.overall_score).toBe(82);
    expect(qualityAt(join(runDir, "quality.json"))).toEqual(second);
  });

  it("用尽 Attempt 时两次都是低分，根目录快照保留最后一次的维度", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW,
      SAMPLE_STORY, LOW_REVIEW,
    ]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("exhausted");
    const root = qualityAt(join(runDir, "quality.json"));
    expect(root.overall_score).toBe(60);
    expect(root.accepted).toBe(false);
    expect(root.dimensions).toEqual(LOW_DIMENSIONS);
  });
});

describe("§35 Repair Path：维度随修订后的审阅一起更新", () => {
  it("低分 → 修订 → 重新审阅：attempt 快照取修订后的四个维度", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY,
      SAMPLE_STORY,
      LOW_REVIEW,
      `修订后的正文，补上了高潮。${SAMPLE_STORY}`,
      HIGH_REVIEW,
    ]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);
    const attemptDir = join(runDir, "attempts", "01");
    const repairDir = join(attemptDir, "repairs", "01");

    expect(result.quality_status).toBe("accepted");
    expect(result.attempts[0].repairs).toHaveLength(1);

    const attemptQuality = qualityAt(join(attemptDir, "quality.json"));
    expect(attemptQuality.overall_score).toBe(82);
    expect(attemptQuality.dimensions).toEqual(HIGH_DIMENSIONS);
    expect(qualityAt(join(runDir, "quality.json"))).toEqual(attemptQuality);

    // 首次结论仍是修订前那份（带低分维度），修订后那份在 repairs/01/
    expect(readJson(join(attemptDir, "review.json")).score).toBe(60);
    expect((readJson(join(repairDir, "review.json")).dimensions as QualityDimensions).coherence.score)
      .toBe(84);

    // metadata 同口径：分数与修订记录都取修订后的结论
    const attemptMeta = readJson(join(attemptDir, "metadata.json"));
    expect(attemptMeta.overall_score).toBe(82);
    expect(attemptMeta.review_score).toBe(82);
    const repairs = attemptMeta.repairs as Array<Record<string, unknown>>;
    expect(repairs[0].before_review_score).toBe(60);
    expect(repairs[0].after_review_score).toBe(82);
  });
});
