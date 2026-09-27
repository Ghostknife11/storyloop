/**
 * v2.1.0 Quality Reviewer v2 的输出契约（TASK §7/§8/§9/§10/§11/§12）。
 *
 * 与 v1.3.0 的 ReviewResult 是同一套评价的升级版，不是第二套评价：
 *   - 维度仍然是 Co / N / C / Ca 四个，含义一字不改（TASK §9）；
 *   - 整体分仍然是四维均分，由系统确定性计算，没有权重、没有题材适配（TASK §10）；
 *   - 每个维度从「分数 + 短评」升级为「分数 + 短评 + strengths + problems」（TASK §7）；
 *   - 新增结构化 diagnostics（TASK §8），problems 不再只是一句自然语言。
 *
 * 边界（TASK §7/§28）：仍然只评价、不改写、不决定重试。
 * 诊断数量再多也不参与 RetryPolicy / RepairStrategy 的判定。
 */

import {
  DIMENSION_SCORE_MAX,
  DIMENSION_SCORE_MIN,
  QUALITY_DIMENSION_KEYS,
  aggregateDimensionScore,
  type QualityDimensionKey,
} from "@/domain/quality-dimensions";
import {
  validateQualityDiagnostics,
  type QualityDiagnostic,
} from "@/domain/quality-diagnostic";
import type { ReviewResult } from "@/domain/review-result";

export class QualityReviewV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityReviewV2ValidationError";
  }
}

/** §8 单个维度的结论：分数 + 短评 + 这个维度上的优点 / 问题。 */
export interface QualityDimensionResult {
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
}

/** §8 QualityReviewV2Result：四维 + 统一诊断 + 一句话总结。 */
export interface QualityReviewV2Result {
  /** §10：永远是四个维度的确定性均分（见 validateQualityReviewV2Result）。 */
  score: number;
  dimensions: Record<QualityDimensionKey, QualityDimensionResult>;
  diagnostics: QualityDiagnostic[];
  summary: string;
}

function dimensionStrings(raw: unknown, field: string, where: string): string[] {
  if (!Array.isArray(raw)) {
    throw new QualityReviewV2ValidationError(`${where}.${field} 必须是数组`);
  }
  return raw.map((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new QualityReviewV2ValidationError(`${where}.${field}[${i}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/**
 * §37 维度 schema：四个一个都不能少，也不许多出第五个（TASK §7 明确不做 35 维）。
 * 缺维度、多维度、分数越界、短评为空、strengths / problems 不是字符串数组，
 * 一律按解析失败处理——不补 0、不挑一个先凑着。
 */
function validateQualityDimensionResults(raw: unknown): Record<QualityDimensionKey, QualityDimensionResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new QualityReviewV2ValidationError("dimensions 必须是包含四个维度的对象");
  }
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(QUALITY_DIMENSION_KEYS);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      throw new QualityReviewV2ValidationError(
        `dimensions 包含未知维度 ${key}（只支持 ${QUALITY_DIMENSION_KEYS.join(" / ")}）`,
      );
    }
  }

  const out = {} as Record<QualityDimensionKey, QualityDimensionResult>;
  for (const key of QUALITY_DIMENSION_KEYS) {
    const d = r[key];
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      throw new QualityReviewV2ValidationError(`dimensions.${key} 缺失或不是对象`);
    }
    const { score, summary, strengths, problems } = d as Record<string, unknown>;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new QualityReviewV2ValidationError(`dimensions.${key}.score 必须是数字`);
    }
    if (score < DIMENSION_SCORE_MIN || score > DIMENSION_SCORE_MAX) {
      throw new QualityReviewV2ValidationError(
        `dimensions.${key}.score 必须在 ${DIMENSION_SCORE_MIN} ~ ${DIMENSION_SCORE_MAX} 之间（实际 ${score}）`,
      );
    }
    const text = typeof summary === "string" ? summary.trim() : "";
    if (!text) throw new QualityReviewV2ValidationError(`dimensions.${key}.summary 不能为空`);
    out[key] = {
      score,
      summary: text,
      strengths: dimensionStrings(strengths, "strengths", `dimensions.${key}`),
      problems: dimensionStrings(problems, "problems", `dimensions.${key}`),
    };
  }
  return out;
}

/**
 * §37 v2 审阅输出 schema：四维齐全 + 诊断合法 + 总结非空。
 *
 * score 与 v1.5.0 的商业分同一条规矩：模型自报的分数不被采信，落盘与返回的
 * 永远是四维均分——这样「质量整体分」可复现，也不会出现一个随口报的高分
 * 盖住四个维度的实情（TASK §10「系统确定性计算」）。
 */
export function validateQualityReviewV2Result(raw: unknown): QualityReviewV2Result {
  const r = (raw ?? {}) as Record<string, unknown>;

  const dimensions = validateQualityDimensionResults(r.dimensions);

  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) throw new QualityReviewV2ValidationError("summary 不能为空");

  return {
    score: aggregateDimensionScore(dimensions),
    dimensions,
    diagnostics: validateQualityDiagnostics(r.diagnostics ?? [], "quality-reviewer"),
    summary,
  };
}

/** 读盘用的宽容版：结构认不出来时返回 null，绝不补一条假结论占位。 */
export function qualityReviewV2ResultOf(raw: unknown): QualityReviewV2Result | null {
  try {
    return validateQualityReviewV2Result(raw);
  } catch {
    return null;
  }
}

/** 同一句话只留第一次出现，保持旧 DTO 的列表干净（维度之间重复表述很常见）。 */
function uniqueTexts(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * §27 旧 Review DTO 兼容层：QualityReviewV2Result → ReviewResult。
 *
 * v1 的 review.json 有顶层 strengths / problems / suggestions，v2 把它们放进了维度
 * 与诊断里。这里按固定顺序摊平回去，于是旧客户端读到的字段一个不少：
 *   strengths  = 四个维度的 strengths（Co → N → C → Ca 顺序）
 *   problems   = 四个维度的 problems（同一顺序）
 *   suggestions = 带 suggestion 的诊断（按诊断顺序），没有就整个键不出现
 *   dimensions = 四维的 {score, summary}——与 v1.3.0 落盘的形状逐字一致
 *
 * score 取 v2 的确定性均分：v1 的 reviewOverallScore 在有维度时算的就是这个数，
 * 所以 RetryPolicy、metadata.review_score、quality.json 的 overall_score 全部不变。
 */
export function legacyReviewOf(review: QualityReviewV2Result): ReviewResult {
  const strengths: string[] = [];
  const problems: string[] = [];
  for (const key of QUALITY_DIMENSION_KEYS) {
    const dimension = review.dimensions[key];
    strengths.push(...dimension.strengths);
    problems.push(...dimension.problems);
  }

  const suggestions = review.diagnostics
    .map((d) => d.suggestion)
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  const legacy: ReviewResult = {
    score: review.score,
    summary: review.summary,
    strengths: uniqueTexts(strengths),
    problems: uniqueTexts(problems),
  };
  if (suggestions.length > 0) legacy.suggestions = uniqueTexts(suggestions);

  const dimensions = {} as Record<QualityDimensionKey, { score: number; summary: string }>;
  for (const key of QUALITY_DIMENSION_KEYS) {
    dimensions[key] = { score: review.dimensions[key].score, summary: review.dimensions[key].summary };
  }
  legacy.dimensions = dimensions;
  return legacy;
}
