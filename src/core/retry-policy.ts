/**
 * §3/§10/§11/§21 RetryPolicy：决定「要不要再写一遍」的确定性规则。
 * §11 判定顺序：
 *   1. 本次生成失败且还有 Attempt → Retry（generation_error）
 *   2. Validation Failed 且允许 → Retry（validation_failed）
 *   3. Review 成功但 score < min_review_score → Retry（review_score_below_threshold）
 *   4. 否则 Accept
 * §12 Reviewer / Validator 自身异常不代表 Story 有问题，不能触发 Story Retry。
 * §21 只用已有结果做简单规则判断：没有 LLM Retry Decider，没有自适应策略。
 */

import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";

/** §3 RetryPolicy：max_attempts 含首次生成在内（§3/§71）。 */
export interface RetryPolicy {
  max_attempts: number;
  min_review_score: number;
  retry_on_validation_failure: boolean;
}

/** §4 默认策略：初次生成 + 最多 1 次自动重试。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 2,
  min_review_score: 70,
  retry_on_validation_failure: true,
};

/** §31 Settings Validation：上限避免误操作造成大量 API 消耗。 */
export const MAX_ATTEMPTS_LIMIT = { min: 1, max: 5 } as const;

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

  return {
    max_attempts: maxAttempts,
    min_review_score: score,
    retry_on_validation_failure: onValidation,
  };
}

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

const ACCEPT: RetryDecision = { should_retry: false, reason: null };

function retry(reason: RetryReason): RetryDecision {
  return { should_retry: true, reason };
}

/**
 * §11 质量判断：这一次 Attempt 是否满足策略，不关心还剩几次机会。
 * reason === null 表示满足；否则 reason 说明卡在哪一步。
 *
 * §12 的组件自身异常只让对应那一路判据作废，不产生 reason、也不替 Story 定性：
 * Validator 抛异常时跳过「Validation Failed」这一格，Reviewer 抛异常时跳过「分数门槛」这一格，
 * 其余判据照常参与判断。
 */
function qualityOf(input: RetryDecisionInput, policy: RetryPolicy): RetryDecision {
  // §11.1 生成失败：正文都没拿到。
  if (input.generation_error) return retry("generation_error");

  // §11.2 / §14 Validation Failed（§12：Validator 自身异常时这一格作废）。
  if (!input.validator_error && input.validation && !input.validation.passed) {
    if (policy.retry_on_validation_failure) return retry("validation_failed");
  }

  // §12：Reviewer Error ≠ Story Retry Trigger——分数门槛作废，且不因此重试。
  if (input.reviewer_error) return ACCEPT;

  // §11.3 / §13 只有一个总分阈值，没有多维质量门禁。
  if (input.review && input.review.score < policy.min_review_score) {
    return retry("review_score_below_threshold");
  }

  return ACCEPT;
}

/**
 * §11/§15/§16 单次判定。attempt_number 已经参与判断：达到 max_attempts 一律不再重试，
 * 因此即便循环写错也不可能无限重试（§15：禁止 while not accepted 无限 regenerate）。
 *
 * should_retry 只回答「还允不允许再试一次」；reason 回答「这一次为什么不算通过」。
 * 最后一次 Attempt 没通过时返回 should_retry=false 但保留 reason——
 * 上层据此判定 quality_status=exhausted，而不是误报 accepted。
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { policy } = input;
  const attemptNumber = input.attempt_number;

  // 非法编号无法判断还剩几次：一律不再重试。
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) return ACCEPT;

  const quality = qualityOf(input, policy);
  if (!quality.should_retry) return quality;

  // §15 硬上限：已到达最后一次允许的 Attempt。
  if (attemptNumber >= policy.max_attempts) {
    return { should_retry: false, reason: quality.reason };
  }

  return quality;
}
