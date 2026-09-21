/**
 * §12/§13 RepairStrategy：把 Validation / Review 的结论映射成一个 RepairRequest。
 *
 * 固定规则，没有学习、没有 LLM 分类器（§8 禁止复杂 Failure Classifier）：
 * 按 §13 的固定优先级取**一个**主要问题（§14：一次只修一个），
 * 返回 null 表示不值得修，直接进入 Full Retry（§22）。
 */

import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";
import {
  validateRepairIssueType,
  type RepairIssueType,
  type RepairTarget,
} from "@/types/repair";

/** §22/§7 不可修复的 Validation 问题码：拿到这些说明正文整个不可用，只能整篇重生。 */
const NO_REPAIR_CODES = ["EMPTY_CONTENT", "INVALID_OUTPUT"] as const;

/**
 * §7/§13 Validation 问题码 → Repair Issue Type。
 * POSSIBLE_TRUNCATION 归 ending（§24：ending repair 同时服务 MISSING_ENDING 与 POSSIBLE_TRUNCATION）。
 * 未列出的问题码按 general 处理——不猜、不扩类。
 */
const CODE_TO_ISSUE: Record<string, RepairIssueType> = {
  MISSING_ENDING: "ending",
  POSSIBLE_TRUNCATION: "ending",
  TOO_SHORT: "length",
  MISSING_PROTAGONIST: "character_presence",
};

/**
 * §7/§13 Validation 问题码 → Repair Issue Type；未登记的码返回 null。
 * RepairStrategy 与手动 Repair 的预填共用这一个映射，避免两处规则漂移。
 */
export function issueTypeOfCode(code: string): RepairIssueType | null {
  return CODE_TO_ISSUE[code] ?? null;
}

/** §13 固定优先级：数字越小越先修。只在这里定义一次，避免规则漂移。 */
const CODE_PRIORITY: Record<string, number> = {
  MISSING_ENDING: 1,
  POSSIBLE_TRUNCATION: 2,
  TOO_SHORT: 3,
  MISSING_PROTAGONIST: 4,
};

/**
 * §8 Review problem 关键词 → Issue Type。
 * problems 是自然语言，只能用简单规则映射；映射不上就是 general。
 * 顺序即优先级：先结尾、再长度、再人物，最后才是连贯 / 结构。
 */
const PROBLEM_KEYWORDS: Array<{ issue: RepairIssueType; keywords: string[] }> = [
  { issue: "ending", keywords: ["结尾", "结局", "收束", "ending", "abrupt"] },
  { issue: "length", keywords: ["字数", "长度", "太短", "过短", "too short", "length", "brief"] },
  {
    issue: "character_presence",
    keywords: ["主角", "人物缺席", "protagonist", "character presence"],
  },
  {
    issue: "continuity",
    keywords: ["矛盾", "前后", "连贯", "脱节", "continuity", "inconsistent", "contradict"],
  },
  { issue: "structure", keywords: ["结构", "中段", "断层", "beat", "structure", "pacing"] },
];

/** §8 单个 problem 文本的分类：命中关键词用对应类型，否则 general。 */
export function classifyProblem(problem: string): RepairIssueType {
  const text = problem.toLowerCase();
  for (const { issue, keywords } of PROBLEM_KEYWORDS) {
    if (keywords.some((k) => text.includes(k.toLowerCase()))) return issue;
  }
  return "general";
}

/**
 * §12/§14 RepairStrategy：choose 只回答「这次该修什么」。
 * 它不决定 Accept（§21：最终是否接受统一由 RetryPolicy 判断），
 * 也不修改 StoryConfig / BeatPlan / 模型 / 温度（§9）。
 * 返回 RepairTarget（类型 + 问题说明）而不是整份 RepairRequest：
 * story / config / beat_plan 由 Pipeline 用 repairRequestOf 补齐，Strategy 不碰它们。
 */
export class RepairStrategy {
  /**
   * @returns 要修的 RepairTarget；null = 不可修或没有可修的问题 → Full Retry。
   */
  choose(validation: ValidationResult | null, review: ReviewResult | null): RepairTarget | null {
    const fromValidation = this.chooseFromValidation(validation);
    if (fromValidation) return fromValidation;
    return this.chooseFromReview(review);
  }

  /** §7/§13：Validation 失败时按固定优先级取一个 error 级问题。 */
  private chooseFromValidation(validation: ValidationResult | null): RepairTarget | null {
    if (!validation) return null;
    // §22：EMPTY_CONTENT / INVALID_OUTPUT 不尝试修复。
    if (validation.issues.some((i) => (NO_REPAIR_CODES as readonly string[]).includes(i.code))) {
      return null;
    }
    const candidates = validation.issues.filter((i) => CODE_TO_ISSUE[i.code]);
    if (candidates.length === 0) return null;

    let best = candidates[0];
    for (const issue of candidates) {
      if (this.priorityOf(issue.code) < this.priorityOf(best.code)) best = issue;
    }
    return {
      issue_type: CODE_TO_ISSUE[best.code],
      issue_message: best.message,
    };
  }

  /** §8：Validation 没得可修时（通过、或只有未登记的问题码），再看 Reviewer 的自然语言问题。 */
  private chooseFromReview(review: ReviewResult | null): RepairTarget | null {
    if (!review || review.problems.length === 0) return null;
    const problem = review.problems.find((p) => p.trim().length > 0);
    if (!problem) return null;
    return {
      issue_type: classifyProblem(problem),
      issue_message: problem,
    };
  }

  private priorityOf(code: string): number {
    return CODE_PRIORITY[code] ?? 99;
  }
}

/** §31/§38 手动 Repair API 也走同一套映射：issue_type 由白名单约束。 */
export function repairIssueTypeOf(raw: unknown): RepairIssueType {
  return validateRepairIssueType(raw);
}
