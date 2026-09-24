/**
 * v1.2.0 QualityAssembler：把已有的 ValidationResult / ReviewResult / 采纳结论
 * 统一装配成 QualityResult。
 *
 * §17/§19 硬约束：纯函数——不调用 LLM、不调用 Retry、不修改 Story、不碰文件系统、
 * 不读环境变量。同样的输入必然得到同样的输出，因此可以随时重算、随时测试。
 * §39/§40：RetryPolicy 与 RepairStrategy 都不改成依赖 QualityResult，这里只消费它们的结论。
 *
 * 装配规则（§6/§7/§8/§11/§12/§14/§18）：
 *   overall_score     ← 有维度时取四维均值，否则取 review.score；两者都没有就是 null（不自己打分）
 *   validation_passed ← validation.passed，没有校验结论就是 null（不与「校验没过」混淆）
 *   accepted          ← 调用方给的采纳结论（RetryPolicy 的既有判定）
 *   issues            ← 校验命中项（category = code，带 severity）+ 审阅问题（category = review_problem）
 *   suggestions       ← review.suggestions（§14 方案A）；没有就不造
 *   summary           ← review.summary，没有审阅结论就是 null
 *   dimensions        ← review.dimensions 原样搬运（v1.3.0）；没有就是整键不出现
 */

import type { QualityIssue, QualityResult, QualitySuggestion } from "@/types/quality";
import type { ValidationResult } from "@/types/validation-result";
import { reviewOverallScore, type ReviewResult } from "@/types/review-result";

/** §18 输入：三个已经存在的结论，缺哪一路就传 null。 */
export interface QualityAssemblyInput {
  validation: ValidationResult | null;
  review: ReviewResult | null;
  accepted: boolean;
}

/** §12：审阅侧的问题没有严重度，统一归一个稳定类别，不在本版本做复杂问题分类。 */
export const REVIEW_PROBLEM_CATEGORY = "review_problem";

/** §11：校验命中项 → QualityIssue，id 按出现顺序编号保证确定性。 */
function validationIssues(validation: ValidationResult | null): QualityIssue[] {
  if (!validation) return [];
  return validation.issues.map((issue, i) => ({
    id: `validation-${i + 1}`,
    source: "validation" as const,
    category: issue.code,
    message: issue.message,
    severity: issue.severity,
  }));
}

/** §12：审阅问题 → QualityIssue，原文照抄，不改写、不归类、不合并。 */
function reviewIssues(review: ReviewResult | null): QualityIssue[] {
  if (!review) return [];
  return review.problems.map((problem, i) => ({
    id: `review-${i + 1}`,
    source: "review" as const,
    category: REVIEW_PROBLEM_CATEGORY,
    message: problem,
  }));
}

/** §14 方案A：建议来自 ReviewResult 的可选 suggestions；缺失或不是数组就当没有建议。 */
function reviewSuggestions(review: ReviewResult | null): QualitySuggestion[] {
  if (!review || !Array.isArray(review.suggestions)) return [];
  return review.suggestions.map((message, i) => ({
    id: `review-suggestion-${i + 1}`,
    source: "review" as const,
    message,
  }));
}

/**
 * §18 整体分：有维度时取四维均值（四舍五入到 1 位小数），否则沿用 review.score。
 * 这是一次确定性换算，不是新的评价——维度由 Reviewer 给，本函数只做算术。
 */
function overallScoreOf(review: ReviewResult | null): number | null {
  if (!review) return null;
  return reviewOverallScore(review);
}

/** §18：维度原样搬运，不挑一个代表、不改分、不补缺的维度。 */
function dimensionsOf(review: ReviewResult | null): QualityResult["dimensions"] {
  return review?.dimensions ? review.dimensions : undefined;
}

export class QualityAssembler {
  assemble(input: QualityAssemblyInput): QualityResult {
    const dimensions = dimensionsOf(input.review);
    return {
      overall_score: overallScoreOf(input.review),
      validation_passed: input.validation ? input.validation.passed : null,
      accepted: input.accepted,
      issues: [...validationIssues(input.validation), ...reviewIssues(input.review)],
      suggestions: reviewSuggestions(input.review),
      summary: input.review ? input.review.summary : null,
      ...(dimensions ? { dimensions } : {}),
    };
  }
}
