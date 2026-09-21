import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  MAX_ATTEMPTS_LIMIT,
  MAX_REPAIRS_LIMIT,
  RETRY_REASONS,
  RetryPolicyError,
  decideRetry,
  validateRetryPolicy,
  type RetryDecisionInput,
} from "@/core/retry-policy";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §44/§45 RetryPolicy：纯 Fixture 决策表，绝不打真实付费 API。
 * §21 决策必须确定性：同样的输入永远给出同样的结论。
 */

const PASSED: ValidationResult = { passed: true, issues: [] };
const FAILED: ValidationResult = {
  passed: false,
  issues: [
    { code: "TOO_SHORT", severity: "error", message: "正文长度明显不足。" },
  ],
};

function review(score: number): ReviewResult {
  return {
    score,
    summary: "总结。",
    strengths: ["强"],
    problems: ["弱"],
  };
}

function input(patch: Partial<RetryDecisionInput> = {}): RetryDecisionInput {
  return {
    policy: DEFAULT_RETRY_POLICY,
    attempt_number: 1,
    validation: PASSED,
    review: review(80),
    ...patch,
  };
}

describe("RetryPolicy 常量（§3/§4/§22）", () => {
  it("默认策略：初次生成 + 最多 1 次自动重试 + 每个 Attempt 最多 1 次定点修订", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      max_attempts: 2,
      min_review_score: 70,
      retry_on_validation_failure: true,
      enable_repair: true,
      max_repairs_per_attempt: 1,
    });
  });

  it("max_attempts 含首次生成在内（§3）", () => {
    expect(MAX_ATTEMPTS_LIMIT).toEqual({ min: 1, max: 5 });
  });

  it("只有三个稳定 reason（§22）", () => {
    expect([...RETRY_REASONS]).toEqual([
      "generation_error",
      "validation_failed",
      "review_score_below_threshold",
    ]);
  });
});

describe("validateRetryPolicy（§31/§51）", () => {
  it("缺字段用默认值补齐", () => {
    expect(validateRetryPolicy({})).toEqual(DEFAULT_RETRY_POLICY);
    expect(validateRetryPolicy({ max_attempts: 3 })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      max_attempts: 3,
    });
  });

  it("非法 max_attempts 一律拒绝", () => {
    expect(() => validateRetryPolicy({ max_attempts: 0 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ max_attempts: 6 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ max_attempts: 2.5 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ max_attempts: "2" })).toThrow(RetryPolicyError);
  });

  it("非法 min_review_score 一律拒绝", () => {
    expect(() => validateRetryPolicy({ min_review_score: -1 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ min_review_score: 101 })).toThrow(RetryPolicyError);
    expect(() => validateRetryPolicy({ min_review_score: NaN })).toThrow(RetryPolicyError);
    expect(validateRetryPolicy({ min_review_score: 0 }).min_review_score).toBe(0);
    expect(validateRetryPolicy({ min_review_score: 100 }).min_review_score).toBe(100);
  });

  it("非法 retry_on_validation_failure 拒绝", () => {
    expect(() => validateRetryPolicy({ retry_on_validation_failure: "yes" })).toThrow(RetryPolicyError);
  });
});

/** §18/§39 RetryPolicy 的 Repair 部分：开关 + 每个 Attempt 的上限。 */
describe("validateRetryPolicy — Repair 字段（§18）", () => {
  it("缺 Repair 字段时用默认值补齐", () => {
    expect(validateRetryPolicy({})).toEqual({
      ...DEFAULT_RETRY_POLICY,
      enable_repair: true,
      max_repairs_per_attempt: 1,
    });
  });

  it("max_repairs_per_attempt 允许 0 ~ 3（§34：0 = 关闭 Repair）", () => {
    expect(MAX_REPAIRS_LIMIT).toEqual({ min: 0, max: 3 });
    for (const n of [0, 1, 2, 3]) {
      expect(validateRetryPolicy({ max_repairs_per_attempt: n }).max_repairs_per_attempt).toBe(n);
    }
  });

  it("越界与非整数的 max_repairs_per_attempt 一律拒绝", () => {
    for (const bad of [-1, 4, 1.5, "1", true]) {
      expect(() => validateRetryPolicy({ max_repairs_per_attempt: bad })).toThrow(RetryPolicyError);
    }
  });

  it("非法 enable_repair 拒绝", () => {
    expect(() => validateRetryPolicy({ enable_repair: "on" })).toThrow(RetryPolicyError);
  });

  it("enable_repair 不影响 qualityOf：Accept / Retry 判定只看质量", () => {
    const off = { ...DEFAULT_RETRY_POLICY, enable_repair: false };
    expect(decideRetry(input({ policy: off, validation: FAILED })).reason).toBe("validation_failed");
    expect(decideRetry(input({ policy: off })).reason).toBeNull();
  });
});

describe("decideRetry（§11/§13/§14/§15）", () => {
  it("Validation 通过 + 分数达标 → Accept，不重试", () => {
    expect(decideRetry(input())).toEqual({ should_retry: false, reason: null });
  });

  it("分数恰好等于阈值 → Accept（只有 < 阈值才重试）", () => {
    expect(decideRetry(input({ review: review(70) })).should_retry).toBe(false);
    expect(decideRetry(input({ review: review(69) }))).toEqual({
      should_retry: true,
      reason: "review_score_below_threshold",
    });
  });

  it("生成失败且还有 Attempt → Retry（§11.1）", () => {
    expect(decideRetry(input({ generation_error: "LLM 502", validation: null, review: null }))).toEqual({
      should_retry: true,
      reason: "generation_error",
    });
  });

  it("Validation Failed + 允许重试 → Retry（§14）", () => {
    expect(decideRetry(input({ validation: FAILED }))).toEqual({
      should_retry: true,
      reason: "validation_failed",
    });
  });

  it("Validation Failed + 关闭重试开关 → Accept", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, retry_on_validation_failure: false };
    expect(decideRetry(input({ policy, validation: FAILED, review: null }))).toEqual({
      should_retry: false,
      reason: null,
    });
  });

  it("分数低 + 校验也失败：按 §11 顺序先报 validation_failed", () => {
    expect(decideRetry(input({ validation: FAILED, review: review(40) }))).toEqual({
      should_retry: true,
      reason: "validation_failed",
    });
  });

  it("达到 max_attempts：不再重试，但保留 reason（§15/§16）", () => {
    const decision = decideRetry(
      input({ attempt_number: 2, policy: { ...DEFAULT_RETRY_POLICY, max_attempts: 2 }, review: review(50) }),
    );
    expect(decision).toEqual({ should_retry: false, reason: "review_score_below_threshold" });
  });

  it("max_attempts = 1：第一次就不允许重试", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, max_attempts: 1 };
    expect(decideRetry(input({ policy, validation: FAILED, review: null }))).toEqual({
      should_retry: false,
      reason: "validation_failed",
    });
  });

  it("非法 attempt_number 一律不重试（§15 防呆）", () => {
    for (const n of [0, -1, 1.5, NaN]) {
      expect(decideRetry(input({ attempt_number: n, validation: FAILED })).should_retry).toBe(false);
    }
  });
});

describe("decideRetry — §12 组件自身异常", () => {
  it("Reviewer 自身异常：不触发重试", () => {
    expect(decideRetry(input({ reviewer_error: true, review: null }))).toEqual({
      should_retry: false,
      reason: null,
    });
  });

  it("Validator 自身异常：不当作 Story Failed，不触发重试", () => {
    expect(decideRetry(input({ validator_error: true, validation: null, review: null }))).toEqual({
      should_retry: false,
      reason: null,
    });
  });

  it("Reviewer 异常时，Validation Failed 仍然算不合格（异常只让对应判据作废）", () => {
    expect(decideRetry(input({ validation: FAILED, reviewer_error: true, review: null }))).toEqual({
      should_retry: true,
      reason: "validation_failed",
    });
  });

  it("Validator 异常时，分数门槛仍然生效", () => {
    expect(
      decideRetry(input({ validator_error: true, validation: null, review: review(30) })),
    ).toEqual({ should_retry: true, reason: "review_score_below_threshold" });
  });
});

describe("decideRetry — §21 确定性", () => {
  it("同一输入重复判定结果一致", () => {
    const once = decideRetry(input({ validation: FAILED, review: review(65) }));
    for (let i = 0; i < 5; i++) {
      expect(decideRetry(input({ validation: FAILED, review: review(65) }))).toEqual(once);
    }
  });

  it("decision 只有 should_retry / reason 两个字段（§10）", () => {
    expect(Object.keys(decideRetry(input())).sort()).toEqual(["reason", "should_retry"]);
  });
});
