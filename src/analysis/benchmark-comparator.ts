/**
 * v2.3.0 执行比较（TASK §59/§60/§61）。
 *
 * 合法的输出只有一种：两次执行各自算出来的事实，以及它们的差值。
 *
 *   Overall: 72.1 → 74.8
 *   Ca: 66.2 → 69.4
 *   Failure rate: 18% → 11%
 *   Mean duration: 42s → 47s
 *
 * 不合法的输出也写在代码里（`BENCHMARK_COMPARISON_CAVEAT`）：不解释差异为什么
 * 发生。「因为 Prompt v3 所以提升了 2.7 分」这种句式在 Benchmark 里没有依据——
 * 协议固定的是输入条件，不是因果设计（TASK §61）。要因果结论得靠受控实验
 * （v1.7.0 的 Experiment），那是另一条路。
 *
 * 这里同样不做综合排名：没有 `0.5 质量 + 0.3 成本 + 0.2 速度` 这种加权总分
 * （TASK §63）。UI 可以按某一个事实数值排序，但排序不是评分。
 */

import {
  BENCHMARK_METRIC_DEFINITIONS,
  benchmarkMetricDefinition,
} from "@/domain/benchmark-metric";
import {
  BENCHMARK_COMPARISON_CAVEAT,
  type BenchmarkComparison,
  type BenchmarkComparisonRow,
  type BenchmarkComparisonSide,
  type BenchmarkExecution,
  type BenchmarkMetricSummary,
} from "@/domain/benchmark-result";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 一侧的失败率（百分数）。一个样本都没有时是 null，不当 0%。 */
function failureRateOf(execution: BenchmarkExecution): number | null {
  const aggregate = execution.aggregate;
  if (aggregate === null || aggregate.totalSamples === 0) return null;
  return round2((aggregate.failedSamples / aggregate.totalSamples) * 100);
}

function sideOf(execution: BenchmarkExecution): BenchmarkComparisonSide {
  return {
    benchmarkId: execution.id,
    suiteId: execution.suiteId,
    suiteVersion: execution.suiteVersion,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
  };
}

/**
 * 一行指标的比较。
 *
 * 只有两侧都算出这个指标时才成行：一侧有这个指标、另一侧没有，摆在一起
 * 也不是同一次测量（协议不同），于是整行不出现，而不是补一个 null 当差值。
 */
function rowOf(
  key: string,
  base: BenchmarkMetricSummary | undefined,
  target: BenchmarkMetricSummary | undefined,
): BenchmarkComparisonRow | null {
  if (base === undefined || target === undefined) return null;
  const definition = benchmarkMetricDefinition(key);
  if (definition === null) return null;
  const baseMean = base.mean;
  const targetMean = target.mean;
  const delta = baseMean !== null && targetMean !== null ? round2(targetMean - baseMean) : null;
  const deltaPercent =
    delta !== null && baseMean !== null && baseMean !== 0 ? round2((delta / baseMean) * 100) : null;
  return {
    key,
    label: definition.label,
    unit: definition.unit,
    baseMean,
    baseCount: base.count,
    targetMean,
    targetCount: target.count,
    delta,
    deltaPercent,
  };
}

/**
 * 比较两次执行。
 *
 * 刻意不校验「两次执行是不是同一份 Suite」：跨 Suite 的比较由读者自己判断
 * 要不要看（两侧的 suiteId / suiteVersion / digest 就在返回体里）。在这里替人
 * 拒绝，就等于替人决定什么算「可比」——而这件事协议给不出答案。
 */
export function compareBenchmarkExecutions(
  base: BenchmarkExecution,
  target: BenchmarkExecution,
): BenchmarkComparison {
  const rows: BenchmarkComparisonRow[] = [];
  for (const definition of BENCHMARK_METRIC_DEFINITIONS) {
    const row = rowOf(
      definition.key,
      base.aggregate?.metrics[definition.key],
      target.aggregate?.metrics[definition.key],
    );
    if (row !== null) rows.push(row);
  }
  const baseFailureRate = failureRateOf(base);
  const targetFailureRate = failureRateOf(target);
  const failureDelta =
    baseFailureRate !== null && targetFailureRate !== null ? round2(targetFailureRate - baseFailureRate) : null;
  return {
    base: sideOf(base),
    target: sideOf(target),
    rows,
    failureRate: { base: baseFailureRate, target: targetFailureRate, delta: failureDelta },
    caveat: BENCHMARK_COMPARISON_CAVEAT,
  };
}
