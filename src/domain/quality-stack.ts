/**
 * v2.1.0 Quality Stack 的统一视图（TASK §21/§22/§23/§24）。
 *
 * quality-stack.json 是把三套已经存在的结论放到一张表里看，不是第四套评价：
 *   - beatValidation / qualityReview / commercialReview 原样收录，一分不改、
 *     一个维度不补（§22），某一套没跑出来就整个键不出现；
 *   - diagnostics 是三套诊断按 beat → quality → commercial 顺序合并后做轻量去重
 *     的结果（§23：只按 source + category + target + message 去重）；
 *   - summary 由 diagnostics 现算，不是另一份人工记账。
 *
 * 边界（TASK §21/§28）：这里没有 LLM、没有重新评分、没有 Story、没有 Retry /
 * Repair 判定。它只回答「这一轮质量侧发生了什么」。
 */

import {
  validateBeatValidationV2Result,
  type BeatValidationV2Result,
} from "@/domain/beat-validation-v2";
import {
  validateCommercialReviewV2Result,
  type CommercialReviewV2Result,
} from "@/domain/commercial-review-v2";
import {
  countDiagnosticsBySeverity,
  dedupeQualityDiagnostics,
  isQualityDiagnosticSource,
  validateQualityDiagnostic,
  type QualityDiagnostic,
  type QualityDiagnosticSource,
} from "@/domain/quality-diagnostic";
import {
  validateQualityReviewV2Result,
  type QualityReviewV2Result,
} from "@/domain/quality-review-v2";

/** quality-stack.json 自己的 schema 版本，与 run-manifest / telemetry 的各管各的。 */
export const QUALITY_STACK_SCHEMA_VERSION = "1";

export class QualityStackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityStackValidationError";
  }
}

/**
 * §22 status 三值：
 *   complete —— 三套结论都在
 *   partial  —— 至少一套在、但不是全套（§36：某一套失败时保留具体模块状态）
 *   failed   —— 一套都没有
 */
export type QualityStackStatus = "complete" | "partial" | "failed";

/** §22 summary：severity 计数，一个函数算出来，UI 与落盘共用同一口径。 */
export interface QualityStackSummary {
  totalDiagnostics: number;
  errors: number;
  warnings: number;
  info: number;
}

/** §22 QualityStackResult：统一视图 + 合并诊断 + severity 计数。 */
export interface QualityStackResult {
  schemaVersion: string;
  status: QualityStackStatus;
  beatValidation?: BeatValidationV2Result | null;
  qualityReview?: QualityReviewV2Result | null;
  commercialReview?: CommercialReviewV2Result | null;
  diagnostics: QualityDiagnostic[];
  summary: QualityStackSummary;
}

/** §21 协调器的输入：三套已经跑完的结论，缺哪一路就传 null（§36 具体模块状态由此保留）。 */
export interface QualityStackModules {
  beatValidation: BeatValidationV2Result | null;
  qualityReview: QualityReviewV2Result | null;
  commercialReview: CommercialReviewV2Result | null;
}

/**
 * §22/§36：按「有几套结论在位」定 status。
 * 没有结论就是 failed，三套齐全就是 complete，其余是 partial——
 * 这是一个确定性换算，不猜某一套为什么不在。
 */
export function qualityStackStatusOf(modules: QualityStackModules): QualityStackStatus {
  const present = [modules.beatValidation, modules.qualityReview, modules.commercialReview].filter(
    (entry) => entry !== undefined && entry !== null,
  ).length;
  if (present === 0) return "failed";
  if (present === 3) return "complete";
  return "partial";
}

/** 三套诊断的合并顺序：骨架 → 故事质量 → 商业可读性，与 UI 的 Overview 分区一致。 */
export function qualityStackDiagnosticsOf(modules: QualityStackModules): QualityDiagnostic[] {
  const all: QualityDiagnostic[] = [];
  for (const entry of [modules.beatValidation, modules.qualityReview, modules.commercialReview]) {
    if (entry) all.push(...entry.diagnostics);
  }
  return dedupeQualityDiagnostics(all);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * §37 读盘与写盘前的严格校验：形状不对就抛，绝不补一条假诊断、绝不补 0。
 *
 * 与三套 v2 结论同一套口径：
 *   - schemaVersion 只认 QUALITY_STACK_SCHEMA_VERSION；
 *   - status 只能取三值之一，且必须与「有几个模块键在位」对得上；
 *   - 三个模块键给 null 或干脆不给都算「这套没结论」，给了就必须过该模块自己的严格校验；
 *   - diagnostics 必须过单条 schema（category 按来源各认各的白名单），id 保持磁盘上的原值；
 *   - summary 必须与 diagnostics 现算的计数一致——对不上就是被人改过，整份作废。
 */
export function validateQualityStackResult(raw: unknown): QualityStackResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new QualityStackValidationError("quality stack 必须是对象");
  }
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== QUALITY_STACK_SCHEMA_VERSION) {
    throw new QualityStackValidationError(
      `schemaVersion 只支持 ${QUALITY_STACK_SCHEMA_VERSION}（实际 ${String(r.schemaVersion)}）`,
    );
  }

  const status = r.status;
  if (status !== "complete" && status !== "partial" && status !== "failed") {
    throw new QualityStackValidationError(`status 不合法：${String(status)}`);
  }

  const beatValidation = optionalModule(r.beatValidation, "beatValidation", validateBeatValidationV2Result);
  const qualityReview = optionalModule(r.qualityReview, "qualityReview", validateQualityReviewV2Result);
  const commercialReview = optionalModule(
    r.commercialReview,
    "commercialReview",
    validateCommercialReviewV2Result,
  );

  const modules: QualityStackModules = {
    beatValidation: beatValidation ?? null,
    qualityReview: qualityReview ?? null,
    commercialReview: commercialReview ?? null,
  };
  const expectedStatus = qualityStackStatusOf(modules);
  if (status !== expectedStatus) {
    throw new QualityStackValidationError(
      `status 与在位的模块对不上：${status}（这一份应当是 ${expectedStatus}）`,
    );
  }

  if (!Array.isArray(r.diagnostics)) {
    throw new QualityStackValidationError("diagnostics 必须是数组");
  }
  const diagnostics = r.diagnostics.map(validateStoredDiagnostic);

  if (typeof r.summary !== "object" || r.summary === null || Array.isArray(r.summary)) {
    throw new QualityStackValidationError("summary 必须是对象");
  }
  const summary = countDiagnosticsBySeverity(diagnostics);
  for (const key of ["totalDiagnostics", "errors", "warnings", "info"] as const) {
    const value = (r.summary as Record<string, unknown>)[key];
    if (value !== summary[key]) {
      throw new QualityStackValidationError(
        `summary.${key} 必须是 ${summary[key]}（实际 ${String(value)}）`,
      );
    }
  }

  const out: QualityStackResult = {
    schemaVersion: QUALITY_STACK_SCHEMA_VERSION,
    status,
    diagnostics,
    summary,
  };
  // 没有结论的模块整键不出现——与 v1.3.0 起「dimensions 没有就不造」同一条约定
  if (beatValidation) out.beatValidation = beatValidation;
  if (qualityReview) out.qualityReview = qualityReview;
  if (commercialReview) out.commercialReview = commercialReview;
  return out;
}

function optionalModule<T>(
  value: unknown,
  key: string,
  validate: (raw: unknown) => T,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return validate(value);
  } catch (e) {
    throw new QualityStackValidationError(`${key} 不是合法的结论：${errorText(e)}`);
  }
}

/**
 * 合并视图里的单条诊断：source 由记录自己说（这一份不是某一家的输出，而是三家合起来的一页），
 * 但 id 必须还是那家按输出顺序指派的 `<source>-<序号>`——否则 UI 定位与 FailureAnalyzer
 * 的证据指向会对不上。category 仍按 source 各认各的白名单（§12/§13/§19）。
 */
function validateStoredDiagnostic(raw: unknown): QualityDiagnostic {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new QualityStackValidationError("diagnostics 含非对象条目");
  }
  const source = (raw as Record<string, unknown>).source;
  if (!isQualityDiagnosticSource(source)) {
    throw new QualityStackValidationError(`diagnostics.source 非法：${String(source)}`);
  }
  const diagnostic = validateQualityDiagnostic(raw, source as QualityDiagnosticSource);
  if (!diagnostic.id.startsWith(`${source}-`)) {
    throw new QualityStackValidationError(
      `diagnostics.id 必须由 ${source} 按输出顺序指派（实际 ${diagnostic.id}）`,
    );
  }
  return diagnostic;
}

/** 读盘用的宽容版：结构认不出来时返回 null，绝不补一份假的质量总览占位。 */
export function qualityStackResultOf(raw: unknown): QualityStackResult | null {
  try {
    return validateQualityStackResult(raw);
  } catch {
    return null;
  }
}
