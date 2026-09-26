/**
 * v1.7.0 实验界面的唯一状态推导（与 manifest-view / quality-view 同一套模式）。
 *
 * 这里全部是纯函数：把 API 回来的定义与结果整理成「界面上要摆出来的行」。
 * 三条边界写死在实现里，因为它们分别是这个版本承诺过的三件事：
 *
 *   1. 不排名（TASK §26「无 winner」）。结果表的行顺序永远是 definition.variants
 *      的声明顺序，绝不按分数重排——重排这一步本身就是排名。
 *   2. 没有分数就没有数字。均值是 null 时显示「—」，不补 0、不显示「略」，
 *      也推导不出任何「谁更好」（§25 只做计数与均值）。
 *   3. 没有绝对路径、没有采样明细之外的任何东西。用户要点进具体一条样本，
 *      走既有的 Run 详情（/api/runs/<run_id>），这里只给链接。
 */

import type { ExperimentDetailApi, ExperimentDefinitionApi, ExperimentListItemApi } from "@/lib/api";
import type {
  ExperimentEfficiencyApi,
  ExperimentEfficiencyMetricApi,
  ExperimentFailureDistributionApi,
  ExperimentVariantSummaryApi,
} from "@/lib/api";
import { CATEGORY_LABELS, type FailureCategory } from "@/types/failure-analysis";

/** 实验状态 → 一行文案。语气中性：partial 不是失败，pending 不是错误。 */
export function experimentStatusLabel(status: string): { label: string; tone: "neutral" | "good" | "warn" | "bad" } {
  switch (status) {
    case "completed":
      return { label: "全部完成", tone: "good" };
    case "partial":
      return { label: "部分完成", tone: "warn" };
    case "failed":
      return { label: "没有可用样本", tone: "bad" };
    case "running":
      return { label: "正在运行", tone: "neutral" };
    default:
      return { label: "尚未运行", tone: "neutral" };
  }
}

/** 均值展示：null → 「—」，数字原样（两位小数是服务端算好的，这里不再加工）。 */
export function meanText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/**
 * v1.8.0 §24 效率一格：均值 + 有值样本数。
 *
 * 一个样本都没有时只显示「—」——不显示 `0/4`，那会让读者以为「跑过但全是 0」。
 * 格式：`4.2s · 2/4`（毫秒数在这里换成人读时长）。
 */
export function efficiencyCellText(
  metric: ExperimentEfficiencyMetricApi,
  runCount: number,
  format: (mean: number) => string,
): string {
  if (metric.mean === null || !Number.isFinite(metric.mean)) return "—";
  return `${format(metric.mean)} · ${metric.sampleCount}/${runCount}`;
}

/** 毫秒 → 人读时长（与 Run 详情同一套口径）。 */
export function msText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 一行 = 一个 Variant 的聚合数字。顺序 = definition.variants 的顺序（不按分数排）。 */
export interface ExperimentResultRow {
  variantId: string;
  variantName: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  meanOverallScore: number | null;
  meanCommercialScore: number | null;
  meanCoherence: number | null;
  meanNarrative: number | null;
  meanCharacter: number | null;
  meanCausality: number | null;
  meanHook: number | null;
  meanPacing: number | null;
  meanEngagement: number | null;
  meanPayoff: number | null;
  /** v1.8.0 §23：同一行的效率数字。没有遥测的样本不进分母，所以这里可能是 null。 */
  efficiency: ExperimentEfficiencyApi;
  /** v1.9.0 §52：同一行的失败类别分布；1.9.0 之前的实验没有这块，是 null。 */
  failures: ExperimentFailureDistributionRow | null;
}

/** v1.9.0 §52 一行失败类别分布：类别 → 条数，外加两个分母说明。 */
export interface ExperimentFailureDistributionRow {
  analyzedCount: number;
  classifiedCount: number;
  /** 按 FailureCategory 的优先级顺序排好，没出现过的类别不进来。 */
  items: { category: FailureCategory; label: string; count: number }[];
}

/** 还没跑出结果时返回 null（界面整段隐藏，不显示空表）。 */
export function resultRowsOf(detail: ExperimentDetailApi | null): ExperimentResultRow[] | null {
  const result = detail?.result;
  if (!result || !Array.isArray(result.summary?.variants)) return null;
  const nameOf = new Map(detail.definition.variants.map((v) => [v.id, v.name]));
  // 用定义顺序重建行，不信任服务端数组顺序以外的任何排序
  return detail.definition.variants.map((variant) => {
    const summary = result.summary.variants.find((s) => s.variantId === variant.id);
    // 定义里有、结果里没有的这一组：全 null、计数 0。服务端不会漏（summarizeExperiment
    // 每个 Variant 都给一行），但这里要挡住——读者以为「这次实验没有这一组」比空行更糟。
    return {
      variantId: variant.id,
      variantName: nameOf.get(variant.id) ?? variant.id,
      runCount: summary?.runCount ?? 0,
      successCount: summary?.successCount ?? 0,
      failureCount: summary?.failureCount ?? 0,
      meanOverallScore: summary?.meanOverallScore ?? null,
      meanCommercialScore: summary?.meanCommercialScore ?? null,
      meanCoherence: summary?.meanCoherence ?? null,
      meanNarrative: summary?.meanNarrative ?? null,
      meanCharacter: summary?.meanCharacter ?? null,
      meanCausality: summary?.meanCausality ?? null,
      meanHook: summary?.meanHook ?? null,
      meanPacing: summary?.meanPacing ?? null,
      meanEngagement: summary?.meanEngagement ?? null,
      meanPayoff: summary?.meanPayoff ?? null,
      efficiency: efficiencyOf(summary),
      failures: failureDistributionOf(summary),
    };
  });
}

/**
 * v1.9.0 §52 摘要 → 行。没有这一块（1.9.0 之前跑出来的实验）时返回 null，
 * 界面据此整段隐藏，不当 0、也不显示「全部没有失败」。
 * 顺序按 FailureCategory 的固定优先级，不按条数重排——重排就是排名。
 */
function failureDistributionOf(
  summary: ExperimentVariantSummaryApi | undefined,
): ExperimentFailureDistributionRow | null {
  const failures: ExperimentFailureDistributionApi | undefined = summary?.failures;
  if (failures === undefined) return null;
  const counts = failures.counts ?? {};
  const items = (Object.keys(CATEGORY_LABELS) as FailureCategory[])
    .filter((category) => typeof counts[category] === "number")
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      count: counts[category] ?? 0,
    }));
  return {
    analyzedCount: typeof failures.analyzedCount === "number" ? failures.analyzedCount : 0,
    classifiedCount: typeof failures.classifiedCount === "number" ? failures.classifiedCount : 0,
    items,
  };
}

/** §52 分布的一行文案：`正文生成问题 ×2 · 重试次数用尽 ×1`；一条都没有时是「—」。 */
export function failureDistributionText(row: ExperimentFailureDistributionRow | null): string {
  if (row === null || row.items.length === 0) return "—";
  return row.items.map((item) => `${item.label} ×${item.count}`).join(" · ");
}

/** v1.7.1 之前跑出来的实验没有 efficiency 块：各项按「没有数据」处理，不是按 0。 */
const EMPTY_METRIC: ExperimentEfficiencyMetricApi = { mean: null, sampleCount: 0 };

function efficiencyOf(summary: ExperimentVariantSummaryApi | undefined): ExperimentEfficiencyApi {
  const e = summary?.efficiency;
  return {
    durationMs: e?.durationMs ?? EMPTY_METRIC,
    llmCalls: e?.llmCalls ?? EMPTY_METRIC,
    inputTokens: e?.inputTokens ?? EMPTY_METRIC,
    outputTokens: e?.outputTokens ?? EMPTY_METRIC,
    totalTokens: e?.totalTokens ?? EMPTY_METRIC,
    retries: e?.retries ?? EMPTY_METRIC,
    repairs: e?.repairs ?? EMPTY_METRIC,
  };
}

/** 变体卡片：这个名字 + 它相对 Base 改了哪些变量（没改就不列）。 */
export interface VariantChange {
  label: string;
  value: string;
}

export interface VariantCard {
  variantId: string;
  variantName: string;
  changes: VariantChange[];
}

const PARAM_LABELS: Record<string, string> = {
  model: "Model",
  temperature: "Temperature",
  maxAttempts: "Max Attempts",
  minReviewScore: "Min Review Score",
};

function baseValueOf(definition: ExperimentDefinitionApi, key: "model" | "temperature" | "maxAttempts" | "minReviewScore"): string {
  const { base } = definition;
  if (key === "model") return base.modelConfig?.model ?? "服务端默认";
  if (key === "temperature") {
    return base.generationParameters?.temperature !== undefined ? String(base.generationParameters.temperature) : "服务端默认";
  }
  const policy = base.retryPolicy;
  if (!policy) return "默认策略";
  if (key === "maxAttempts") return String(policy.max_attempts);
  return String(policy.min_review_score);
}

/**
 * 每个 Variant 一张卡片。
 *
 * 「什么都没改」也是合法 Variant（基准自己就是一个 Variant），此时卡片写
 * 「与 Base 相同」——这句话是事实，不暗示它是参照组或更好。
 */
export function variantCardsOf(definition: ExperimentDefinitionApi): VariantCard[] {
  return definition.variants.map((variant) => {
    const changes: VariantChange[] = [];
    if (variant.overrides.model !== undefined) {
      changes.push({ label: PARAM_LABELS.model, value: `${baseValueOf(definition, "model")} → ${variant.overrides.model}` });
    }
    if (variant.overrides.generation?.temperature !== undefined) {
      const to = variant.overrides.generation.temperature;
      changes.push({ label: PARAM_LABELS.temperature, value: `${baseValueOf(definition, "temperature")} → ${to}` });
    }
    if (variant.overrides.retry?.maxAttempts !== undefined) {
      changes.push({
        label: PARAM_LABELS.maxAttempts,
        value: `${baseValueOf(definition, "maxAttempts")} → ${variant.overrides.retry.maxAttempts}`,
      });
    }
    if (variant.overrides.retry?.minReviewScore !== undefined) {
      changes.push({
        label: PARAM_LABELS.minReviewScore,
        value: `${baseValueOf(definition, "minReviewScore")} → ${variant.overrides.retry.minReviewScore}`,
      });
    }
    return { variantId: variant.id, variantName: variant.name, changes };
  });
}

/** 一行 = 一条样本 Run。顺序与 runs.json 一致（Variant 顺序 × repetition 顺序）。 */
export interface ExperimentRunRow {
  variantId: string;
  variantName: string;
  repetition: number;
  runId: string | null;
  status: "pending" | "completed" | "failed";
  failure: string | null;
  overallScore: number | null;
  commercialScore: number | null;
}

export function runRowsOf(detail: ExperimentDetailApi | null): ExperimentRunRow[] {
  const runs = detail?.runs;
  if (!runs || !Array.isArray(runs.entries)) return [];
  const nameOf = new Map(detail.definition.variants.map((v) => [v.id, v.name]));
  const scoreOf = new Map<string, { overall: number | null; commercial: number | null }>();
  for (const reference of detail.result?.runs ?? []) {
    scoreOf.set(reference.runId, {
      overall: overallScoreOf(reference),
      commercial: commercialScoreOf(reference),
    });
  }
  return runs.entries.map((entry) => {
    const scores = entry.runId ? scoreOf.get(entry.runId) : undefined;
    return {
      variantId: entry.variantId,
      variantName: nameOf.get(entry.variantId) ?? entry.variantId,
      repetition: entry.repetition,
      runId: entry.runId,
      status: entry.status,
      failure: entry.failure ?? null,
      overallScore: scores?.overall ?? null,
      commercialScore: scores?.commercial ?? null,
    };
  });
}

/** 分数只认数字；没有分数（这一步失败 / 旧 Run）就是 null，不猜、不补 0。 */
function overallScoreOf(reference: { overallScore?: number | null }): number | null {
  return typeof reference.overallScore === "number" && Number.isFinite(reference.overallScore)
    ? reference.overallScore
    : null;
}

function commercialScoreOf(reference: { commercialScore?: number | null }): number | null {
  return typeof reference.commercialScore === "number" && Number.isFinite(reference.commercialScore)
    ? reference.commercialScore
    : null;
}

/** 列表页的一行：足够判断要不要点进去，不给任何比较结论。 */
export function experimentListRow(item: ExperimentListItemApi): {
  title: string;
  subtitle: string;
  status: { label: string; tone: "neutral" | "good" | "warn" | "bad" };
} {
  return {
    title: item.name,
    subtitle: `${item.variantCount} 个变体 × ${item.repetitions} 次 = ${item.totalRuns} 条样本`,
    status: experimentStatusLabel(item.status),
  };
}
