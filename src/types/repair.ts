/**
 * §3/§4/§5/§6 Repair 数据模型——v0.8.0 第一次允许针对明确问题的定点修订。
 *
 * Repair 与 Retry 是两件事（§2）：
 *   Retry  = 重新调用 StoryGenerator，整篇重生；
 *   Repair = 基于现有 Story 做针对性修订，不新增 GenerationAttempt（§17）。
 * §5 明确不要 root cause / causal diagnosis / strategy score / policy id / confidence——
 * 本文件不提供任何失败归因字段。
 */

import type { ValidationResult } from "@/types/validation-result";
import { validateValidationResult } from "@/types/validation-result";

/** §6 支持的 Repair Issue Types：只有这六类，不要一次扩成几十种。 */
export type RepairIssueType =
  | "length"
  | "ending"
  | "character_presence"
  | "continuity"
  | "structure"
  | "general";

export const REPAIR_ISSUE_TYPES: readonly RepairIssueType[] = [
  "length",
  "ending",
  "character_presence",
  "continuity",
  "structure",
  "general",
];

/** §3 RepairRequest：一次定点修订所需的全部输入。 */
export interface RepairRequest {
  /** 当前正文全文（§11：模型返回的是完整修订后正文，不是 diff / patch）。 */
  story: string;
  issue_type: RepairIssueType;
  /** 人类可读的问题说明：Validation issue message 或 Reviewer problem 原文。 */
  issue_message: string;
  config: unknown;
  beat_plan: unknown;
}

/**
 * §12 RepairStrategy 的选择结果：这次要修什么。
 * story / config / beat_plan 属于「拿什么去修」，由 Pipeline 在组装 RepairRequest 时补齐
 * （repairRequestOf）——Strategy 不接触 StoryConfig / BeatPlan，也不重写正文（§9）。
 */
export interface RepairTarget {
  issue_type: RepairIssueType;
  issue_message: string;
}

/** §14：一次只处理一个主要问题——一个完好的结构里只有一个 target。 */
export function repairTarget(issueType: RepairIssueType, issueMessage: string): RepairTarget {
  return { issue_type: issueType, issue_message: issueMessage };
}

/** §3 RepairTarget + 上下文 → 完整的 RepairRequest。 */
export function repairRequestOf(
  target: RepairTarget,
  story: string,
  config: unknown,
  beatPlan: unknown,
): RepairRequest {
  return {
    story,
    issue_type: target.issue_type,
    issue_message: target.issue_message,
    config,
    beat_plan: beatPlan,
  };
}

/** §4 RepairResult：repaired_story 为空即视为没修好（success=false）。 */
export interface RepairResult {
  repaired_story: string;
  issue_type: RepairIssueType;
  success: boolean;
  notes: string | null;
}

/**
 * §5 RepairRecord：一次 Repair 的过程记录。
 * 不带 root cause / 因果诊断 / 策略分数 / 置信度（§5 禁止项）。
 */
export interface RepairRecord {
  repair_number: number;
  issue_type: RepairIssueType;
  issue_message: string;
  before_validation: ValidationResult | null;
  after_validation: ValidationResult | null;
  before_review_score: number | null;
  after_review_score: number | null;
  success: boolean;
}

/** §39/§40 API / UI 摘要：只暴露编号、类型与成败，不暴露正文与完整结论。 */
export interface RepairSummary {
  repair_number: number;
  issue_type: RepairIssueType;
  success: boolean;
}

/**
 * §36 单个 Attempt 详情里的修订视图：比 Summary 多出「为什么修」与前后对比，
 * 供 Repair 结果面板展示 Type / Reason / Before Score / After Score / Validation 变化。
 * 仍然不带正文全文，也不带 §5 禁止的归因字段。
 */
export interface RepairDetail {
  repair_number: number;
  issue_type: RepairIssueType;
  issue_message: string;
  success: boolean;
  before_review_score: number | null;
  after_review_score: number | null;
  before_validation_passed: boolean | null;
  after_validation_passed: boolean | null;
}

export class RepairValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairValidationError";
  }
}

/** §6/§38 issue_type 必须是白名单里的一个；未知类型一律拒绝，不猜。 */
export function validateRepairIssueType(raw: unknown): RepairIssueType {
  if (typeof raw === "string" && REPAIR_ISSUE_TYPES.includes(raw as RepairIssueType)) {
    return raw as RepairIssueType;
  }
  throw new RepairValidationError(
    `issue_type 必须是 ${REPAIR_ISSUE_TYPES.join(" / ")} 之一（实际 ${String(raw)}）`,
  );
}

/** §31 repair request.json 的形状：编号 / 类型 / 说明，正好三个字段。 */
export interface RepairRequestRecord {
  repair_number: number;
  issue_type: RepairIssueType;
  issue_message: string;
}

/** §33 Repair 目录名：两位零填充，与 attempt 编号同一套规则（99 上限）。 */
export function repairDirectoryName(repairNumber: number): string {
  if (!Number.isInteger(repairNumber) || repairNumber < 1) {
    throw new RepairValidationError(
      `repair_number 必须是 >= 1 的整数（实际 ${String(repairNumber)}）`,
    );
  }
  if (repairNumber > 99) {
    throw new RepairValidationError(`repair_number 不能超过 99（实际 ${repairNumber}）`);
  }
  return String(repairNumber).padStart(2, "0");
}

/** §32 Repair metadata：只记录这次修订前后的对比，不做历史 Repair Analytics。 */
export interface RepairMetadata {
  repair_number: number;
  issue_type: RepairIssueType;
  success: boolean;
  before_review_score: number | null;
  after_review_score: number | null;
  before_validation_passed: boolean | null;
  after_validation_passed: boolean | null;
}

/** §5 RepairRecord 结构校验：只查形状，不重新判断这次修订是否合理。 */
export function validateRepairRecord(raw: unknown): RepairRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  const repairNumber = r.repair_number;
  if (typeof repairNumber !== "number" || !Number.isInteger(repairNumber) || repairNumber < 1) {
    throw new RepairValidationError(
      `repair_number 必须是 >= 1 的整数（实际 ${String(repairNumber)}）`,
    );
  }
  const issueType = validateRepairIssueType(r.issue_type);
  const issueMessage = r.issue_message;
  if (typeof issueMessage !== "string" || !issueMessage.trim()) {
    throw new RepairValidationError(`repairs[${repairNumber}].issue_message 必须是非空字符串`);
  }
  if (typeof r.success !== "boolean") {
    throw new RepairValidationError(`repairs[${repairNumber}].success 必须是布尔值`);
  }
  const beforeValidation = validationOrNull(r.before_validation);
  const afterValidation = validationOrNull(r.after_validation);
  const beforeScore = scoreOrNull(r.before_review_score);
  const afterScore = scoreOrNull(r.after_review_score);
  return {
    repair_number: repairNumber,
    issue_type: issueType,
    issue_message: issueMessage,
    before_validation: beforeValidation,
    after_validation: afterValidation,
    before_review_score: beforeScore,
    after_review_score: afterScore,
    success: r.success as boolean,
  };
}

function validationOrNull(raw: unknown): ValidationResult | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validateValidationResult(raw);
  } catch {
    return null;
  }
}

function scoreOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** §40 RepairRecord → RepairSummary：UI / API 只暴露摘要。 */
export function repairSummary(record: RepairRecord): RepairSummary {
  return {
    repair_number: record.repair_number,
    issue_type: record.issue_type,
    success: record.success,
  };
}

/** §36 RepairRecord → RepairDetail：Attempt 详情用，带问题说明与前后对比。 */
export function repairDetail(record: RepairRecord): RepairDetail {
  return {
    repair_number: record.repair_number,
    issue_type: record.issue_type,
    issue_message: record.issue_message,
    success: record.success,
    before_review_score: record.before_review_score,
    after_review_score: record.after_review_score,
    before_validation_passed: record.before_validation ? record.before_validation.passed : null,
    after_validation_passed: record.after_validation ? record.after_validation.passed : null,
  };
}
