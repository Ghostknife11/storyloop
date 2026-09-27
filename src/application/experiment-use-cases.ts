/**
 * v2.0.0 实验用例（Application）。
 *
 * §30 实验执行必须走正式生成路径，§37 API 路由只做「解析输入 / 调用用例 /
 * 映射结果」，§72 不许 Analysis import Application。所以「把正式生成路径交到
 * Analysis 手上」这一步落在 Application：这里把 generate 工厂注入实验服务，
 * Analysis 只按收到的部件跑，不自己 import 生成组装配线。
 *
 * 同理，Analysis 也不 new 存储、不读环境变量（§43/§33）：两个存储与凭据探针
 * 的默认实现都在这一层补，调用方给的部件优先。四个用例与 v1.7.0 的
 * analysis/experiment-service 同名同签名，测试照样可以注入自己的假 LLM、
 * 自己的工厂和自己的临时目录。
 */

import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { ExperimentStore } from "@/infrastructure/storage/experiment-store";
import { providerConfigured } from "@/infrastructure/health/health-probe";
import { logger } from "@/infrastructure/logging/logger";
import { appSettings } from "@/infrastructure/config/app-config";
import { buildPipeline } from "@/application/generate-service";
import {
  createExperiment as createExperimentRecord,
  getExperiment as readExperiment,
  listExperiments as listExperimentRecords,
  runExperimentById as runExperimentRecord,
} from "@/analysis/experiment-service";
import type {
  ExperimentDeps,
  ExperimentDetail,
  ExperimentListItem,
} from "@/analysis/experiment-service";
import type { ExperimentDefinition, ExperimentResult } from "@/domain/experiment";
import type { Logger } from "@/ports/logger";

export type { ExperimentDeps, ExperimentDetail, ExperimentListItem };

/** 用例入口收的依赖：可以什么都不给（全部走默认），也可以逐项替换成测试替身。 */
export type ExperimentCaseDeps = Partial<ExperimentDeps>;

/**
 * 用例要用的依赖：调用方给的部件优先，缺省补上正式生成路径、默认存储与
 * 服务端凭据探针。
 *
 * 逐项合并而不是整对象展开覆盖：`{ generate: buildPipeline, ...deps }` 一旦遇到
 * 调用方显式传 undefined 就会把正式路径又抹掉，那种对象不值得保留。
 */
function withStorage(deps: ExperimentCaseDeps): ExperimentDeps {
  const runsRoot = appSettings().runsDir;
  return {
    ...deps,
    artifactStore: deps.artifactStore ?? new ArtifactStore(runsRoot),
    experimentStore: deps.experimentStore ?? new ExperimentStore(runsRoot),
    providerProbe: deps.providerProbe ?? providerConfigured,
    logger: deps.logger ?? logger,
    generate: deps.generate ?? buildPipeline,
  };
}

/**
 * 用例统一记失败日志：堆栈只进服务端日志，响应里只有 code 与一句话。
 *
 * 放在这一层而不是路由里：路由只做「解析 / 调用 / 映射」（§37），十几个路由各写
 * 一遍 logger 就等于把 Infrastructure 的 import 撒得到处都是。
 */
async function logged<T>(logger: Logger, what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    logger.error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, e);
    throw e;
  }
}

/** POST /api/experiments：建一份实验定义（先建，不跑）。 */
export async function createExperiment(body: unknown, deps: ExperimentCaseDeps = {}): Promise<ExperimentDefinition> {
  const merged = withStorage(deps);
  return logged(merged.logger, "create experiment", () => createExperimentRecord(body, merged));
}

/** GET /api/experiments：列表只给定义摘要与结果状态，不带任何样本详情。 */
export async function listExperiments(deps: ExperimentCaseDeps = {}): Promise<ExperimentListItem[]> {
  return listExperimentRecords(withStorage(deps));
}

/** GET /api/experiments/<experiment_id>：定义 + 跑出来的格子 + 结果。 */
export async function getExperiment(experimentId: string, deps: ExperimentCaseDeps = {}): Promise<ExperimentDetail> {
  return readExperiment(experimentId, withStorage(deps));
}

/** POST /api/experiments/<experiment_id>/run：预检通过就跑完整个实验。 */
export async function runExperimentById(experimentId: string, deps: ExperimentCaseDeps = {}): Promise<ExperimentResult> {
  const merged = withStorage(deps);
  return logged(merged.logger, `run experiment ${experimentId}`, () => runExperimentRecord(experimentId, merged));
}
