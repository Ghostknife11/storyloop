import type { ValidationResult } from "@/types/validation-result";

/**
 * §28/§30 Validation 区域的唯一状态推导（与 review-view.ts 同一套模式）。
 * §30 Validation Failed 只是硬性检查未通过：正文继续显示，Run 仍是 completed，
 * 因此这里绝不产出「整个结果页失败」的状态，也不产出任何重试建议。
 */
export type ValidationPanelState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ready"; passed: boolean; issues: ValidationResult["issues"] }
  | { kind: "failed"; error: string };

export function validationPanelState(input: {
  validation: ValidationResult | null;
  validationStatus: string;
  validationError?: string | null;
  revalidating?: boolean;
}): ValidationPanelState {
  if (input.revalidating) return { kind: "loading" };
  if (input.validation) {
    return {
      kind: "ready",
      passed: input.validation.passed,
      issues: input.validation.issues,
    };
  }
  if (input.validationStatus === "failed") {
    return {
      kind: "failed",
      error: input.validationError?.trim() || "Validator 未返回有效校验结果",
    };
  }
  return { kind: "hidden" };
}
