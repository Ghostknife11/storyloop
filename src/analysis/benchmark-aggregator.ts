/**
 * v2.3.0 确定性聚合（TASK §31/§32/§33/§99）。
 *
 * 这个模块是纯算术：给它同一批样本，永远得到同一页数字。不调 LLM、不排序、
 * 不排名、不做显著性检验（TASK §35/§63/§99）。它只回答「这批样本各自是什么、
 * 合起来看是多少」。
 *
 * 三个必须先说清楚的口径，否则数字会被读错：
 *
 *   1. **分母是有值的样本数**，不是这一组的样本总数。「30 条样本、12 条拿到
 *      usage」的输入 token 均值，分母是 12。于是 `count` 必须跟着均值一起出现
 *      （TASK §30/「Metric counts are exposed」）。
 *   2. **null 不是 0**。Provider 不给 usage 就是没有这个数，补 0 等于凭空
 *      发明一次「没有 usage 的调用」，会把均值整体拉低。
 *   3. **失败样本是否参与由协议说了算**（failureHandling）。两种口径都如实报
 *      完成数 / 失败数，差别只在失败样本的 null 会不会进分母——这个选择写在
 *      协议里，执行过程中不许改（TASK §17）。
 */

import {
  BENCHMARK_METRIC_DEFINITIONS,
  type BenchmarkMetricKey,
} from "@/domain/benchmark-metric";
import type {
  BenchmarkAggregate,
  BenchmarkExecutionSnapshot,
  BenchmarkGroupResult,
  BenchmarkMetricSummary,
  BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import type { BenchmarkCase, BenchmarkSuite } from "@/domain/benchmark-suite";
import type { ArtifactStore } from "@/ports/artifact-store";
import { benchmarkFailureCategoryOf, benchmarkFailureStageOf } from "@/analysis/benchmark-metrics";

/** 均值四舍五入到两位小数：指标表不是演算纸，多出来的位数是噪音。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 一个指标的汇总：count / mean / min / max。一个已知值都没有时 mean 是 null、count 是 0。 */
export function summarizeMetricValues(values: (number | null)[]): BenchmarkMetricSummary {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (present.length === 0) return { count: 0, mean: null, min: null, max: null };
  const total = present.reduce((sum, value) => sum + value, 0);
  return {
    count: present.length,
    mean: round2(total / present.length),
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

/**
 * 一个指标在一组样本上的取值序列。
 *
 * failure_rate 是唯一的例外：它的值不来自任何产物，而来自「这条样本跑成没有」
 * 这个执行事实本身——所以它由这里现算，而不是从 metrics 表里取。
 */
function valuesOf(key: BenchmarkMetricKey, samples: BenchmarkSampleResult[]): (number | null)[] {
  if (key === "failure_rate") {
    return samples.map((sample) => (sample.status === "failed" ? 0 : 100));
  }
  return samples.map((sample) => sample.metrics[key] ?? null);
}

/** 参与聚合的样本：按协议的 failureHandling 决定失败样本进不进分母。 */
function participating(samples: BenchmarkSampleResult[], failureHandling: BenchmarkSuite["protocol"]["failureHandling"]) {
  if (failureHandling === "include") return samples;
  return samples.filter((sample) => sample.status !== "failed");
}

/**
 * 一个分组（byGenre / byTag）的汇总。
 * 分组的键来自 Case 自己的元数据：没有 genre / 没有 tag 的题根本不成组（§97/§98）。
 */
function groupResultOf(
  cases: BenchmarkCase[],
  samples: BenchmarkSampleResult[],
  acceptedMetrics: readonly string[],
): BenchmarkGroupResult {
  const byCase = new Map<string, BenchmarkSampleResult[]>();
  for (const sample of samples) {
    const own = byCase.get(sample.caseId) ?? [];
    own.push(sample);
    byCase.set(sample.caseId, own);
  }
  const own: BenchmarkSampleResult[] = [];
  for (const item of cases) own.push(...(byCase.get(item.id) ?? []));
  const metrics: Partial<Record<BenchmarkMetricKey, BenchmarkMetricSummary>> = {};
  for (const definition of BENCHMARK_METRIC_DEFINITIONS) {
    if (!acceptedMetrics.includes(definition.key)) continue;
    metrics[definition.key as BenchmarkMetricKey] = summarizeMetricValues(valuesOf(definition.key, own));
  }
  return {
    caseCount: cases.length,
    sampleCount: own.length,
    completedSamples: own.filter((sample) => sample.status === "completed").length,
    failedSamples: own.filter((sample) => sample.status === "failed").length,
    metrics,
  };
}

/** 按键字典序输出：同一个输入永远得到同一份 JSON（含键顺序）。 */
function sortedCounts(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key) as number;
  return out;
}

/**
 * §31 汇总一次执行。
 *
 * 失败类别读每个样本自己的 failure-analysis.json（读不到就是「没分析过」，
 * 不进任何计数）；失败阶段读失败样本自己的 telemetry.json。两处都不是 Benchmark
 * 自己推断的——它只搬运 Failure Analysis 与 Telemetry 已经写下的事实（§78）。
 */
export function aggregateBenchmark(
  samples: BenchmarkSampleResult[],
  suite: BenchmarkSuite,
  store: ArtifactStore,
): BenchmarkAggregate {
  const accepted = suite.protocol.acceptedMetrics;
  const inPlay = participating(samples, suite.protocol.failureHandling);

  const metrics: Record<string, BenchmarkMetricSummary> = {};
  for (const definition of BENCHMARK_METRIC_DEFINITIONS) {
    if (!accepted.includes(definition.key)) continue;
    metrics[definition.key] = summarizeMetricValues(valuesOf(definition.key, inPlay));
  }

  // byGenre / byTag：按题分组，因此先按 caseId 找到题
  const genreCases = new Map<string, BenchmarkCase[]>();
  const tagCases = new Map<string, BenchmarkCase[]>();
  for (const item of suite.cases) {
    const byGenre = genreCases.get(item.genre) ?? [];
    byGenre.push(item);
    genreCases.set(item.genre, byGenre);
    for (const tag of item.tags ?? []) {
      const byTag = tagCases.get(tag) ?? [];
      byTag.push(item);
      tagCases.set(tag, byTag);
    }
  }

  const byGenre: Record<string, BenchmarkGroupResult> = {};
  for (const genre of [...genreCases.keys()].sort()) {
    byGenre[genre] = groupResultOf(genreCases.get(genre) as BenchmarkCase[], samples, accepted);
  }
  const byTag: Record<string, BenchmarkGroupResult> = {};
  for (const tag of [...tagCases.keys()].sort()) {
    byTag[tag] = groupResultOf(tagCases.get(tag) as BenchmarkCase[], samples, accepted);
  }

  const categories = new Map<string, number>();
  const stages = new Map<string, number>();
  for (const sample of samples) {
    if (sample.runId === null) continue;
    const category = benchmarkFailureCategoryOf(sample.runId, store);
    if (category !== null) categories.set(category, (categories.get(category) ?? 0) + 1);
    const stage = benchmarkFailureStageOf(sample.runId, store);
    if (stage !== null) stages.set(stage, (stages.get(stage) ?? 0) + 1);
  }

  const threshold = suite.protocol.passThreshold ?? null;
  let pass: BenchmarkAggregate["pass"] = null;
  if (threshold !== null) {
    const scores = inPlay.map((sample) => sample.metrics.overall_quality ?? null);
    pass = {
      threshold,
      passed: scores.filter((score) => score !== null && score >= threshold).length,
      failed: scores.filter((score) => score !== null && score < threshold).length,
      unmeasured: scores.filter((score) => score === null).length,
    };
  }

  return {
    totalSamples: samples.length,
    completedSamples: samples.filter((sample) => sample.status === "completed").length,
    failedSamples: samples.filter((sample) => sample.status === "failed").length,
    metrics,
    byGenre,
    byTag,
    failureCategories: sortedCounts(categories),
    failureStages: sortedCounts(stages),
    pass,
  };
}

/**
 * §104/§72 从快照里取这次执行的覆盖范围：哪些题、每题几次。
 * 展开顺序恒定——Suite 声明顺序 × repetition 升序，不按任何成绩重排。
 */
export function expandBenchmarkSamples(snapshot: BenchmarkExecutionSnapshot): { caseId: string; repetition: number }[] {
  const out: { caseId: string; repetition: number }[] = [];
  for (const caseId of snapshot.caseIds) {
    for (let repetition = 1; repetition <= snapshot.repetitions; repetition += 1) {
      out.push({ caseId, repetition });
    }
  }
  return out;
}
