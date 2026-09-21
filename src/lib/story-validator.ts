/**
 * §8/§9 StoryValidator：把硬性规则聚合成一个 ValidationResult。
 * §2 判断的是「是否基本可接受」，不是「写得怎么样」——后者属于 BasicReviewer。
 * §3 只做确定性检查；§58 只能返回 ValidationResult，禁止返回 fixed_story / revised_story / patched_story。
 */

import type { StoryConfig } from "@/types/story-config";
import {
  validationPassed,
  type ValidationIssue,
  type ValidationResult,
} from "@/types/validation-result";
import {
  STORY_VALIDATION_RULES,
  type ValidationInput,
  type ValidationRule,
} from "@/lib/validation-rules";

/** §25 Validator 自身异常：与「Validation Failed」是两件事，由 Pipeline 分开记录。 */
export class ValidatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidatorError";
  }
}

export class StoryValidator {
  private rules: readonly ValidationRule[];

  /** §9 规则可注入（测试用），默认使用内置硬规则；§7 不做 Plugin Registry。 */
  constructor(rules: readonly ValidationRule[] = STORY_VALIDATION_RULES) {
    this.rules = rules;
  }

  /** §8 validate(config, story) → ValidationResult。§18 Validation Failed 不是异常，正常返回。 */
  validate(config: StoryConfig, story: string): ValidationResult {
    const input: ValidationInput = { config, story };
    const issues: ValidationIssue[] = [];
    for (const rule of this.rules) {
      const found = rule.check(input);
      if (found) issues.push(found);
    }
    return { passed: validationPassed(issues), issues };
  }
}
