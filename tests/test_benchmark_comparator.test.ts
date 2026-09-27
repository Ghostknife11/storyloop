/**
 * v2.3.0 执行比较（Analysis；TASK §59/§60/§61/§63）。
 *
 * 这里只有一件事：两次执行各自算出的事实，以及它们的差值。
 *
 * 这份测试守两道边界：
 *   1. **不编数**。一侧没算出来的指标不成行、差值不当 0、除零不给百分比、
 *      没有样本时失败率是 null 而不是 0%。
 *   2. **不做解释、不做综合**。返回体里没有「因为 Prompt v3 所以提升」这种
 *      因果句式（caveat 明说做不到），也没有加权总分（§63）。
 */

import { describe, expect, it } from "vitest";
import { compareBenchmarkExecutions } from "@/analysis/benchmark-comparator";
import { emptyMetricValues } from "@/domain/benchmark-metric";
import {
  BENCHMARK_COMPARISON_CAVEAT,
  BENCHMARK_EXECUTION_SCHEMA_VERSION,
  type BenchmarkExecution,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import { benchmarkSuiteOf } from "@/domain/benchmark-suite";
import { benchmarkMetricKeys } from "@/domain/benchmark-metric";
import { SAMPLE_CONFIG } from "./helpers/fixtures";

const METRICS = benchmarkMetricKeys();

function suiteRaw(id: string, version: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id,
    version,
    name: `${id} ${version}`,
    cases: [
      { id: "case-a", title: "题 A", genre: "悬疑", storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", tags: ["短篇"] },
    ],
    protocol: {
      repetitions: 1,
      plannerMode: "normal",
      acceptedMetrics: [...METRICS],
      failureHandling: "include",
      passThreshold: 71,
    },
    source: { origin: "original", license: "CC0-1.0", note: "测试构造。" },
    createdAt: "2026-09-28",
  };
}

function suiteOf(id: string, version: string) {
  const suite = benchmarkSuiteOf(suiteRaw(id, version), METRICS);
  expect(suite).not.toBeNull();
  return suite as NonNullable<ReturnType<typeof benchmarkSuiteOf>>;
}

function sampleOf(status: "completed" | "failed", overall: number | null): BenchmarkSampleResult {
  return {
    caseId: "case-a",
    repetition: 1,
    runId: status === "completed" ? "run-case-a-1" : null,
    status,
    metrics: { ...emptyMetricValues(), overall_quality: overall, duration_ms: 42000 },
    failure: status === "failed" ? "generating: 上游 502" : null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:00:42.000Z",
  };
}

interface ExecutionOptions {
  id: string;
  suiteId?: string;
  suiteVersion?: string;
  status?: BenchmarkExecution["status"];
  /** overall_quality 的均值序列（顺便是失败率的分母来源）。 */
  scores: (number | null)[];
  durationMean?: number | null;
  /** 协议没接受的指标：aggregate.metrics 里整个键不出现（这才是「一侧没有这个指标」）。 */
  dropMetrics?: string[];
  label?: string | null;
}

function executionOf(options: ExecutionOptions): BenchmarkExecution {
  const samples = options.scores.map((score) => sampleOf(score === null ? "failed" : "completed", score));
  const failed = samples.filter((sample) => sample.status === "failed").length;
  const summary = (value: number | null, count: number) => ({ count, mean: value, min: value, max: value });
  const suite = suiteOf(options.suiteId ?? "cmp-suite", options.suiteVersion ?? "1.0.0");
  const metrics: Record<string, ReturnType<typeof summary>> = {
    // count 是「有值的样本数」——它是均值的分母，不是样本总数
    overall_quality: summary(options.scores[0] ?? null, options.scores.filter((score) => score !== null).length),
    duration_ms: summary(options.durationMean ?? null, options.durationMean === null ? 0 : samples.length),
    failure_rate: summary(100 - (failed / Math.max(samples.length, 1)) * 100, samples.length),
  };
  for (const key of options.dropMetrics ?? []) delete metrics[key];
  return {
    schemaVersion: BENCHMARK_EXECUTION_SCHEMA_VERSION,
    id: options.id,
    suiteId: suite.id,
    suiteVersion: suite.version,
    status: options.status ?? "completed",
    snapshot: {
      suiteId: suite.id,
      suiteVersion: suite.version,
      suiteDigest: `digest-${options.suiteId ?? "cmp-suite"}-${options.suiteVersion ?? "1.0.0"}`,
      protocol: suite.protocol,
      protocolDigest: "protocol-digest",
      projectVersion: "2.3.0",
      commit: null,
      models: null,
      prompts: null,
      parameters: null,
      caseIds: ["case-a"],
      repetitions: 1,
      plannedSamples: samples.length,
      label: options.label ?? null,
      startedAt: "2026-09-28T00:00:00.000Z",
    },
    samples,
    aggregate: {
      totalSamples: samples.length,
      completedSamples: samples.length - failed,
      failedSamples: failed,
      metrics,
      failureCategories: {},
      failureStages: {},
      pass: null,
    },
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:01:00.000Z",
  };
}

const BASE = executionOf({ id: "bmk-base", scores: [72.1, 72.1], durationMean: 42000 });
const TARGET = executionOf({ id: "bmk-target", scores: [74.8, 74.8], durationMean: 47000 });

function rowOf(comparison: ReturnType<typeof compareBenchmarkExecutions>, key: string) {
  return comparison.rows.find((row) => row.key === key) ?? null;
}

describe("Benchmark 比较 — 只报差值（§59/§60）", () => {
  const comparison = compareBenchmarkExecutions(BASE, TARGET);

  it("两侧身份都带上，谁跟谁比一眼看得出来", () => {
    expect(comparison.base).toMatchObject({ benchmarkId: "bmk-base", suiteId: "cmp-suite" });
    expect(comparison.target).toMatchObject({ benchmarkId: "bmk-target", suiteId: "cmp-suite" });
  });

  it("一行 = 一侧的均值 vs 另一侧的均值，差值 = target − base", () => {
    const row = rowOf(comparison, "overall_quality");
    expect(row).toMatchObject({ baseMean: 72.1, targetMean: 74.8, delta: 2.7, baseCount: 2, targetCount: 2 });
    expect(row?.deltaPercent).toBeCloseTo(3.74, 2);
    const duration = rowOf(comparison, "duration_ms");
    expect(duration?.delta).toBe(5000);
  });

  it("rows 按注册表顺序出：指标顺序不 constituent 素材顺序重排", () => {
    expect(comparison.rows.map((row) => row.key)).toEqual(
      [...METRICS].filter((key) => comparison.rows.some((row) => row.key === key)),
    );
    expect(comparison.rows[0]?.key).toBe([...METRICS].find((key) => comparison.rows.some((row) => row.key === key)));
  });

  it("一侧没算出某个指标，整行不出现——不补 null 当差值", () => {
    // 协议不同（另一侧根本没接受 duration_ms）：aggregate 里连这个键都没有
    const otherProtocol = executionOf({ id: "bmk-other-protocol", scores: [70, 70], dropMetrics: ["duration_ms"] });
    const rows = compareBenchmarkExecutions(BASE, otherProtocol).rows.map((row) => row.key);
    expect(rows).toContain("overall_quality");
    expect(rows).not.toContain("duration_ms");
  });

  it("base 为 0 时相对差值是 null：除零没有答案，不编一个", () => {
    const zero = executionOf({ id: "bmk-zero", scores: [0, 0] });
    const row = rowOf(compareBenchmarkExecutions(zero, TARGET), "overall_quality");
    expect(row?.delta).toBe(74.8);
    expect(row?.deltaPercent).toBeNull();
  });

  it("失败率 = 失败样本 ÷ 样本数：一个样本都没有时是 null，不当 0%", () => {
    const empty = executionOf({ id: "bmk-empty", scores: [] });
    expect(compareBenchmarkExecutions(BASE, empty).failureRate.target).toBeNull();
    // BASE 两个样本都成了（0%），另一个一半失败 → 差值 = 50 − 0
    const failing = compareBenchmarkExecutions(BASE, executionOf({ id: "bmk-fail", scores: [null, 72] }));
    expect(failing.failureRate.target).toBe(50);
    expect(failing.failureRate.delta).toBe(50);
  });

  it("刻意不拒跨 Suite 比较：两侧 id / 版本 / digest 都在返回体里，结论自己看", () => {
    const other = executionOf({ id: "bmk-other", suiteId: "other-suite", suiteVersion: "2.0.0", scores: [80, 80] });
    const cross = compareBenchmarkExecutions(BASE, other);
    expect(cross.target.suiteVersion).toBe("2.0.0");
    expect(rowOf(cross, "overall_quality")?.delta).toBeCloseTo(7.9, 1);
  });
});

describe("Benchmark 比较 — 不越界（§61/§63）", () => {
  const comparison = compareBenchmarkExecutions(BASE, TARGET);

  it("caveat 是契约的一部分：只说观测到的差值，不给因果解释", () => {
    expect(comparison.caveat).toBe(BENCHMARK_COMPARISON_CAVEAT);
    expect(comparison.caveat).toContain("不解释差异原因");
  });

  it("返回体里没有任何加权总分 / 排名 / 综合分数字段", () => {
    const text = JSON.stringify(comparison);
    for (const forbidden of ["overallScore", "ranking", "winner", "composite", "weights", "regression", "improvement"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("行里只有均值、已知样本数与差值：没有方向判定、没有好坏标签", () => {
    for (const row of comparison.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["baseCount", "baseMean", "delta", "deltaPercent", "key", "label", "targetCount", "targetMean", "unit"].sort(),
      );
    }
  });
});
