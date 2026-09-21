/**
 * §5 GenerationAttempt：一次完整的故事生成尝试。
 * §7：从 v0.7.0 起一个 Run 可以包含多个 Attempt。
 * §6：attempt_number 从 1 开始连续递增。
 * 与 network retry（§29）无关——这是 Pipeline 级别的故事生成尝试。
 * v0.8.0 新增 repairs（§17）：同一次 Attempt 内部做过的定点修订，按发生顺序排列。
 * Repair 不新增 Attempt，所以记录挂在 Attempt 上，而不是多一个 attempt_number。
 */

import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";
import type { RepairRecord, RepairSummary } from "@/types/repair";
import { repairSummary, validateRepairRecord } from "@/types/repair";
import { RETRY_REASONS, type RetryReason } from "@/core/retry-policy";

export interface GenerationAttempt {
  attempt_number: number;
  /** §20 生成异常时为 null：正文没拿到，attempt 目录里也不会有 story.md。 */
  story: string | null;
  /** Validator 自身异常时为 null（§12）。 */
  validation: ValidationResult | null;
  /** Reviewer 未执行 / 自身异常时为 null（§12/§18）。 */
  review: ReviewResult | null;
  /** §17 被 RetryPolicy 接受（selected）时为 true。 */
  accepted: boolean;
  /** §22 稳定 reason；accepted 时为 null。 */
  retry_reason: RetryReason | null;
  /** §24 本次尝试自身的错误（生成 / 校验 / 审阅异常的安全摘要）。 */
  error: string | null;
  /** §17 本次 Attempt 内发生过的 Repair；一次都没修时是空数组。 */
  repairs: RepairRecord[];
}

/** §51 Attempt 编号 / reason 必须合法，否则 attempt metadata 不可信。 */
export class GenerationAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationAttemptError";
  }
}

/** §24/§38 metadata 与 API 响应用的摘要：不带正文全文（§38 默认不必返回全文）。 */
export interface AttemptSummary {
  attempt_number: number;
  accepted: boolean;
  retry_reason: RetryReason | null;
  review_score: number | null;
  validation_passed: boolean | null;
  /** §40 本次 Attempt 内发生过的 Repair 次数。 */
  repair_count: number;
  /** §40 只含编号 / 类型 / 成败，不带修订正文与完整结论。 */
  repairs: RepairSummary[];
}

export function validateAttemptNumber(attemptNumber: unknown): number {
  if (
    typeof attemptNumber !== "number" ||
    !Number.isInteger(attemptNumber) ||
    attemptNumber < 1
  ) {
    throw new GenerationAttemptError(
      `attempt_number 必须是 >= 1 的整数（实际 ${String(attemptNumber)}）`,
    );
  }
  return attemptNumber;
}

/** §33 Attempt 目录名：两位零填充，Windows 与文件系统都安全。 */
export function attemptDirectoryName(attemptNumber: number): string {
  validateAttemptNumber(attemptNumber);
  if (attemptNumber > 99) {
    throw new GenerationAttemptError(`attempt_number 不能超过 99（实际 ${attemptNumber}）`);
  }
  return String(attemptNumber).padStart(2, "0");
}

export function validateRetryReason(raw: unknown): RetryReason | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  if (!RETRY_REASONS.includes(raw as RetryReason)) {
    throw new GenerationAttemptError(`retry_reason 非法：${raw}`);
  }
  return raw as RetryReason;
}

/** §5/§24 Attempt 的结构校验：只查形状，不重新判断这一次重试是否合理。 */
export function validateGenerationAttempt(raw: unknown): GenerationAttempt {
  const r = (raw ?? {}) as Record<string, unknown>;
  const attemptNumber = validateAttemptNumber(r.attempt_number);

  const story = r.story === null || r.story === undefined ? null : r.story;
  if (story !== null && typeof story !== "string") {
    throw new GenerationAttemptError(`attempts[${attemptNumber}].story 必须是字符串或 null`);
  }

  const accepted = r.accepted;
  if (typeof accepted !== "boolean") {
    throw new GenerationAttemptError(`attempts[${attemptNumber}].accepted 必须是布尔值`);
  }

  const retryReason = validateRetryReason(r.retry_reason);
  if (accepted && retryReason !== null) {
    throw new GenerationAttemptError(
      `attempts[${attemptNumber}] 已 accepted，不应再带 retry_reason`,
    );
  }
  const error = r.error === null || r.error === undefined ? null : r.error;
  if (error !== null && typeof error !== "string") {
    throw new GenerationAttemptError(`attempts[${attemptNumber}].error 必须是字符串或 null`);
  }

  // §5：未 accepted 时必须能说明原因——retry_reason 或 error 任一即可。
  if (!accepted && retryReason === null && error === null) {
    throw new GenerationAttemptError(
      `attempts[${attemptNumber}] 未 accepted，必须给出 retry_reason 或 error`,
    );
  }

  const validation =
    r.validation === null || r.validation === undefined ? null : (r.validation as ValidationResult);
  const review =
    r.review === null || r.review === undefined ? null : (r.review as ReviewResult);
  // §17：repairs 缺省视为空数组——没有修订的 Attempt 与 v0.7.0 产物保持同构。
  const rawRepairs = r.repairs === null || r.repairs === undefined ? [] : r.repairs;
  if (!Array.isArray(rawRepairs)) {
    throw new GenerationAttemptError(`attempts[${attemptNumber}].repairs 必须是数组`);
  }
  const repairs = rawRepairs.map((item) => {
    try {
      return validateRepairRecord(item);
    } catch (e) {
      throw new GenerationAttemptError(
        e instanceof Error ? e.message : `attempts[${attemptNumber}].repairs[?] 非法`,
      );
    }
  });

  return {
    attempt_number: attemptNumber,
    story,
    validation,
    review,
    accepted,
    retry_reason: retryReason,
    error,
    repairs,
  };
}

/** §38 Attempt → AttemptSummary：UI / API 只暴露摘要，不暴露全部正文。 */
export function attemptSummary(attempt: GenerationAttempt): AttemptSummary {
  return {
    attempt_number: attempt.attempt_number,
    accepted: attempt.accepted,
    retry_reason: attempt.retry_reason,
    review_score: attempt.review ? attempt.review.score : null,
    validation_passed: attempt.validation ? attempt.validation.passed : null,
    repair_count: attempt.repairs.length,
    repairs: attempt.repairs.map(repairSummary),
  };
}
