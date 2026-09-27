/**
 * v2.1.0 QualityDiagnostic —— 三套质量组件共用的诊断语言（TASK §4/§5/§6）。
 *
 * v2.0.0 及以前，Beat 校验、故事质量审阅、商业可读性审阅各说各话：
 * Beat 校验是 `BeatValidationIssue`（code + severity + beat_ids），
 * 商业审阅只有一句 `problems` 字符串。v2.1.0 让它们统一到这一个模型上，
 * 于是同一个诊断既能进 quality-stack.json，也能进 UI 的 Quality Center，
 * 还能被 FailureAnalyzer 当结构化信号读（TASK §29）。
 *
 * 边界（TASK §5/§28）：诊断只是「说明」，不是「行动依据」。
 * 它不携带 rootCause / confidenceProbability / repairPolicy / adaptiveWeight /
 * causalNodeId / evidenceLedgerId / characterDecisionId，也不驱动
 * Retry / Repair / Model Switch / Prompt Switch。
 */

import { BEAT_VALIDATION_ISSUE_CODES } from "@/domain/beat-validation";

export class QualityDiagnosticValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityDiagnosticValidationError";
  }
}

/** §4 诊断来源：只有这三个组件会产出诊断，多一个都不行。 */
export const QUALITY_DIAGNOSTIC_SOURCES = [
  "beat-validator",
  "quality-reviewer",
  "commercial-reviewer",
] as const;

export type QualityDiagnosticSource = (typeof QUALITY_DIAGNOSTIC_SOURCES)[number];

/**
 * §6 Severity 语义（三个组件共用同一套口径）：
 *   info    = 可优化，但不是明显问题
 *   warning = 明显影响质量，但通常不阻止 Pipeline
 *   error   = 结构性或硬性问题，可阻止当前阶段继续
 */
export const QUALITY_DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;

export type QualityDiagnosticSeverity = (typeof QUALITY_DIAGNOSTIC_SEVERITIES)[number];

/** §4 诊断指向：这条诊断说的是哪一部分。 */export const QUALITY_DIAGNOSTIC_TARGETS = [
  "beat-plan",
  "story",
  "opening",
  "middle",
  "ending",
  "character",
  "global",
] as const;

export type QualityDiagnosticTarget = (typeof QUALITY_DIAGNOSTIC_TARGETS)[number];

/**
 * §12 故事质量诊断类别（Quality Reviewer v2 专用）。
 * 首版刻意保持少而稳定——禁止无限扩张 category（TASK §12）。
 */
export const QUALITY_DIAGNOSTIC_CATEGORIES = [
  "continuity_break",
  "setting_conflict",
  "character_state_conflict",
  "goal_unclear",
  "motivation_weak",
  "character_inconsistency",
  "narrative_stall",
  "repetition",
  "unsupported_turn",
  "causal_gap",
  "weak_climax",
  "weak_resolution",
] as const;

/** §19 商业可读性诊断类别（Commercial Reviewer v2 专用）。 */
export const COMMERCIAL_DIAGNOSTIC_CATEGORIES = [
  "weak_opening",
  "late_conflict",
  "slow_pacing",
  "repetitive_middle",
  "low_information_gain",
  "weak_engagement",
  "tension_drop",
  "weak_payoff",
  "unresolved_promise",
  "overlong_resolution",
] as const;

/**
 * §13 Beat 校验诊断类别：直接沿用 v1.4.0 的十一个稳定 Code。
 * 于是 beat-validation.json 的旧 issues 与新 diagnostics 是同一批事实的两种写法，
 * 映射时不需要翻译表（TASK §14「旧 issues 通过 DTO 兼容层继续提供」）。
 */
export const BEAT_DIAGNOSTIC_CATEGORIES = BEAT_VALIDATION_ISSUE_CODES;

/** §4 QualityDiagnostic：一条结构化诊断。 */
export interface QualityDiagnostic {
  /** 稳定标识：由校验方按输出顺序指派，不让模型自己编（见 validateQualityDiagnostics）。 */
  id: string;
  source: QualityDiagnosticSource;
  category: string;
  severity: QualityDiagnosticSeverity;
  target: QualityDiagnosticTarget;
  message: string;
  suggestion?: string;
  relatedBeatIds?: number[];
}

export function isQualityDiagnosticSource(value: unknown): value is QualityDiagnosticSource {
  return typeof value === "string" && (QUALITY_DIAGNOSTIC_SOURCES as readonly string[]).includes(value);
}

export function isQualityDiagnosticSeverity(value: unknown): value is QualityDiagnosticSeverity {
  return (
    typeof value === "string" && (QUALITY_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isQualityDiagnosticTarget(value: unknown): value is QualityDiagnosticTarget {
  return typeof value === "string" && (QUALITY_DIAGNOSTIC_TARGETS as readonly string[]).includes(value);
}

/**
 * 每个来源只认自己那一份类别白名单（§12/§13/§19）。
 * 故事质量诊断写进商业类别、或反过来，一律按非法输出处理——
 * 两套评价体系不做换算（与 v1.5.0 起「Co/N/C/Ca 与 H/P/E/Pf 不互相驱动」同一条边界）。
 */
export function diagnosticCategoriesOf(source: QualityDiagnosticSource): readonly string[] {
  if (source === "beat-validator") return BEAT_DIAGNOSTIC_CATEGORIES;
  if (source === "commercial-reviewer") return COMMERCIAL_DIAGNOSTIC_CATEGORIES;
  return QUALITY_DIAGNOSTIC_CATEGORIES;
}

/**
 * §37 单条诊断 schema：source / category / severity / target / message 全部必填且合法。
 *
 * `source` 由调用方给定而不是从 raw 里读：解析器在解析某一套组件的输出时
 * 就已经知道这条诊断是谁说的，模型再自报一遍只会多一个可以撒谎的地方。
 *
 * 未知键按仓库既有约定忽略（与 validateReviewResult 一致），但 §5 禁用的字段
 * 由 tests/test_quality_stack_security.test.ts 单独把守。
 */
export function validateQualityDiagnostic(
  raw: unknown,
  source: QualityDiagnosticSource,
): QualityDiagnostic {
  const r = (raw ?? {}) as Record<string, unknown>;
  const where = `diagnostics[${source}]`;

  if (typeof r.id !== "string" || !r.id.trim()) {
    throw new QualityDiagnosticValidationError(`${where}.id 必填`);
  }

  const category = typeof r.category === "string" ? r.category.trim() : "";
  const allowed = diagnosticCategoriesOf(source);
  if (!allowed.includes(category)) {
    throw new QualityDiagnosticValidationError(
      `${where}.category 非法：${category || "（空）"}（${source} 只允许 ${allowed.join(" / ")}）`,
    );
  }

  const severity = typeof r.severity === "string" ? r.severity.trim() : "";
  if (!isQualityDiagnosticSeverity(severity)) {
    throw new QualityDiagnosticValidationError(
      `${where}.severity 非法：${severity || "（空）"}（只允许 ${QUALITY_DIAGNOSTIC_SEVERITIES.join(" / ")}）`,
    );
  }

  const target = typeof r.target === "string" ? r.target.trim() : "";
  if (!isQualityDiagnosticTarget(target)) {
    throw new QualityDiagnosticValidationError(
      `${where}.target 非法：${target || "（空）"}（只允许 ${QUALITY_DIAGNOSTIC_TARGETS.join(" / ")}）`,
    );
  }

  const message = typeof r.message === "string" ? r.message.trim() : "";
  if (!message) throw new QualityDiagnosticValidationError(`${where}.message 不能为空`);

  const out: QualityDiagnostic = {
    id: r.id.trim(),
    source,
    category,
    severity,
    target,
    message,
  };
  // §4：suggestion 与 relatedBeatIds 都是可选的；给了就不能是空壳
  if (r.suggestion !== undefined && r.suggestion !== null) {
    const suggestion = typeof r.suggestion === "string" ? r.suggestion.trim() : "";
    if (!suggestion) {
      throw new QualityDiagnosticValidationError(`${where}.suggestion 必须是非空字符串`);
    }
    out.suggestion = suggestion;
  }
  if (r.relatedBeatIds !== undefined && r.relatedBeatIds !== null) {
    if (!Array.isArray(r.relatedBeatIds)) {
      throw new QualityDiagnosticValidationError(`${where}.relatedBeatIds 必须是数组`);
    }
    const beatIds = r.relatedBeatIds.filter(
      (v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0,
    );
    if (beatIds.length > 0) out.relatedBeatIds = beatIds;
  }
  return out;
}

/**
 * §37 诊断数组：逐条过 validateQualityDiagnostic，并补上稳定 id。
 *
 * id 由校验方按输出顺序指派（`<source>-<序号>`），不让模型自己编：
 * 模型编的 id 会随输出顺序漂移，去重、UI 定位、FailureAnalyzer 的证据指向都会对不上；
 * 而同一个故事两次审阅只要输出顺序一致，拿到的 id 就一致。
 */
export function validateQualityDiagnostics(
  raw: unknown,
  source: QualityDiagnosticSource,
): QualityDiagnostic[] {
  if (!Array.isArray(raw)) {
    throw new QualityDiagnosticValidationError(`diagnostics 必须是数组（${source}）`);
  }
  return raw.map((item, i) =>
    validateQualityDiagnostic({ ...(item as Record<string, unknown>), id: `${source}-${i + 1}` }, source),
  );
}

/** 读盘用的宽容版：结构认不出来时返回 null，绝不补一条假诊断占位。 */
export function qualityDiagnosticsOf(raw: unknown, source: QualityDiagnosticSource): QualityDiagnostic[] | null {
  try {
    return validateQualityDiagnostics(raw, source);
  } catch {
    return null;
  }
}

/** §23 去重键：只按 source + category + target + message，不做语义合并。 */
export function diagnosticDedupKey(diagnostic: QualityDiagnostic): string {
  return [diagnostic.source, diagnostic.category, diagnostic.target, diagnostic.message].join("|");
}

/**
 * §23 轻量去重：同一来源对同一处说的同一句话只留第一条。
 * 禁止 embedding 聚类与语义合并模型——这里只有字符串相等。
 */
export function dedupeQualityDiagnostics(
  diagnostics: readonly QualityDiagnostic[],
): QualityDiagnostic[] {
  const seen = new Set<string>();
  const out: QualityDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticDedupKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

/** §22 QualityStackResult.summary 的计数口径：一个函数算出来，UI 与落盘共用。 */
export function countDiagnosticsBySeverity(
  diagnostics: readonly QualityDiagnostic[],
): { totalDiagnostics: number; errors: number; warnings: number; info: number } {
  return {
    totalDiagnostics: diagnostics.length,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
  };
}
