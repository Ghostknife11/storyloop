import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QualityAssembler } from "@/core/quality-assembler";
import { DEFAULT_RETRY_POLICY, decideRetry } from "@/core/retry-policy";
import { parseReviewResult } from "@/lib/review-parser";
import {
  reviewOverallScore,
  validateQualityDimensions,
  validateReviewResult,
  ReviewValidationError,
  type ReviewResult,
} from "@/types/review-result";
import { qualityResultOf, type QualityResult } from "@/types/quality";
import {
  DIMENSION_DEFINITIONS,
  DIMENSION_LABELS,
  QUALITY_DIMENSION_KEYS,
  aggregateDimensionScore,
  isQualityDimensionKey,
  type QualityDimensions,
} from "@/types/quality-dimensions";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.3.0 多维度审阅契约（TASK §30 ~ §41）。
 *
 * 覆盖：维度模型与确定性聚合、ReviewResult 的可选维度及其校验、解析路径、
 * QualityAssembler / quality.json 的透传、重试门槛只认整体分、以及「维度不参与
 * 任何决策」这条边界。LLM 一律 Fake，不调用真实收费模型。
 */

const DIMENSIONS: QualityDimensions = {
  coherence: { score: 80, summary: "设定、称呼、时间线前后一致。" },
  narrative: { score: 76, summary: "起承转合完整，中段节奏偏慢。" },
  character: { score: 72, summary: "主角目标清晰，高潮处退让动机交代不足。" },
  causality: { score: 66, summary: "主线因果成立，配角的反水缺少铺垫。" },
};

const REVIEW_JSON = JSON.stringify({
  score: 73.5,
  dimensions: DIMENSIONS,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
  suggestions: ["压缩重复线索，并让中段事件承担新的推进功能。"],
});

const LEGACY_JSON = JSON.stringify({
  score: 74,
  summary: "故事整体完整，主线清楚。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
});

function assemblerInput(review: ReviewResult | null, accepted = true) {
  return {
    validation: { passed: true, issues: [] },
    review,
    accepted,
  };
}

describe("v1.3.0 维度模型（§2/§3）", () => {
  it("四个基础维度，顺序固定：连贯性 → 叙事 → 人物 → 因果", () => {
    expect(QUALITY_DIMENSION_KEYS).toEqual(["coherence", "narrative", "character", "causality"]);
    for (const key of QUALITY_DIMENSION_KEYS) {
      expect(DIMENSION_LABELS[key]).toMatch(/\S/);
      expect(DIMENSION_DEFINITIONS[key]).toMatch(/\S/);
    }
  });

  it("isQualityDimensionKey 只认这四个键", () => {
    expect(isQualityDimensionKey("coherence")).toBe(true);
    expect(isQualityDimensionKey("causality")).toBe(true);
    expect(isQualityDimensionKey("commercial")).toBe(false);
    expect(isQualityDimensionKey("COHERENCE")).toBe(false);
    expect(isQualityDimensionKey("")).toBe(false);
    expect(isQualityDimensionKey(null)).toBe(false);
    expect(isQualityDimensionKey(["coherence"])).toBe(false);
  });

  it("§4 聚合是确定性均分：80/76/72/66 → 73.5", () => {
    expect(aggregateDimensionScore(DIMENSIONS)).toBe(73.5);
  });

  it("§4 均分四舍五入到 1 位小数，且不含权重", () => {
    expect(aggregateDimensionScore({
      coherence: { score: 61, summary: "a" },
      narrative: { score: 59, summary: "b" },
      character: { score: 63, summary: "c" },
      causality: { score: 57, summary: "d" },
    })).toBe(60);
    expect(aggregateDimensionScore({
      coherence: { score: 0, summary: "a" },
      narrative: { score: 0, summary: "b" },
      character: { score: 0, summary: "c" },
      causality: { score: 1, summary: "d" },
    })).toBe(0.3);
    expect(aggregateDimensionScore({
      coherence: { score: 100, summary: "a" },
      narrative: { score: 100, summary: "b" },
      character: { score: 100, summary: "c" },
      causality: { score: 100, summary: "d" },
    })).toBe(100);
  });

  it("§4 纯函数：不改输入，重复调用结果一致", () => {
    const snapshot = JSON.stringify(DIMENSIONS);
    const first = aggregateDimensionScore(DIMENSIONS);
    const second = aggregateDimensionScore(DIMENSIONS);
    expect(first).toBe(second);
    expect(JSON.stringify(DIMENSIONS)).toBe(snapshot);
  });
});

describe("v1.3.0 ReviewResult.dimensions 校验（§12/§16）", () => {
  it("四个维度齐全 → 保留，summary 做 trim", () => {
    const r = validateReviewResult(JSON.parse(REVIEW_JSON));
    expect(r.dimensions).toEqual({
      coherence: { score: 80, summary: "设定、称呼、时间线前后一致。" },
      narrative: { score: 76, summary: "起承转合完整，中段节奏偏慢。" },
      character: { score: 72, summary: "主角目标清晰，高潮处退让动机交代不足。" },
      causality: { score: 66, summary: "主线因果成立，配角的反水缺少铺垫。" },
    });
  });

  it("缺一个维度 → 解析失败，且错误信息点名缺的是谁（不偷偷补 0）", () => {
    const raw = JSON.parse(REVIEW_JSON) as Record<string, unknown>;
    const partial = { ...(raw.dimensions as Record<string, unknown>) };
    delete partial.causality;
    expect(() => validateReviewDimensionsSafe(partial)).toThrow(/dimensions\.causality/);
    // 同样的输入走完整校验路径，也是解析失败而不是当成旧格式
    expect(() => validateReviewResult({ ...raw, dimensions: partial })).toThrow(/dimensions\.causality/);
  });

  it("多出未知维度 → 拒绝（模型自己扩到 35 维也进不来）", () => {
    const raw = JSON.parse(REVIEW_JSON) as Record<string, unknown>;
    const extra = {
      ...(raw.dimensions as Record<string, unknown>),
      commercial: { score: 90, summary: "商业价值高" },
    };
    expect(() => validateReviewDimensionsSafe(extra)).toThrow(/未知维度 commercial/);
    expect(() => validateReviewResult({ ...raw, dimensions: extra })).toThrow(/未知维度 commercial/);
  });

  it("维度分 0 与 100 合法；越界 / 非数字 / NaN 一律拒绝", () => {
    expect(validateQualityDimensions(zeroHundred()).coherence.score).toBe(0);
    for (const bad of [-1, 101, "80", null, Number.NaN]) {
      const d = JSON.parse(JSON.stringify(DIMENSIONS));
      d.coherence.score = bad;
      expect(() => validateReviewDimensionsSafe(d), `score=${String(bad)}`).toThrow(ReviewValidationError);
    }
  });

  it("维度 summary 为空 → 拒绝（没有短评的分数不可解释）", () => {
    const d = JSON.parse(JSON.stringify(DIMENSIONS));
    d.narrative.summary = "   ";
    expect(() => validateReviewDimensionsSafe(d)).toThrow(/dimensions\.narrative\.summary/);
  });

  it("dimensions 不是对象（数组 / 字符串）→ 拒绝", () => {
    expect(() => validateReviewDimensionsSafe([])).toThrow(/dimensions 必须是/);
    expect(() => validateReviewDimensionsSafe("four")).toThrow(/dimensions 必须是/);
  });

  it("§16 没有 dimensions 的旧 JSON：整个键不出现，结构逐字兼容", () => {
    const r = validateReviewResult(JSON.parse(LEGACY_JSON));
    expect(r).not.toHaveProperty("dimensions");
    expect(Object.keys(r).sort()).toEqual(["problems", "score", "strengths", "summary"]);
  });

  it("§16 dimensions 显式为 null 时按旧结构处理，键不出现", () => {
    const raw = JSON.parse(LEGACY_JSON) as Record<string, unknown>;
    const r = validateReviewResult({ ...raw, dimensions: null });
    expect(r).not.toHaveProperty("dimensions");
  });

  it("§18 整体分口径：有维度取均分，没有维度取 score", () => {
    expect(reviewOverallScore(validateReviewResult(JSON.parse(REVIEW_JSON)))).toBe(73.5);
    expect(reviewOverallScore(validateReviewResult(JSON.parse(LEGACY_JSON)))).toBe(74);
  });
});

/** 只喂 dimensions 一段：单独校验维度 schema 时不要求 score / summary 等字段。 */
function validateReviewDimensionsSafe(dimensions: unknown): QualityDimensions {
  return validateQualityDimensions(dimensions);
}

function zeroHundred(): Record<string, unknown> {
  return {
    coherence: { score: 0, summary: "没有问题" },
    narrative: { score: 100, summary: "结构与节奏都到位" },
    character: { score: 100, summary: "言行与动机一致" },
    causality: { score: 100, summary: "因果清楚" },
  };
}

describe("v1.3.0 Review 解析路径（§30/§41）", () => {
  it("带四维的 JSON → ReviewResult.dimensions", () => {
    expect(parseReviewResult(REVIEW_JSON).dimensions).toEqual(DIMENSIONS);
  });

  it("markdown code fence + 首尾空白：轻量清理后照常解析", () => {
    const r = parseReviewResult(`\n\`\`\`json\n${REVIEW_JSON}\n\`\`\`\n`);
    expect(r.dimensions).toEqual(DIMENSIONS);
    expect(r.score).toBe(73.5);
  });

  it("维度缺一个 → ReviewParseError（不降级成没有维度）", () => {
    const raw = JSON.parse(REVIEW_JSON) as Record<string, unknown>;
    const partial = { ...(raw.dimensions as Record<string, unknown>) };
    delete partial.character;
    expect(() => parseReviewResult(JSON.stringify({ ...raw, dimensions: partial })))
      .toThrow(/dimensions\.character/);
  });

  it("维度分越界 / 多维度 → ReviewParseError", () => {
    const raw = JSON.parse(REVIEW_JSON) as Record<string, unknown>;
    const bad = { ...(raw.dimensions as Record<string, unknown>) };
    bad.coherence = { score: 140, summary: "超分" };
    expect(() => parseReviewResult(JSON.stringify({ ...raw, dimensions: bad })))
      .toThrow(/dimensions\.coherence\.score/);

    const extra = { ...(raw.dimensions as Record<string, unknown>), tension: { score: 90, summary: "x" } };
    expect(() => parseReviewResult(JSON.stringify({ ...raw, dimensions: extra })))
      .toThrow(/未知维度 tension/);
  });

  it("旧格式（没有维度）仍然解析成功", () => {
    expect(parseReviewResult(LEGACY_JSON).dimensions).toBeUndefined();
  });
});

describe("v1.3.0 QualityAssembler 透传维度（§18/§20）", () => {
  const assembler = new QualityAssembler();

  it("有维度：overall_score = 四维均分，dimensions 原样搬运", () => {
    const quality = assembler.assemble(assemblerInput(validateReviewResult(JSON.parse(REVIEW_JSON))));
    expect(quality.overall_score).toBe(73.5);
    expect(quality.dimensions).toEqual(DIMENSIONS);
  });

  it("没有维度：overall_score = review.score，dimensions 键不出现", () => {
    const quality = assembler.assemble(assemblerInput(validateReviewResult(JSON.parse(LEGACY_JSON))));
    expect(quality.overall_score).toBe(74);
    expect(quality).not.toHaveProperty("dimensions");
  });

  it("没有审阅结论：overall_score = null，也没有维度", () => {
    const quality = assembler.assemble(assemblerInput(null));
    expect(quality.overall_score).toBeNull();
    expect(quality).not.toHaveProperty("dimensions");
  });

  it("§17 确定性：同一份输入装配两次逐字相同", () => {
    const review = validateReviewResult(JSON.parse(REVIEW_JSON));
    expect(assembler.assemble(assemblerInput(review))).toEqual(assembler.assemble(assemblerInput(review)));
  });
});

describe("v1.3.0 quality.json 读写（§21/§38）", () => {
  const assembler = new QualityAssembler();

  it("落盘的 quality.json 带维度，读回来一致", () => {
    const quality = assembler.assemble(assemblerInput(validateReviewResult(JSON.parse(REVIEW_JSON))));
    const dir = mkdtempSync(join(tmpdir(), "storyloop-dimensions-"));
    try {
      const path = join(dir, "quality.json");
      writeFileSync(path, JSON.stringify(quality, null, 2), "utf8");
      const back = qualityResultOf(JSON.parse(readFileSync(path, "utf8")));
      expect(back?.dimensions).toEqual(DIMENSIONS);
      expect(back?.overall_score).toBe(73.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("§16 旧 Run 的 quality.json 没有维度：读回来没有这个键", () => {
    const legacy = assembler.assemble(assemblerInput(validateReviewResult(JSON.parse(LEGACY_JSON))));
    const back = qualityResultOf(JSON.parse(JSON.stringify(legacy)));
    expect(back).not.toBeNull();
    expect(back).not.toHaveProperty("dimensions");
    expect(back?.overall_score).toBe(74);
  });

  it("维度损坏（多键 / 越界 / 缺维度）：丢掉维度但保住快照，不 500", () => {
    const legacy = assembler.assemble(assemblerInput(validateReviewResult(JSON.parse(LEGACY_JSON))));
    const raw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    raw.dimensions = { ...DIMENSIONS, commercial: { score: 90, summary: "商业价值" } };
    expect(qualityResultOf(raw)).not.toBeNull();
    expect(qualityResultOf(raw)).not.toHaveProperty("dimensions");

    const brokenScore = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    brokenScore.dimensions = { ...DIMENSIONS };
    (brokenScore.dimensions as Record<string, { score: number }>).causality.score = 999;
    expect(qualityResultOf(brokenScore)).not.toBeNull();
    expect(qualityResultOf(brokenScore)).not.toHaveProperty("dimensions");
  });
});

describe("v1.3.0 重试门槛只认整体分（§19/§23/§40）", () => {
  function review(score: number, dimensions?: QualityDimensions): ReviewResult {
    return {
      score,
      dimensions,
      summary: "s",
      strengths: [],
      problems: dimensions ? ["因果线索断了"] : ["高潮缺失"],
    };
  }

  it("§40 70/68/67/67 → 整体 68 < 70 → 重试（review_score_below_threshold）", () => {
    const decision = decideRetry({
      policy: DEFAULT_RETRY_POLICY,
      attempt_number: 1,
      validation: { passed: true, issues: [] },
      review: review(70, {
        coherence: { score: 70, summary: "a" },
        narrative: { score: 68, summary: "b" },
        character: { score: 67, summary: "c" },
        causality: { score: 67, summary: "d" },
      }),
    });
    expect(decision).toEqual({ should_retry: true, reason: "review_score_below_threshold" });
  });

  it("四维均值达到门槛 → 采纳，与各维度高低无关", () => {
    const decision = decideRetry({
      policy: DEFAULT_RETRY_POLICY,
      attempt_number: 1,
      validation: { passed: true, issues: [] },
      review: review(71, {
        coherence: { score: 95, summary: "a" },
        narrative: { score: 72, summary: "b" },
        character: { score: 62, summary: "c" },
        causality: { score: 55, summary: "d" },
      }),
    });
    expect(decision).toEqual({ should_retry: false, reason: null });
  });

  it("单个维度很低不触发重试：没有 per-dimension 阈值", () => {
    const decision = decideRetry({
      policy: { ...DEFAULT_RETRY_POLICY, max_attempts: 5 },
      attempt_number: 1,
      validation: { passed: true, issues: [] },
      review: review(80, {
        coherence: { score: 100, summary: "a" },
        narrative: { score: 92, summary: "b" },
        character: { score: 88, summary: "c" },
        causality: { score: 40, summary: "d" },
      }),
    });
    expect(decision.reason).toBeNull();
  });

  it("旧结论（没有维度）行为不变：score < 门槛仍然重试", () => {
    const decision = decideRetry({
      policy: DEFAULT_RETRY_POLICY,
      attempt_number: 1,
      validation: { passed: true, issues: [] },
      review: review(68),
    });
    expect(decision).toEqual({ should_retry: true, reason: "review_score_below_threshold" });
  });

  it("RetryPolicy 里没有任何维度阈值字段", () => {
    expect(Object.keys(DEFAULT_RETRY_POLICY).sort()).toEqual([
      "enable_repair", "max_attempts", "max_repairs_per_attempt", "min_review_score",
      "retry_on_validation_failure",
    ]);
  });
});

describe("v1.3.0 维度是评价输出，不是行动依据（§24/§26/§28）", () => {
  it("提示词只要求四个基础维度，不出现商业 / 35 维 / 严重度字样", () => {
    const prompt = readFileSync(join(repoRoot(), "prompts", "reviewer.txt"), "utf8");
    for (const key of QUALITY_DIMENSION_KEYS) expect(prompt).toContain(key);
    expect(prompt).toContain("连贯性");
    expect(prompt).toContain("因果");
    // 连贯性与因果是两件事：口径必须写清楚
    expect(prompt).toMatch(/连贯性管「前后对得上」，因果管「推得动」/);
    // 明确禁止商业口径与更远期的字段
    expect(prompt).toContain("不要用商业价值");
    for (const forbidden of ["severity", "confidence", "evidence", "attribution"]) {
      expect(prompt.toLowerCase()).not.toContain(forbidden);
    }
    // 不允许模型自己扩维度
    expect(prompt).toContain("不要增加第五个维度");
  });

  it("审阅提示词没有新增占位符（BasicReviewer 的占位符白名单不变）", () => {
    const prompt = readFileSync(join(repoRoot(), "prompts", "reviewer.txt"), "utf8");
    const placeholders = new Set(prompt.match(/\{\{[a-z_]+\}\}/g) ?? []);
    expect([...placeholders].sort()).toEqual([
      "{{conflict}}", "{{ending}}", "{{extra_requirements}}", "{{genre}}", "{{premise}}",
      "{{protagonist}}", "{{setting}}", "{{stakes}}", "{{story}}", "{{style}}",
      "{{target_words}}", "{{title}}",
    ]);
  });

  it("维度不会把本机路径或凭据带进产物", () => {
    const quality: QualityResult = {
      overall_score: 73.5,
      validation_passed: true,
      accepted: true,
      issues: [],
      suggestions: [],
      summary: "总体可读。",
      dimensions: DIMENSIONS,
    };
    const text = JSON.stringify(quality);
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("sk-");
  });
});
