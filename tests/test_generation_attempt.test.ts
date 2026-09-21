import { describe, expect, it } from "vitest";
import {
  GenerationAttemptError,
  attemptDirectoryName,
  attemptSummary,
  validateAttemptNumber,
  validateGenerationAttempt,
  validateRetryReason,
  type GenerationAttempt,
} from "@/core/generation-attempt";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §5/§6/§43 GenerationAttempt：Fixture 结构校验，同样绝不打真实付费 API。
 */

const PASSED: ValidationResult = { passed: true, issues: [] };
const review: ReviewResult = { score: 74, summary: "总结。", strengths: ["强"], problems: ["弱"] };

function attempt(patch: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    attempt_number: 1,
    story: "陈岚走进雨夜。",
    validation: PASSED,
    review,
    accepted: false,
    retry_reason: "validation_failed",
    error: null,
    ...patch,
  };
}

describe("GenerationAttempt 字段（§5）", () => {
  it("七个字段，一个不多", () => {
    expect(Object.keys(attempt()).sort()).toEqual([
      "accepted",
      "attempt_number",
      "error",
      "retry_reason",
      "review",
      "story",
      "validation",
    ]);
  });

  it("合法 attempt 原样通过校验", () => {
    expect(validateGenerationAttempt(attempt())).toEqual(attempt());
    expect(validateGenerationAttempt(attempt({ accepted: true, retry_reason: null }))).toEqual(
      attempt({ accepted: true, retry_reason: null }),
    );
  });
});

describe("attempt_number（§6）", () => {
  it("从 1 开始的整数才合法", () => {
    expect(validateAttemptNumber(1)).toBe(1);
    expect(validateAttemptNumber(42)).toBe(42);
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      expect(() => validateAttemptNumber(bad)).toThrow(GenerationAttemptError);
    }
  });

  it("目录名两位零填充（§23）", () => {
    expect(attemptDirectoryName(1)).toBe("01");
    expect(attemptDirectoryName(9)).toBe("09");
    expect(attemptDirectoryName(10)).toBe("10");
    expect(attemptDirectoryName(99)).toBe("99");
  });

  it("编号超过 99 拒绝：目录名无法保持两位", () => {
    expect(() => attemptDirectoryName(100)).toThrow(GenerationAttemptError);
  });
});

describe("validateGenerationAttempt（§5/§24）", () => {
  it("accepted 与 retry_reason 互斥", () => {
    expect(() => validateGenerationAttempt(attempt({ accepted: true }))).toThrow(/retry_reason/);
    expect(validateGenerationAttempt(attempt({ accepted: false })).accepted).toBe(false);
  });

  it("未 accepted 且没有 reason 时，error 可替代说明", () => {
    const a = attempt({ retry_reason: null, error: "LLM 502" });
    expect(validateGenerationAttempt(a)).toEqual(a);
  });

  it("生成为 null 时也必须带 reason 或 error", () => {
    expect(
      validateGenerationAttempt(attempt({ story: null, retry_reason: "generation_error" })).story,
    ).toBeNull();
    // reason 与 error 都没有：无法说明为什么没被采纳
    expect(() => validateGenerationAttempt(attempt({ story: null, retry_reason: null }))).toThrow(
      /retry_reason|error/,
    );
  });

  it("字段类型错误一律拒绝", () => {
    expect(() => validateGenerationAttempt({ ...attempt(), story: 42 })).toThrow(GenerationAttemptError);
    expect(() => validateGenerationAttempt({ ...attempt(), accepted: "yes" })).toThrow(GenerationAttemptError);
    expect(() => validateGenerationAttempt({ ...attempt(), error: 7 })).toThrow(GenerationAttemptError);
  });

  it("validation / review 为 null 表示该阶段没跑或自身异常（§12）", () => {
    const a = attempt({ validation: null, review: null, retry_reason: null, error: "Validator 崩溃" });
    expect(validateGenerationAttempt(a).validation).toBeNull();
    expect(validateGenerationAttempt(a).review).toBeNull();
  });
});

describe("validateRetryReason（§22）", () => {
  it("只认三个稳定字符串", () => {
    expect(validateRetryReason("generation_error")).toBe("generation_error");
    expect(validateRetryReason("validation_failed")).toBe("validation_failed");
    expect(validateRetryReason("review_score_below_threshold")).toBe("review_score_below_threshold");
  });

  it("null / undefined 表示没有重试原因", () => {
    expect(validateRetryReason(null)).toBeNull();
    expect(validateRetryReason(undefined)).toBeNull();
  });

  it("白名单之外的原因一律拒绝（§67 禁止发明新失败归因）", () => {
    for (const bad of ["repair", "dimension", "model_tuning", "cost", "", "generation_error "]) {
      expect(() => validateRetryReason(bad)).toThrow(GenerationAttemptError);
    }
  });
});

describe("attemptSummary（§24/§38）", () => {
  it("只带摘要字段，不带正文与完整 Validation / Review", () => {
    const s = attemptSummary(attempt());
    expect(s).toEqual({
      attempt_number: 1,
      accepted: false,
      retry_reason: "validation_failed",
      review_score: 74,
      validation_passed: true,
    });
    expect(JSON.stringify(s)).not.toContain("陈岚");
  });

  it("没有 Review / Validation 时分数与校验结论为 null", () => {
    const s = attemptSummary(
      attempt({ review: null, validation: null, retry_reason: "generation_error", story: null }),
    );
    expect(s.review_score).toBeNull();
    expect(s.validation_passed).toBeNull();
  });
});
