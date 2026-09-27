import {
  validateCommercialReviewV2Result,
  type CommercialReviewV2Result,
} from "@/domain/commercial-review-v2";
import { stripFence } from "@/engine/review-parser";

export class CommercialReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialReviewParseError";
  }
}

/**
 * v2.1.0 Commercial Review Parser：raw LLM output → 清理 → JSON parse → schema 校验
 * → CommercialReviewV2Result。
 *
 * 与 §15 同一条规矩：非法就是非法，抛 CommercialReviewParseError，
 * 不构建 LLM JSON Repair Agent，业务层也不自动重试——
 * 商业审阅失败只让这一路结论缺失（TASK §24），故事本身照常成立。
 *
 * v2 起 schema 更严：四个维度必须齐全（旧格式里没有维度就没有退路），
 * 每个维度除分数与短评外还必须带 strengths / problems，诊断走统一的
 * QualityDiagnostic 校验（TASK §18/§19）。
 */
export function parseCommercialReviewV2Result(raw: string): CommercialReviewV2Result {
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
    return validateCommercialReviewV2Result(json);
  } catch (e) {
    throw new CommercialReviewParseError(
      e instanceof Error ? e.message : `Commercial Reviewer 输出不合法：${String(e)}`,
    );
  }
}
