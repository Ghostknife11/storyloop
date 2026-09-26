import { CATEGORY_LABELS } from "@/lib/failure-rules";
import type {
  FailureAnalysisResult,
  FailureCategory,
  FailureEvidence,
  FailureSignal,
} from "@/types/failure-analysis";

/**
 * v1.9.0 失败分析面板的唯一状态推导（与 telemetry-view / manifest-view 同一套模式）。
 *
 * 这个文件只回答「怎么显示」，不回答「这意味着什么」：
 *   - 不提供任何「很可能是因为…」：每条信号后面跟的是它自己的证据引用，
 *     结论到「哪一类、哪个阶段、哪份文件的哪个字段」为止（TASK §60/§69）。
 *   - §30 旧 Run 没有 failure-analysis.json（或文件被改坏）时整个面板不出现，
 *     由父层显示「这个 Run 没有失败分析」——不做迁移、不现算、不补零。
 *   - 取不到的值一律 —（与 telemetry-view 同一约定）。
 */

export type FailurePanelState =
  | { kind: "hidden" }
  | {
      kind: "ready";
      analysis: FailureAnalysisResult;
      schemaVersion: string;
      /** 状态 → 一行说明：none 就是「没有检测到运行级失败」。 */
      statusText: string;
      /** 主要失败类别（没有时为 null，此时不渲染这一行）。 */
      primaryLabel: string | null;
      /** 次要失败类别，按优先级排序后原样显示。 */
      secondaryLabels: string[];
      /** 首个失败阶段；没有时是 —。 */
      firstFailureStageText: string;
      /** 终态（completed / failed 等）；没有时是 —。 */
      terminalStateText: string;
      /** 信号表：code / 来源 / 严重度 / 说明。 */
      signals: FailureSignalRow[];
      /** 证据表：指向哪份文件的哪个字段、哪个 Attempt、哪一轮修订。 */
      evidence: FailureEvidenceRow[];
    };

export interface FailureSignalRow {
  key: string;
  code: string;
  sourceText: string;
  severity: FailureSignal["severity"];
  message: string;
}

export interface FailureEvidenceRow {
  key: string;
  /** 「beat-validation.json#issues[0].code」这类一句话，来源文件 + 字段。 */
  locationText: string;
  stageText: string;
  attemptText: string;
  repairText: string;
  valueText: string;
  note: string;
}

/** §18 信号来源 → 展示名。取值就是 FailureSignalSource 那十个。 */
const SOURCE_LABELS: Record<FailureSignal["source"], string> = {
  metadata: "metadata.json",
  telemetry: "telemetry.json",
  "beat-validation": "beat-validation.json",
  "story-validation": "validation.json",
  "quality-review": "quality.json",
  "commercial-review": "commercial-review.json",
  retry: "重试策略",
  repair: "修订记录",
  storage: "产物存储",
  security: "安全策略",
};

/** status → 一行说明。四种取值的含义与 failure-analysis.json 的 status 字段一致。 */
const STATUS_TEXTS: Record<FailureAnalysisResult["status"], string> = {
  none: "没有检测到运行级失败",
  detected: "检测到运行级失败",
  partial: "部分信号可归类，另有未能归类的信号",
  unknown: "有失败迹象，但归不进任何已知类别",
};

/** §7 严重度 → 展示色名（组件侧映射成 class，这里只给稳定字符串便于测试）。 */
export function severityClass(severity: FailureSignal["severity"]): string {
  if (severity === "error") return "text-red-600 dark:text-red-400";
  if (severity === "warning") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/** 类别名 → 展示名。白名单之外的取值原样显示，不猜。 */
export function categoryLabel(category: FailureCategory | null | undefined): string | null {
  if (category === null || category === undefined) return null;
  return CATEGORY_LABELS[category] ?? category;
}

function sourceTextOf(source: FailureSignal["source"]): string {
  return SOURCE_LABELS[source] ?? source;
}

function textValueOf(value: FailureEvidence["value"]): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

function locationTextOf(ev: FailureEvidence): string {
  const parts: string[] = [];
  if (ev.sourceArtifact) parts.push(ev.sourceArtifact);
  if (ev.sourceField) parts.push(ev.sourceField);
  if (parts.length === 0) return "—";
  return parts.join(" · ");
}

export function failurePanelState(
  analysis: FailureAnalysisResult | null | undefined,
): FailurePanelState {
  // §30：没有分析（旧 Run / 文件被改坏）时整个面板不出现
  if (analysis === null || analysis === undefined) return { kind: "hidden" };
  const signals: FailureSignalRow[] = analysis.signals.map((signal, i) => ({
    key: `${signal.code}-${i}`,
    code: signal.code,
    sourceText: sourceTextOf(signal.source),
    severity: signal.severity,
    message: signal.message,
  }));
  const evidence: FailureEvidenceRow[] = analysis.evidence.map((ev, i) => ({
    key: `${ev.sourceArtifact ?? "none"}-${ev.sourceField ?? "none"}-${i}`,
    locationText: locationTextOf(ev),
    stageText: ev.stage ?? "—",
    attemptText: typeof ev.attemptId === "string" ? ev.attemptId : "—",
    repairText: typeof ev.repairId === "string" ? ev.repairId : "—",
    valueText: textValueOf(ev.value),
    note: ev.note ?? "",
  }));
  return {
    kind: "ready",
    analysis,
    schemaVersion: analysis.schemaVersion,
    statusText: STATUS_TEXTS[analysis.status] ?? analysis.status,
    primaryLabel: categoryLabel(analysis.primaryCategory),
    secondaryLabels: analysis.secondaryCategories.map(
      (category) => CATEGORY_LABELS[category] ?? category,
    ),
    firstFailureStageText: analysis.firstFailureStage ?? "—",
    terminalStateText: analysis.terminalState ?? "—",
    signals,
    evidence,
  };
}
