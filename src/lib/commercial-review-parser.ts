import {
  validateCommercialReviewResult,
  type CommercialReviewResult,
} from "@/types/commercial-review";
import { stripFence } from "@/lib/review-parser";

export class CommercialReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialReviewParseError";
  }
}

/**
 * §23 Commercial Review Parser：raw LLM output → 清理 → JSON parse → schema 校验
 * → CommercialReviewResult。
 *
 * 与 §15 同一条规矩：非法就是非法，抛 CommercialReviewParseError，
 * 不构建 LLM JSON Repair Agent，业务层也不自动重试——
 * 商业审阅失败只让这一路结论缺失（TASK §24），故事本身照常成立。
 */
export function parseCommercialReviewResult(raw: string): CommercialReviewResult {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new CommercialReviewParseError(
      `Commercial Reviewer 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return validateCommercialReviewResult(json);
  } catch (e) {
    throw new CommercialReviewParseError(
      e instanceof Error ? e.message : `Commercial Reviewer 输出不合法：${String(e)}`,
    );
  }
}
