/**
 * v2.1.0 Commercial Reviewer v2 的输出契约（TASK §17/§18/§19/§20）。
 *
 * 与 v1.5.0 的 CommercialReviewResult 是同一套评价的升级版，不是第二套评价：
 *   - 维度仍然是 H / P / E / Pf 四个，含义一字不改（TASK §17「继续保留」）；
 *   - 整体分仍然是四维均分，由系统确定性计算，没有权重、没有题材适配；
 *   - 每个维度从「分数 + 短评」升级为「分数 + 短评 + strengths + problems」；
 *   - 新增结构化 diagnostics（TASK §17），problems 不再散落在四个字符串里。
 *
 * §20 Payoff 边界：Payoff 仍然只是 0~100 的商业评价维度。它不演化成
 * Payoff Discovery Engine / Foreshadow Graph / Promise Tracking Engine /
 * Evidence Ledger——所以这里只有维度分、短评与诊断，没有承诺清单、
 * 没有伏笔图、没有兑现追踪。
 *
 * 边界（TASK §14/§28）：仍然只评价、不改写、不决定重试。
 * 诊断数量再多也不参与 RetryPolicy / RepairStrategy 的判定。
 */

import {
  COMMERCIAL_DIMENSION_KEYS,
  COMMERCIAL_SCORE_MAX,
  COMMERCIAL_SCORE_MIN,
  aggregateCommercialDimensions,
  type CommercialDimensionKey,
  type CommercialReviewResult,
} from "@/domain/commercial-review";
import {
  validateQualityDiagnostics,
  type QualityDiagnostic,
} from "@/domain/quality-diagnostic";

export class CommercialReviewV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialReviewV2ValidationError";
  }
}

/** §18 单个商业维度的结论：分数 + 短评 + 这个维度上的优点 / 问题。 */
export interface CommercialDimensionResult {
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
}

/** §18 CommercialReviewV2Result：四维 + 统一诊断 + 一句话总结。 */
export interface CommercialReviewV2Result {
  /** 永远是四个维度的确定性均分（见 validateCommercialReviewV2Result）。 */
  score: number;
  dimensions: Record<CommercialDimensionKey, CommercialDimensionResult>;
  diagnostics: QualityDiagnostic[];
  summary: string;
}

function dimensionStrings(raw: unknown, field: string, where: string): string[] {
  if (!Array.isArray(raw)) {
    throw new CommercialReviewV2ValidationError(`${where}.${field} 必须是数组`);
  }
  return raw.map((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new CommercialReviewV2ValidationError(`${where}.${field}[${i}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/**
 * §37 维度 schema：H / P / E / Pf 一个都不能少，也不许多出第五个。
 * 缺维度、多维度、分数越界、短评为空、strengths / problems 不是字符串数组，
 * 一律按解析失败处理——不补 0、不挑一个先凑着。
 */
function validateCommercialDimensionResults(
  raw: unknown,
): Record<CommercialDimensionKey, CommercialDimensionResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialReviewV2ValidationError("dimensions 必须是包含四个商业维度的对象");
  }
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(COMMERCIAL_DIMENSION_KEYS);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      throw new CommercialReviewV2ValidationError(
        `dimensions 包含未知维度 ${key}（只支持 ${COMMERCIAL_DIMENSION_KEYS.join(" / ")}）`,
      );
    }
  }

  const out = {} as Record<CommercialDimensionKey, CommercialDimensionResult>;
  for (const key of COMMERCIAL_DIMENSION_KEYS) {
    const d = r[key];
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      throw new CommercialReviewV2ValidationError(`dimensions.${key} 缺失或不是对象`);
    }
    const { score, summary, strengths, problems } = d as Record<string, unknown>;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new CommercialReviewV2ValidationError(`dimensions.${key}.score 必须是数字`);
    }
    if (score < COMMERCIAL_SCORE_MIN || score > COMMERCIAL_SCORE_MAX) {
      throw new CommercialReviewV2ValidationError(
        `dimensions.${key}.score 必须在 ${COMMERCIAL_SCORE_MIN} ~ ${COMMERCIAL_SCORE_MAX} 之间（实际 ${score}）`,
      );
    }
    const text = typeof summary === "string" ? summary.trim() : "";
    if (!text) throw new CommercialReviewV2ValidationError(`dimensions.${key}.summary 不能为空`);
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
 * §37 v2 商业审阅输出 schema：四维齐全 + 诊断合法 + 总结非空。
 *
 * score 与 v1.5.0 同一条规矩：模型自报的分数不被采信，落盘与返回的永远是
 * 四维均分——这样「商业整体分」可复现，也不会出现一个随口报的高分盖住
 * 四个维度的实情。v2 起提示词直接不让模型报整体分（见 §26 的 @2 提示词）。
 */
export function validateCommercialReviewV2Result(raw: unknown): CommercialReviewV2Result {
  const r = (raw ?? {}) as Record<string, unknown>;

  const dimensions = validateCommercialDimensionResults(r.dimensions);

  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) throw new CommercialReviewV2ValidationError("summary 不能为空");

  return {
    score: aggregateCommercialDimensions(dimensions),
    dimensions,
    diagnostics: validateQualityDiagnostics(r.diagnostics ?? [], "commercial-reviewer"),
    summary,
  };
}

/** 读盘用的宽容版：结构认不出来时返回 null，绝不补一条假结论占位。 */
export function commercialReviewV2ResultOf(raw: unknown): CommercialReviewV2Result | null {
  try {
    return validateCommercialReviewV2Result(raw);
  } catch {
    return null;
  }
}

/** 同一句话只留第一次出现，保持旧 DTO 的列表干净（维度之间重复表述很常见）。 */
function uniqueTexts(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * §27 旧 Commercial DTO 兼容层：CommercialReviewV2Result → CommercialReviewResult。
 *
 * v1.5.0 的 commercial-review.json 有顶层 strengths / problems / suggestions，
 * v2 把它们放进了维度与诊断里。这里按固定顺序摊平回去，于是旧客户端读到的
 * 字段一个不少：
 *   strengths  = 四个维度的 strengths（H → P → E → Pf 顺序）
 *   problems   = 四个维度的 problems（同一顺序）
 *   suggestions = 带 suggestion 的诊断（按诊断顺序），没有就整个键不出现
 *   dimensions = 四维的 {score, summary}——与 v1.5.0 落盘的形状逐字一致
 *
 * score 取 v2 的确定性均分：v1.5.0 的 commercialOverallScore 算的就是这个数，
 * 所以 metadata.commercial_score、UI 面板显示的分、/api/review/commercial
 * 的响应全部不变。
 */
export function legacyCommercialReviewOf(review: CommercialReviewV2Result): CommercialReviewResult {
  const strengths: string[] = [];
  const problems: string[] = [];
  for (const key of COMMERCIAL_DIMENSION_KEYS) {
    const dimension = review.dimensions[key];
    strengths.push(...dimension.strengths);
    problems.push(...dimension.problems);
  }

  const suggestions = review.diagnostics
    .map((d) => d.suggestion)
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  const dimensions = {} as Record<CommercialDimensionKey, { score: number; summary: string }>;
  for (const key of COMMERCIAL_DIMENSION_KEYS) {
    dimensions[key] = { score: review.dimensions[key].score, summary: review.dimensions[key].summary };
  }

  const legacy: CommercialReviewResult = {
    score: review.score,
    summary: review.summary,
    strengths: uniqueTexts(strengths),
    problems: uniqueTexts(problems),
    suggestions: uniqueTexts(suggestions),
    dimensions,
  };
  return legacy;
}
