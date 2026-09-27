/**
 * v2.3.0 Benchmark 指标读取（TASK §26/§27/§28/§105）。
 *
 * 一句话概括这个模块：**把一条 Run 已经写下的事实搬进指标表，一个数都不新造**。
 *
 * 三条边界：
 *   1. 不调 Reviewer、不重新评分（TASK §28）。Benchmark 路径与 Production 路径
 *      打的是同一套分——因为这里读的就是 Production 那次跑出来的结论。
 *   2. 只读最终产物（运行根那一份），不读 Attempt 中间的版本，也不引用别的 Run。
 *   3. 读不到就是 null（TASK §30）。Provider 没给 usage、某一步没跑、文件被手改坏，
 *      都让这个指标是 null；补 0 等于凭空发明一次「没有 usage 的调用」。
 */

import type { ArtifactStore } from "@/ports/artifact-store";
import {
  BENCHMARK_METRIC_DEFINITIONS,
  emptyMetricValues,
  type BenchmarkMetricValues,
} from "@/domain/benchmark-metric";
import type { RunManifest } from "@/domain/run-manifest";
import type { RunTelemetry } from "@/domain/telemetry";

/** 有限数字原样留下，其它一律 null。 */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 维度分：只要分数，短评是给人读的一句话，不进指标表。 */
function dimensionScore(dimensions: unknown, key: string): number | null {
  if (typeof dimensions !== "object" || dimensions === null) return null;
  const entry = (dimensions as Record<string, unknown>)[key];
  if (typeof entry !== "object" || entry === null) return null;
  return numOrNull((entry as Record<string, unknown>).score);
}

/** 0/100 的比率：只有确实拿到布尔结论时才有值，「没跑到」与「没通过」是两件事。 */
function rate(passed: boolean | null | undefined): number | null {
  return typeof passed === "boolean" ? (passed ? 100 : 0) : null;
}

/**
 * 采纳率：入选 Attempt 占已发生 Attempt 的比例。
 * 一次 Attempt 都没发生（配置层就失败）时是 null——分母为 0 的比率没有意义。
 */
function acceptanceRate(manifest: RunManifest | null): number | null {
  if (manifest === null || manifest.attempts.length === 0) return null;
  const accepted = manifest.attempts.filter((attempt) => attempt.status === "accepted").length;
  return Math.round((accepted / manifest.attempts.length) * 10000) / 100;
}

/** 成本：Provider 给了金额与币种才算有值；只给其中一个时仍然当没有（§57）。 */
function costOf(telemetry: RunTelemetry | null): number | null {
  if (telemetry === null) return null;
  const amounts: number[] = [];
  for (const call of telemetry.llmCalls) {
    const cost = call.cost;
    if (cost && typeof cost.amount === "number" && Number.isFinite(cost.amount)) amounts.push(cost.amount);
  }
  if (amounts.length === 0) return null;
  const total = amounts.reduce((sum, value) => sum + value, 0);
  return Math.round((total / amounts.length) * 10000) / 10000;
}

/**
 * 一条样本的指标值。
 *
 * 每个注册表里的键都会出现：有值就是数字，没有就是 null。刻意不让「键缺失」
 * 也成为一种表示——缺键与缺值在 JSON 里是两种写法，而读的人只有一种理解。
 */
export function benchmarkSampleMetrics(runId: string, store: ArtifactStore): BenchmarkMetricValues {
  const out = emptyMetricValues();

  // ---- 质量：读这条 Run 自己的质量结论（v2.1.0 起也读得到 quality-stack.json，
  //      这里用各产物原文件，于是 2.1.0 之前的 Run 同样能进指标表）----
  const quality = store.readFinalQuality(runId);
  if (quality) {
    out.overall_quality = numOrNull(quality.overall_score);
    out.coherence = dimensionScore(quality.dimensions, "coherence");
    out.narrative = dimensionScore(quality.dimensions, "narrative");
    out.character = dimensionScore(quality.dimensions, "character");
    out.causality = dimensionScore(quality.dimensions, "causality");
    out.validation_pass_rate = rate(quality.validation_passed);
  }

  // ---- 商业可读性：同一套口径，另一套独立结论 ----
  const commercial = store.readFinalCommercialReview(runId);
  if (commercial) {
    out.commercial_overall = numOrNull(commercial.score);
    out.hook = dimensionScore(commercial.dimensions, "hook");
    out.pacing = dimensionScore(commercial.dimensions, "pacing");
    out.engagement = dimensionScore(commercial.dimensions, "engagement");
    out.payoff = dimensionScore(commercial.dimensions, "payoff");
  }

  // ---- 结构校验与采纳：确定性事实，不需要任何模型结论 ----
  const beatValidation = store.readFinalBeatValidation(runId);
  if (beatValidation) out.beat_validation_pass_rate = rate(beatValidation.passed);
  out.acceptance_rate = acceptanceRate(store.readRunManifest(runId));

  // ---- 遥测：耗时 / 调用 / token / 费用（§77）----
  const telemetry = store.readRunTelemetry(runId);
  if (telemetry) {
    const totals = telemetry.totals;
    out.duration_ms = numOrNull(totals.durationMs);
    out.llm_calls = numOrNull(totals.llmCalls);
    out.input_tokens = numOrNull(totals.inputTokens);
    out.output_tokens = numOrNull(totals.outputTokens);
    out.total_tokens = numOrNull(totals.totalTokens);
    out.cost_amount = costOf(telemetry);
  }

  return out;
}

/**
 * §78 一条样本的主要失败类别。读不到失败分析（这条 Run 没分析过）就是 null——
 * Benchmark 不自己推断类别，只把 Failure Analysis 已经分好的类搬过来。
 */
export function benchmarkFailureCategoryOf(runId: string, store: ArtifactStore): string | null {
  return store.readFailureAnalysis(runId)?.primaryCategory ?? null;
}

/** §56 一条样本的失败阶段。成功样本与没遥测的样本都是 null。 */
export function benchmarkFailureStageOf(runId: string, store: ArtifactStore): string | null {
  const telemetry = store.readRunTelemetry(runId);
  if (telemetry === null || telemetry.status !== "failed") return null;
  return telemetry.failureStage ?? null;
}

/** §105 一条样本的正文校验结论（供测试与调试单独取用；聚合走指标表）。 */
export function benchmarkValidationPassedOf(runId: string, store: ArtifactStore): boolean | null {
  return store.readFinalValidation(runId)?.passed ?? null;
}

/** 注册表的键列表：导出表头、协议校验、UI 列序都用它。 */
export function benchmarkMetricKeys(): string[] {
  return BENCHMARK_METRIC_DEFINITIONS.map((definition) => definition.key);
}
