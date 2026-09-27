/**
 * v2.0.0 组合根（TASK §14/§34）——生成管线半边。
 *
 * 这是全仓唯一「new 出具体实现」的地方：FileArtifactStore、ExperimentStore、
 * 以及按请求现建的模型客户端，都只在这里落地；用例、门面、路由、CLI 拿到的
 * 都是已经装好的依赖（§16），因此 Interface 里看不见 new StoryGenerator()。
 *
 * §34 的用法就是本文件这三个导出：
 *   const deps = createDependencies(config);
 *   const app  = createStoryLoopApplication(deps);
 *   await app.service.generate(body);
 *
 * 每次调用都重新解析一次环境与目录（不在模块级缓存）：RUNS_DIR / LLM_* 是服务端
 * 运维旋钮，测试 chdir 进临时目录后也必须立刻生效——这是 v1.x 起就守住的约定，
 * 组合根不能把它改回 import 时求值。
 *
 * Workspace 那半边（项目 / 稿件 / 导出 / 健康）在 ./workspace.ts，并由这里转出去，
 * 好让只读写 projects/ 的路由直接 import 它：那条路的依赖图里一个 HTTP 客户端都
 * 不该有（详见 ./workspace.ts 的说明与 test_workspace_network_boundary）。
 */

import {
  createStoryLoopService,
  type StoryLoopDependencies,
  type StoryLoopService,
} from "@/application/story-loop-service";
import { assembleHealthReport, type HealthReport } from "@/application/health";
import { buildPipeline } from "@/application/generate-service";
import { appSettings } from "@/infrastructure/config/app-config";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { ExperimentStore } from "@/infrastructure/storage/experiment-store";
import { healthProbes, providerConfigured } from "@/infrastructure/health/health-probe";
import type { ArtifactStore as ArtifactStorePort } from "@/ports/artifact-store";
import type { LLMClient } from "@/ports/llm-client";
import type { PipelineFactory } from "@/engine/pipeline-components";

// Workspace 半边就在这里转出去（实现在 ./workspace.ts）。路由请直接 import
// "@/composition/workspace"：绕回本文件，就又把模型客户端拉回它的依赖图里了。
export {
  createWorkspace,
  createWorkspaceBundle,
  type WorkspaceBundle,
  type WorkspaceCases,
  type WorkspaceOptions,
} from "./workspace";

/** 组合根的入参：全部可选，缺省值一律来自服务端配置（§33 只在这里读）。 */
export interface StoryLoopOptions {
  /** 产物根目录；缺省取 RUNS_DIR 或仓库下的 runs/。 */
  runsDir?: string;
  /** 调用方自带的模型客户端（测试替身 / CLI / 嵌入方）。
   *  缺省时由用例按请求体与服务端环境现建，URL 关卡照旧生效（§24）。 */
  llm?: LLMClient;
  artifactStore?: ArtifactStorePort;
  experimentStore?: ExperimentStore;
}

/** 装好的依赖：两个袋子的部件 + 两个存储实例（实例只为渲染与探测留一份）。 */
export interface StoryLoopDependenciesBundle extends StoryLoopDependencies {
  runsDir: string;
  artifactStore: ArtifactStorePort;
  experimentStore: ExperimentStore;
}

/** §14 第一步：把 Infrastructure 的实现装配成用例可用的依赖。 */
export function createDependencies(options: StoryLoopOptions = {}): StoryLoopDependenciesBundle {
  const runsDir = options.runsDir?.trim() || appSettings().runsDir;
  const artifactStore = options.artifactStore ?? new ArtifactStore(runsDir);
  const experimentStore = options.experimentStore ?? new ExperimentStore(runsDir);
  const shared = options.llm ? { llm: options.llm } : {};
  return {
    runsDir,
    artifactStore,
    experimentStore,
    run: { ...shared, artifactStore },
    // §30：实验与普通 Run 走同一条正式生成路径，这里由组合根把它交到实验用例手上；
    // 凭据探针同样在这里落地——分析层只问一句，自己不去摸环境变量（§33）
    experiment: { ...shared, artifactStore, experimentStore, generate: buildPipeline, providerProbe: providerConfigured },
  };
}

/** §14 第二步：把依赖绑成可用的应用（门面 + 健康）。 */
export interface StoryLoopApplication {
  /** §17 公共服务门面：API / CLI / UI 数据层只面向它。 */
  service: StoryLoopService;
  /** 原始依赖（CLI 渲染产物时要直接读存储的那条路）。 */
  deps: StoryLoopDependenciesBundle;
  /** §30 生成路径的唯一正式入口。 */
  generate: PipelineFactory;
  /** §46 健康与能力：真查出来的布尔，不带任何凭据。 */
  health(): HealthReport;
}

export function createStoryLoopApplication(
  deps: StoryLoopDependenciesBundle = createDependencies(),
): StoryLoopApplication {
  const service = createStoryLoopService(deps);
  const generate: PipelineFactory = deps.experiment?.generate ?? buildPipeline;
  return {
    service,
    deps,
    generate,
    health: () => assembleHealthReport(healthProbes(deps.runsDir)),
  };
}

/** 一步拿到装好的应用：路由与 CLI 的常规入口。 */
export function createStoryLoop(options: StoryLoopOptions = {}): StoryLoopApplication {
  return createStoryLoopApplication(createDependencies(options));
}

