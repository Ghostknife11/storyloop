export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

/** §17 Review 状态：与 Run status 分开记录，Review 失败不影响 Run 本身。 */
export type ReviewStatus = "not_started" | "reviewing" | "completed" | "failed";

/** §5 ReviewResult：一个整体分数 + 总结 + 优点 + 问题。§10 禁止多维 / 严重度 / 证据等字段。 */
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
  return result;
}
