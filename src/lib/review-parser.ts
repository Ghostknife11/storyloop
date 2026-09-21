import { validateReviewResult, type ReviewResult } from "@/types/review-result";

export class ReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewParseError";
  }
}

/** §15 允许的轻量清理：trim + 移除 markdown code fence。 */
function stripFence(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  return text;
}

/**
 * §15 Review Parser：raw LLM output → 清理 → JSON parse → schema 校验 → ReviewResult。
 * 禁止构建 LLM JSON Repair Agent（§15）：非法就是非法，抛 ReviewParseError，
 * 由用户手动 Review Again（§30），业务层不自动重试。
 */
export function parseReviewResult(raw: string): ReviewResult {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ReviewParseError(
      `Reviewer 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validateReviewResult(json);
}
