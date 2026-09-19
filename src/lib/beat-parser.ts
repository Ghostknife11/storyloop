import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

export class BeatParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatParseError";
  }
}

/** §12 允许的轻量清理：trim + 移除 markdown code fence。 */
function stripFence(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  return text;
}

/**
 * §12 BeatPlan Parser：raw LLM output → 清理 → JSON parse → schema 校验 → BeatPlan。
 * 禁止智能修复（§12）：非法就是非法，抛 BeatParseError 由用户手动 Regenerate（§13）。
 */
export function parseBeatPlan(raw: string): BeatPlan {
  const text = stripFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new BeatParseError(`Planner 输出不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  return validateBeatPlan(json);
}
