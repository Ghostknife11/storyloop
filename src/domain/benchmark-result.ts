/**
 * v2.3.0 Benchmark 执行结果领域模型（TASK §24/§25/§31/§32/§36/§37）。
 *
 * 这里的每一个形状都只回答「那次执行发生了什么」：
 *
 *   snapshot   —— 跑之前定下来的全部条件（哪份 Suite 的哪个版本、什么协议、
 *                 哪个 StoryLoop 版本、哪些题、跑几个样本）；
 *   samples    —— 每条样本自己是什么状态、自己的指标是多少（引用 runId，不复制正文，§39）；
 *   aggregate  —— 确定性地把样本汇总成一页数字（§99：不调 LLM、不排序、不排名）。
 *
 * 一条贯穿全部形状的规矩：**缺值是 null，不是 0**（TASK §30）。`count` 永远跟着
 * 数字一起出现——「均值 74.2，5 条样本」与「均值 74.2，30 条样本」是两件事，
 * 少了 count 就会被读成同一件事。
 *
 * 这些模型同样没有一处能反过来改生成行为：没有 recommendedModel、没有自适应开关、
 * 没有自动应用的策略（TASK §2/§82/§127）。
 */

import type { BenchmarkMetricKey, BenchmarkMetricValues } from "@/domain/benchmark-metric";
import type { BenchmarkProtocol } from "@/domain/benchmark-suite";
import type { ModelSnapshot, ParameterSnapshot, PromptSnapshot } from "@/domain/run-manifest";

export const BENCHMARK_EXECUTION_SCHEMA_VERSION = "1";

/**
 * 执行 id：单个目录名（存储布局就是 `executions/<id>/`）。
 * 与 run_id 同一套形态约束——不合法的一律当「不存在」，不进路径解析。
 */
export const BENCHMARK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isBenchmarkId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    value.length <= 128 &&
    BENCHMARK_ID_PATTERN.test(value)
  );
}

/**
 * §44 一次执行的整体状态：
 *   completed —— 全部样本跑成；
 *   partial   —— 有跑成的也有失败的（130 条里 4 条失败仍然是 partial，不是失败）；
 *   failed    —— 一条都没跑成（通常是配置层就错了，见 §46）。
 */
export type BenchmarkExecutionStatus = "pending" | "running" | "completed" | "partial" | "failed";

/** §45 单条样本的结局。runId 为 null 表示这条样本连 Run 都没建起来。 */
export type BenchmarkSampleStatus = "completed" | "failed";

/** §25 一条样本的结果：它是谁、跑成没有、它自己的指标是多少。 */
export interface BenchmarkSampleResult {
  caseId: string;
  repetition: number;
  /** 引用 runs/<run_id>/（§39：Benchmark 只存引用，Run 本体仍由 RunRepository 管）。 */
  runId: string | null;
  status: BenchmarkSampleStatus;
  metrics: BenchmarkMetricValues;
  /** 失败时的一句话（稳定错误码 + 阶段），不带异常原文、不带任何路径。 */
  failure?: string | null;
  startedAt: string;
  completedAt: string | null;
}

/** §32 一个指标的汇总：count / mean / min / max。一个已知值都没有时 mean 是 null、count 是 0。 */
export interface BenchmarkMetricSummary {
  /** 有值的样本数——它是均值的分母，不是这一组的样本总数。 */
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** §31 一个分组（byGenre / byTag）的结果。分组的键来自 Case 自己的元数据（§97/§98）。 */
export interface BenchmarkGroupResult {
  /** 这一组里有几道题（不是几个样本）。 */
  caseCount: number;
  sampleCount: number;
  completedSamples: number;
  failedSamples: number;
  metrics: Partial<Record<BenchmarkMetricKey, BenchmarkMetricSummary>>;
}

/** §95 可选的 PASS 切线结论：只对 overall_quality 生效，且切线来自协议，不是平台默认值。 */
export interface BenchmarkPassBlock {
  threshold: number;
  passed: number;
  failed: number;
  /** 没有整体质量分的样本：不计入通过，也不计入不通过。 */
  unmeasured: number;
}

/** §31 一次执行的汇总。 */
export interface BenchmarkAggregate {
  totalSamples: number;
  completedSamples: number;
  failedSamples: number;
  /** 只含协议 acceptedMetrics 里声明的那些指标。 */
  metrics: Record<string, BenchmarkMetricSummary>;
  byGenre?: Record<string, BenchmarkGroupResult>;
  byTag?: Record<string, BenchmarkGroupResult>;
  /** §78 主要失败类别分布：类别 → 样本数，没出现过的类别整个键不出现。 */
  failureCategories: Record<string, number>;
  /** §56 失败阶段分布：阶段名 → 样本数，来自失败样本自己的遥测。 */
  failureStages: Record<string, number>;
  /** §95 配了切线才有；没配就是 null。 */
  pass: BenchmarkPassBlock | null;
}

/**
 * §18/§72 执行快照：跑之前就该定下来、跑完之后不允许改的全部条件。
 *
 * `models` / `prompts` / `parameters` 三项刻意留空到第一条样本跑成之后才填，
 * 并且填的是**那条样本 Manifest 里已经写下的事实**——Benchmark 不信「当前配置」，
 * 只信这次真的跑在什么上面（TASK §19）。一条样本都没跑成时它们保持 null，
 * 不会拿服务端当前设置冒充实况。
 */
export interface BenchmarkExecutionSnapshot {
  suiteId: string;
  suiteVersion: string;
  suiteDigest: string;
  protocol: BenchmarkProtocol;
  protocolDigest: string;
  projectVersion: string;
  /** 部署环境注入了 commit 才有；没注入就是 null，不为了好看去跑 git。 */
  commit: string | null;
  models: Record<string, ModelSnapshot> | null;
  prompts: PromptSnapshot[] | null;
  parameters: ParameterSnapshot | null;
  /** §72 这次执行覆盖哪些题（顺序即 Suite 声明顺序）。 */
  caseIds: string[];
  repetitions: number;
  /** cases × repetitions，跑之前就算得出来（TASK §41）。 */
  plannedSamples: number;
  /** 执行说明（例如「2.3.0 发布前基线」）。纯粹是标签，不参与任何判定（§94）。 */
  label: string | null;
  startedAt: string;
}

/** §24 一次 Benchmark 执行。 */
export interface BenchmarkExecution {
  schemaVersion: string;
  id: string;
  suiteId: string;
  suiteVersion: string;
  status: BenchmarkExecutionStatus;
  snapshot: BenchmarkExecutionSnapshot;
  samples: BenchmarkSampleResult[];
  aggregate: BenchmarkAggregate | null;
  startedAt: string;
  completedAt: string | null;
}

/** §59/§60 一次比较的一行：两侧各自的均值与已知样本数、差值与相对差值。 */
export interface BenchmarkComparisonRow {
  key: string;
  label: string;
  unit: string;
  baseMean: number | null;
  baseCount: number;
  targetMean: number | null;
  targetCount: number;
  /** 绝对差值 = target - base。任一侧没有均值时是 null，不当 0。 */
  delta: number | null;
  /** 相对差值（百分点）。base 为 0 或 null 时是 null——除零没有答案，不编一个。 */
  deltaPercent: number | null;
}

/** 比较里的执行方：只带身份与状态，不带样本明细。 */
export interface BenchmarkComparisonSide {
  benchmarkId: string;
  suiteId: string;
  suiteVersion: string;
  status: BenchmarkExecutionStatus;
  startedAt: string;
  completedAt: string | null;
}

/**
 * §59 两次执行的并排比较。
 *
 * `caveat` 是契约的一部分而不是装饰文案：比较只报告**观测到的差异**，
 * 不解释差异为什么发生（TASK §61）。少了这句话，72.1 → 74.8 很容易被读成
 * 「因为换了 Prompt」——而 Benchmark 的实验设计给不出这个因果结论。
 */
export interface BenchmarkComparison {
  base: BenchmarkComparisonSide;
  target: BenchmarkComparisonSide;
  rows: BenchmarkComparisonRow[];
  failureRate: {
    base: number | null;
    target: number | null;
    delta: number | null;
  };
  caveat: string;
}

/** §60 比较结果的固定说明：UI 与 JSON 导出都用这一句。 */
export const BENCHMARK_COMPARISON_CAVEAT =
  "这里只报告两次执行各自算出的事实差值（observed difference），不解释差异原因；" +
  "Benchmark 的协议无法支持因果结论。";
