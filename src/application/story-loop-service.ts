/**
 * v2.0.0 公共服务门面（TASK §17）。
 *
 * 一个版本对外只暴露真实存在的能力，因此这份门面是把既有的用例**逐个绑到一份
 * 依赖上**，自己是纯转发：不写分支、不读环境变量、不 import Infrastructure。
 * 需要改行为时改用例，不需要在门面上叠第二套逻辑——否则门面会变成 God Object
 * （§17 明确禁止），两份逻辑也一定会 diverged。
 *
 * §16 里的依赖由组合根（src/composition）装配好再交进来：Interface（API 路由 /
 * CLI / UI 数据层）拿到的就是这个对象，不自己 new 任何引擎部件或存储实现。
 */

import {
  getRun,
  getRunAttempt,
  getRunFailureAnalysis,
  getRunQualityStack,
  getRunTelemetry,
  planStory,
  previewPrompt,
  repairStory,
  reviewStory,
  reviewStoryCommercial,
  startRun,
  startRunFromPlan,
  validateStory,
  validateStoryBeats,
  type RunResult,
  type ReviewOutcome,
  type CommercialReviewOutcome,
  type ValidationOutcome,
  type BeatValidationOutcome,
  type RepairOutcome,
  type RunLookupResult,
  type AttemptLookupResult,
  type RunTelemetryLookupResult,
  type RunFailureAnalysisLookupResult,
  type RunQualityStackLookupResult,
  type RunDeps,
} from "@/application/generate-service";
import {
  createExperiment,
  getExperiment,
  listExperiments,
  runExperimentById,
  type ExperimentCaseDeps,
  type ExperimentDetail,
  type ExperimentListItem,
} from "@/application/experiment-use-cases";
import type { BeatPlan } from "@/domain/beat-plan";
import { projectVersion } from "@/infrastructure/config/version";
import type { ApiErrorBody } from "@/application/error-model";
import type { ExperimentDefinition, ExperimentResult } from "@/domain/experiment";

/** 用例返回的内联形状在这里命名一次，门面签名就不必重复它的展开。 */
export type PlanOutcome = { status: number; json: BeatPlan | ApiErrorBody };
export type PromptPreviewOutcome = { status: number; json: { prompt: string } | ApiErrorBody };

/**
 * 门面的全部依赖（§14）。
 *
 * 两个袋子分开：`run` 是生成路径的可注入部件（§5），`experiment` 是实验用例的
 * 依赖（含生成路径工厂，§30）。组合根负责把 Infrastructure 的实现放进去；
 * 不传就是用例自己按服务端配置取默认值（与 v1.9 行为一致）。
 */
export interface StoryLoopDependencies {
  run?: RunDeps;
  experiment?: ExperimentCaseDeps;
}

/** §17 公共服务门面。方法名与既有用例一一对应，不新造语义。 */
export interface StoryLoopService {
  /** 版本号：唯一真源是仓库 VERSION 文件（§42/§43），接口层不再自己去读文件。 */
  version(): string;
  /** StoryConfig → BeatPlan（只规划，不生成正文）。 */
  plan(body: unknown): Promise<PlanOutcome>;
  /** StoryConfig → 完整 Run（Automatic）。 */
  generate(body: unknown): Promise<RunResult>;
  /** config + beat_plan → 完整 Run（Manual）。 */
  generateFromPlan(body: unknown): Promise<RunResult>;
  /** 只渲染将要发给模型的正文提示词，不调模型。 */
  previewPrompt(body: unknown): Promise<PromptPreviewOutcome>;
  /** 对正文跑硬性规则。 */
  validate(body: unknown): Promise<ValidationOutcome>;
  /** 对 BeatPlan 跑结构规则。 */
  validateBeats(body: unknown): Promise<BeatValidationOutcome>;
  /** 对正文做质量审阅。 */
  review(body: unknown): Promise<ReviewOutcome>;
  /** 对正文做商业可读性审阅。 */
  reviewCommercial(body: unknown): Promise<CommercialReviewOutcome>;
  /** 对正文做一次定点修订。 */
  repair(body: unknown): Promise<RepairOutcome>;
  /** 建一份实验定义（先建，不跑）。 */
  createExperiment(body: unknown): Promise<ExperimentDefinition>;
  /** 实验列表（摘要 + 结果状态）。 */
  listExperiments(): Promise<ExperimentListItem[]>;
  /** 一份实验的定义、格子与结果。 */
  getExperiment(experimentId: string): Promise<ExperimentDetail>;
  /** 把一份实验跑完。 */
  runExperiment(experimentId: string): Promise<ExperimentResult>;
  /** 一条 Run 的详情。 */
  getRun(runId: string): Promise<RunLookupResult>;
  /** 一条 Run 的某一次 Attempt（attempt_number 路由上是字符串，原样交给用例校验）。 */
  getRunAttempt(runId: string, attemptNumber: number | string): Promise<AttemptLookupResult>;
  /** 一条 Run 的遥测。 */
  getRunTelemetry(runId: string): Promise<RunTelemetryLookupResult>;
  /** 一条 Run 的失败分析。 */
  getRunFailureAnalysis(runId: string): Promise<RunFailureAnalysisLookupResult>;
  /** v2.1.0 TASK §33 一条 Run 的统一质量视图（Quality Center 的数据源）。 */
  getRunQualityStack(runId: string): Promise<RunQualityStackLookupResult>;
}

/** 把绑定好的门面交出去。deps 省略时各用例按服务端配置自行取默认值（§16）。 */
export function createStoryLoopService(deps: StoryLoopDependencies = {}): StoryLoopService {
  const run: RunDeps = deps.run ?? {};
  // 实验用例收 Partial：这里给不给都由 experiment-use-cases 补默认存储（§14）
  const experiment: ExperimentCaseDeps = deps.experiment ?? {};
  return {
    version: () => projectVersion(),
    plan: (body) => planStory(body, run.llm, run.planner),
    generate: (body) => startRun(body, run),
    generateFromPlan: (body) => startRunFromPlan(body, run),
    previewPrompt: (body) => previewPrompt(body, run.generator),
    validate: (body) => validateStory(body, run),
    validateBeats: (body) => validateStoryBeats(body, run),
    review: (body) => reviewStory(body, run),
    reviewCommercial: (body) => reviewStoryCommercial(body, run),
    repair: (body) => repairStory(body, run),
    createExperiment: (body) => createExperiment(body, experiment),
    listExperiments: () => listExperiments(experiment),
    getExperiment: (experimentId) => getExperiment(experimentId, experiment),
    runExperiment: (experimentId) => runExperimentById(experimentId, experiment),
    getRun: (runId) => getRun(runId, run.artifactStore),
    getRunAttempt: (runId, attemptNumber) => getRunAttempt(runId, attemptNumber, run.artifactStore),
    getRunTelemetry: (runId) => getRunTelemetry(runId, run.artifactStore),
    getRunFailureAnalysis: (runId) => getRunFailureAnalysis(runId, run.artifactStore),
    getRunQualityStack: (runId) => getRunQualityStack(runId, run.artifactStore),
  };
}
