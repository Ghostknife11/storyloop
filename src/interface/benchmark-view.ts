/**
 * v2.3.0 Benchmark 界面的唯一状态推导（与 experiment-view / workspace-view 同一套模式）。
 *
 * 这里全部是纯函数：把 API 回来的 Suite / 执行 / 聚合 / 比较整理成「界面上要摆出来的行」。
 * 边界写死在实现里，因为它们分别是这个版本承诺过的几件事：
 *
 *   1. **没有数就没有数字**（TASK §30）。指标是 null 时显示「—」，不补 0、不补「略」，
 *      也不把「有 n 条样本」写成「n 条都测过」——分母写清楚，剩下的读者自己看。
 *   2. **不排名、不推荐**（§26/§63）。所有行的顺序都来自服务端给的顺序：指标按注册表
 *      顺序、失败类别按固定优先级、历史点按时间正序。任何一处按数值重排都是在暗示
 *      「哪个更好」，而这个版本不出这种结论。
 *   3. **阈值必须来自 Suite**（§95/§96）。PASS 一行永远带着 Suite 里配的那个数，
 *      界面上没有任何一处写死分数线，也没有「提高阈值试试」这类入口。
 *   4. **Baseline 只是标签**（§93）。它是会话期的一个名字，不参与任何排序与计算。
 */

import type {
  BenchmarkAggregateApi,
  BenchmarkComparisonApi,
  BenchmarkExecutionDetailApi,
  BenchmarkExecutionItemApi,
  BenchmarkGroupResultApi,
  BenchmarkHistoryPointApi,
  BenchmarkMetricSummaryApi,
  BenchmarkSampleApi,
  BenchmarkSuiteApi,
  BenchmarkSuiteItemApi,
} from "@/interface/api";
import type { BenchmarkMetricDefinition, BenchmarkMetricGroup } from "@/domain/benchmark-metric";
import { benchmarkMetricDefinition, benchmarkMetricGroups } from "@/domain/benchmark-metric";
import { CATEGORY_LABELS, type FailureCategory } from "@/domain/failure-analysis";

/** 语气：good / warn / bad 只用于「这件事本身是好是坏」，neutral 用于「只是陈述」。 */
export type BenchmarkTone = "neutral" | "good" | "warn" | "bad";

/** 界面上任何一个「没有这个数」的地方都用它：一个字符，不占位置，也绝不改写成 0。 */
export const BENCHMARK_EMPTY = "—";

// ---------------------------------------------------------------------------
// 数字格式化：单位决定长相。单位也来自注册表，这里不重新定义一套。
// ---------------------------------------------------------------------------

/** 毫秒 → 人读时长（与 Run 详情同一套口径）。 */
export function benchmarkMsText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return BENCHMARK_EMPTY;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const rest = Math.round((ms % 60_000) / 1000);
  return `${minutes}分${String(rest).padStart(2, "0")}秒`;
}

/** Token 数 → 人读。千以下原样，千以上收成 k，不编小数位以外的精度。 */
function tokenText(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 费用 → 人读。币种由 Provider 决定，注册表里只记了一个数，
 * 所以这里不带货币符号、只按大小换小数位：宁可少一位，也不显示假的精度。
 */
function currencyText(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
  return value.toFixed(2);
}

/** 一个指标值 → 界面文字。null / NaN / 非有限数一律「—」（§30）。 */
export function benchmarkMetricText(value: number | null | undefined, unit: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return BENCHMARK_EMPTY;
  switch (unit) {
    case "percent":
      return `${value.toFixed(1)}%`;
    case "score":
      return value.toFixed(1);
    case "ms":
      return benchmarkMsText(value);
    case "tokens":
      return tokenText(value);
    case "currency":
      return currencyText(value);
    case "count":
    case "calls":
      return String(Math.round(value));
    default:
      return String(value);
  }
}

/** 汇总一行：`74.2 · 5/8 条样本`——均值 + 有值样本数 / 总样本数，分母不藏。 */
export function benchmarkSummaryText(summary: BenchmarkMetricSummaryApi | undefined, totalSamples: number): string {
  if (!summary || typeof summary.mean !== "number" || !Number.isFinite(summary.mean)) return BENCHMARK_EMPTY;
  return `${summary.mean} · ${summary.count}/${totalSamples}`;
}

/** 一个指标的极值区间：`61 ~ 88`。只有一个数或不稳时原样给出。 */
export function benchmarkRangeText(summary: BenchmarkMetricSummaryApi | undefined): string {
  if (!summary || typeof summary.min !== "number" || typeof summary.max !== "number") return BENCHMARK_EMPTY;
  if (summary.min === summary.max) return String(summary.min);
  return `${summary.min} ~ ${summary.max}`;
}

/** 指标来源 → 一句话。界面上只解释来历，不解释「好不好」。 */
export function benchmarkMetricSourceLabel(source: string): string {
  switch (source) {
    case "quality-stack":
      return "Quality Stack";
    case "telemetry":
      return "遥测";
    case "failure-analysis":
      return "失败分析";
    case "run-metadata":
      return "Run 元数据";
    default:
      return source;
  }
}

// ---------------------------------------------------------------------------
// 状态与来源
// ---------------------------------------------------------------------------

/** 执行状态 → 一行文案。partial 不是失败，running 不是错误。 */
export function benchmarkStatusLabel(status: string): { label: string; tone: BenchmarkTone } {
  switch (status) {
    case "completed":
      return { label: "全部完成", tone: "good" };
    case "partial":
      return { label: "部分完成", tone: "warn" };
    case "failed":
      return { label: "没有可用样本", tone: "bad" };
    case "running":
      return { label: "正在运行", tone: "neutral" };
    case "pending":
      return { label: "尚未开始", tone: "neutral" };
    default:
      return { label: "状态未知", tone: "neutral" };
  }
}

/** Suite 题面来源 → 一行文案（§55 数据集安全：来源与许可必须摆在看得见的地方）。 */
export function benchmarkOriginLabel(source: BenchmarkSuiteItemApi["source"]): string {
  const origin = (() => {
    switch (source.origin) {
      case "original":
        return "原创题面";
      case "public-domain":
        return "公有领域素材";
      case "licensed":
        return "已授权素材";
      case "user-provided":
        return "使用者自带题面";
      default:
        return "来源未知";
    }
  })();
  return `${origin} · 许可：${source.license || "未标注"}`;
}

/** Suite 列表的一行。 */
export interface BenchmarkSuiteRow {
  id: string;
  version: string;
  name: string;
  subtitle: string;
  origin: string;
  digest: string;
  description: string | null;
}

export function benchmarkSuiteRow(item: BenchmarkSuiteItemApi): BenchmarkSuiteRow {
  return {
    id: item.id,
    version: item.version,
    name: item.name,
    subtitle: `${item.caseCount} 道题 × ${item.repetitions} 次 = ${item.plannedSamples} 条样本`,
    origin: benchmarkOriginLabel(item.source),
    digest: item.suiteDigest,
    description: item.description ?? null,
  };
}

/** 执行列表的一行。不给任何「哪次更好」的结论，只给足以决定点不点进去的事实。 */
export interface BenchmarkExecutionRow {
  id: string;
  title: string;
  suite: string;
  subtitle: string;
  status: { label: string; tone: BenchmarkTone };
  passText: string;
  isBaseline: boolean;
  startedAt: string;
}

export function benchmarkExecutionRow(item: BenchmarkExecutionItemApi): BenchmarkExecutionRow {
  const status = benchmarkStatusLabel(item.status);
  return {
    id: item.id,
    title: item.label && item.label.trim() ? item.label : item.id,
    suite: `${item.suiteId}@${item.suiteVersion}`,
    subtitle: `${item.completedSamples}/${item.plannedSamples} 条样本完成 · ${item.projectVersion}`,
    status,
    passText: benchmarkPassText(item.aggregate),
    isBaseline: item.isBaseline,
    startedAt: item.startedAt,
  };
}

/** §95/§96 PASS 一行：阈值来自 Suite 协议，这里只负责把它读出来摆着。 */
export function benchmarkPassText(aggregate: BenchmarkAggregateApi | null | undefined): string {
  const pass = aggregate?.pass;
  if (!pass) return BENCHMARK_EMPTY;
  return `${pass.passed} 过 / ${pass.failed} 未过 / ${pass.unmeasured} 未测量（阈值 ${pass.threshold}）`;
}

// ---------------------------------------------------------------------------
// 详情页：指标表
// ---------------------------------------------------------------------------

/** 指标表的一行。顺序 = 注册表顺序，`groupOf` 只决定摆在哪一页。 */
export interface BenchmarkMetricRow {
  key: string;
  label: string;
  unit: string;
  group: BenchmarkMetricGroup;
  source: string;
  sourceLabel: string;
  definition: string;
  /** 原始均值：图表直接用，null 就是没有（§30）。 */
  mean: number | null;
  meanText: string;
  rangeText: string;
  countText: string;
  hasValue: boolean;
}

export function benchmarkMetricRowOf(
  definition: BenchmarkMetricDefinition,
  summary: BenchmarkMetricSummaryApi | undefined,
  totalSamples: number,
): BenchmarkMetricRow {
  const raw = summary?.mean;
  const mean = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    group: definition.group,
    source: definition.source,
    sourceLabel: benchmarkMetricSourceLabel(definition.source),
    definition: definition.definition,
    mean,
    meanText: mean === null ? BENCHMARK_EMPTY : benchmarkMetricText(mean, definition.unit),
    rangeText: benchmarkRangeText(summary),
    countText: summary ? `${summary.count}/${totalSamples}` : `0/${totalSamples}`,
    hasValue: mean !== null,
  };
}

/** 详情页一屏要摆的所有指标行，按注册表分组顺序（质量 → 商业 → 可靠性 → 失败 → 效率）。 */
export function benchmarkMetricRows(
  aggregate: BenchmarkAggregateApi | null | undefined,
  acceptedMetrics?: readonly string[],
): BenchmarkMetricRow[] {
  const total = aggregate?.totalSamples ?? 0;
  const out: BenchmarkMetricRow[] = [];
  for (const group of benchmarkMetricGroups()) {
    for (const definition of group.metrics) {
      if (acceptedMetrics && !acceptedMetrics.includes(definition.key)) continue;
      out.push(benchmarkMetricRowOf(definition, aggregate?.metrics?.[definition.key], total));
    }
  }
  return out;
}

/** 只取某一组的行（详情页的分页就是这么切的）。 */
export function benchmarkMetricRowsOfGroup(
  aggregate: BenchmarkAggregateApi | null | undefined,
  group: BenchmarkMetricGroup,
): BenchmarkMetricRow[] {
  return benchmarkMetricRows(aggregate).filter((row) => row.group === group);
}

// ---------------------------------------------------------------------------
// 失败与分组
// ---------------------------------------------------------------------------

/** §78 失败类别的一行。类别只按固定优先级摆，条数只是事实，不据此排名。 */
export interface BenchmarkFailureRow {
  category: string;
  label: string;
  count: number;
}

export function benchmarkFailureRows(aggregate: BenchmarkAggregateApi | null | undefined): BenchmarkFailureRow[] {
  const counts = aggregate?.failureCategories ?? {};
  return (Object.keys(CATEGORY_LABELS) as FailureCategory[])
    .filter((category) => typeof counts[category] === "number" && counts[category] > 0)
    .map((category) => ({ category, label: CATEGORY_LABELS[category], count: counts[category] ?? 0 }));
}

/** 失败阶段分布：阶段名来自失败分析已经分好的类，这里原样摆。 */
export function benchmarkStageRows(aggregate: BenchmarkAggregateApi | null | undefined): { stage: string; count: number }[] {
  const counts = aggregate?.failureStages ?? {};
  return Object.keys(counts)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .map((stage) => ({ stage, count: counts[stage] ?? 0 }));
}

/** §97 byGenre / §98 byTag 的一行。分组名来自题面元数据，不推测、不外推。 */
export interface BenchmarkGroupRow {
  name: string;
  caseCount: number;
  sampleCount: number;
  completedSamples: number;
  failedSamples: number;
  overallQuality: string;
  failureRate: string;
}

export function benchmarkGroupRows(
  groups: Record<string, BenchmarkGroupResultApi> | undefined,
): BenchmarkGroupRow[] {
  if (!groups) return [];
  return Object.keys(groups)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const group = groups[name] as BenchmarkGroupResultApi;
      return {
        name,
        caseCount: group.caseCount,
        sampleCount: group.sampleCount,
        completedSamples: group.completedSamples,
        failedSamples: group.failedSamples,
        overallQuality: benchmarkMetricText(group.metrics?.overall_quality?.mean ?? null, "score"),
        failureRate: benchmarkMetricText(group.metrics?.failure_rate?.mean ?? null, "percent"),
      };
    });
}

// ---------------------------------------------------------------------------
// 样本表
// ---------------------------------------------------------------------------

/** 样本表的一行：身份 + 失败原因 + 声明过的指标。没有正文、没有提示词（§66）。 */
export interface BenchmarkSampleRow {
  caseId: string;
  repetition: number;
  runId: string | null;
  status: "completed" | "failed";
  failure: string | null;
  /** 这条样本自己的耗时；两个时间戳有一个不可用时是「—」。 */
  durationText: string;
  metrics: { key: string; label: string; text: string }[];
}

export function benchmarkSampleRowOf(
  sample: BenchmarkSampleApi,
  acceptedMetrics?: readonly string[],
): BenchmarkSampleRow {
  const metrics: { key: string; label: string; text: string }[] = [];
  for (const group of benchmarkMetricGroups()) {
    for (const definition of group.metrics) {
      if (acceptedMetrics && !acceptedMetrics.includes(definition.key)) continue;
      metrics.push({
        key: definition.key,
        label: definition.label,
        text: benchmarkMetricText(sample.metrics?.[definition.key] ?? null, definition.unit),
      });
    }
  }
  return {
    caseId: sample.caseId,
    repetition: sample.repetition,
    runId: sample.runId,
    status: sample.status,
    failure: sample.failure ?? null,
    durationText: benchmarkSampleDuration(sample),
    metrics,
  };
}

// ---------------------------------------------------------------------------
// 环境快照与比较
// ---------------------------------------------------------------------------

/** §24 环境快照的一行：这次测量是在什么条件下跑的。一条事实一行，不解释。 */
export interface BenchmarkSnapshotRow {
  label: string;
  value: string;
}

export function benchmarkSnapshotRows(detail: BenchmarkExecutionDetailApi | null): BenchmarkSnapshotRow[] {
  const snapshot = detail?.execution.snapshot;
  if (!snapshot) return [];
  const rows: BenchmarkSnapshotRow[] = [
    { label: "Suite", value: `${snapshot.suiteId}@${snapshot.suiteVersion}` },
    { label: "Suite 摘要", value: snapshot.suiteDigest || BENCHMARK_EMPTY },
    { label: "协议摘要", value: snapshot.protocolDigest || BENCHMARK_EMPTY },
    { label: "项目版本", value: snapshot.projectVersion || BENCHMARK_EMPTY },
    { label: "提交", value: snapshot.commit ?? BENCHMARK_EMPTY },
    { label: "题目", value: `${snapshot.caseIds.length} 道` },
    { label: "每题次数", value: String(snapshot.repetitions) },
    { label: "计划样本", value: String(snapshot.plannedSamples) },
  ];
  for (const [role, model] of Object.entries(snapshot.models ?? {})) {
    // baseUrlClass 是分类不是地址：真实地址不进界面（§67）
    rows.push({ label: `模型 · ${role}`, value: `${model.model}（${model.baseUrlClass}）` });
  }
  for (const prompt of snapshot.prompts ?? []) {
    rows.push({
      label: `提示词 · ${prompt.role}`,
      value: prompt.digest ? `${prompt.version} · ${prompt.digest.slice(0, 12)}` : prompt.version,
    });
  }
  return rows;
}

/** 协议配置的一行：重复次数、规划方式、采纳指标、失败处理、阈值（§95 阈值来自 Suite）。 */
export interface BenchmarkProtocolRow {
  label: string;
  value: string;
}

export function benchmarkProtocolRows(suite: BenchmarkSuiteApi | null): BenchmarkProtocolRow[] {
  const protocol = suite?.protocol;
  if (!protocol) return [];
  return [
    { label: "重复次数", value: String(protocol.repetitions) },
    { label: "规划方式", value: protocol.plannerMode === "fixed-plan" ? "共用一份剧情骨架" : "每个样本自己规划" },
    { label: "失败样本处理", value: protocol.failureHandling === "include" ? "计入样本" : "计入失败数，不进指标" },
    { label: "采纳指标", value: `${protocol.acceptedMetrics.length} 项` },
    { label: "PASS 阈值", value: typeof protocol.passThreshold === "number" ? String(protocol.passThreshold) : "未配置" },
  ];
}

/** §59 比较表的一行。差值带方向，但不给「更好」的结论——方向只是减法的结果。 */
export interface BenchmarkComparisonRow {
  metric: string;
  label: string;
  unit: string;
  baseText: string;
  targetText: string;
  deltaText: string;
  deltaPercentText: string;
  baseCount: number;
  targetCount: number;
  direction: "up" | "down" | "same" | "unknown";
}

export function benchmarkComparisonRows(comparison: BenchmarkComparisonApi | null): BenchmarkComparisonRow[] {
  if (!comparison) return [];
  return comparison.rows.map((row) => {
    const direction: BenchmarkComparisonRow["direction"] =
      row.delta === null ? "unknown" : row.delta > 0 ? "up" : row.delta < 0 ? "down" : "same";
    return {
      metric: row.metric,
      label: row.label,
      unit: row.unit,
      baseText: benchmarkMetricText(row.baseMean, row.unit),
      targetText: benchmarkMetricText(row.targetMean, row.unit),
      deltaText: row.delta === null ? BENCHMARK_EMPTY : `${row.delta > 0 ? "+" : ""}${row.delta}`,
      deltaPercentText:
        row.deltaPercent === null ? BENCHMARK_EMPTY : `${row.deltaPercent > 0 ? "+" : ""}${row.deltaPercent.toFixed(1)}%`,
      baseCount: row.baseCount,
      targetCount: row.targetCount,
      direction,
    };
  });
}

/** §91 历史图的一个点：真实保存过的执行才进得来，没有的点整段跳过（§92）。 */
export interface BenchmarkHistorySeriesPoint {
  id: string;
  label: string;
  suiteId: string;
  suiteVersion: string;
  startedAt: string;
  status: string;
  overallQuality: number | null;
  commercialOverall: number | null;
  failureRate: number | null;
  durationMs: number | null;
}

export function benchmarkHistorySeries(points: readonly BenchmarkHistoryPointApi[]): BenchmarkHistorySeriesPoint[] {
  return [...points]
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
    .map((point) => ({
      id: point.id,
      label: point.label && point.label.trim() ? point.label : point.id,
      suiteId: point.suiteId,
      suiteVersion: point.suiteVersion,
      startedAt: point.startedAt,
      status: point.status,
      overallQuality: numberOrNull(point.overallQuality),
      commercialOverall: numberOrNull(point.commercialOverall),
      failureRate: numberOrNull(point.failureRate),
      durationMs: numberOrNull(point.durationMs),
    }));
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 历史图可选的四条线（§91）。没有一条有值就返回空数组，界面据此整段隐藏。 */
export function benchmarkHistoryLines(
  series: readonly BenchmarkHistorySeriesPoint[],
): { key: "overallQuality" | "commercialOverall" | "failureRate" | "durationMs"; label: string; unit: string }[] {
  const lines = [
    { key: "overallQuality" as const, label: "整体质量", unit: "score" },
    { key: "commercialOverall" as const, label: "商业可读性", unit: "score" },
    { key: "failureRate" as const, label: "样本失败率", unit: "percent" },
    { key: "durationMs" as const, label: "平均耗时", unit: "ms" },
  ];
  return lines.filter((line) => series.some((point) => point[line.key] !== null));
}

// ---------------------------------------------------------------------------
// 列表与筛选
// ---------------------------------------------------------------------------

/** 执行筛选：一次只看一个 Suite（界面上的下拉就是为了这个，没有「全部对比」按钮）。 */
export function benchmarkExecutionsOfSuite(
  items: readonly BenchmarkExecutionItemApi[],
  suiteId: string | null,
): BenchmarkExecutionItemApi[] {
  if (!suiteId) return [...items];
  return items.filter((item) => item.suiteId === suiteId);
}

/** 一次执行的标题：label 是人给的备注，没有就退回 id（绝不编一个名字）。 */
export function benchmarkExecutionTitle(item: { id: string; label: string | null }): string {
  return item.label && item.label.trim() ? item.label : item.id;
}

/** Suite 详情页的题目一行：题面本身来自 Suite，界面只读不改（§44 不可变）。 */
export interface BenchmarkCaseRow {
  id: string;
  title: string;
  genre: string;
  mode: string;
  tags: string;
}

export function benchmarkCaseRows(suite: BenchmarkSuiteApi | null): BenchmarkCaseRow[] {
  if (!suite) return [];
  return suite.cases.map((item) => ({
    id: item.id,
    title: item.title,
    genre: item.genre,
    mode: item.beatPlanMode === "fixed" ? "共用剧情骨架" : "自己规划",
    tags: (item.tags ?? []).join(" · "),
  }));
}

/** 时间戳 → 界面文字（与 workspace-view 同一套口径，解析不出来原样返回）。 */
export function benchmarkTimestampLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 一条样本耗时 → 短标签。历史图与样本表共用，避免两处算法不一致。 */
export function benchmarkSampleDuration(sample: BenchmarkSampleApi): string {
  const start = new Date(sample.startedAt).getTime();
  const end = new Date(sample.completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return BENCHMARK_EMPTY;
  return benchmarkMsText(end - start);
}

/** 指标键 → 中文标签。找不到（Suite 里删过的旧键）时退回键名本身，不隐藏这一行。 */
export function benchmarkMetricLabel(key: string): string {
  return benchmarkMetricDefinition(key)?.label ?? key;
}
