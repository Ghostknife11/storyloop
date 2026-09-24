import { validateBeatValidationResult, type BeatValidationResult } from "@/types/beat-validation";

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
 * §15 BeatValidation Parser：raw LLM output → 清理 → JSON parse → schema 校验 → BeatValidationResult。
 * 与 review-parser / beat-parser 同一套写法：非法就是非法，抛 BeatValidationParseError，
 * 由调用方决定怎么处理（§15 禁止构建 LLM JSON Repair Agent）。
 */
export function parseBeatValidationResult(raw: string): BeatValidationResult {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BeatValidationParseError(
      `BeatValidator 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validateBeatValidationResult(json);
}
