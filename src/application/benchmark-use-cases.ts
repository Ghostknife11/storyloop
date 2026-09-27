/**
 * v2.3.0 Benchmark 用例（Application；TASK §84）。
 *
 * 七个用例，与 §84 推荐清单一一对应：列 Suite、读 Suite、跑执行、读执行、
 * 列执行、比较、导出。和 v2.0 的实验用例同一个分工：Analysis 负责聚合与执行，
 * Infrastructure 负责存储，这一层只做三件事——补默认依赖、加并发锁、把结果
 * 翻成路由好用的形状。它不 import Engine，不读环境变量，不自己 new 存储
 * （默认值除外，那也和实验用例一样是「调用方什么都没给」时的兜底）。
 *
 * 两个只有这里才有的判断：
 *
 *   1. **同一份 Suite 不许并发跑两份**（`runningSuites`）。两次执行会各自生成
 *      自己的 benchmarkId、各自的 runId，文件上不会打架，但同一份题被同时跑两轮
 *      时，任何「对比这两次」都说不清是在比版本还是在比偶发性。宁可当场 409。
 *   2. **执行中的锁按 `<suiteId>@<version>` 记**。同一份 Suite 升了版本之后
 *      照跑，那道锁只挡「同一版本同时跑第二遍」。
 */

import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { BenchmarkStore } from "@/infrastructure/storage/benchmark-store";
import { benchmarkEnvironment } from "@/infrastructure/tracking/benchmark-environment";
import { missingPromptRoles } from "@/infrastructure/tracking/prompt-registry";
import { providerConfigured } from "@/infrastructure/health/health-probe";
import { logger } from "@/infrastructure/logging/logger";
import { appSettings } from "@/infrastructure/config/app-config";
import { buildPipeline } from "@/application/generate-service";
import { BenchmarkRunner, type BenchmarkRunnerDeps } from "@/analysis/benchmark-runner";
import { compareBenchmarkExecutions } from "@/analysis/benchmark-comparator";
import {
  BENCHMARK_EXPORT_FORMATS,
  renderBenchmarkExport,
  type BenchmarkExportFormat,
} from "@/analysis/benchmark-export";
import {
  BenchmarkNotFoundError,
  BenchmarkStateError,
  BenchmarkValidationError,
  benchmarkSampleCount,
  validateBenchmarkRunRequest,
} from "@/domain/benchmark-suite";
import { isBenchmarkId } from "@/domain/benchmark-result";
import { contentDisposition } from "@/domain/export-artifact";
import type { BenchmarkAggregate, BenchmarkComparison, BenchmarkExecution } from "@/domain/benchmark-result";
import type { BenchmarkSuite } from "@/domain/benchmark-suite";
import type { Logger } from "@/ports/logger";
import type {
  BenchmarkExecutionRepository,
  BenchmarkSuiteRepository,
  BenchmarkSuiteSummary,
} from "@/ports/benchmark-store";

export {
  BENCHMARK_EXPORT_FORMATS,
  BENCHMARK_EXPORT_MIME,
  type BenchmarkExportFormat,
} from "@/analysis/benchmark-export";

/** 用例入口收的依赖：可以什么都不给（全部走默认），也可以逐项换成测试替身。 */
export type BenchmarkCaseDeps = Partial<BenchmarkRunnerDeps> & {
  /** Suite 与执行可以是同一个存储（生产就是），测试里分开给更省事。 */
  suites?: BenchmarkSuiteRepository;
  executions?: BenchmarkExecutionRepository;
};

/** 用例要用的依赖：调用方给的优先，缺的补正式实现。 */
type ResolvedBenchmarkDeps = BenchmarkRunnerDeps & {
  suites: BenchmarkSuiteRepository;
  executions: BenchmarkExecutionRepository;
};

function resolveBenchmarkDeps(deps: BenchmarkCaseDeps): ResolvedBenchmarkDeps {
  const runsRoot = appSettings().runsDir;
  const suites = deps.suites ?? deps.benchmarkStore ?? new BenchmarkStore(runsRoot);
  const executions = deps.executions ?? deps.benchmarkStore ?? new BenchmarkStore(runsRoot);
  return {
    ...deps,
    suites,
    executions,
    // 同一个实例满足两个端口：生产路径下 Suite 与执行共用一个存储根
    benchmarkStore: suites as BenchmarkSuiteRepository & BenchmarkExecutionRepository,
    artifactStore: deps.artifactStore ?? new ArtifactStore(runsRoot),
    environment: deps.environment ?? benchmarkEnvironment(),
    providerProbe: deps.providerProbe ?? providerConfigured,
    promptProbe: deps.promptProbe ?? missingPromptRoles,
    logger: deps.logger ?? logger,
    generate: deps.generate ?? buildPipeline,
  };
}

/**
 * 同一版本、同一份 Suite 的运行锁。
 *
 * 刻意不做「第二次调用排队等待」：那条路会让一次 30 个样本的执行在服务器里
 * 排起长队，而 HTTP 请求早超时了，用户看着一个永远不响应的按钮。当场拒绝更诚实。
 */
const runningSuites = new Set<string>();

function suiteLockKey(suite: BenchmarkSuite): string {
  return `${suite.id}@${suite.version}`;
}

/** 用例统一记失败日志：堆栈只进服务端日志，响应里只有 code 与一句话。 */
async function logged<T>(log: Logger, what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    log.error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, e);
    throw e;
  }
}

/** §83 列表接口给界面看的执行摘要：够判断「点哪一个」，不带样本明细。 */
export interface BenchmarkExecutionListItem {
  id: string;
  suiteId: string;
  suiteVersion: string;
  suiteName: string | null;
  status: BenchmarkExecution["status"];
  label: string | null;
  projectVersion: string;
  commit: string | null;
  startedAt: string;
  completedAt: string | null;
  plannedSamples: number;
  completedSamples: number;
  failedSamples: number;
  /** 聚合出来才有；执行还没跑完时这部分是 null。 */
  aggregate: BenchmarkAggregate | null;
  /** §93 用户标了 baseline 的那一份；纯标签，不带任何自动效果。 */
  isBaseline: boolean;
}

/**
 * §93 Baseline 是一份名单，存在进程内。
 *
 * 为什么不是 Suite / Execution 上的一个字段：执行写完之后就不许改（§37），
 * 而「哪一次算基线」是会变的操作。把它放在运行期标签里，历史结果一个字都不用动。
 * 换来的代价：重启就忘。所以界面上标成「本次会话的基线」，不说成永久状态。
 */
const baselines = new Set<string>();

/** 把某次执行标记 / 取消标记为 Baseline（§93：只是标签）。 */
export function setBenchmarkBaseline(benchmarkId: string, isBaseline: boolean): boolean {
  if (!isBenchmarkId(benchmarkId)) throw new BenchmarkValidationError("执行 id 不合法");
  if (isBaseline) baselines.add(benchmarkId);
  else baselines.delete(benchmarkId);
  return isBaseline;
}

export function isBenchmarkBaseline(benchmarkId: string): boolean {
  return baselines.has(benchmarkId);
}

/** GET /api/benchmarks/suites：全部已存版本的摘要（含样本数与来源说明）。 */
export async function listBenchmarkSuites(deps: BenchmarkCaseDeps = {}): Promise<BenchmarkSuiteSummary[]> {
  return resolveBenchmarkDeps(deps).suites.listSuites();
}

/** GET /api/benchmarks/suites/:id：某一版 Suite 全文（题面 + 协议 + 来源）。 */
export async function getBenchmarkSuite(
  suiteId: string,
  deps: BenchmarkCaseDeps = {},
  suiteVersion?: string,
): Promise<BenchmarkSuite> {
  const { suites } = resolveBenchmarkDeps(deps);
  const suite = suites.readSuite(suiteId, suiteVersion);
  if (suite === null) {
    throw new BenchmarkNotFoundError(suiteVersion ? `Suite ${suiteId}@${suiteVersion} 不存在` : `Suite ${suiteId} 不存在`);
  }
  return suite;
}

/** POST /api/benchmarks/executions：预检通过就跑完整个执行。 */
export async function runBenchmark(body: unknown, deps: BenchmarkCaseDeps = {}): Promise<BenchmarkExecution> {
  const merged = resolveBenchmarkDeps(deps);
  const request = validateBenchmarkRunRequest(body);
  const suite = merged.suites.readSuite(request.suiteId, request.suiteVersion);
  if (suite === null) {
    throw new BenchmarkNotFoundError(
      request.suiteVersion ? `Suite ${request.suiteId}@${request.suiteVersion} 不存在` : `Suite ${request.suiteId} 不存在`,
    );
  }
  const key = suiteLockKey(suite);
  if (runningSuites.has(key)) {
    throw new BenchmarkStateError(`Suite ${key} 正在执行中：等这一次跑完再试，不要同时跑两份`);
  }
  runningSuites.add(key);
  try {
    // 预检在 Runner 里做（§40：LLM 请求之前全查完）。这里只负责锁与日志。
    return await logged(merged.logger, `run benchmark suite ${key}`, () =>
      new BenchmarkRunner(merged).run(suite, {
        ...(request.label !== undefined ? { label: request.label } : {}),
        ...(request.allowLargeBenchmark !== undefined ? { allowLargeBenchmark: request.allowLargeBenchmark } : {}),
      }),
    );
  } finally {
    runningSuites.delete(key);
  }
}

/** GET /api/benchmarks/executions：列表，按时间正序（id 前缀就是时间戳）。 */
export async function listBenchmarkExecutions(deps: BenchmarkCaseDeps = {}): Promise<BenchmarkExecutionListItem[]> {
  const { executions, suites } = resolveBenchmarkDeps(deps);
  const names = new Map<string, string>();
  for (const summary of suites.listSuites()) names.set(`${summary.id}@${summary.version}`, summary.name);
  const out: BenchmarkExecutionListItem[] = [];
  for (const id of executions.listExecutionIds()) {
    const execution = executions.readExecution(id);
    if (execution === null) continue;
    out.push(itemOf(execution, names.get(`${execution.suiteId}@${execution.suiteVersion}`) ?? null));
  }
  return out;
}

function itemOf(execution: BenchmarkExecution, suiteName: string | null): BenchmarkExecutionListItem {
  const aggregate = execution.aggregate;
  return {
    id: execution.id,
    suiteId: execution.suiteId,
    suiteVersion: execution.suiteVersion,
    suiteName,
    status: execution.status,
    label: execution.snapshot.label,
    projectVersion: execution.snapshot.projectVersion,
    commit: execution.snapshot.commit,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    plannedSamples: execution.snapshot.plannedSamples,
    completedSamples: aggregate?.completedSamples ?? execution.samples.filter((s) => s.status === "completed").length,
    failedSamples: aggregate?.failedSamples ?? execution.samples.filter((s) => s.status === "failed").length,
    aggregate,
    isBaseline: isBenchmarkBaseline(execution.id),
  };
}

/** 一次执行的完整视图（详情接口的返回体）。 */
export interface BenchmarkExecutionDetail {
  execution: BenchmarkExecution;
  /** 引用的那一版 Suite 全文；Suite 后来被删了就是 null（跑过的数据照样在）。 */
  suite: BenchmarkSuite | null;
  /** 请求带了 compare=<baseId> 时才有：与另一次执行的逐指标比较。 */
  comparison: BenchmarkComparison | null;
}

/** GET /api/benchmarks/executions/:id：执行三件套 + 可选的与基线比较。 */
export async function getBenchmarkExecution(
  benchmarkId: string,
  deps: BenchmarkCaseDeps = {},
  options: { compareWith?: string | null } = {},
): Promise<BenchmarkExecutionDetail> {
  const { executions, suites } = resolveBenchmarkDeps(deps);
  const execution = executions.readExecution(benchmarkId);
  if (execution === null) throw new BenchmarkNotFoundError(`Benchmark 执行 ${benchmarkId} 不存在`);
  const suite = suites.readSuite(execution.suiteId, execution.suiteVersion);
  let comparison: BenchmarkComparison | null = null;
  if (options.compareWith && options.compareWith !== benchmarkId && isBenchmarkId(options.compareWith)) {
    const base = executions.readExecution(options.compareWith);
    if (base !== null && base.aggregate !== null && execution.aggregate !== null) {
      comparison = compareBenchmarkExecutions(base, execution);
    }
  }
  return { execution, suite, comparison };
}

/** §91 历史图的取数：把若干次执行的关键数字摊平成点序列。 */
export interface BenchmarkHistoryPoint {
  id: string;
  label: string | null;
  suiteId: string;
  suiteVersion: string;
  status: BenchmarkExecution["status"];
  startedAt: string;
  projectVersion: string;
  commit: string | null;
  overallQuality: number | null;
  commercialOverall: number | null;
  failureRate: number | null;
  durationMs: number | null;
}

/** GET /api/benchmarks/executions（同一份数据的图表取向）。 */
export async function benchmarkHistory(
  suiteId?: string,
  deps: BenchmarkCaseDeps = {},
): Promise<BenchmarkHistoryPoint[]> {
  const { executions } = resolveBenchmarkDeps(deps);
  const out: BenchmarkHistoryPoint[] = [];
  for (const id of executions.listExecutionIds()) {
    const execution = executions.readExecution(id);
    if (execution === null) continue;
    if (suiteId !== undefined && execution.suiteId !== suiteId) continue;
    const aggregate = execution.aggregate;
    out.push({
      id: execution.id,
      label: execution.snapshot.label,
      suiteId: execution.suiteId,
      suiteVersion: execution.suiteVersion,
      status: execution.status,
      startedAt: execution.startedAt,
      projectVersion: execution.snapshot.projectVersion,
      commit: execution.snapshot.commit,
      overallQuality: aggregate?.metrics.overall_quality?.mean ?? null,
      commercialOverall: aggregate?.metrics.commercial_overall?.mean ?? null,
      failureRate: aggregate?.metrics.failure_rate?.mean ?? null,
      durationMs: aggregate?.metrics.duration_ms?.mean ?? null,
    });
  }
  return out;
}

/** 导出用例的返回：文件名 + bytes + 该有的两个响应头。 */
export interface BenchmarkExportOutcome {
  filename: string;
  mimeType: string;
  byteSize: number;
  download: string;
  bytes: Uint8Array;
}

/** GET /api/benchmarks/executions/:id/export：JSON / CSV 两种，都不带正文。 */
export async function exportBenchmarkResult(
  benchmarkId: string,
  format: string,
  deps: BenchmarkCaseDeps = {},
): Promise<BenchmarkExportOutcome> {
  const { executions, suites } = resolveBenchmarkDeps(deps);
  if (!BENCHMARK_EXPORT_FORMATS.includes(format as BenchmarkExportFormat)) {
    throw new BenchmarkValidationError(`format 只能是 ${BENCHMARK_EXPORT_FORMATS.join(" / ")}`);
  }
  const execution = executions.readExecution(benchmarkId);
  if (execution === null) throw new BenchmarkNotFoundError(`Benchmark 执行 ${benchmarkId} 不存在`);
  const suite = suites.readSuite(execution.suiteId, execution.suiteVersion);
  const rendered = renderBenchmarkExport(format as BenchmarkExportFormat, execution, suite);
  return {
    filename: rendered.filename,
    mimeType: rendered.mimeType,
    byteSize: rendered.bytes.byteLength,
    download: contentDisposition(rendered.filename),
    bytes: rendered.bytes,
  };
}

/** 服务层用的一个入口：直接跑一份 Suite（CLI / 脚本），不经过 HTTP 语义。 */
export async function runBenchmarkById(
  suiteId: string,
  deps: BenchmarkCaseDeps = {},
  suiteVersion?: string,
): Promise<BenchmarkExecution> {
  return runBenchmark({ suiteId, ...(suiteVersion !== undefined ? { suiteVersion } : {}) }, deps);
}

/** 供 UI 与测试：一次执行该跑多少个样本（不建执行也能问）。 */
export async function benchmarkPlannedSamples(suiteId: string, deps: BenchmarkCaseDeps = {}): Promise<number> {
  const suite = await getBenchmarkSuite(suiteId, deps);
  return benchmarkSampleCount(suite);
}
