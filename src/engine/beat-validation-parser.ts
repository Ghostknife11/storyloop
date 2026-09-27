import {
  validateBeatValidationV2Result,
  type BeatValidationV2Result,
} from "@/domain/beat-validation-v2";

export class BeatValidationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatValidationParseError";
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
 * v2.1.0 Beat Validator v2 Parser：raw LLM output → 清理 → JSON parse → schema 校验
 * → BeatValidationV2Result（TASK §14/§37）。
 *
 * 与 v1.x 同一条规矩：非法就是非法，抛 BeatValidationParseError，
 * 不构建 LLM JSON Repair Agent，业务层也不自动重试。
 *
 * v2 起命中项写成统一 diagnostics（category = 十一个稳定 Code 之一），
 * 不再接受模型自报的 passed——布尔结论由诊断重新推导。
 */
export function parseBeatValidationV2Result(raw: string): BeatValidationV2Result {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BeatValidationParseError(
      `BeatValidator 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return validateBeatValidationV2Result(json);
  } catch (e) {
    throw new BeatValidationParseError(
      e instanceof Error ? e.message : `BeatValidator 输出不合法：${String(e)}`,
    );
  }
}
