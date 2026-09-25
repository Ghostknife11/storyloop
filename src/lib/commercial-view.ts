import {
  COMMERCIAL_DIMENSION_KEYS,
  COMMERCIAL_DIMENSION_LABELS,
  COMMERCIAL_DIMENSION_SHORTS,
  commercialOverallScore,
  type CommercialDimensionKey,
  type CommercialReviewResult,
} from "@/types/commercial-review";
import { formatScore } from "@/lib/review-view";

/** §27/§41 一个商业维度的展示行：键、短标记、维度名、分数、进度条百分比、短评。 */
export interface CommercialDimensionView {
  key: CommercialDimensionKey;
  short: string;
  label: string;
  scoreText: string;
  /** 进度条宽度：分数本身就是 0 ~ 100 的百分数，不再换算。 */
  percent: number;
  summary: string;
}

/**
 * §27/§24 Commercial Review 区域的唯一状态推导。
 * §24/§25：商业审阅这一路自身失败只是面板失败——故事、校验、质量结论全部保留，
 * 因此这里绝不产出「整个结果页失败」的状态。
 * §32：旧 Run 没有 commercial-review.json 时整个区域不出现（与 Quality 面板同一约定），
 * 不占位、不编一个「0 分」冒充没跑过。
 */
export type CommercialPanelState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | {
      kind: "ready";
      scoreText: string;
      summary: string;
      strengths: string[];
      problems: string[];
      suggestions: string[];
      dimensions: CommercialDimensionView[];
    }
  | { kind: "failed"; error: string };

/** §27：维度行按固定顺序（H / P / E / Pf）产出，纯展示换算，不改分。 */
function dimensionViewsOf(review: CommercialReviewResult): CommercialDimensionView[] {
  return COMMERCIAL_DIMENSION_KEYS.map((key) => {
    const d = review.dimensions[key];
    const scoreText = formatScore(d.score);
    return {
      key,
      short: COMMERCIAL_DIMENSION_SHORTS[key],
      label: COMMERCIAL_DIMENSION_LABELS[key],
      scoreText,
      percent: Number.isFinite(d.score) ? Math.max(0, Math.min(100, d.score)) : 0,
      summary: d.summary,
    };
  });
}

export function commercialPanelState(input: {
  commercialReview: CommercialReviewResult | null;
  commercialReviewStatus: string;
  commercialReviewError?: string | null;
  reReviewing?: boolean;
}): CommercialPanelState {
  if (input.reReviewing) return { kind: "loading" };
  if (input.commercialReview) {
    return {
      kind: "ready",
      // §11：整体分与 metadata 的 commercial_score、commercial-review.json 的 score 同一个口径
      scoreText: formatScore(commercialOverallScore(input.commercialReview)),
      summary: input.commercialReview.summary,
      strengths: input.commercialReview.strengths,
      problems: input.commercialReview.problems,
      suggestions: input.commercialReview.suggestions,
      dimensions: dimensionViewsOf(input.commercialReview),
    };
  }
  if (input.commercialReviewStatus === "failed") {
    return { kind: "failed", error: input.commercialReviewError?.trim() || "商业审阅未返回有效评价" };
  }
  return { kind: "hidden" };
}
