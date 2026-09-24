import { reviewOverallScore, type ReviewResult } from "@/types/review-result";

/**
 * §32 分数展示：只显示「74 / 100」。
 * 禁止 PASS / FAIL / Needs Retry / S/A/B/C 等级（§32/§69）。
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/**
 * §31/§34 Review 区域的唯一状态推导。
 * Review 失败只是面板失败：Story 继续显示，且允许 Review Again（§34），
 * 因此这里绝不产出「整个结果页失败」的状态。
 */
export type ReviewPanelState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ready"; scoreText: string; summary: string; strengths: string[]; problems: string[] }
  | { kind: "failed"; error: string };

export function reviewPanelState(input: {
  review: ReviewResult | null;
  reviewStatus: string;
  reviewError?: string | null;
  reReviewing?: boolean;
}): ReviewPanelState {
  if (input.reReviewing) return { kind: "loading" };
  if (input.review) {
    return {
      kind: "ready",
      // v1.3.0 §18：有维度时整体分取四维均分，和 Quality 面板、重试门槛同一个口径。
      scoreText: formatScore(reviewOverallScore(input.review)),
      summary: input.review.summary,
      strengths: input.review.strengths,
      problems: input.review.problems,
    };
  }
  if (input.reviewStatus === "failed") {
    return { kind: "failed", error: input.reviewError?.trim() || "Reviewer 未返回有效评价" };
  }
  return { kind: "hidden" };
}
