import type { RunTelemetry, StageName, StageTelemetry, LLMCallTelemetry } from "@/types/telemetry";
import { telemetryErrorMessage } from "@/core/telemetry-collector";

/**
 * v1.8.0 Observability 面板的唯一状态推导（与 manifest-view / quality-view 同一套模式）。
 *
 * 这个文件只回答「怎么显示」，不回答「这意味着什么」：
 *   - 没有「慢」「快」「正常」这类阈值判断——本版本不设基线，也不做告警（TASK §31）。
 *   - 没有失败归因、没有「很可能是因为」：失败阶段与错误码是摆出来的事实，
 *     至于原因， telemetry 里没有，也不许从这里推（TASK §60）。
 *   - null 一律显示成 —，绝不显示成 0（TASK §24）。「Provider 没给 usage」与
 *     「用了 0 token」在读起来必须是两件事。
 */

export type TelemetryPanelState =
  | { kind: "hidden" }
  | {
      kind: "ready";
      telemetry: RunTelemetry;
      /** 七个总量指标；成本只有真实可得时才有这一行。 */
      summary: TelemetrySummaryRow[];
      /** §27 阶段时间线：按发生顺序，含 skipped 与 failed。 */
      stages: StageTimelineRow[];
      /** §28 模型调用表：按发生顺序。 */
      calls: LLMCallRow[];
      attempts: AttemptRow[];
      /** 失败时的失败阶段；成功 Run 是 null，整段不渲染。 */
      failure: FailureRow | null;
      /** 遥测自身的 schema 版本号，面板脚注用。 */
      schemaVersion: string;
    };

export interface TelemetrySummaryRow {
  key: string;
  label: string;
  value: string;
  /** 取不到值时是 true，用 — 显示；这一行的 value 本身已经是 fallback 文本。 */
  unknown: boolean;
}

export interface StageTimelineRow {
  key: string;
  stage: StageName;
  label: string;
  status: StageTelemetry["status"];
  statusText: string;
  durationText: string;
  /** 0 ~ 100，相对本次 Run 里最慢的那个阶段；用于时间线条宽。 */
  percent: number;
  attemptLabel: string | null;
  errorText: string | null;
  errorCode: string | null;
}

export interface LLMCallRow {
  key: string;
  id: string;
  stage: StageName;
  stageLabel: string;
  model: string;
  durationText: string;
  inputText: string;
  outputText: string;
  status: LLMCallTelemetry["status"];
  errorText: string | null;
  hasCost: boolean;
}

export interface AttemptRow {
  key: string;
  label: string;
  statusText: string;
  durationText: string;
  callsText: string;
  repairsText: string;
}

export interface FailureRow {
  stageText: string;
  codeText: string;
}

/** 阶段名 → 展示名。顺序固定沿用 STAGE_NAMES 的真实顺序，不按耗时重排。 */
const STAGE_LABELS: Record<StageName, string> = {
  planning: "Planning",
  validating_beat_plan: "Beat structure validation",
  generating: "Writing",
  saving: "Saving artifacts",
  validating: "Validation",
  reviewing: "Review",
  repairing: "Repair",
  revalidating: "Re-validation",
  rereviewing: "Re-review",
  reviewing_commercial: "Commercial review",
  artifact_promotion: "Artifact promotion",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as StageName] ?? stage;
}

/** §24 的展示侧：null / undefined / 非有限数一律 —，0 是 0。 */
export function numberText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/** 毫秒 → 人读时长。不足 1 秒显示毫秒，超过 1 分钟顺带上分钟。 */
export function durationText(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} ms`;
  const seconds = rounded / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds - minutes * 60)} s`;
}

function tokenText(value: number | null | undefined): string {
  return numberText(value);
}

/** §8：token 三个数只在 Provider 真给过 usage 时才有意义，否则整行显示 —。 */
function tokenUsageText(t: RunTelemetry["totals"]): { text: string; unknown: boolean } {
  if (t.usageSampleCount === 0) {
    return { text: "—（Provider 未返回 usage）", unknown: true };
  }
  const parts = [
    `in ${tokenText(t.inputTokens)}`,
    `out ${tokenText(t.outputTokens)}`,
    `total ${tokenText(t.totalTokens)}`,
  ].join(" · ");
  return { text: `${parts} · 样本 ${t.usageSampleCount}/${t.llmCalls}`, unknown: false };
}

/** §8：只有至少一次调用真的带回金额与币种，成本这一行才出现。 */
function costText(t: RunTelemetry): string | null {
  const priced = t.llmCalls.filter((c) => c.cost && typeof c.cost.amount === "number");
  if (priced.length === 0) return null;
  const byCurrency = new Map<string, number>();
  for (const call of priced) {
    const currency = call.cost?.currency ?? "?";
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + (call.cost?.amount ?? 0));
  }
  const text = [...byCurrency.entries()]
    .map(([currency, amount]) => `${amount} ${currency}`)
    .join(" · ");
  return `${text} · ${priced.length}/${t.llmCalls} 次调用有价`;
}

export function telemetryPanelState(telemetry: RunTelemetry | null | undefined): TelemetryPanelState {
  // §29：旧 Run 没有 telemetry.json；连 runId 都读不到就不展示，不猜、不补零
  if (!telemetry || typeof telemetry.runId !== "string" || !telemetry.runId.trim()) {
    return { kind: "hidden" };
  }
  const t = telemetry;
  const usage = tokenUsageText(t.totals);
  const cost = costText(t);

  const summary: TelemetrySummaryRow[] = [
    {
      key: "duration",
      label: "Total duration",
      value: durationText(t.durationMs),
      unknown: typeof t.durationMs !== "number",
    },
    {
      key: "llm_calls",
      label: "LLM calls",
      value: numberText(t.totals.llmCalls),
      unknown: false,
    },
    {
      key: "attempts",
      label: "Attempts",
      value: numberText(t.attempts.length),
      unknown: false,
    },
    {
      key: "retries",
      label: "Retries",
      value: numberText(t.totals.retries),
      unknown: false,
    },
    {
      key: "repairs",
      label: "Repairs",
      value: numberText(t.totals.repairs),
      unknown: false,
    },
    { key: "tokens", label: "Token usage", value: usage.text, unknown: usage.unknown },
  ];
  // §26：成本「若真实可得」——没有价格数据时这一行整个不出现，不显示 0
  if (cost !== null) {
    summary.push({ key: "cost", label: "Cost", value: cost, unknown: false });
  }

  return {
    kind: "ready",
    telemetry: t,
    summary,
    stages: stageTimelineRows(t),
    calls: llmCallRows(t),
    attempts: attemptRows(t),
    failure: failureRowOf(t),
    schemaVersion: t.schemaVersion,
  };
}

/** §27 阶段时间线：一行一次执行；条宽相对最慢阶段，不是相对总时长（阶段之间有间隔）。 */
export function stageTimelineRows(t: RunTelemetry): StageTimelineRow[] {
  const slowest = t.stages.reduce((max, s) => Math.max(max, s.durationMs ?? 0), 0);
  return t.stages.map((s, i) => ({
    key: `${s.stage}-${i}`,
    stage: s.stage,
    label: stageLabel(s.stage),
    status: s.status,
    statusText: stageStatusText(s.status),
    durationText: durationText(s.durationMs),
    percent: slowest > 0 && typeof s.durationMs === "number" ? Math.round((s.durationMs / slowest) * 100) : 0,
    attemptLabel: typeof s.attemptNumber === "number" ? `Attempt ${s.attemptNumber}` : null,
    errorCode: s.errorCode ?? null,
    errorText: s.status === "failed" ? telemetryErrorMessage(s.errorCode ?? "") : null,
  }));
}

function stageStatusText(status: StageTelemetry["status"]): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
  }
}

/** §28 模型调用表：模型名、耗时、真实 usage、结局；usage 取不到就是 —。 */
export function llmCallRows(t: RunTelemetry): LLMCallRow[] {
  return t.llmCalls.map((c) => ({
    key: c.id,
    id: c.id,
    stage: c.stage,
    stageLabel: stageLabel(c.stage),
    model: c.model ?? "—",
    durationText: durationText(c.durationMs),
    inputText: numberText(c.inputTokens),
    outputText: numberText(c.outputTokens),
    status: c.status,
    errorText: c.status === "failed" ? telemetryErrorMessage(c.errorCode ?? "") : null,
    hasCost: Boolean(c.cost && typeof c.cost.amount === "number"),
  }));
}

function attemptStatusText(status: "accepted" | "retried" | "failed"): string {
  switch (status) {
    case "accepted":
      return "accepted";
    case "retried":
      return "retried";
    case "failed":
      return "failed";
  }
}

function attemptRows(t: RunTelemetry): AttemptRow[] {
  return t.attempts.map((a) => ({
    key: a.attemptId,
    label: `Attempt ${a.index}`,
    statusText: attemptStatusText(a.status),
    durationText: durationText(a.durationMs),
    callsText: [
      `write ${a.generationCalls}`,
      `review ${a.reviewCalls}`,
      `commercial ${a.commercialReviewCalls}`,
    ].join(" · "),
    repairsText: `${a.repairCount}`,
  }));
}

function failureRowOf(t: RunTelemetry): FailureRow | null {
  if (t.status !== "failed") return null;
  const stage = typeof t.failureStage === "string" && t.failureStage.trim() ? t.failureStage : "unknown stage";
  return {
    stageText: stageLabel(stage),
    codeText: telemetryErrorMessage(t.failureCode ?? ""),
  };
}
