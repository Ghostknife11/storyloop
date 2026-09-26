/**
 * v1.7.0 基础聚合：把一次实验的样本按 Variant 分组，算出计数与均值。
 *
 * 这里刻意只做两件事：数一数、算平均。没有排序、没有赢家、没有显著性检验、
 * 没有 p 值、没有置信区间、没有效应量。原因不是「以后再加」，而是这个版本
 * 就应该只回答「这几组数字分别是什么」——剩下的一半问题交给读结果的人。
 *
 * 两个口径问题必须先说清楚，否则数字会被读错：
 *   1. 均值只对「真的有分数」的样本求。一条样本的审阅失败了，overall_score 是 null，
 *      它不参与均值，也不被当成 0（补 0 等于凭空制造一个差评）。
 *   2. 分母是「有值的样本数」，不是「这一组的样本总数」。所以同一次实验里，
 *      A 组的三条都有分数、B 组只有一条有分数，两组的均值不可直接比大小——
 *      这也是 UI 上必须把有值数量摆出来的原因。
 */

import type { ArtifactStore } from "@/storage/artifact-store";
import type { ExperimentRunIndexEntry } from "@/types/experiment";
import type { ExperimentDefinition, ExperimentVariantSummary } from "@/types/experiment";
import type {
  ExperimentEfficiency,
  ExperimentEfficiencyMetric,
} from "@/types/experiment";
import type { QualityDimensionKey } from "@/types/quality-dimensions";
import type { CommercialDimensionKey } from "@/types/commercial-review";
import type { RunTelemetry } from "@/types/telemetry";

/** 一条样本读回来的分数（缺的项是 null，不补 0）。
 *  维度只搬分数：短评是给人读的一句话，不进均值。 */
export interface ExperimentRunScores {
  overallScore: number | null;
  commercialScore: number | null;
  dimensions: Partial<Record<QualityDimensionKey, number>> | null;
  commercial: Partial<Record<CommercialDimensionKey, number>> | null;
}

/**
 * 从这条 Run 自己的产物里取分数。
 *
 * 只读最终产物（运行根那一份），不重跑、不推断、不引用别的 Run。
 * 读不到（旧 Run / 这一步没跑 / 该步自己失败）就返回 null 项。
 */
export function runScoresOf(runId: string, store: ArtifactStore): ExperimentRunScores {
  const quality = store.readFinalQuality(runId);
  const commercial = store.readFinalCommercialReview(runId);
  return {
    overallScore: quality?.overall_score ?? null,
    commercialScore: commercial?.score ?? null,
    dimensions: dimensionScoresOf(quality?.dimensions),
    commercial: dimensionScoresOf(commercial?.dimensions),
  };
}

/** Record<Key, {score, short}> → Record<Key, number>：只要分数。 */
function dimensionScoresOf(
  dims: Record<string, { score: number } | undefined> | undefined,
): { [key: string]: number } | null {
  if (!dims) return null;
  const out: { [key: string]: number } = {};
  for (const [key, value] of Object.entries(dims)) {
    if (typeof value?.score === "number" && Number.isFinite(value.score)) out[key] = value.score;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 均值：没有有效值时返回 null；否则四舍五入到两位小数（TASK §59）。 */
export function meanOf(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) return null;
  const total = present.reduce((sum, v) => sum + v, 0);
  return Math.round((total / present.length) * 100) / 100;
}

/** 某一组里某个维度/指标的均值：只有至少一个样本带这个键才算得出来。 */
function meanOfField(
  samples: { scores: ExperimentRunScores }[],
  pick: (scores: ExperimentRunScores) => number | null | undefined,
): number | null {
  const values: (number | null)[] = [];
  for (const sample of samples) {
    const value = pick(sample.scores);
    if (typeof value === "number" && Number.isFinite(value)) values.push(value);
  }
  return meanOf(values);
}

// ---------------------------------------------------------------------------
// v1.8.0 效率指标（TASK §23/§24）
//
// 与分数均值同一套口径，只是数据源换成每个样本自己的 telemetry.json：
// 只对真有值的样本求均值，分母是有值的样本数（不是这一组的样本总数），
// 于是「3 次调用里有 1 次拿到了 usage」不会被稀释成「平均 1/3 个 token」。
// 1.8.0 之前跑出来的样本没有 telemetry.json，它们只是不进分母，不影响别的样本。
// ---------------------------------------------------------------------------

/** 一条样本读回来的效率原始值（缺的项是 undefined，不是 0）。 */
export interface ExperimentRunEfficiency {
  durationMs?: number | null;
  llmCalls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  retries?: number | null;
  repairs?: number | null;
}

/**
 * 从这条 Run 自己的 telemetry.json 取效率值。
 *
 * 读不到（1.8.0 之前的 Run / 文件被手改坏 / 这一步整体缺失）就整份是空对象——
 * 空对象表示「没有可用的效率数据」，不是「效率是 0」。
 */
export function runEfficiencyOf(runId: string, store: ArtifactStore): ExperimentRunEfficiency {
  const telemetry: RunTelemetry | null = store.readRunTelemetry(runId);
  if (telemetry === null) return {};
  const totals = telemetry.totals;
  return {
    durationMs: totals.durationMs,
    // 调用次数与重试次数是采集器必然给出的两项，没有它们说明这份遥测不完整
    llmCalls: totals.llmCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    retries: totals.retries,
    repairs: totals.repairs,
  };
}

/** 一个指标：均值 + 有值样本数。一个样本都没有时是 {mean: null, sampleCount: 0}。 */
function metricOf(
  samples: { efficiency: ExperimentRunEfficiency }[],
  pick: (efficiency: ExperimentRunEfficiency) => number | null | undefined,
): ExperimentEfficiencyMetric {
  let sampleCount = 0;
  let total = 0;
  for (const sample of samples) {
    const value = pick(sample.efficiency);
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      sampleCount += 1;
    }
  }
  return {
    mean: sampleCount === 0 ? null : Math.round((total / sampleCount) * 100) / 100,
    sampleCount,
  };
}

/** 一组样本的效率聚合。没有样本时六项都是 null + 0。 */
function efficiencyOf(samples: { efficiency: ExperimentRunEfficiency }[]): ExperimentEfficiency {
  return {
    durationMs: metricOf(samples, (e) => e.durationMs),
    llmCalls: metricOf(samples, (e) => e.llmCalls),
    inputTokens: metricOf(samples, (e) => e.inputTokens),
    outputTokens: metricOf(samples, (e) => e.outputTokens),
    totalTokens: metricOf(samples, (e) => e.totalTokens),
    retries: metricOf(samples, (e) => e.retries),
    repairs: metricOf(samples, (e) => e.repairs),
  };
}

/**
 * 按 definition.variants 的顺序分组聚合。
 *
 * 顺序就是定义里的声明顺序，不按分数重排——重排这一步就是排名，
 * 而 v1.7.0 不排名（TASK §26「无 winner」）。
 * 连一个样本都没跑出来的 Variant 也会出现在结果里（各项 null、计数为 0），
 * 否则读者会以为这次实验没有这一组。
 */
export function summarizeExperiment(
  definition: ExperimentDefinition,
  entries: ExperimentRunIndexEntry[],
  store: ArtifactStore,
): ExperimentVariantSummary[] {
  return definition.variants.map((variant) => {
    const cells = entries.filter((entry) => entry.variantId === variant.id && entry.runId !== null);
    const samples = cells.map((cell) => ({
      cell,
      scores: runScoresOf(cell.runId as string, store),
      efficiency: runEfficiencyOf(cell.runId as string, store),
    }));
    return {
      variantId: variant.id,
      runCount: cells.length,
      successCount: cells.filter((cell) => cell.status === "completed").length,
      failureCount: cells.filter((cell) => cell.status === "failed").length,
      meanOverallScore: meanOfField(samples, (s) => s.overallScore),
      meanCommercialScore: meanOfField(samples, (s) => s.commercialScore),
      meanCoherence: meanOfField(samples, (s) => s.dimensions?.coherence),
      meanNarrative: meanOfField(samples, (s) => s.dimensions?.narrative),
      meanCharacter: meanOfField(samples, (s) => s.dimensions?.character),
      meanCausality: meanOfField(samples, (s) => s.dimensions?.causality),
      meanHook: meanOfField(samples, (s) => s.commercial?.hook),
      meanPacing: meanOfField(samples, (s) => s.commercial?.pacing),
      meanEngagement: meanOfField(samples, (s) => s.commercial?.engagement),
      meanPayoff: meanOfField(samples, (s) => s.commercial?.payoff),
      // v1.8.0 §23：效率指标同样按 Variant 分组，同样只对真有的样本求
      efficiency: efficiencyOf(samples),
    };
  });
}

/** 整个实验的计数（不含任何判断）。 */
export function experimentCountsOf(entries: ExperimentRunIndexEntry[]): {
  runCount: number;
  successCount: number;
  failureCount: number;
} {
  const produced = entries.filter((entry) => entry.runId !== null);
  return {
    runCount: produced.length,
    successCount: produced.filter((entry) => entry.status === "completed").length,
    failureCount: produced.filter((entry) => entry.status === "failed").length,
  };
}
