/**
 * v1.9.0 Failure Analysis 领域模型：把「这个 Run 失败了」变成「它属于哪一类失败、
 * 有哪些信号、证据指向哪里」。这是本版本的唯一新数据形状，API / UI / 持久化 / 实验
 * 聚合四处共用，所以命名与口径都收敛在这里。
 *
 * §24/§67 边界：这里没有任何字段用于表达「为什么失败」。没有 rootCause、
 * 没有 probability、没有 confidence、没有 attribution，也不会有——
 * 本版本只做分类与证据链接，不推断因果。
 *
 * 命名沿用仓库现状：领域模型内部用 snake_case（与 validation-result.ts /
 * quality.ts 一致），于是模型、failure-analysis.json、API 响应三处同名。
 */

import type { BeatValidationResult } from "@/types/beat-validation";
import type { CommercialReviewResult } from "@/types/commercial-review";
import type { QualityResult } from "@/types/quality";
import type { ReviewResult } from "@/types/review-result";
import type { RunTelemetry } from "@/types/telemetry";
import type { ValidationResult } from "@/types/validation-result";

/** §27 failure-analysis.json 的 schema 版本。只增字段不改语义时不动它。 */
export const FAILURE_ANALYSIS_SCHEMA_VERSION = "1";

/**
 * §4 失败类别：固定集合，只能追加，不能改名或改含义。
 *
 * 顺序即 §22 的 Primary 优先级（数字越小越优先）：安全与配置最先，
 * 因为它们是「这次 Run 根本没跑起来」；商业可读性最后，因为它是评价结论，
 * 不是技术失败（§10）。
 */
export const FAILURE_CATEGORIES = [
  "SECURITY",
  "CONFIGURATION",
  "STORAGE",
  "PLANNING",
  "GENERATION",
  "VALIDATION",
  "REVIEWER",
  "RETRY_EXHAUSTION",
  "REPAIR_EXHAUSTION",
  "QUALITY",
  "COMMERCIAL",
  "UNKNOWN",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === "string" && (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * §33/§52 类别的中文展示标签：分析摘要、Run 面板、实验聚合共用同一份措辞。
 *
 * 放在这里而不是 `lib/failure-rules.ts`，是因为规则表为了 `instanceof PipelineError`
 * 会把整条服务端链路（含 node:fs）拖进依赖图；界面只需要一份标签，
 * 不该为此把产物读写代码打进浏览器包。
 */
export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  SECURITY: "安全策略阻止",
  CONFIGURATION: "配置问题",
  STORAGE: "产物存储问题",
  PLANNING: "剧情骨架问题",
  GENERATION: "正文生成问题",
  VALIDATION: "正文校验问题",
  REVIEWER: "审阅环节问题",
  RETRY_EXHAUSTION: "重试次数用尽",
  REPAIR_EXHAUSTION: "修订次数用尽",
  QUALITY: "质量偏低",
  COMMERCIAL: "商业可读性偏低",
  UNKNOWN: "未能归类",
};

/**
 * §18 一条信号出自哪里。取值就是仓库里真实存在的事实来源，
 * 不发明「模型内部状态」这类拿不到证据的出处。
 */
export type FailureSignalSource =
  | "metadata"
  | "telemetry"
  | "beat-validation"
  | "story-validation"
  | "quality-review"
  | "commercial-review"
  | "retry"
  | "repair"
  | "storage"
  | "security";

/**
 * §18 FailureSignal：一条可观测的事实。code 是稳定标识（API / UI / 聚合都只用它），
 * severity 表达「这件事有多硬」——info 是背景，warning 是薄弱项，error 是硬失败。
 */
export interface FailureSignal {
  code: string;
  source: FailureSignalSource;
  severity: "info" | "warning" | "error";
  message: string;
}

/**
 * §19 FailureEvidence：一条指向现有事实的引用。note 是人读的那句话，
 * 其余字段都是「去哪儿看」——sourceArtifact / sourceField / stage /
 * attemptId / repairId / code / value 全部可空，因为有些信号只有 note 可写。
 */
export interface FailureEvidence {
  sourceArtifact?: string | null;
  sourceField?: string | null;
  stage?: string | null;
  attemptId?: string | null;
  repairId?: string | null;
  code?: string | null;
  value?: string | number | boolean | null;
  note: string;
}

/**
 * §17 FailureAnalysisResult：一次 Run 的失败分析结论。
 *
 * status 四值（§28/§47）：
 *   none     —— 没有发现运行级失败（成功 Run 也是这个）
 *   detected —— 至少一个类别有直接证据
 *   partial  —— 有失败迹象，但类别只能部分确定
 *   unknown  —— 有失败，但证据不足以归类（§16：优于猜测）
 *
 * primaryCategory 在 status = none 时是 null；secondaryCategories 不包含 primary。
 */
export interface FailureAnalysisResult {
  schemaVersion: string;
  runId: string;
  status: "none" | "detected" | "partial" | "unknown";
  primaryCategory: FailureCategory | null;
  secondaryCategories: FailureCategory[];
  summary: string;
  signals: FailureSignal[];
  evidence: FailureEvidence[];
  /** 第一次失败发生在哪个阶段；没有失败事实时是 null（不猜）。 */
  firstFailureStage: string | null;
  /** 这个 Run 最终停在哪里（completed / failed / 状态字段原值）；读不到时 null。 */
  terminalState: string | null;
}

/** §3 FailureAnalyzer 的输入：全部是**已经存在**的事实，没有一项需要新采集。 */
export interface FailureAnalysisInput {
  runId: string;
  /** metadata.status 原值（completed / failed / …）。 */
  status: string | null;
  /** metadata.quality_status 原值（accepted / exhausted）。 */
  qualityStatus: string | null;
  attemptCount: number | null;
  selectedAttempt: number | null;
  /** 当时生效的策略（§38/§39：耗尽判定必须用真实上限，不能用猜测值）。 */
  maxAttempts: number | null;
  minReviewScore: number | null;
  enableRepair: boolean | null;
  maxRepairsPerAttempt: number | null;
  repairCount: number | null;
  /** v1.8.0 遥测：阶段状态与失败码的事实来源。旧 Run 没有这份文件时是 null。 */
  telemetry: RunTelemetry | null;
  /** v1.4.0 骨架校验结论；没跑过这一步时是 null。 */
  beatValidation: BeatValidationResult | null;
  beatValidationStatus: string | null;
  validation: ValidationResult | null;
  validationStatus: string | null;
  review: ReviewResult | null;
  reviewStatus: string | null;
  commercialReview: CommercialReviewResult | null;
  commercialReviewStatus: string | null;
  quality: QualityResult | null;
  /** 各 Attempt 的采纳结论与修订摘要（§38/§39 的判定依据）。 */
  attempts: FailureAnalysisAttempt[];
  /** 中途观测到的错误码原文（含未知码，§41：不丢）。 */
  errorCodes: string[];
  /** §42 产物存在性：只作辅助信号，不单独定类。 */
  artifactPresence: FailureArtifactPresence;
}

/** §3/§38 一次 Attempt 在分析里的最小事实集。 */
export interface FailureAnalysisAttempt {
  attemptNumber: number;
  accepted: boolean | null;
  retryReason: string | null;
  validationPassed: boolean | null;
  repairCount: number;
  /** 这一 Attempt 里每轮修订的成败与针对的问题类型（§39）。 */
  repairs: { repairNumber: number; issueType: string; success: boolean }[];
}

/** §42 产物存在性：true / false / null（null = 这次 Run 不该有这个文件，或读不到）。 */
export interface FailureArtifactPresence {
  story: boolean;
  beatValidation: boolean;
  validation: boolean;
  review: boolean;
  commercialReview: boolean;
  quality: boolean;
  manifest: boolean;
  telemetry: boolean;
}

// ---------------------------------------------------------------------------
// 校验与读取归一化（与 runTelemetryOf / runManifestOf 同一套约定）
// ---------------------------------------------------------------------------

function strOf(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FailureAnalysisError(`${field} 必须是非空字符串`);
  }
  return value;
}

function optStrOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function opt<T extends object>(patch: Record<string, unknown>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as Partial<T>;
}

/** 结构校验：形状不对就抛（写盘前自查用，与 validateRunTelemetry 同一套口径）。 */
export function validateFailureAnalysis(raw: unknown): FailureAnalysisResult {
  if (typeof raw !== "object" || raw === null) {
    throw new FailureAnalysisError("failure analysis 必须是对象");
  }
  const r = raw as Record<string, unknown>;
  if (strOf(r.schemaVersion, "schemaVersion") !== FAILURE_ANALYSIS_SCHEMA_VERSION) {
    throw new FailureAnalysisError(`schemaVersion 只支持 ${FAILURE_ANALYSIS_SCHEMA_VERSION}`);
  }
  const status = strOf(r.status, "status");
  if (status !== "none" && status !== "detected" && status !== "partial" && status !== "unknown") {
    throw new FailureAnalysisError(`status 不合法：${status}`);
  }
  const primary = r.primaryCategory;
  let primaryCategory: FailureCategory | null = null;
  if (primary !== undefined && primary !== null) {
    if (!isFailureCategory(primary)) {
      throw new FailureAnalysisError(`primaryCategory 不合法：${String(primary)}`);
    }
    primaryCategory = primary;
  }
  if (status === "none" && primaryCategory !== null) {
    throw new FailureAnalysisError("status 为 none 时 primaryCategory 必须是 null");
  }
  if (!Array.isArray(r.secondaryCategories)) {
    throw new FailureAnalysisError("secondaryCategories 必须是数组");
  }
  const secondary = (r.secondaryCategories as unknown[]).map((c) => {
    if (!isFailureCategory(c)) throw new FailureAnalysisError(`secondaryCategories 含非法值：${String(c)}`);
    return c;
  });
  if (primaryCategory !== null && secondary.includes(primaryCategory)) {
    throw new FailureAnalysisError("secondaryCategories 不能包含 primaryCategory");
  }
  if (!Array.isArray(r.signals)) throw new FailureAnalysisError("signals 必须是数组");
  if (!Array.isArray(r.evidence)) throw new FailureAnalysisError("evidence 必须是数组");
  return {
    schemaVersion: FAILURE_ANALYSIS_SCHEMA_VERSION,
    runId: strOf(r.runId, "runId"),
    status,
    primaryCategory,
    secondaryCategories: secondary,
    summary: strOf(r.summary, "summary"),
    signals: (r.signals as unknown[]).map(validateFailureSignal),
    evidence: (r.evidence as unknown[]).map(validateFailureEvidence),
    firstFailureStage: optStrOf(r.firstFailureStage) ?? null,
    terminalState: optStrOf(r.terminalState) ?? null,
  };
}

function validateFailureSignal(raw: unknown): FailureSignal {
  if (typeof raw !== "object" || raw === null) throw new FailureAnalysisError("signal 必须是对象");
  const r = raw as Record<string, unknown>;
  const severity = strOf(r.severity, "signal.severity");
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new FailureAnalysisError(`signal.severity 不合法：${severity}`);
  }
  return {
    code: strOf(r.code, "signal.code"),
    source: strOf(r.source, "signal.source") as FailureSignalSource,
    severity,
    message: strOf(r.message, "signal.message"),
  };
}

function validateFailureEvidence(raw: unknown): FailureEvidence {
  if (typeof raw !== "object" || raw === null) throw new FailureAnalysisError("evidence 必须是对象");
  const r = raw as Record<string, unknown>;
  if (typeof r.note !== "string" || r.note.length === 0) {
    throw new FailureAnalysisError("evidence.note 必须是非空字符串");
  }
  const value = r.value;
  if (
    value !== undefined &&
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new FailureAnalysisError("evidence.value 只能是字符串 / 数字 / 布尔");
  }
  return {
    ...opt<FailureEvidence>({ sourceArtifact: optStrOf(r.sourceArtifact) }),
    ...opt<FailureEvidence>({ sourceField: optStrOf(r.sourceField) }),
    ...opt<FailureEvidence>({ stage: optStrOf(r.stage) }),
    ...opt<FailureEvidence>({ attemptId: optStrOf(r.attemptId) }),
    ...opt<FailureEvidence>({ repairId: optStrOf(r.repairId) }),
    ...opt<FailureEvidence>({ code: optStrOf(r.code) }),
    ...opt<FailureEvidence>({ value: value as string | number | boolean | null | undefined }),
    note: r.note,
  };
}

/** 读取时归一化：任何形状问题都归一成 null，不抛给调用方。 */
export function failureAnalysisOf(raw: unknown): FailureAnalysisResult | null {
  try {
    return validateFailureAnalysis(raw);
  } catch {
    return null;
  }
}

/** §29：分析器自身出错时用的显式类型（与 TelemetryError 同一套命名）。 */
export class FailureAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailureAnalysisError";
  }
}
