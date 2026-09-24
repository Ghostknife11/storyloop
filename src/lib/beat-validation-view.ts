import type { BeatValidationIssue, BeatValidationResult } from "@/types/beat-validation";

/**
 * v1.4.0 Beat Validation 区域的唯一状态推导（与 validation-view / quality-view 同一套模式）。
 * §7：校验没过 ≠ Run 失败，因此这里绝不产出「整个结果页失败」的状态，
 * 也不产出任何「改写 / 重排 / 补拍」的动作建议——本版本只报告，不修复。
 * §37：beat_validation 缺失（更早的 Run / 没跑这一步）时整体隐藏，不白屏。
 */
export type BeatValidationPanelState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | {
      kind: "ready";
      passed: boolean;
      issues: BeatValidationIssue[];
      summary: string;
    }
  | { kind: "failed"; error: string };

export function beatValidationPanelState(input: {
  beatValidation: BeatValidationResult | null;
  beatValidationStatus: string;
  beatValidationError?: string | null;
  validating?: boolean;
}): BeatValidationPanelState {
  if (input.validating) return { kind: "loading" };
  if (input.beatValidation) {
    return {
      kind: "ready",
      passed: input.beatValidation.passed,
      issues: input.beatValidation.issues,
      summary: input.beatValidation.summary,
    };
  }
  if (input.beatValidationStatus === "failed") {
    return {
      kind: "failed",
      error: input.beatValidationError?.trim() || "BeatValidator 未返回有效校验结果",
    };
  }
  return { kind: "hidden" };
}

/** §4 命中项里涉及的拍号统一展示成「Beat 3」这种形式；没有指明就是整份骨架的问题。 */
export function beatIssueLabel(beatIds: readonly number[] | undefined): string | null {
  if (!beatIds || beatIds.length === 0) return null;
  return beatIds.map((id) => `Beat ${id}`).join(" / ");
}
