/**
 * v1.9.0 §40 集中式失败规则：错误码 → 失败类别的唯一映射处。
 *
 * 为什么单独一个文件：本版本开始，「一个码属于哪一类失败」这件事会被
 * 分析器、API 响应、UI 标签、实验聚合四处用到。散落成一堆
 * `if (code === "…")` 的时候，加一个新码就要改四个地方，而且一定会有
 * 一处忘了改——所以规则只有这一份。
 *
 * §41：查不到规则的码**不丢**。ruleForCode 返回 null，由调用方决定
 * 是降级到 UNKNOWN 还是按已知 stage 归大类；原始码始终原样进 Signal。
 *
 * §15/§67：这里没有任何「猜测根因」的成分。规则只回答「这个已经发生的
 * 事实属于哪一类」，不回答「它为什么发生」。
 */

import { PipelineError } from "@/core/pipeline";
import { LLMRequestError, LLMTimeoutError } from "@/lib/llm";
import type { FailureCategory, FailureSignalSource } from "@/types/failure-analysis";
import { FAILURE_CATEGORIES } from "@/types/failure-analysis";
import { BEAT_VALIDATION_ISSUE_CODES } from "@/types/beat-validation";
import { VALIDATION_ISSUE_CODES } from "@/types/validation-result";

/** §40 FailureRule：一条「这些码属于这一类」的规则。priority 越小越优先。 */
export interface FailureRule {
  category: FailureCategory;
  source: FailureSignalSource;
  codes: string[];
  priority: number;
}

/** §22 类别优先级。与 FAILURE_CATEGORIES 的顺序一致（测试里有断言钉死）。 */
export const CATEGORY_PRIORITY: Record<FailureCategory, number> = FAILURE_CATEGORIES.reduce(
  (acc, category, index) => {
    acc[category] = index;
    return acc;
  },
  {} as Record<FailureCategory, number>,
);

/**
 * 分析器自己合成的信号码（状态型失败，不是错误码）。
 * 与规则表共用一份定义，避免分析器与规则各写一套字符串。
 */
export const RETRY_EXHAUSTION_CODES = ["RETRY_LIMIT_REACHED", "RETRY_EXHAUSTED"] as const;
export const REPAIR_EXHAUSTION_CODES = [
  "REPAIR_LIMIT_REACHED",
  "REPAIR_TARGET_STILL_PRESENT",
  "REPAIR_EXHAUSTED",
] as const;

/** §15 SECURITY：安全策略阻止了操作。只说「被阻止」，不说「被攻击」。 */
const SECURITY_CODES = [
  "UNSAFE_BASE_URL",
  "UNSAFE_REQUEST_URL",
  "SSRF_BLOCKED",
  "SECRET_SAFE_SERIALIZATION_REJECTED",
] as const;

/** §5 CONFIGURATION：这次 Run 在开始之前就不该被接受。 */
const CONFIGURATION_CODES = [
  "CONFIG_INVALID",
  "UNSUPPORTED_CONFIG_VERSION",
  "MISSING_CONFIG_FIELD",
  "INVALID_MODEL_CONFIG",
  "PROMPT_VERSION_NOT_FOUND",
  "EXPERIMENT_PREFLIGHT_FAILED",
  "EXPERIMENT_INVALID",
  "RETRY_POLICY_INVALID",
  "REPAIR_POLICY_INVALID",
] as const;

/** §14 STORAGE：产物没落稳。 */
const STORAGE_CODES = [
  "ARTIFACT_WRITE_FAILED",
  "ATOMIC_RENAME_FAILED",
  "ARTIFACT_PATH_INVALID",
] as const;

/** §6 PLANNING：骨架没立起来，正文生成没发生或不该发生。 */
const PLANNING_CODES: string[] = [
  ...BEAT_VALIDATION_ISSUE_CODES,
  "PLANNER_INVALID_OUTPUT",
  "BEAT_PARSE_ERROR",
  "BEAT_PLAN_REJECTED",
  "BEAT_VALIDATION_FAILED",
  "BEAT_VALIDATION_COMPONENT_FAILED",
];

/** §7 GENERATION：正文模型这一跳本身没成。 */
const GENERATION_CODES = [
  "LLM_TIMEOUT",
  "LLM_REQUEST_FAILED",
  "LLM_EMPTY_RESPONSE",
  "GENERATION_FAILED",
] as const;

/**
 * §8 VALIDATION：StoryValidator 的硬性结论。组件自身失败也归这里——
 * 但 Signal 的 message 会写明「是组件失败，不是正文有问题」，
 * 免得被读成故事质量差（§13 对 REVIEWER 的同一要求）。
 */
const VALIDATION_CODES: string[] = [
  ...VALIDATION_ISSUE_CODES,
  "VALIDATION_FAILED_INTERNAL",
  "VALIDATION_COMPONENT_FAILED",
];

/**
 * §13 REVIEWER：审阅环节自身失败（超时 / 输出非法 / 结构不对）。
 * 与「故事写得不好」是两件事，类别上也必须分开。
 */
const REVIEWER_CODES = [
  "REVIEW_FAILED",
  "REVIEW_COMPONENT_FAILED",
  "REVIEW_PARSE_ERROR",
  "COMMERCIAL_REVIEW_FAILED",
  "COMMERCIAL_REVIEW_COMPONENT_FAILED",
  "COMMERCIAL_REVIEW_PARSE_ERROR",
] as const;

/** §9 QUALITY：整体质量低于策略阈值，或某个基础维度明显薄弱。 */
const QUALITY_CODES = [
  "QUALITY_BELOW_THRESHOLD",
  "LOW_OVERALL_SCORE",
  "WEAK_COHERENCE",
  "WEAK_NARRATIVE",
  "WEAK_CHARACTER",
  "WEAK_CAUSALITY",
] as const;

/** §10 COMMERCIAL：商业可读性偏低。是评价结论，不是技术失败。 */
const COMMERCIAL_CODES = [
  "LOW_COMMERCIAL_SCORE",
  "WEAK_HOOK",
  "WEAK_PACING",
  "WEAK_ENGAGEMENT",
  "WEAK_PAYOFF",
] as const;

/** §16 UNKNOWN：遥测的兜底码也落在这里——「失败了但没归类」本身就是结论。 */
const UNKNOWN_CODES = ["RUN_FAILED", "UNKNOWN_FAILURE", "UNCLASSIFIED_FAILURE"] as const;

/** §40 唯一的规则表。 */
export const FAILURE_RULES: readonly FailureRule[] = [
  { category: "SECURITY", source: "security", codes: [...SECURITY_CODES], priority: CATEGORY_PRIORITY.SECURITY },
  { category: "CONFIGURATION", source: "metadata", codes: [...CONFIGURATION_CODES], priority: CATEGORY_PRIORITY.CONFIGURATION },
  { category: "STORAGE", source: "storage", codes: [...STORAGE_CODES], priority: CATEGORY_PRIORITY.STORAGE },
  { category: "PLANNING", source: "beat-validation", codes: PLANNING_CODES, priority: CATEGORY_PRIORITY.PLANNING },
  { category: "GENERATION", source: "telemetry", codes: [...GENERATION_CODES], priority: CATEGORY_PRIORITY.GENERATION },
  { category: "VALIDATION", source: "story-validation", codes: VALIDATION_CODES, priority: CATEGORY_PRIORITY.VALIDATION },
  { category: "REVIEWER", source: "quality-review", codes: [...REVIEWER_CODES], priority: CATEGORY_PRIORITY.REVIEWER },
  { category: "RETRY_EXHAUSTION", source: "retry", codes: [...RETRY_EXHAUSTION_CODES], priority: CATEGORY_PRIORITY.RETRY_EXHAUSTION },
  { category: "REPAIR_EXHAUSTION", source: "repair", codes: [...REPAIR_EXHAUSTION_CODES], priority: CATEGORY_PRIORITY.REPAIR_EXHAUSTION },
  { category: "QUALITY", source: "quality-review", codes: [...QUALITY_CODES], priority: CATEGORY_PRIORITY.QUALITY },
  { category: "COMMERCIAL", source: "commercial-review", codes: [...COMMERCIAL_CODES], priority: CATEGORY_PRIORITY.COMMERCIAL },
  { category: "UNKNOWN", source: "metadata", codes: [...UNKNOWN_CODES], priority: CATEGORY_PRIORITY.UNKNOWN },
] as const;

/** 命中规则的类别；未命中返回 null（§41：不猜，交给调用方降级）。 */
export function categoryOfCode(code: string): FailureCategory | null {
  for (const rule of FAILURE_RULES) {
    if (rule.codes.includes(code)) return rule.category;
  }
  return null;
}

/** 某个类别覆盖的全部码（测试与文档用）。 */
export function codesOfCategory(category: FailureCategory): string[] {
  const rule = FAILURE_RULES.find((r) => r.category === category);
  return rule ? [...rule.codes] : [];
}

/** §22：确定性优先级。未知类别给最大值，绝不插队。 */
export function categoryPriority(category: FailureCategory): number {
  return CATEGORY_PRIORITY[category] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * §4/§6/§8：把一个 issue code 收窄成它的 Signal source。
 * Beat 结构码与正文校验码都可能是 VALIDATION 字面量，但出处不同，
 * evidence 必须指到正确的文件，所以 source 不能靠类别反推。
 */
export function sourceOfIssueCode(code: string): FailureSignalSource {
  if ((BEAT_VALIDATION_ISSUE_CODES as readonly string[]).includes(code)) return "beat-validation";
  if ((VALIDATION_ISSUE_CODES as readonly string[]).includes(code)) return "story-validation";
  return "metadata";
}

/** 类别的英文稳定名：API / 聚合 / artifacts 里用的就是它，不做本地化。
 *  中文展示标签与它分开：见 types/failure-analysis.ts 的 CATEGORY_LABELS。 */
export const CATEGORY_KEYS: Record<FailureCategory, string> = FAILURE_CATEGORIES.reduce(
  (acc, category) => {
    acc[category] = category;
    return acc;
  },
  {} as Record<FailureCategory, string>,
);

// ---------------------------------------------------------------------------
// §40 错误码采集：把一次真实异常收敛成稳定码列表
// ---------------------------------------------------------------------------

/**
 * 沿 PipelineError.cause 一路解到最内层，收集一路上所有可命名的失败码。
 *
 * 与 telemetryCodeOf 的分工：遥测只记「最内层那一个码」；这里要全链，
 * 因为一次 Run 失败可能同时踩到「写盘失败」与「模型超时」，
 * 而 Secondary Categories 需要把这些都看见（§45）。
 *
 * §41：认不出的异常保留 Error.name 原样进列表——宁可留一个没人认识的码，
 * 也不把未知失败洗成一个看起来什么都知道的类别。
 */
export function errorCodesOf(e: unknown): string[] {
  const codes: string[] = [];
  const push = (code: string): void => {
    if (!codes.includes(code)) codes.push(code);
  };
  let current: unknown = e;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof PipelineError) {
      current = current.cause;
      continue;
    }
    if (current instanceof LLMTimeoutError) {
      push("LLM_TIMEOUT");
    } else if (current instanceof LLMRequestError) {
      push("LLM_REQUEST_FAILED");
    } else if (current instanceof Error) {
      const name = current.name;
      if (current.message.includes("内容为空")) push("LLM_EMPTY_RESPONSE");
      switch (name) {
        case "BeatParseError":
          push("PLANNER_INVALID_OUTPUT");
          break;
        case "ReviewParseError":
          push("REVIEW_PARSE_ERROR");
          break;
        case "CommercialReviewParseError":
        case "CommercialReviewValidationError":
          push("COMMERCIAL_REVIEW_PARSE_ERROR");
          break;
        case "ValidatorError":
          push("VALIDATION_FAILED_INTERNAL");
          break;
        case "BeatValidationParseError":
        case "BeatValidationValidationError":
          push("BEAT_VALIDATION_FAILED");
          break;
        case "ArtifactWriteError":
          push("ARTIFACT_WRITE_FAILED");
          break;
        case "UnsafeRequestUrlError":
          // §15：被安全策略拒绝的地址。归类时是 SECURITY，不是 CONFIGURATION——
          // 虽然 API 层为了状态码把它报成 CONFIG_INVALID，那是 HTTP 语义，
          // 失败类别要说清「是谁拦下了这次操作」。
          push("UNSAFE_BASE_URL");
          break;
        case "RetryPolicyError":
          push("RETRY_POLICY_INVALID");
          break;
        case "UnsupportedConfigVersionError":
          push("UNSUPPORTED_CONFIG_VERSION");
          break;
        case "ConfigLoadError":
        case "ConfigValidationError":
          push("CONFIG_INVALID");
          break;
        default:
          break;
      }
      // 认不出的也留下名字，别丢事实（§41）
      if (!FAILURE_RULES.some((rule) => rule.codes.includes(name))) push(name);
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null || next === current) break;
    current = next;
  }
  return codes;
}
