import {
  aggregateDimensionScore,
  DIMENSION_SCORE_MAX,
  DIMENSION_SCORE_MIN,
  QUALITY_DIMENSION_KEYS,
  type QualityDimensions,
} from "@/types/quality-dimensions";

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

/** §17 Review 状态：与 Run status 分开记录，Review 失败不影响 Run 本身。 */
export type ReviewStatus = "not_started" | "reviewing" | "completed" | "failed";

/**
 * §5 ReviewResult：一个整体分数 + 总结 + 优点 + 问题。
 * §10 禁止严重度 / 证据 / 置信度等字段。
 *
 * v1.3.0 起多了可选的 dimensions（§2）：四个基础质量维度。
 * 它同样是可选的（§16）——没有它时整条链路退回 v1.2 的纯整体分行为。
 */
export interface ReviewResult {
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
  /**
   * §14 方案A：可选的改进建议。v1.2.0 新增，v1.2.0 之前与更早的 review.json 都没有这个键。
   * 因此它是可选的：缺失时按旧结构解析，缺字段不等于解析失败（§16）。
   */
  suggestions?: string[];
  /**
   * §2 v1.3.0 可选的四个维度评分。缺失（更早的 review.json、或模型没按格式输出）时
   * 整个键不出现，overall_score 继续由 score 给（§16）。
   * 一旦出现，四个维度必须齐全、各自 0 ~ 100 且带非空短评——缺维度按解析失败处理，
   * 不偷偷补 0（§12），因为补出来的 0 会被当成真实评价参与展示。
   */
  dimensions?: QualityDimensions;
}

/** §6 Score 范围：0 ~ 100，越界一律拒绝（§51/§52）。 */
export const REVIEW_SCORE_MIN = 0;
export const REVIEW_SCORE_MAX = 100;

function reviewItems(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new ReviewValidationError(`${field} 必须是数组`);
  return raw.map((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ReviewValidationError(`${field}[${i}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/**
 * §18 v1.3.0：一次审阅的「整体分」口径。有维度时是四维均分，否则就是 score。
 * QualityAssembler、RetryPolicy 与各处 metadata 都读这一个函数，
 * 保证「门槛比的分」「UI 显示的分」「落盘记的分」永远是同一个数。
 * 注意它仍然只有一个分——不会按维度分别设阈值。
 */
export function reviewOverallScore(review: ReviewResult): number {
  return review.dimensions ? aggregateDimensionScore(review.dimensions) : review.score;
}

/**
 * §12 维度 schema 校验：出现就必须四个齐全、各自 0 ~ 100 且带非空短评。
 * 缺维度、多维度（模型自作聪明扩到 35 维）、类型不对，一律按解析失败处理——
 * 不补 0、不挑一个先凑着，因为补出来的数会被当成真实评价参与聚合与展示。
 */
export function validateQualityDimensions(raw: unknown): QualityDimensions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReviewValidationError("dimensions 必须是包含四个维度的对象");
  }
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(QUALITY_DIMENSION_KEYS);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      throw new ReviewValidationError(
        `dimensions 包含未知维度 ${key}（只支持 ${QUALITY_DIMENSION_KEYS.join(" / ")}）`,
      );
    }
  }

  const out = {} as QualityDimensions;
  for (const key of QUALITY_DIMENSION_KEYS) {
    const d = r[key];
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      throw new ReviewValidationError(`dimensions.${key} 缺失或不是对象`);
    }
    const { score, summary } = d as Record<string, unknown>;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new ReviewValidationError(`dimensions.${key}.score 必须是数字`);
    }
    if (score < DIMENSION_SCORE_MIN || score > DIMENSION_SCORE_MAX) {
      throw new ReviewValidationError(
        `dimensions.${key}.score 必须在 ${DIMENSION_SCORE_MIN} ~ ${DIMENSION_SCORE_MAX} 之间（实际 ${score}）`,
      );
    }
    const text = typeof summary === "string" ? summary.trim() : "";
    if (!text) throw new ReviewValidationError(`dimensions.${key}.summary 不能为空`);
    out[key] = { score, summary: text };
  }
  return out;
}

/** §15 schema 校验：只查结构，不评价 Review 本身的质量。 */
export function validateReviewResult(raw: unknown): ReviewResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const score = r.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new ReviewValidationError("score 必须是数字");
  }
  if (score < REVIEW_SCORE_MIN || score > REVIEW_SCORE_MAX) {
    throw new ReviewValidationError(
      `score 必须在 ${REVIEW_SCORE_MIN} ~ ${REVIEW_SCORE_MAX} 之间（实际 ${score}）`,
    );
  }

  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) throw new ReviewValidationError("summary 不能为空");

  const result: ReviewResult = {
    score,
    summary,
    strengths: reviewItems(r.strengths, "strengths"),
    problems: reviewItems(r.problems, "problems"),
  };
  // §16：旧 JSON 没有 suggestions（或手改成 null）时整个键不出现，
  // 这样 v1.0 / v1.1 落盘的 review.json 读回来与当年逐字一致。
  if (r.suggestions !== undefined && r.suggestions !== null) {
    result.suggestions = reviewItems(r.suggestions, "suggestions");
  }
  // §16：同 suggestions，v1.3.0 之前落盘的 review.json 没有 dimensions 这个键；
  // 缺失或显式 null 时整个键不出现，旧文件读回来逐字一致。
  if (r.dimensions !== undefined && r.dimensions !== null) {
    result.dimensions = validateQualityDimensions(r.dimensions);
  }
  return result;
}
