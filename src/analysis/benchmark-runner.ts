/**
 * v2.3.0 Benchmark Runner（TASK §20/§21/§22/§40/§41/§44/§45/§46）。
 *
 * 它做十件事：加载 Suite → 校验 Suite → 展开 Cases × Repetitions → 调正式
 * Production Pipeline → 收集 runId → 读 Run 结果 → 聚合指标 → 持久化结果。
 *
 * 三条硬规矩，缺一条这个模块就不该存在：
 *
 *   1. **不复制 Pipeline**（TASK §21）。生成路径只有一条：组合根交进来的
 *      `generate` 工厂（生产实现就是 Application 的 buildPipeline）。这里没有
 *      benchmarkGenerationPipeline，也不自己拼引擎流程。
 *   2. **每个样本都是普通 Run**（TASK §22）。有自己的 run_id、自己的产物目录、
 *      自己的 run-manifest.json / telemetry.json / failure-analysis.json /
 *      quality-stack.json，区别只在 Manifest 上多一个 benchmark 出身块。
 *   3. **预检全部发生在任何 LLM 请求之前**（TASK §40/§46）。Suite 不合法、
 *      骨架引用不存在、提示词版本缺失、模型没配、样本数超过上限——这些都让
 *      执行在第一个请求之前就失败，一次付费调用都不发生。
 *
 * 另外两件它刻意不做的事：单个样本失败不中止其余样本（§45），以及跑完之后
 * **什么都不改**——默认模型、提示词、温度、RetryPolicy、RepairPolicy 一个都不动
 * （§81）。Benchmark 只测量，不控制。
 *
 * 环境相关的东西（新执行 id、摘要、版本号、commit）一律从 `BenchmarkEnvironment`
 * 取，由组合根注入：Analysis 不读时钟以外的环境、不读文件、不 import
 * Infrastructure（§39/§72 的依赖方向测试守护这条线）。
 */

import type { PipelineComponents, PipelineFactory } from "@/engine/pipeline-components";
import { missingPipelineFactory } from "@/engine/pipeline-components";
import { failureSummaryOf } from "@/domain/errors";
import {
  BENCHMARK_RUN_LIMIT,
  BenchmarkStateError,
  BenchmarkValidationError,
  benchmarkSampleCount,
  benchmarkSuiteOf,
  fixedBeatPlanRefs,
  type BenchmarkProtocol,
  type BenchmarkSuite,
} from "@/domain/benchmark-suite";
import { benchmarkMetricKeys, emptyMetricValues } from "@/domain/benchmark-metric";
import {
  BENCHMARK_EXECUTION_SCHEMA_VERSION,
  isBenchmarkId,
  type BenchmarkExecution,
  type BenchmarkExecutionSnapshot,
  type BenchmarkExecutionStatus,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import type { ArtifactStore } from "@/ports/artifact-store";
import type { BenchmarkExecutionRepository, BenchmarkSuiteRepository } from "@/ports/benchmark-store";
import type { ProviderProbe } from "@/ports/provider-probe";
import type { Logger } from "@/ports/logger";
import { aggregateBenchmark, expandBenchmarkSamples } from "@/analysis/benchmark-aggregator";
import { benchmarkSampleMetrics } from "@/analysis/benchmark-metrics";

/**
 * Runner 需要的环境事实。全部由组合根注入，便于测试替换，也避免 Analysis
 * 反向依赖 Infrastructure。
 */
export interface BenchmarkEnvironment {
  /** 新执行 id：实现保证它是合法目录名。 */
  newBenchmarkId(): string;
  suiteDigest(suite: BenchmarkSuite): string;
  protocolDigest(protocol: BenchmarkProtocol): string;
  /** StoryLoop 版本（VERSION 文件是唯一真源）。 */
  projectVersion(): string;
  /** 部署环境注入了 commit 才有，否则 null。 */
  commit(): string | null;
}

/**
 * Benchmark 执行依赖。
 *
 * 与实验执行器的依赖同构，换掉的只有存储：实验存 definition/runs/results，
 * Benchmark 存 Suite 与执行三件套。baseUrl 同样刻意不在其中——一条样本的地址
 * 永远来自服务端 LLM_BASE_URL，每一条样本都照过一次 SSRF 关卡。
 */
export interface BenchmarkRunnerDeps extends PipelineComponents {
  artifactStore: ArtifactStore;
  benchmarkStore: BenchmarkSuiteRepository & BenchmarkExecutionRepository;
  environment: BenchmarkEnvironment;
  /** 服务端凭据探针：没注入 llm 时才问它；没注入探针按「没配」算（fail-closed）。 */
  providerProbe?: ProviderProbe;
  /** 提示词登记检查：返回还缺哪些提示词文件。由组合根注入（Analysis 不读盘）。 */
  promptProbe?: () => string[];
  logger: Logger;
  /** 生成路径工厂；缺省抛错，不自己拼一条别的路。 */
  generate?: PipelineFactory;
}

export interface BenchmarkRunOptions {
  /** 执行说明（例如「2.3.0 发布前基线」）。纯粹是标签，不参与任何判定（§94）。 */
  label?: string | null;
  /** §42 样本数超过安全线时的显式确认。不给就在预检里拒绝，不烧钱。 */
  allowLargeBenchmark?: boolean;
}

/** §44 整体状态：全成 → completed；有成有败 → partial；全败 → failed。 */
function statusOf(samples: BenchmarkSampleResult[]): BenchmarkExecutionStatus {
  const completed = samples.filter((sample) => sample.status === "completed").length;
  const failed = samples.length - completed;
  if (samples.length === 0) return "failed";
  if (failed === 0) return "completed";
  if (completed === 0) return "failed";
  return "partial";
}

export class BenchmarkRunner {
  constructor(private readonly deps: BenchmarkRunnerDeps) {}

  /**
   * §40 预检：任何 LLM 请求之前必须全部成立的几件事。
   *
   * 顺序有含义：先查数据（Suite / 骨架），再查环境（提示词 / 模型），最后查规模
   * （样本数）——数据错了不该去问模型，规模超了不该开始跑。
   */
  preflight(suite: BenchmarkSuite, options: BenchmarkRunOptions): { plannedSamples: number } {
    // 1. Suite 读回来再校验一次：磁盘上的文件可能被手改坏
    const checked = benchmarkSuiteOf(JSON.parse(JSON.stringify(suite)), benchmarkMetricKeys());
    if (checked === null) {
      throw new BenchmarkValidationError("Suite 读回来校验不过，拒绝执行");
    }
    // 2. case id 唯一（校验器已经查过，这里是显式的第二道，防的是并发改文件）
    const ids = new Set(checked.cases.map((item) => item.id));
    if (ids.size !== checked.cases.length) {
      throw new BenchmarkValidationError("Suite 里有重复的 case id");
    }
    // 3. 固定骨架必须真的存在
    for (const ref of fixedBeatPlanRefs(checked)) {
      const plan = this.deps.benchmarkStore.readBeatPlan(checked.id, checked.version, ref.ref);
      if (plan === null) {
        throw new BenchmarkValidationError(
          `Case ${ref.caseId} 的固定骨架 ${ref.ref} 不存在或不是合法 BeatPlan`,
        );
      }
    }
    // 4. 提示词版本必须齐
    const missing = this.deps.promptProbe?.() ?? [];
    if (missing.length > 0) {
      throw new BenchmarkValidationError(`提示词登记不完整：缺 ${missing.join(" / ")}`);
    }
    // 5. 模型配置：没注入客户端时，只有服务端真配了凭据才放行
    if (!this.deps.llm && !(this.deps.providerProbe?.() ?? false)) {
      throw new BenchmarkValidationError(
        "LLM_API_KEY 未配置：一个样本都跑不了。请在服务端环境变量里配好再跑（Benchmark 不接受地址与密钥覆盖）",
      );
    }
    // 6. 规模：cases × repetitions 必须在上限之内
    const plannedSamples = benchmarkSampleCount(checked);
    if (plannedSamples > BENCHMARK_RUN_LIMIT.hard) {
      throw new BenchmarkStateError(
        `这次执行要跑 ${plannedSamples} 个样本，超过硬上限 ${BENCHMARK_RUN_LIMIT.hard}；` +
          "请减少 repetitions 或拆成多份 Suite",
      );
    }
    if (plannedSamples > BENCHMARK_RUN_LIMIT.confirmAbove && options.allowLargeBenchmark !== true) {
      throw new BenchmarkStateError(
        `这次执行要跑 ${plannedSamples} 个样本（超过 ${BENCHMARK_RUN_LIMIT.confirmAbove} 的安全线）：` +
          "请在请求里显式确认 allowLargeBenchmark 再跑",
      );
    }
    return { plannedSamples };
  }

  /**
   * 跑完一次执行并落盘三件套（execution.json / samples.json / aggregate.json）。
   *
   * 每一条样本跑完就写一次盘：中途进程被杀，磁盘上也已经留下「前几条样本跑出了
   * 哪些 runId、失败在哪一步」，GET 能如实显示 running 与 partial，而不是一片空白。
   */
  async run(suite: BenchmarkSuite, options: BenchmarkRunOptions = {}): Promise<BenchmarkExecution> {
    const checked = benchmarkSuiteOf(JSON.parse(JSON.stringify(suite)), benchmarkMetricKeys());
    if (checked === null) {
      throw new BenchmarkValidationError("Suite 读回来校验不过，拒绝执行");
    }
    const { plannedSamples } = this.preflight(checked, options);

    const benchmarkId = this.deps.environment.newBenchmarkId();
    const snapshot: BenchmarkExecutionSnapshot = {
      suiteId: checked.id,
      suiteVersion: checked.version,
      suiteDigest: this.deps.environment.suiteDigest(checked),
      protocol: checked.protocol,
      protocolDigest: this.deps.environment.protocolDigest(checked.protocol),
      projectVersion: this.deps.environment.projectVersion(),
      commit: this.deps.environment.commit(),
      models: null,
      prompts: null,
      parameters: null,
      caseIds: checked.cases.map((item) => item.id),
      repetitions: checked.protocol.repetitions,
      plannedSamples,
      label: options.label?.trim() ? options.label.trim() : null,
      startedAt: new Date().toISOString(),
    };

    const samples: BenchmarkSampleResult[] = [];
    let execution: BenchmarkExecution = {
      schemaVersion: BENCHMARK_EXECUTION_SCHEMA_VERSION,
      id: benchmarkId,
      suiteId: checked.id,
      suiteVersion: checked.version,
      status: "running",
      snapshot,
      samples: [],
      aggregate: null,
      startedAt: snapshot.startedAt,
      completedAt: null,
    };
    this.deps.benchmarkStore.putExecution(execution);
    this.deps.logger.info(`benchmark ${benchmarkId} started（${plannedSamples} samples）`);

    const plans = expandBenchmarkSamples(snapshot);
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      const sample = await this.runOne(plan.caseId, plan.repetition, checked, benchmarkId, snapshot);
      samples.push(sample);
      // 快照里的模型 / 提示词 / 参数在第一条跑出 runId 的样本落地后补上：
      // 记的是那条样本 Manifest 里已经写下的事实，不是服务端的当前设置（§19）
      if (snapshot.models === null && sample.runId !== null) {
        patchSnapshotFromRun(snapshot, sample.runId, this.deps.artifactStore);
      }
      this.deps.benchmarkStore.putSamples(benchmarkId, samples);
      this.deps.logger.info(
        `benchmark ${benchmarkId} sample ${i + 1}/${plans.length} ` +
          `${plan.caseId}#${plan.repetition} → ${sample.status}`,
      );
    }

    const aggregate = aggregateBenchmark(samples, checked, this.deps.artifactStore);
    this.deps.benchmarkStore.putAggregate(benchmarkId, aggregate);
    execution = {
      ...execution,
      snapshot,
      samples,
      aggregate,
      status: statusOf(samples),
      completedAt: new Date().toISOString(),
    };
    // 终态最后写：一旦这份 execution.json 落到终态，存储层就拒绝再改（§37）
    this.deps.benchmarkStore.putExecution(execution);
    this.deps.logger.info(`benchmark ${benchmarkId} finished（${execution.status}）`);
    return execution;
  }

  /**
   * 跑一个样本。
   *
   * fixed 模式走 runWithPlan（这份题用 Suite 里那一份骨架），regenerate 模式走 run
   * （每个样本自己过 Planner）。两条路都把 benchmark 出身带进 Manifest。
   */
  private async runOne(
    caseId: string,
    repetition: number,
    suite: BenchmarkSuite,
    benchmarkId: string,
    snapshot: BenchmarkExecutionSnapshot,
  ): Promise<BenchmarkSampleResult> {
    const item = suite.cases.find((entry) => entry.id === caseId);
    const startedAt = new Date().toISOString();
    const failed = (failure: string, runId: string | null = null): BenchmarkSampleResult => ({
      caseId,
      repetition,
      runId,
      status: "failed",
      metrics: emptyMetricValues(),
      failure,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    if (item === undefined) return failed(`Suite 里没有 case ${caseId}`);

    const provenance = {
      benchmarkId,
      suiteId: suite.id,
      suiteVersion: suite.version,
      suiteDigest: snapshot.suiteDigest,
      caseId,
      repetition,
    };

    try {
      // 每个样本单独建一条 Pipeline：与实验执行器同一套理由（模型是烤进客户端的）。
      // runtime 传空对象——Benchmark 不覆盖模型、温度与地址，测的就是服务端当下
      // 这一套配置（§81：跑完也不会改它）。
      const generate = this.deps.generate ?? missingPipelineFactory;
      const pipeline = await generate({}, this.deps);
      let runId: string;
      if (item.beatPlanMode === "fixed") {
        const plan = this.deps.benchmarkStore.readBeatPlan(suite.id, suite.version, item.beatPlanRef ?? "");
        if (plan === null) return failed(`Case ${caseId} 的固定骨架读不回来`);
        const result = await pipeline.runWithPlan(
          item.storyConfig,
          plan,
          {},
          undefined,
          undefined,
          undefined,
          provenance,
        );
        runId = result.run_id;
      } else {
        const result = await pipeline.run(item.storyConfig, {}, undefined, undefined, undefined, provenance);
        runId = result.run_id;
      }
      return {
        caseId,
        repetition,
        runId,
        status: "completed",
        metrics: benchmarkSampleMetrics(runId, this.deps.artifactStore),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (e) {
      const err = failureSummaryOf(e);
      this.deps.logger.warning(
        `benchmark ${benchmarkId} sample ${caseId}#${repetition} failed（${err.code}）: ${err.message}`,
      );
      return failed(`${err.stage ?? "unknown"}: ${err.message}`, err.runId);
    }
  }
}

/**
 * §19 从第一条跑出 runId 的样本的 Manifest 里取模型 / 提示词 / 参数快照。
 *
 * Benchmark 不信「当前配置」：这三个块写的是那次运行**真的**跑在什么上面。
 * 读不到（这条样本没有 Manifest）就保持 null，不会拿服务端设置冒充实况。
 */
function patchSnapshotFromRun(
  snapshot: BenchmarkExecutionSnapshot,
  runId: string,
  store: ArtifactStore,
): void {
  const manifest = store.readRunManifest(runId);
  if (manifest === null) return;
  snapshot.models = manifest.models;
  snapshot.prompts = manifest.prompts;
  snapshot.parameters = manifest.parameters;
  snapshot.projectVersion = manifest.project.version;
  if (manifest.project.commit !== undefined) snapshot.commit = manifest.project.commit;
}

/** 便捷入口：存储与生成路径都由调用方交进来（预检在 run 里做，服务层再包一层锁）。 */
export async function runBenchmark(
  suite: BenchmarkSuite,
  deps: BenchmarkRunnerDeps,
  options: BenchmarkRunOptions = {},
): Promise<BenchmarkExecution> {
  return new BenchmarkRunner(deps).run(suite, options);
}

/** 供测试与调试：一个 id 合不合法（路由参数先用它挡一道）。 */
export function benchmarkIdLooksValid(value: unknown): value is string {
  return isBenchmarkId(value);
}
