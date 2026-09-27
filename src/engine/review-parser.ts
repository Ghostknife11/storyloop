import {
  validateQualityReviewV2Result,
  type QualityReviewV2Result,
} from "@/domain/quality-review-v2";

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewParseError";
  }
}

/** §15 允许的轻量清理：trim + 移除 markdown code fence。 */
export function stripFence(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  return text;
}

/**
 * v2.1.0 Quality Reviewer v2 Parser：raw LLM output → 清理 → JSON parse → schema 校验
 * → QualityReviewV2Result（TASK §37）。
 *
 * 与 v1.x 同一条规矩：非法就是非法，抛 ReviewParseError，不构建 LLM JSON Repair Agent，
 * 业务层也不自动重试。错误名沿用 v1.x 的 ReviewParseError——对外错误契约
 * （REVIEW_FAILED / REVIEW_PARSE_ERROR / REVIEW_COMPONENT_FAILED）因此一个字都不用改。
 *
 * v2 起 schema 更严：四个维度必须齐全（v1.x 允许没有维度的旧格式），
 * 每个维度必须带 strengths / problems，diagnostics 必须过 QualityDiagnostic 校验。
 */
export function parseQualityReviewV2Result(raw: string): QualityReviewV2Result {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ReviewParseError(
      `Reviewer 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return validateQualityReviewV2Result(json);
  } catch (e) {
    throw new ReviewParseError(
      e instanceof Error ? e.message : `Reviewer 输出不合法：${String(e)}`,
    );
  }
}
