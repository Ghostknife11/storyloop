/**
 * v2.0.0 Retry 判定逻辑（Engine）。
 *
 * §31「RetryPolicy → Domain / Engine」：策略契约、默认值、校验在 src/domain/retry-policy.ts；
 * 这里只留「这一次 Attempt 要不要再来一遍」的判定顺序（§3/§10/§11/§12/§21 原文不变）：
 *   1. 本次生成失败且还有 Attempt → Retry（generation_error）
 *   2. Validation Failed 且允许 → Retry（validation_failed）
 *   3. Review 成功但 score < min_review_score → Retry（review_score_below_threshold）
 *   4. 否则 Accept
 * §12 Reviewer / Validator 自身异常不代表 Story 有问题，不能触发 Story Retry。
 * §21 只用已有结果做简单规则判断：没有 LLM Retry Decider，没有自适应策略。
 *
 * 契约从 Domain 再导出一次：`@/engine/retry-policy` 这个路径自 v0.5.0 起就在被
 * Pipeline / 实验 / 测试大量引用，v2.0.0 换的是位置而不是名字。
 */

import type { RetryReason } from "@/domain/retry-policy";
import { reviewOverallScore } from "@/domain/review-result";
import type { RetryDecision, RetryDecisionInput, RetryPolicy } from "@/domain/retry-policy";

export type { RetryDecision, RetryDecisionInput, RetryPolicy, RetryReason } from "@/domain/retry-policy";
export {
  DEFAULT_RETRY_POLICY,
  MAX_ATTEMPTS_LIMIT,
  MAX_REPAIRS_LIMIT,
  RETRY_REASONS,
  RetryPolicyError,
  validateRetryPolicy,
} from "@/domain/retry-policy";

export type { ValidationResult } from "@/domain/validation-result";
export type { ReviewResult } from "@/domain/review-result";

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
  // v1.3.0：有维度时门槛比的是四维均分（与 overall_score、UI 显示同一个口径），
  // 不是任何一个单独维度；也没有按维度分别设阈值。
  if (input.review && reviewOverallScore(input.review) < policy.min_review_score) {
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
