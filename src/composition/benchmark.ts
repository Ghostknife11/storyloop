/**
 * v2.3.0 组合根——Benchmark 半边（TASK §33/§34/§35/§83）。
 *
 * 和 generate 半边共用同一个组合根入口（index.ts 的 `benchmark` 依赖袋），
 * 但给路由的是这里这个门面：路由只需要「列 Suite / 读 Suite / 跑执行 / 读执行 /
 * 列执行 / 比历史 / 导出」七个动作，看不到 BenchmarkStore、看不到 Pipeline 部件、
 * 也看不到凭据探针（§37：路由只做解析输入、调用用例、映射结果）。
 *
 * 为什么不吃 workspace 那一套「单独一个 composition 文件」的待遇：工作区拆开是为了
 * 让只读写 projects/ 的路由的依赖图里一个 HTTP 客户端都不出现。Benchmark 的
 * 路由反过来——它必须真的发起生成（POST /executions 就是花真钱跑样本），所以它
 * 本来就该在这张依赖图里。硬拆只会得到两个都要维护的半边。
 *
 * 每次调用重新解析环境与目录（不在模块级缓存）：RUNS_DIR 是运维旋钮，测试 chdir
 * 进临时目录后必须立刻生效——与生成半边同一条约定。
 */

import { appSettings } from "@/infrastructure/config/app-config";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { BenchmarkStore } from "@/infrastructure/storage/benchmark-store";
import { benchmarkEnvironment } from "@/infrastructure/tracking/benchmark-environment";
import { missingPromptRoles } from "@/infrastructure/tracking/prompt-registry";
import { providerConfigured } from "@/infrastructure/health/health-probe";
import { buildPipeline } from "@/application/generate-service";
import {
  benchmarkHistory,
  exportBenchmarkResult,
  getBenchmarkExecution,
  getBenchmarkSuite,
  listBenchmarkExecutions,
  listBenchmarkSuites,
  runBenchmark,
  setBenchmarkBaseline,
  type BenchmarkCaseDeps,
  type BenchmarkExecutionDetail,
  type BenchmarkExecutionListItem,
  type BenchmarkExportOutcome,
  type BenchmarkHistoryPoint,
} from "@/application/benchmark-use-cases";
import type { BenchmarkSuite } from "@/domain/benchmark-suite";
import type { BenchmarkExecution } from "@/domain/benchmark-result";
import type { BenchmarkSuiteSummary } from "@/ports/benchmark-store";
import type { ArtifactStore as ArtifactStorePort } from "@/ports/artifact-store";
import type { BenchmarkEnvironment } from "@/analysis/benchmark-runner";
import type { PipelineFactory } from "@/engine/pipeline-components";
import type { LLMClient } from "@/ports/llm-client";
import type { ProviderProbe } from "@/ports/provider-probe";

export interface BenchmarkOptions {
  runsDir?: string;
  /** Suite 与执行可以分开给（测试）；生产用同一个 BenchmarkStore。 */
  suiteStore?: BenchmarkStore;
  executionStore?: BenchmarkStore;
  artifactStore?: ArtifactStorePort;
  /** 测试替身 / CLI 自带的模型客户端；缺省按服务端配置现建。 */
  llm?: LLMClient;
  /** 生成路径工厂：生产是 buildPipeline，测试可以换成假的（§21 不许自己拼）。 */
  generate?: PipelineFactory;
  environment?: BenchmarkEnvironment;
  providerProbe?: ProviderProbe;
}

/** 装配结果：一个依赖袋（给 CLI 与测试），路由只用 createBenchmarkCases。 */
export interface BenchmarkBundle {
  runsDir: string;
  deps: BenchmarkCaseDeps;
}

export function createBenchmarkBundle(options: BenchmarkOptions = {}): BenchmarkBundle {
  const runsDir = options.runsDir?.trim() || appSettings().runsDir;
  const artifactStore = options.artifactStore ?? new ArtifactStore(runsDir);
  const suiteStore = options.suiteStore ?? new BenchmarkStore(runsDir);
  const executionStore = options.executionStore ?? suiteStore;
  return {
    runsDir,
    deps: {
      suites: suiteStore,
      executions: executionStore,
      benchmarkStore: suiteStore,
      artifactStore,
      environment: options.environment ?? benchmarkEnvironment(),
      providerProbe: options.providerProbe ?? providerConfigured,
      promptProbe: missingPromptRoles,
      generate: options.generate ?? buildPipeline,
      ...(options.llm ? { llm: options.llm } : {}),
    },
  };
}

/** Benchmark 用例门面。每个方法都是现取依赖、现调用——组合根不缓存实例。 */
export interface BenchmarkCases {
  deps: BenchmarkBundle;
  listSuites(): Promise<BenchmarkSuiteSummary[]>;
  getSuite(suiteId: string, suiteVersion?: string): Promise<BenchmarkSuite>;
  run(raw: unknown): Promise<BenchmarkExecution>;
  listExecutions(): Promise<BenchmarkExecutionListItem[]>;
  getExecution(benchmarkId: string, compareWith?: string | null): Promise<BenchmarkExecutionDetail>;
  history(suiteId?: string): Promise<BenchmarkHistoryPoint[]>;
  export(benchmarkId: string, format: string): Promise<BenchmarkExportOutcome>;
  setBaseline(benchmarkId: string, isBaseline: boolean): boolean;
}

export function createBenchmarkCases(options: BenchmarkOptions = {}): BenchmarkCases {
  const bundle = createBenchmarkBundle(options);
  const d = bundle.deps;
  return {
    deps: bundle,
    listSuites: () => listBenchmarkSuites(d),
    getSuite: (suiteId, suiteVersion) => getBenchmarkSuite(suiteId, d, suiteVersion),
    run: (raw) => runBenchmark(raw, d),
    listExecutions: () => listBenchmarkExecutions(d),
    getExecution: (benchmarkId, compareWith) => getBenchmarkExecution(benchmarkId, d, { compareWith }),
    history: (suiteId) => benchmarkHistory(suiteId, d),
    export: (benchmarkId, format) => exportBenchmarkResult(benchmarkId, format, d),
    setBaseline: (benchmarkId, isBaseline) => setBenchmarkBaseline(benchmarkId, isBaseline),
  };
}
