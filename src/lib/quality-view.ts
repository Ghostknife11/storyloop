import type { QualityIssue, QualityResult, QualitySuggestion } from "@/types/quality";
import {
  DIMENSION_LABELS,
  QUALITY_DIMENSION_KEYS,
  type QualityDimensionKey,
} from "@/types/quality-dimensions";

/**
 * v1.2.0 Quality Summary 区域的唯一状态推导（与 review-view / validation-view 同一套写法）。
 *
 * §34 边界：这里只做「怎么显示」的判断。v1.3.0 起多了四个基础维度的呈现方式，
 * 但维度只是评价输出——不产出等级、不做趋势、不给 PASS/FAIL，也不参与任何决策。
 * §37：quality 缺失（更早的响应 / 尚未装配）时整体隐藏，不白屏。
 */
export type QualityPanelState =
  | { kind: "hidden" }
  | {
      kind: "ready";
      /** §33：整体分；没有审阅结论时是 —（不是 0，也不是 NaN）。 */
      overallScoreText: string;
      /** §7：校验没过与「校验没跑」是两件事，文案必须能区分。 */
      validationText: string;
      validationTone: "ok" | "bad" | "unknown";
      /** §8：采纳结论直接来自 RetryPolicy。 */
      acceptedText: string;
      issues: QualityIssue[];
      suggestions: QualitySuggestion[];
      summary: string | null;
      /** v1.3.0 §36：四个维度的展示形态；没有维度（旧 Run）时是空数组，整段不渲染。 */
      dimensions: QualityDimensionView[];
    };

/** v1.3.0 §36：一个维度在面板里的样子（固定顺序、归一化分数文本、进度条百分比）。 */
export interface QualityDimensionView {
  key: QualityDimensionKey;
  label: string;
  scoreText: string;
  /** 0 ~ 100，直接用作进度条宽度；分数本身已由 schema 保证在区间内。 */
  percent: number;
  summary: string;
}

/** §32：整体分只显示「74 / 100」这一个数，没有等级。 */
export function qualityScoreText(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** v1.3.0 §36：维度 → 展示行，顺序固定；缺维度（旧 Run）时是空数组，而不是半截列表。 */
function dimensionViewsOf(quality: QualityResult): QualityDimensionView[] {
  const dimensions = quality.dimensions;
  if (!dimensions) return [];
  return QUALITY_DIMENSION_KEYS.map((key) => {
    const d = dimensions[key];
    return {
      key,
      label: DIMENSION_LABELS[key],
      scoreText: qualityScoreText(d.score),
      percent: Math.max(0, Math.min(100, d.score)),
      summary: d.summary,
    };
  });
}

export function qualityPanelState(input: { quality: QualityResult | null }): QualityPanelState {
  const quality = input.quality;
  if (!quality) return { kind: "hidden" };

  let validationText: string;
  let validationTone: "ok" | "bad" | "unknown";
  if (quality.validation_passed === null) {
    validationText = "未知（校验未完成）";
    validationTone = "unknown";
  } else if (quality.validation_passed) {
    validationText = "通过";
    validationTone = "ok";
  } else {
    validationText = "未通过";
    validationTone = "bad";
  }

  return {
    kind: "ready",
    overallScoreText: qualityScoreText(quality.overall_score),
    validationText,
    validationTone,
    acceptedText: quality.accepted ? "已采纳" : "未采纳",
    issues: quality.issues,
    suggestions: quality.suggestions,
    summary: quality.summary,
    dimensions: dimensionViewsOf(quality),
  };
}
