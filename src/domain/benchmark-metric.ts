/**
 * v2.3.0 Benchmark 指标注册表（TASK §26/§29/§30）。
 *
 * 一个平台要能反复测量，指标就必须是**有名字、有单位、有口径**的东西：
 * 「74.2」不说明任何事，「overall_quality = 74.2 分，5 条样本的均值，来自各样本
 * 自己的 quality-stack.json」才说明事。所以每个指标在这里登记一次，
 * 聚合、仪表盘、CSV 表头、文档四处共用同一份定义，不各写一遍。
 *
 * 两条硬规矩：
 *   1. **缺值只能是 null**（TASK §30）。Provider 不给 token usage 就没有这个数，
 *      补 0 等于凭空发明一次「没有 usage」的调用。
 *   2. **Benchmark 不自己产指标**。每个指标的 source 都是别的层已经写下的产物
 *      （Quality Stack / Telemetry / Failure Analysis / Run 元数据）——Benchmark
 *      只读取与聚合，不再调一次 Reviewer（TASK §27/§28）。
 */

export const BENCHMARK_METRIC_REGISTRY_VERSION = "1";

/** 单位只描述「这个数是什么」，不做任何换算。 */
export type BenchmarkMetricUnit = "score" | "percent" | "count" | "ms" | "calls" | "tokens" | "currency";

/**
 * 聚合方式：
 *   mean —— 只对真有值的样本求平均，分母是有值样本数（TASK §30）；
 *   rate —— 0/100 的求平均，得到的是百分比；
 *   count —— 计数类的求平均（每次运行平均发生几次）。
 */
export type BenchmarkMetricAggregation = "mean" | "rate" | "count";

/** 指标的事实来源：界面与文档都按这句话解释数字的来历。 */
export type BenchmarkMetricSource =
  | "quality-stack"
  | "telemetry"
  | "failure-analysis"
  | "run-metadata";

export interface BenchmarkMetricDefinition {
  key: string;
  /** 中文标签：仪表盘、对比表、CSV 说明共用。 */
  label: string;
  unit: BenchmarkMetricUnit;
  aggregation: BenchmarkMetricAggregation;
  /** 缺失值行为。永远只有一种：null，绝不补 0（TASK §30）。 */
  missingValue: "null";
  source: BenchmarkMetricSource;
  /** 这个指标是什么意思——文档与 UI 的 tooltip 用同一句。 */
  definition: string;
}

/**
 * §26 首版指标全集。
 *
 * 顺序即 UI 的呈现顺序：质量 → 商业 → 可靠性 → 失败 → 效率。
 * 一个指标都不多做（没有相关性、没有趋势拟合、没有综合分，TASK §63）。
 */
export const BENCHMARK_METRIC_DEFINITIONS = [
  // ---- 质量：读各样本自己的 quality-stack.json（v2.1.0 的正式质量来源，§76）----
  {
    key: "overall_quality",
    label: "整体质量",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "四维质量分的确定性均分（Co/N/C/Ca），取自样本自己的 Quality Stack 结论",
  },
  {
    key: "coherence",
    label: "连贯性",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "设定、称呼、时间线前后是否一致",
  },
  {
    key: "narrative",
    label: "叙事",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "叙事结构与节奏：起承转合是否完整、详略是否得当",
  },
  {
    key: "character",
    label: "人物",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "人物一致性与动机：言行是否符合其目标与处境",
  },
  {
    key: "causality",
    label: "因果",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "因果链：事件推进是否有清楚的前因后果",
  },
  // ---- 商业可读性：同样只读已有结论 ----
  {
    key: "commercial_overall",
    label: "商业可读性总分",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "四个商业维度（H/P/E/Pf）的确定性均分",
  },
  {
    key: "hook",
    label: "钩子",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "开局钩子的强度",
  },
  {
    key: "pacing",
    label: "节奏",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "叙事节奏与信息密度",
  },
  {
    key: "engagement",
    label: "代入感",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "读者代入与追更意愿",
  },
  {
    key: "payoff",
    label: "爽点兑现",
    unit: "score",
    aggregation: "mean",
    missingValue: "null",
    source: "quality-stack",
    definition: "承诺与兑现的完成度",
  },
  // ---- 可靠性：全部由 Run 元数据与结构校验结论确定性算出 ----
  {
    key: "validation_pass_rate",
    label: "正文校验通过率",
    unit: "percent",
    aggregation: "rate",
    missingValue: "null",
    source: "run-metadata",
    definition: "跑出正文校验结论的样本里通过的比例；一步都没跑到的样本不计入分母",
  },
  {
    key: "beat_validation_pass_rate",
    label: "骨架校验通过率",
    unit: "percent",
    aggregation: "rate",
    missingValue: "null",
    source: "run-metadata",
    definition: "跑了骨架校验的样本里通过的比例；没接 BeatValidator 的部署一次都没跑，整体为 null",
  },
  {
    key: "acceptance_rate",
    label: "尝试采纳率",
    unit: "percent",
    aggregation: "rate",
    missingValue: "null",
    source: "run-metadata",
    definition: "入选 Attempt 占已发生 Attempt 的比例：重试越多，这个数越低",
  },
  {
    key: "retry_count",
    label: "平均重试次数",
    unit: "count",
    aggregation: "count",
    missingValue: "null",
    source: "telemetry",
    definition: "每条样本的平均重试次数，取自该样本的 telemetry.json",
  },
  {
    key: "repair_count",
    label: "平均修订次数",
    unit: "count",
    aggregation: "count",
    missingValue: "null",
    source: "telemetry",
    definition: "每条样本的平均修订次数，取自该样本的 telemetry.json",
  },
  // ---- 失败：只读 Failure Analysis 已经分好的类（§78）----
  {
    key: "failure_rate",
    label: "样本失败率",
    unit: "percent",
    aggregation: "rate",
    missingValue: "null",
    source: "run-metadata",
    definition: "整条样本失败的比例（样本失败 = 这条 Run 没跑成）",
  },
  // ---- 效率：只读 Telemetry（§77）----
  {
    key: "duration_ms",
    label: "平均耗时",
    unit: "ms",
    aggregation: "mean",
    missingValue: "null",
    source: "telemetry",
    definition: "每条样本的 Run 级耗时均值",
  },
  {
    key: "llm_calls",
    label: "平均模型调用",
    unit: "calls",
    aggregation: "count",
    missingValue: "null",
    source: "telemetry",
    definition: "每条样本的逻辑模型调用次数均值（传输重试算在同一次里）",
  },
  {
    key: "input_tokens",
    label: "平均输入 Token",
    unit: "tokens",
    aggregation: "mean",
    missingValue: "null",
    source: "telemetry",
    definition: "只对 Provider 真给了 usage 的调用求和后求平均；一次都没给就是 null",
  },
  {
    key: "output_tokens",
    label: "平均输出 Token",
    unit: "tokens",
    aggregation: "mean",
    missingValue: "null",
    source: "telemetry",
    definition: "同上，只对已知值求平均",
  },
  {
    key: "total_tokens",
    label: "平均总 Token",
    unit: "tokens",
    aggregation: "mean",
    missingValue: "null",
    source: "telemetry",
    definition: "同上，只对已知值求平均",
  },
  {
    key: "cost_amount",
    label: "平均单次费用",
    unit: "currency",
    aggregation: "mean",
    missingValue: "null",
    source: "telemetry",
    definition: "只有 Provider 返回金额与币种时才可能有值；没有可靠的费用数据就不显示，不估算（§43）",
  },
] as const satisfies readonly BenchmarkMetricDefinition[];

export type BenchmarkMetricKey = (typeof BENCHMARK_METRIC_DEFINITIONS)[number]["key"];

/** 全部指标键，顺序即呈现顺序。 */
export const BENCHMARK_METRIC_KEYS: readonly BenchmarkMetricKey[] = BENCHMARK_METRIC_DEFINITIONS.map(
  (definition) => definition.key,
);

const BY_KEY = new Map<string, BenchmarkMetricDefinition>(
  BENCHMARK_METRIC_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function isBenchmarkMetricKey(value: unknown): value is BenchmarkMetricKey {
  return typeof value === "string" && BY_KEY.has(value);
}

export function benchmarkMetricDefinition(key: string): BenchmarkMetricDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** 注册表给校验用的键集合（Suite 里的 acceptedMetrics 只能取这些值）。 */
export function benchmarkMetricKeys(): Set<string> {
  return new Set(BENCHMARK_METRIC_KEYS);
}

/** 全量：Suite 不显式声明时（例如内部工具）可以按这份默认清单认。 */
export const DEFAULT_ACCEPTED_METRICS: readonly BenchmarkMetricKey[] = BENCHMARK_METRIC_KEYS;

/** 一条样本的指标值：每个声明的键都在，没有数据的就是 null（绝不缺键、绝不补 0）。 */
export type BenchmarkMetricValues = Record<BenchmarkMetricKey, number | null>;

/** 全 null 的指标表：一个数都不知道时长这样。 */
export function emptyMetricValues(): BenchmarkMetricValues {
  const out = {} as Record<BenchmarkMetricKey, number | null>;
  for (const key of BENCHMARK_METRIC_KEYS) out[key] = null;
  return out;
}
