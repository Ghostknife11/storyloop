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

  return {
    score,
    summary,
    strengths: reviewItems(r.strengths, "strengths"),
    problems: reviewItems(r.problems, "problems"),
  };
}
