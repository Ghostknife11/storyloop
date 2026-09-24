import type { QualityIssue, QualityResult, QualitySuggestion } from "@/types/quality";

/**
 * v1.2.0 Quality Summary 区域的唯一状态推导（与 review-view / validation-view 同一套写法）。
 *
 * §34 边界：这里只做「怎么显示」的判断，绝不产出多维分数、趋势、PASS/FAIL 等级一类
 * v1.3+ 才有的东西。§37：quality 缺失（更早的响应 / 尚未装配）时整体隐藏，不白屏。
 */
export type QualityPanelState =
  | { kind: "hidden" }
  | {
      kind: "ready";
      /** §33：只有一个整体分；没有审阅结论时是 —（不是 0，也不是 NaN）。 */
      overallScoreText: string;
      /** §7：校验没过与「校验没跑」是两件事，文案必须能区分。 */
      validationText: string;
      validationTone: "ok" | "bad" | "unknown";
      /** §8：采纳结论直接来自 RetryPolicy。 */
      acceptedText: string;
      issues: QualityIssue[];
      suggestions: QualitySuggestion[];
      summary: string | null;
    };

/** §32：分数只显示「74 / 100」这一个数，没有等级、没有多维。 */
export function qualityScoreText(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
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
  };
}
