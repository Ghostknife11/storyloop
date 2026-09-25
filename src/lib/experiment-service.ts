/**
 * v1.7.0 实验服务层：校验、落盘、执行、读回。
 *
 * 与 generate-service 的分工：那边管「一次 Run 怎么跑」，这边管「一组 Run
 * 怎么按同一个定义跑、跑完怎么摆出来」。生成路径只有一条（GenerationPipeline），
 * 实验只是把它同一个入口调用若干次。
 *
 * 前置判定全部发生在任何 LLM 请求之前（TASK §30/§31）：
 *   - 定义结构不合法 → 400 EXPERIMENT_INVALID，一个样本都不建；
 *   - id 已存在 → 409 EXPERIMENT_CONFLICT，定义不可变（TASK §34），要改就复制；
 *   - 实验已经跑过 → 409 EXPERIMENT_CONFLICT，重跑等于污染已经写下的结果；
 *   - 没配 LLM_API_KEY 又没注入客户端 → 400，省下 N 次必然失败的请求。
 *
 * API 响应用一个口径：definition / result 原样回传（camelCase），不另做一层
 * 字段映射。磁盘上是什么，接口就返回什么——多一层翻译就多一处会悄悄跑偏的地方。
 */

import { logger } from "@/lib/logger";
import { ArtifactStore } from "@/storage/artifact-store";
import { ExperimentStore } from "@/storage/experiment-store";
import { ExperimentRunner, type ExperimentRunnerDeps } from "@/core/experiment-runner";
import { appSettings } from "@/lib/app-config";
import {
  ExperimentNotFoundError,
  ExperimentStateError,
  ExperimentValidationError,
  validateExperimentDefinition,
  type ExperimentDefinition,
  type ExperimentResult,
  type ExperimentRunIndex,
} from "@/types/experiment";

export { ExperimentNotFoundError, ExperimentStateError, ExperimentValidationError };

export type ExperimentDeps = ExperimentRunnerDeps;

/** 默认依赖：runs/ 与 experiments/ 都由 RUNS_DIR 推导。 */
function storeOf(deps: ExperimentDeps): ExperimentStore {
  return deps.experimentStore ?? new ExperimentStore(appSettings().runsDir);
}

function artifactStoreOf(deps: ExperimentDeps): ArtifactStore {
  return deps.artifactStore ?? new ArtifactStore(appSettings().runsDir);
}

/**
 * §30 预检：开跑之前必须成立的几件事。
 * 返回 null 表示可以跑；抛异常表示不行（错误码由 ApiError 映射成 4xx）。
 */
function preflight(experimentId: string, deps: ExperimentDeps): void {
  const store = storeOf(deps);
  const definition = store.readDefinition(experimentId);
  if (definition === null) {
    throw new ExperimentNotFoundError(`实验 ${experimentId} 不存在`);
  }
  const existing = store.readResults(experimentId);
  if (existing !== null) {
    // 定义不可变、结果也不可变：同一份条件的第二次跑不能覆盖第一次写下的数字
    throw new ExperimentStateError(
      `实验 ${experimentId} 已经跑过（${existing.status}）；定义与结果都不可变，要改条件请复制成一个新实验`,
    );
  }
  if (!deps.llm) {
    const key = process.env.LLM_API_KEY;
    if (!key || !key.trim()) {
      throw new ExperimentValidationError(
        "LLM_API_KEY 未配置：一个样本都跑不了。请在服务端环境变量里配好再跑（实验不接受地址与密钥覆盖）",
      );
    }
  }
}

/**
 * POST /api/experiments 的服务层。
 * 校验通过立刻落盘 definition.json——先建再跑，中间那段时间实验已经是一个
 * 可以被 GET 读到的实体（状态 pending）。
 */
export async function createExperiment(body: unknown, deps: ExperimentDeps = {}): Promise<ExperimentDefinition> {
  const definition = validateExperimentDefinition(body);
  const store = storeOf(deps);
  if (store.exists(definition.experimentId)) {
    throw new ExperimentStateError(
      `实验 ${definition.experimentId} 已存在；定义不可变，要修改条件请换一个 experimentId 重新提交`,
    );
  }
  store.createExperimentDirectory(definition.experimentId);
  store.putDefinition(definition.experimentId, definition);
  logger.info(`experiment ${definition.experimentId} created`);
  return definition;
}

/** GET /api/experiments：列表只给定义摘要与结果状态，不带任何样本详情。 */
export interface ExperimentListItem {
  experimentId: string;
  name: string;
  description?: string;
  repetitions: number;
  variantCount: number;
  totalRuns: number;
  createdAt: string;
  status: ExperimentResult["status"] | "pending";
  completedAt?: string | null;
  /** 只给摘要数字（几个成功、几个失败），够列表页判断要不要点进去。 */
  successCount: number;
  failureCount: number;
}

export async function listExperiments(deps: ExperimentDeps = {}): Promise<ExperimentListItem[]> {
  const store = storeOf(deps);
  const items: ExperimentListItem[] = [];
  for (const id of store.listExperimentIds()) {
    const definition = store.readDefinition(id);
    if (definition === null) continue;
    const result = store.readResults(id);
    items.push({
      experimentId: definition.experimentId,
      name: definition.name,
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      repetitions: definition.repetitions,
      variantCount: definition.variants.length,
      totalRuns: definition.variants.length * definition.repetitions,
      createdAt: definition.createdAt,
      status: result?.status ?? "pending",
      ...(result?.completedAt !== undefined ? { completedAt: result.completedAt } : {}),
      successCount: result?.summary.successCount ?? 0,
      failureCount: result?.summary.failureCount ?? 0,
    });
  }
  // 新的在前：列表页第一眼应该看到最近建的那个实验
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** GET /api/experiments/<id>：定义 + 跑出来的格子 + 结果（没跑过就没有后两者）。 */
export interface ExperimentDetail {
  definition: ExperimentDefinition;
  runs: ExperimentRunIndex | null;
  result: ExperimentResult | null;
}

export async function getExperiment(experimentId: string, deps: ExperimentDeps = {}): Promise<ExperimentDetail> {
  const store = storeOf(deps);
  const definition = store.readDefinition(experimentId);
  if (definition === null) {
    throw new ExperimentNotFoundError(`实验 ${experimentId} 不存在`);
  }
  return {
    definition,
    runs: store.readRuns(experimentId),
    result: store.readResults(experimentId),
  };
}

/** POST /api/experiments/<id>/run：预检通过就跑完整个实验。 */
export async function runExperimentById(
  experimentId: string,
  deps: ExperimentDeps = {},
): Promise<ExperimentResult> {
  preflight(experimentId, deps);
  const store = storeOf(deps);
  const definition = store.readDefinition(experimentId);
  if (definition === null) {
    throw new ExperimentNotFoundError(`实验 ${experimentId} 不存在`);
  }
  const result = await new ExperimentRunner({ ...deps, experimentStore: store }).run(definition);
  logger.info(`experiment ${experimentId} finished (${result.status})`);
  return result;
}
