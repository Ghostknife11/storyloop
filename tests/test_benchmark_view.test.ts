import { describe, expect, it } from "vitest";
import {
  BENCHMARK_EMPTY,
  benchmarkCaseRows,
  benchmarkComparisonRows,
  benchmarkExecutionRow,
  benchmarkExecutionTitle,
  benchmarkExecutionsOfSuite,
  benchmarkFailureRows,
  benchmarkGroupRows,
  benchmarkHistoryLines,
  benchmarkHistorySeries,
  benchmarkMetricRowOf,
  benchmarkMetricRows,
  benchmarkMsText,
  benchmarkMetricText,
  benchmarkOriginLabel,
  benchmarkPassText,
  benchmarkProtocolRows,
  benchmarkSampleDuration,
  benchmarkSampleRowOf,
  benchmarkSnapshotRows,
  benchmarkStageRows,
  benchmarkStatusLabel,
  benchmarkSuiteRow,
  benchmarkSummaryText,
  benchmarkTimestampLabel,
} from "@/interface/benchmark-view";
import { benchmarkMetricDefinition, benchmarkMetricGroups } from "@/domain/benchmark-metric";
import type {
  BenchmarkAggregateApi,
  BenchmarkComparisonApi,
  BenchmarkExecutionDetailApi,
  BenchmarkExecutionItemApi,
  BenchmarkSampleApi,
  BenchmarkSuiteApi,
  BenchmarkSuiteItemApi,
} from "@/interface/api";
import { SAMPLE_CONFIG } from "./helpers/fixtures";

/**
 * v2.3.0 Benchmark 界面推导（TASK §26/§30/§93/§95）。
 *
 * 四条承诺，全部是纯函数测试、不打任何端点：
 *   1. **没有数就没有数字**（§30）——null 一律「—」，不补 0、不补「略」；
 *   2. **不排名、不推荐**（§26/§63）——顺序来自注册表 / 固定优先级 / 时间，
 *      任何一处都不会按数值重排；
 *   3. **阈值来自 Suite**（§95/§96）——PASS 那一行读的是协议里配的数；
 *   4. **Baseline 只是标签**（§93）——它出现在行里，但不改变任何排序与数字。
 */

const SUITE_ITEM: BenchmarkSuiteItemApi = {
  id: "view-suite",
  version: "1.0.0",
  name: "界面测试题库",
  caseCount: 2,
  repetitions: 2,
  plannedSamples: 4,
  suiteDigest: "digest-view-suite",
  createdAt: "2026-09-28",
  source: { origin: "original", license: "CC0-1.0", note: "原创题面。" },
};

const SUITE: BenchmarkSuiteApi = {
  schemaVersion: "1",
  id: "view-suite",
  version: "1.0.0",
  name: "界面测试题库",
  cases: [
    {
      id: "case-a",
      title: "题 A",
      genre: "悬疑",
      storyConfig: SAMPLE_CONFIG,
      beatPlanMode: "regenerate",
      tags: ["短篇"],
    },
    {
      id: "case-b",
      title: "题 B",
      genre: "豪门",
      storyConfig: SAMPLE_CONFIG,
      beatPlanMode: "fixed",
      beatPlanRef: "cases/case-b/beat-plan.json",
      tags: ["长篇"],
    },
  ],
  protocol: {
    repetitions: 2,
    plannerMode: "normal",
    acceptedMetrics: [...benchmarkMetricGroups().flatMap((group) => group.metrics.map((m) => m.key))],
    failureHandling: "include",
    passThreshold: 71,
  },
  source: SUITE_ITEM.source,
  createdAt: "2026-09-28",
};

function summary(mean: number | null, count: number): { count: number; mean: number; min: number; max: number } {
  return { count, mean: mean ?? 0, min: mean ?? 0, max: mean ?? 0 };
}

const AGGREGATE: BenchmarkAggregateApi = {
  totalSamples: 4,
  completedSamples: 3,
  failedSamples: 1,
  metrics: {
    overall_quality: { count: 3, mean: 82.5, min: 76, max: 90 },
    commercial_overall: { count: 2, mean: 74, min: 70, max: 78 },
    failure_rate: { count: 4, mean: 25, min: 25, max: 25 },
  },
  byGenre: {
    悬疑: { caseCount: 1, sampleCount: 2, completedSamples: 2, failedSamples: 0, metrics: { overall_quality: summary(85, 2) } },
    豪门: { caseCount: 1, sampleCount: 2, completedSamples: 1, failedSamples: 1, metrics: { overall_quality: summary(80, 1) } },
  },
  failureCategories: { GENERATION: 1 },
  failureStages: { generating: 1 },
  pass: { threshold: 71, passed: 3, failed: 0, unmeasured: 1 },
};

const SAMPLE: BenchmarkSampleApi = {
  caseId: "case-a",
  repetition: 1,
  runId: "run-case-a-1",
  status: "completed",
  metrics: { overall_quality: 85, commercial_overall: null, duration_ms: 42000 },
  failure: null,
  startedAt: "2026-09-28T00:00:00.000Z",
  completedAt: "2026-09-28T00:00:42.000Z",
};

function executionItem(patch: Partial<BenchmarkExecutionItemApi> = {}): BenchmarkExecutionItemApi {
  return {
    id: "bmk-view-0001",
    suiteId: "view-suite",
    suiteVersion: "1.0.0",
    suiteName: "界面测试题库",
    status: "completed",
    label: "界面测试执行",
    projectVersion: "2.3.0",
    commit: null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:01:00.000Z",
    plannedSamples: 4,
    completedSamples: 3,
    failedSamples: 1,
    aggregate: AGGREGATE,
    isBaseline: false,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// §30 没有数就没有数字
// ---------------------------------------------------------------------------

describe("Benchmark 界面 — 缺数不补（§30）", () => {
  it("指标是 null 时是「—」，不是 0 也不是「略」", () => {
    expect(benchmarkMetricText(null, "score")).toBe(BENCHMARK_EMPTY);
    expect(benchmarkMetricText(undefined, "percent")).toBe(BENCHMARK_EMPTY);
    expect(benchmarkMetricText(Number.NaN, "ms")).toBe(BENCHMARK_EMPTY);
    expect(benchmarkMetricText(85, "score")).toBe("85.0");
    expect(benchmarkMetricText(25, "percent")).toBe("25.0%");
    expect(benchmarkMetricText(42000, "ms")).toBe("42.0s");
    expect(benchmarkMetricText(1500, "tokens")).toBe("1.5k");
    expect(benchmarkMetricText(3, "calls")).toBe("3");
  });

  it("汇总一行把分母写清楚：均值 · 有值样本数 / 总样本数", () => {
    expect(benchmarkSummaryText(AGGREGATE.metrics.overall_quality, 4)).toBe("82.5 · 3/4");
    // 一个已知值都没有：整行是「—」，不写「0 · 0/4」
    expect(benchmarkSummaryText(undefined, 4)).toBe(BENCHMARK_EMPTY);
    expect(benchmarkSummaryText({ count: 0, mean: Number.NaN, min: Number.NaN, max: Number.NaN }, 4)).toBe(BENCHMARK_EMPTY);
  });

  it("指标行：空值不造假，分母照实写", () => {
    const definition = benchmarkMetricDefinition("commercial_overall");
    expect(definition).not.toBeNull();
    const row = benchmarkMetricRowOf(definition as never, { count: 0, mean: Number.NaN, min: Number.NaN, max: Number.NaN }, 4);
    expect(row.mean).toBeNull();
    expect(row.meanText).toBe(BENCHMARK_EMPTY);
    expect(row.hasValue).toBe(false);
    expect(row.countText).toBe("0/4");
  });

  it("一条样本的耗时：时间戳缺一个就是「—」", () => {
    expect(benchmarkSampleDuration(SAMPLE)).toBe("42.0s");
    expect(benchmarkSampleDuration({ ...SAMPLE, completedAt: "" })).toBe(BENCHMARK_EMPTY);
    expect(benchmarkSampleDuration({ ...SAMPLE, startedAt: "not-a-date" })).toBe(BENCHMARK_EMPTY);
  });
});

// ---------------------------------------------------------------------------
// §26 不排名、不推荐
// ---------------------------------------------------------------------------

describe("Benchmark 界面 — 不排名、不推荐（§26/§63）", () => {
  it("指标表按注册表分组顺序出，一处都不按数值重排", () => {
    const rows = benchmarkMetricRows(AGGREGATE, SUITE.protocol.acceptedMetrics);
    const expected = benchmarkMetricGroups().flatMap((group) => group.metrics.map((m) => m.key));
    expect(rows.map((row) => row.key)).toEqual(expected);
    // 分数高的没有排前面
    expect(rows[0]?.key).toBe(expected[0]);
  });

  it("失败类别按固定优先级摆，条数只是事实", () => {
    const rows = benchmarkFailureRows(AGGREGATE);
    expect(rows).toEqual([{ category: "GENERATION", label: "正文生成问题", count: 1 }]);
    // 没出现过的类别整行不出现
    expect(rows.map((row) => row.category)).not.toContain("SECURITY");
  });

  it("分组行按名字典序出，不按成绩", () => {
    const rows = benchmarkGroupRows(AGGREGATE.byGenre);
    expect(rows.map((row) => row.name)).toEqual(["悬疑", "豪门"]);
    expect(rows[0]).toMatchObject({ caseCount: 1, sampleCount: 2, overallQuality: "85.0" });
  });

  it("执行筛选只是筛，不改顺序", () => {
    const items = [executionItem({ id: "bmk-1" }), executionItem({ id: "bmk-2", suiteId: "other" })];
    expect(benchmarkExecutionsOfSuite(items, null).map((item) => item.id)).toEqual(["bmk-1", "bmk-2"]);
    expect(benchmarkExecutionsOfSuite(items, "view-suite").map((item) => item.id)).toEqual(["bmk-1"]);
  });

  it("历史点按时间正序；一条线都没有值就整段不给线（§91/§92）", () => {
    const series = benchmarkHistorySeries([
      {
        id: "bmk-late",
        label: null,
        suiteId: "view-suite",
        suiteVersion: "1.0.0",
        status: "completed",
        startedAt: "2026-09-28T02:00:00.000Z",
        projectVersion: "2.3.0",
        commit: null,
        overallQuality: 90,
        commercialOverall: null,
        failureRate: 0,
        durationMs: 41000,
      },
      {
        id: "bmk-early",
        label: "   ",
        suiteId: "view-suite",
        suiteVersion: "1.0.0",
        status: "partial",
        startedAt: "2026-09-28T01:00:00.000Z",
        projectVersion: "2.3.0",
        commit: null,
        overallQuality: 80,
        commercialOverall: null,
        failureRate: null,
        durationMs: null,
      },
    ]);
    expect(series.map((point) => point.id)).toEqual(["bmk-early", "bmk-late"]);
    // 空白 label 退回 id，不编名字
    expect(series.map((point) => point.label)).toEqual(["bmk-early", "bmk-late"]);
    expect(benchmarkHistoryLines(series).map((line) => line.key)).toEqual(["overallQuality", "failureRate", "durationMs"]);

    const allNull = series.map((point) => ({ ...point, overallQuality: null, failureRate: null, durationMs: null }));
    expect(benchmarkHistoryLines(allNull)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §95/§96 阈值来自 Suite
// ---------------------------------------------------------------------------

describe("Benchmark 界面 — 阈值来自 Suite（§95/§96）", () => {
  it("PASS 一行带着协议里配的那个数", () => {
    expect(benchmarkPassText(AGGREGATE)).toBe("3 过 / 0 未过 / 1 未测量（阈值 71）");
    // 换一份 Suite 就换成另一个数：文字里没有任何写死的分数线
    expect(benchmarkPassText({ ...AGGREGATE, pass: { threshold: 85, passed: 1, failed: 2, unmeasured: 1 } })).toContain(
      "（阈值 85）",
    );
    expect(benchmarkPassText(null)).toBe(BENCHMARK_EMPTY);
    expect(benchmarkPassText({ ...AGGREGATE, pass: null })).toBe(BENCHMARK_EMPTY);
  });

  it("协议行把阈值、失败处理、采纳指标数都摆出来", () => {
    const rows = benchmarkProtocolRows(SUITE);
    expect(rows).toEqual([
      { label: "重复次数", value: "2" },
      { label: "规划方式", value: "每个样本自己规划" },
      { label: "失败样本处理", value: "计入样本" },
      { label: "采纳指标", value: "22 项" },
      { label: "PASS 阈值", value: "71" },
    ]);
    expect(benchmarkProtocolRows({ ...SUITE, protocol: { ...SUITE.protocol, passThreshold: undefined } })).toContainEqual({
      label: "PASS 阈值",
      value: "未配置",
    });
  });
});

// ---------------------------------------------------------------------------
// §93 Baseline 只是标签
// ---------------------------------------------------------------------------

describe("Benchmark 界面 — Baseline 只是标签（§93）", () => {
  it("标成基线的行只是多一行「本次会话」，不排到前面", () => {
    const plain = benchmarkExecutionRow(executionItem({ id: "bmk-plain", startedAt: "2026-09-28T00:00:00.000Z" }));
    const marked = benchmarkExecutionRow(
      executionItem({ id: "bmk-mark", startedAt: "2026-09-28T00:01:00.000Z", isBaseline: true }),
    );
    expect(plain.isBaseline).toBe(false);
    expect(marked.isBaseline).toBe(true);
    // 基线不改标题、不改副标题里的样本计数
    expect(marked.title).toBe("界面测试执行");
    expect(marked.subtitle).toBe("3/4 条样本完成 · 2.3.0");
    expect(marked.passText).toBe(benchmarkPassText(AGGREGATE));
  });

  it("没有 label 就退回 id，不编一个名字", () => {
    expect(benchmarkExecutionTitle({ id: "bmk-x", label: null })).toBe("bmk-x");
    expect(benchmarkExecutionTitle({ id: "bmk-x", label: "  " })).toBe("bmk-x");
    expect(benchmarkExecutionTitle({ id: "bmk-x", label: "发布前基线" })).toBe("发布前基线");
  });
});

// ---------------------------------------------------------------------------
// 状态、来源、快照
// ---------------------------------------------------------------------------

describe("Benchmark 界面 — 状态与来源", () => {
  it("partial 不是失败，running 不是错误", () => {
    expect(benchmarkStatusLabel("completed")).toEqual({ label: "全部完成", tone: "good" });
    expect(benchmarkStatusLabel("partial")).toEqual({ label: "部分完成", tone: "warn" });
    expect(benchmarkStatusLabel("failed")).toEqual({ label: "没有可用样本", tone: "bad" });
    expect(benchmarkStatusLabel("running")).toEqual({ label: "正在运行", tone: "neutral" });
    expect(benchmarkStatusLabel("pending")).toEqual({ label: "尚未开始", tone: "neutral" });
    expect(benchmarkStatusLabel("whatever")).toEqual({ label: "状态未知", tone: "neutral" });
  });

  it("Suite 一行：题数 × 次数 = 样本数，来源与许可摆在看得见的地方", () => {
    const row = benchmarkSuiteRow(SUITE_ITEM);
    expect(row.subtitle).toBe("2 道题 × 2 次 = 4 条样本");
    expect(row.origin).toBe("原创题面 · 许可：CC0-1.0");
    expect(benchmarkOriginLabel({ origin: "licensed", license: "" })).toBe("已授权素材 · 许可：未标注");
    expect(benchmarkOriginLabel({ origin: "public-domain", license: "PD" })).toBe("公有领域素材 · 许可：PD");
  });

  it("题目行：骨架方式与标签原样读", () => {
    expect(benchmarkCaseRows(SUITE)).toEqual([
      { id: "case-a", title: "题 A", genre: "悬疑", mode: "自己规划", tags: "短篇" },
      { id: "case-b", title: "题 B", genre: "豪门", mode: "共用剧情骨架", tags: "长篇" },
    ]);
  });

  it("快照行一条事实一行：地址只给类别，提示词只给摘要（§67）", () => {
    const detail = {
      execution: {
        ...executionItem(),
        schemaVersion: "benchmark-execution/1",
        snapshot: {
          suiteId: "view-suite",
          suiteVersion: "1.0.0",
          suiteDigest: "digest-view-suite",
          protocol: SUITE.protocol,
          protocolDigest: "protocol-digest",
          projectVersion: "2.3.0",
          commit: "abc1234",
          models: { story: { provider: "minimax", model: "MiniMax-M2", baseUrlClass: "server-configured" } },
          prompts: [{ role: "generator", version: "story-v3", digest: "a".repeat(64) }],
          parameters: { generation: { temperature: 0.9 } },
          caseIds: ["case-a", "case-b"],
          repetitions: 2,
          plannedSamples: 4,
          label: "界面测试执行",
          startedAt: "2026-09-28T00:00:00.000Z",
        },
        samples: [SAMPLE],
        aggregate: AGGREGATE,
      },
      suite: SUITE,
      comparison: null,
      isBaseline: false,
    } as unknown as BenchmarkExecutionDetailApi;
    const rows = benchmarkSnapshotRows(detail);
    expect(rows).toContainEqual({ label: "Suite", value: "view-suite@1.0.0" });
    expect(rows).toContainEqual({ label: "模型 · story", value: "MiniMax-M2（server-configured）" });
    expect(rows).toContainEqual({ label: "提示词 · generator", value: `story-v3 · ${"a".repeat(12)}` });
    // 界面上看不到地址、看不到提示词原文、看不到温度以外的参数细节
    expect(JSON.stringify(rows)).not.toContain("https://");
    expect(JSON.stringify(rows)).not.toContain("temperature");
  });

  it("样本行：身份 + 失败原因 + 声明的指标，没有正文", () => {
    const row = benchmarkSampleRowOf(SAMPLE, ["overall_quality", "commercial_overall"]);
    expect(row.metrics).toEqual([
      { key: "overall_quality", label: row.metrics[0]?.label, text: "85.0" },
      { key: "commercial_overall", label: row.metrics[1]?.label, text: BENCHMARK_EMPTY },
    ]);
    expect(row.durationText).toBe("42.0s");
    const failed = benchmarkSampleRowOf({ ...SAMPLE, status: "failed", failure: "generating: 上游 502", runId: null });
    expect(failed.failure).toBe("generating: 上游 502");
    expect(failed.runId).toBeNull();
  });

  it("失败阶段分布按条数出，平了按名字典序", () => {
    const rows = benchmarkStageRows({ ...AGGREGATE, failureStages: { generating: 2, planning: 2, review: 1 } });
    expect(rows).toEqual([
      { stage: "generating", count: 2 },
      { stage: "planning", count: 2 },
      { stage: "review", count: 1 },
    ]);
  });
});

describe("Benchmark 界面 — 比较表（§59/§61）", () => {
  const comparison = {
    base: { benchmarkId: "bmk-base", suiteId: "view-suite", suiteVersion: "1.0.0", projectVersion: "2.2.0", startedAt: "2026-09-01T00:00:00.000Z" },
    target: { benchmarkId: "bmk-target", suiteId: "view-suite", suiteVersion: "1.0.0", projectVersion: "2.3.0", startedAt: "2026-09-28T00:00:00.000Z" },
    rows: [
      { metric: "overall_quality", label: "整体质量", unit: "score", baseMean: 72.1, targetMean: 74.8, baseCount: 4, targetCount: 4, delta: 2.7, deltaPercent: 3.74 },
      { metric: "failure_rate", label: "样本失败率", unit: "percent", baseMean: 20, targetMean: 10, baseCount: 4, targetCount: 4, delta: -10, deltaPercent: -50 },
      { metric: "duration_ms", label: "总耗时", unit: "ms", baseMean: null, targetMean: 5000, baseCount: 0, targetCount: 4, delta: null, deltaPercent: null },
    ],
    failureRate: { baseMean: 20, targetMean: 10, delta: -10, deltaPercent: -50 },
    caveat: "只报告差值，不解释原因。",
  } as unknown as BenchmarkComparisonApi;

  it("差值带符号、null 就是「—」、方向只是减法结果", () => {
    const rows = benchmarkComparisonRows(comparison);
    expect(rows[0]).toMatchObject({ direction: "up", deltaText: "+2.7", deltaPercentText: "+3.7%" });
    expect(rows[1]).toMatchObject({ direction: "down", deltaText: "-10", deltaPercentText: "-50.0%" });
    // 一侧没均值：整行是「—」，方向 unknown，不当「持平」也不当「变好」
    expect(rows[2]).toMatchObject({ direction: "unknown", baseText: BENCHMARK_EMPTY, deltaText: BENCHMARK_EMPTY });
    expect(benchmarkComparisonRows(null)).toEqual([]);
  });
});

describe("Benchmark 界面 — 时间戳", () => {
  it("解析得出来是本地面间，解析不出来原样返回", () => {
    expect(benchmarkTimestampLabel("2026-09-28T00:00:00.000Z")).toMatch(/^2026-09-\d\d \d\d:\d\d$/);
    expect(benchmarkTimestampLabel("not-a-date")).toBe("not-a-date");
  });

  it("时长：毫秒原样、秒一位小数、分钟补零", () => {
    expect(benchmarkMsText(420)).toBe("420ms");
    expect(benchmarkMsText(4200)).toBe("4.2s");
    expect(benchmarkMsText(125_000)).toBe("2分05秒");
    expect(benchmarkMsText(-1)).toBe(BENCHMARK_EMPTY);
  });
});
