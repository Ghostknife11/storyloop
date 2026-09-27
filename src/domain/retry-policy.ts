/**
 * v2.0.0 RetryPolicy 契约归入 Domain（§31「RetryPolicy → Domain / Engine」）。
 *
 * 拆成两半，边界按「谁需要它」划：
 *   这里（Domain）：策略形状、默认值、上下限、reason 词表、外部传入值的校验。
 *                  它们是稳定契约——Run metadata、ExperimentDefinition、
 *                  API 请求体、UI 设置面板全都按这套字段说话。
 *   那里（Engine）：decideRetry —— 「这一次 Attempt 要不要再来一遍」的判定逻辑。
 *
 * 拆开之前，v1.x 的 domain/experiment.ts 为了拿 validateRetryPolicy 反向 import
 * `@/core/retry-policy`，制造了一条 Domain → Engine 的依赖（§12 方向倒挂）。
 * 契约归 Domain 之后这条边自然消失，判定逻辑留在 Engine，两边都只向下依赖。
 */

import type { ValidationResult } from "@/domain/validation-result";
import { reviewOverallScore, type ReviewResult } from "@/domain/review-result";

/** §3 RetryPolicy：max_attempts 含首次生成在内（§3/§71）。 */
export interface RetryPolicy {
  max_attempts: number;
  min_review_score: number;
  retry_on_validation_failure: boolean;
  /** §18 是否允许在整篇重试之前先做定点修订。 */
  enable_repair: boolean;
  /** §18/§19 单个 Attempt 内最多修订几次；0 表示退回 v0.7.0 行为。 */
  max_repairs_per_attempt: number;
}

/** §4 默认策略：初次生成 + 最多 1 次自动重试 + 每个 Attempt 最多 1 次定点修订。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 2,
  min_review_score: 70,
  retry_on_validation_failure: true,
  enable_repair: true,
  max_repairs_per_attempt: 1,
};

/** §31 Settings Validation：上限避免误操作造成大量 API 消耗。 */
export const MAX_ATTEMPTS_LIMIT = { min: 1, max: 5 } as const;

/** §34 Settings Validation：Repair 上限 0 ~ 3；0 = 关闭 Repair。 */
export const MAX_REPAIRS_LIMIT = { min: 0, max: 3 } as const;

/** §22 稳定 reason：UI / CLI / metadata 都只用这三个字符串。 */
export type RetryReason =
  | "generation_error"
  | "validation_failed"
  | "review_score_below_threshold";

export const RETRY_REASONS: readonly RetryReason[] = [
  "generation_error",
  "validation_failed",
  "review_score_below_threshold",
];

/** §10 RetryDecision：一个布尔 + 一个稳定 reason。 */
export interface RetryDecision {
  should_retry: boolean;
  reason: RetryReason | null;
}

/** §51/§31 请求或设置里的 retry_policy 不合法时抛出。 */
export class RetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryPolicyError";
  }
}

/**
 * §31 校验外部传入的 RetryPolicy：缺字段用默认值补齐，越界一律拒绝。
 * 只做范围检查，不改变调用方的策略语义。
 */
export function validateRetryPolicy(raw: unknown): RetryPolicy {
  if (raw === undefined || raw === null) return { ...DEFAULT_RETRY_POLICY };
  const r = (raw ?? {}) as Record<string, unknown>;

  const maxAttempts =
    r.max_attempts === undefined || r.max_attempts === null
      ? DEFAULT_RETRY_POLICY.max_attempts
      : r.max_attempts;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < MAX_ATTEMPTS_LIMIT.min ||
    maxAttempts > MAX_ATTEMPTS_LIMIT.max
  ) {
    throw new RetryPolicyError(
      `retry_policy.max_attempts 必须是 ${MAX_ATTEMPTS_LIMIT.min} ~ ${MAX_ATTEMPTS_LIMIT.max} 之间的整数（实际 ${String(maxAttempts)}）`,
    );
  }

  const score =
    r.min_review_score === undefined || r.min_review_score === null
      ? DEFAULT_RETRY_POLICY.min_review_score
      : r.min_review_score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100
  ) {
    throw new RetryPolicyError(
      `retry_policy.min_review_score 必须在 0 ~ 100 之间（实际 ${String(score)}）`,
    );
  }

  const onValidation =
    r.retry_on_validation_failure === undefined || r.retry_on_validation_failure === null
      ? DEFAULT_RETRY_POLICY.retry_on_validation_failure
      : r.retry_on_validation_failure;
  if (typeof onValidation !== "boolean") {
    throw new RetryPolicyError(
      `retry_policy.retry_on_validation_failure 必须是布尔值（实际 ${String(onValidation)}）`,
    );
  }

  const enableRepair =
    r.enable_repair === undefined || r.enable_repair === null
      ? DEFAULT_RETRY_POLICY.enable_repair
      : r.enable_repair;
  if (typeof enableRepair !== "boolean") {
    throw new RetryPolicyError(
      `retry_policy.enable_repair 必须是布尔值（实际 ${String(enableRepair)}）`,
    );
  }

  // §34：上限 0 ~ 3。0 是合法值（关闭 Repair），不能当成「没传」补默认值。
  const maxRepairs =
    r.max_repairs_per_attempt === undefined || r.max_repairs_per_attempt === null
      ? DEFAULT_RETRY_POLICY.max_repairs_per_attempt
      : r.max_repairs_per_attempt;
  if (
    typeof maxRepairs !== "number" ||
    !Number.isInteger(maxRepairs) ||
    maxRepairs < MAX_REPAIRS_LIMIT.min ||
    maxRepairs > MAX_REPAIRS_LIMIT.max
  ) {
    throw new RetryPolicyError(
      `retry_policy.max_repairs_per_attempt 必须是 ${MAX_REPAIRS_LIMIT.min} ~ ${MAX_REPAIRS_LIMIT.max} 之间的整数（实际 ${String(maxRepairs)}）`,
    );
  }

  return {
    max_attempts: maxAttempts,
    min_review_score: score,
    retry_on_validation_failure: onValidation,
    enable_repair: enableRepair,
    max_repairs_per_attempt: maxRepairs,
  };
}

/**
 * decideRetry 的输入。放在这里而不是 Engine：它的字段就是 Run metadata / API 请求体里
 * 那几个事实，是契约的一半；判定顺序本身才是 Engine 的知识。
 */
export interface RetryDecisionInput {
  policy: RetryPolicy;
  /** §6 Attempt 编号从 1 开始连续递增。 */
  attempt_number: number;
  /** §22 generation_error：本次 StoryGenerator 抛了异常（正文没拿到）。 */
  generation_error?: string | null;
  /** §12 Validator 自身异常：不算 Story Failed，不能触发重试。 */
  validator_error?: boolean;
  /** §12 Reviewer 自身异常：Review Error ≠ Story Retry Trigger。 */
  reviewer_error?: boolean;
  validation: ValidationResult | null;
  review: ReviewResult | null;
}
