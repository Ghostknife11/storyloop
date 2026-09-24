/**
 * v1.2.0 Quality 领域模型：把散落在 ValidationResult / ReviewResult / RetryPolicy /
 * RepairRecord 里的质量表达收敛成一个稳定结构，供 API / UI / 后续质量系统共同复用。
 *
 * §4 定位：QualityResult 不是新的 Reviewer——它不调用 LLM、不重新评分、不替代
 * StoryValidator / BasicReviewer / RetryPolicy / StoryRepairer，只统一表达它们的结果。
 * §10：本版本刻意不加 confidence / rootCause / evidenceSpan / characterId / beatId /
 * probability / failureAttribution 一类字段，那些属于更后面的 Failure Analysis 系统。
 * v1.3.0 起多出可选的 dimensions（见 src/types/quality-dimensions.ts）：四个基础质量维度，
 * 纯粹是评价输出的另一种表达，仍然只由 Reviewer 给，QualityResult 自己不推导、不拆解。
 * 它也仍然不会驱动任何决策——重试与修订只看 overall_score 与 validation_passed。
 *
 * 命名沿用仓库现状：TypeScript 模型内部也用 snake_case（见 src/types/repair.ts /
 * src/types/story-config.ts），于是领域模型、API 响应、metadata、quality.json 四处同名。
 */

import { REVIEW_SCORE_MAX, REVIEW_SCORE_MIN, validateQualityDimensions } from "@/types/review-result";
import type { QualityDimensions } from "@/types/quality-dimensions";

/** §9 QualityIssue 来源：一条问题出自硬性校验还是基础审阅。 */
export type QualityIssueSource = "validation" | "review";

/** §9 QualityIssue：保持轻量，只有来源、类别、消息三样必填。 */
export interface QualityIssue {
  /** 稳定且确定：按出现顺序编号（validation-1 / review-1…），同一输入必然得到同一 id。 */
  id: string;
  source: QualityIssueSource;
  /** §11 校验侧取 ValidationIssue.code；§12 审阅侧统一是 review_problem，不做复杂分类。 */
  category: string;
  message: string;
  /** §11：只有校验侧本来就有 severity 时才带上；审阅侧的问题没有严重度，字段不出现。 */
  severity?: "warning" | "error";
}

/** §13 QualitySuggestion：一条简短、可执行的改进建议。 */
export interface QualitySuggestion {
  id: string;
  /** §13：review = Reviewer 给出的建议。system 保留给后续版本，v1.2.0 不产出。 */
  source: "review" | "system";
  message: string;
}

/** §5 QualityResult：一个整体分数 + 校验结论 + 采纳结论 + 问题 + 建议 + 总结。 */
export interface QualityResult {
  /** §6：直接取 BasicReviewer.score；Reviewer 失败时为 null，绝不自己推导新分数。 */
  overall_score: number | null;
  /** §7：直接取 ValidationResult.passed；Validator 自身失败时为 null，与「校验没过」区分开。 */
  validation_passed: boolean | null;
  /** §8：这一次 Attempt / Run 最终是否被接受，沿用 RetryPolicy 的既有结论，不另立规则。 */
  accepted: boolean;
  issues: QualityIssue[];
  suggestions: QualitySuggestion[];
  /** §6：Reviewer 的总结；没有审阅结论时为 null。 */
  summary: string | null;
  /**
   * v1.3.0：可选的四个基础质量维度，直接来自 ReviewResult.dimensions，
   * 由 QualityAssembler 原样搬运（§18）。缺失时（1.3.0 之前的 Run，或那次审阅
   * 没有按格式给出维度）整个键不出现，overall_score 仍按原来的整体分口径。
   */
  dimensions?: QualityDimensions;
}

/**
 * §28 metadata 里的质量装配状态。
 * v1.2.0 只有一种取值：装配跑完了（装配本身不失败，失败的是 Run）。
 * 之所以不叫 quality_status：那个名字已经被 accepted / exhausted 占用（§29）。
 */
export type QualityAssemblyStatus = "completed";

function textOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function issuesOf(raw: unknown): QualityIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: QualityIssue[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const message = textOf(r.message);
    const category = textOf(r.category);
    const source = r.source === "validation" || r.source === "review" ? r.source : null;
    if (!message || !category || !source) continue;
    out.push({
      id: textOf(r.id) ?? `unknown-${out.length + 1}`,
      source,
      category,
      message,
      ...(r.severity === "warning" || r.severity === "error" ? { severity: r.severity } : {}),
    });
  }
  return out;
}

/**
 * v1.3.0 磁盘读取用的维度归一化：形状不对（缺维度、多维度、分数越界）时按「没有维度」
 * 处理而不是作废整份快照——一次 Run 详情不该因为一个多余维度键就整个 500，
 * 更不能把一个不认识的维度值当成 0 分展示出去。
 */
function dimensionsOf(raw: unknown): QualityDimensions | null {
  if (raw === undefined || raw === null) return null;
  try {
    return validateQualityDimensions(raw);
  } catch {
    return null;
  }
}

function suggestionsOf(raw: unknown): QualitySuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: QualitySuggestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const message = textOf(r.message);
    if (!message) continue;
    out.push({
      id: textOf(r.id) ?? `unknown-${out.length + 1}`,
      source: r.source === "system" ? "system" : "review",
      message,
    });
  }
  return out;
}

/**
 * 磁盘读取用的宽容归一化：quality.json 可能来自手改、也可能来自更早的版本，
 * 形状不认识就整体作废（返回 null），由调用方临时装配，绝不让一次 Run 详情 500。
 * 与 validateValidationResult 那种「结构不对就抛」的校验分工不同：这里是读旧数据。
 */
export function qualityResultOf(raw: unknown): QualityResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.accepted !== "boolean") return null;

  const score = r.overall_score;
  if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) return null;
  if (typeof score === "number" && (score < REVIEW_SCORE_MIN || score > REVIEW_SCORE_MAX)) return null;

  const passed = r.validation_passed;
  if (passed !== null && typeof passed !== "boolean") return null;

  const dimensions = dimensionsOf(r.dimensions);
  return {
    overall_score: score as number | null,
    validation_passed: passed as boolean | null,
    accepted: r.accepted,
    issues: issuesOf(r.issues),
    suggestions: suggestionsOf(r.suggestions),
    summary: textOf(r.summary),
    ...(dimensions ? { dimensions } : {}),
  };
}
