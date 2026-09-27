/**
 * v1.7.0 实验执行器：把一份定义跑成一组 Run，再落地成实验结果。
 *
 * 三条硬规矩：
 *   1. 复用 v1.6.0 的 GenerationPipeline，不写第二条生成路径。每个样本都是一次
 *      完完整整的普通 Run（有自己的 run_id、自己的产物目录、自己的 Manifest），
 *      区别只在 Manifest 上多一个 experiment 块说明它的出身。
 *   2. 顺序执行，不并发。样本顺序就是 runs.json / results.json 的顺序，
 *      也避免一次实验同时打出成倍的付费请求。
 *   3. 单个样本失败不中止实验（TASK §29）：剩下的样本接着跑，失败的格子记下
 *      失败阶段与一句话摘要，最后整体状态是 partial。
 *
 * 这个模块不判断「哪个 Variant 更好」，也不做任何自动调整：跑完全部样本就结束。
 */

import type { ExperimentRunPlan } from "@/engine/experiment-config";
import { expandExperiment } from "@/engine/experiment-config";
import type { PipelineComponents, PipelineFactory } from "@/engine/pipeline-components";
import { missingPipelineFactory } from "@/engine/pipeline-components";
import { failureSummaryOf } from "@/domain/errors";
import {
  ExperimentValidationError,
  experimentDefinitionOf,
  type ExperimentDefinition,
  type ExperimentResult,
  type ExperimentRunIndex,
  type ExperimentRunIndexEntry,
  type ExperimentRunReference,
  type ExperimentStatus,
} from "@/domain/experiment";
import type { ArtifactStore } from "@/ports/artifact-store";
import type { ExperimentRepository } from "@/ports/experiment-store";
import type { ProviderProbe } from "@/ports/provider-probe";
import type { Logger } from "@/ports/logger";
import { experimentCountsOf, runScoresOf, summarizeExperiment, type ExperimentRunScores } from "@/analysis/experiment-summary";

/**
 * 实验执行依赖。
 *
 * baseUrl 刻意不在其中：一条样本的地址永远来自服务端 LLM_BASE_URL，
 * 而工厂内部照旧会跑 `clientFor` → `assertPublicBaseUrl`（v1.1.0 的 SSRF 关卡），
 * 等于每一条样本都过一次，而不是实验绕过一次。
 *
 * generate 是生成路径的正式入口（§30/§72）：由 Application 组合根注入，
 * Analysis 不 import Application、也不自己拼引擎流程——否则
 * Analysis → Application → Engine → Analysis 又会绕成一个环。
 *
 * 两个存储是必填项（§43）：ExperimentRepository / RunRepository 是端口，
 * 具体实现由组合根 new 出来再交进来。Analysis 自己不 new 存储，也不读
 * RUNS_DIR——那会让「换掉存储实现」这件事必须先改分析层代码。
 */
export interface ExperimentRunnerDeps extends PipelineComponents {
  /** Run 产物根与 experiments/ 根都由实现持有；测试传自己的目录即可隔离。 */
  artifactStore: ArtifactStore;
  experimentStore: ExperimentRepository;
  /**
   * 服务端凭据探针（§33）。没注入 llm 时才问它；没注入探针按「没配」算，
   * 于是宁可 400 也不烧 N 次必然失败的付费请求。
   */
  providerProbe?: ProviderProbe;
  /** 工程日志口（§28）；组合根把 Infrastructure 的实现交进来。 */
  logger: Logger;
  /** 生成路径工厂；缺省抛错，不自己拼一条别的路。 */
  generate?: PipelineFactory;
}

export class ExperimentRunner {
  constructor(private readonly deps: ExperimentRunnerDeps) {}

  /**
   * 跑完整个实验并落盘 results.json。
   *
   * 每一格的结果立刻写一次 runs.json：中途进程被杀，磁盘上也已经留下「前几格
   * 跑出了哪些 runId、失败在哪一步」，GET 能如实显示 partial，而不是一片空白。
   */
  async run(definition: ExperimentDefinition): Promise<ExperimentResult> {
    // 定义在落盘时校验过一次，这里再校验一次：磁盘上的文件可能被手改坏
    const checked = experimentDefinitionOf(definition);
    if (checked === null) {
      throw new ExperimentValidationError("实验定义读取回来校验不过，拒绝执行");
    }

    const plans = expandExperiment(checked);
    const startedAt = new Date().toISOString();
    const index: ExperimentRunIndex = {
      experimentId: checked.experimentId,
      totalRuns: plans.length,
      entries: plans.map((plan) => ({
        variantId: plan.variantId,
        repetition: plan.repetition,
        runId: null,
        status: "pending" as const,
      })),
    };
    this.deps.experimentStore.putRuns(checked.experimentId, index);

    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      const outcome = await this.runOne(plan, checked);
      const entry: ExperimentRunIndexEntry = {
        variantId: plan.variantId,
        repetition: plan.repetition,
        runId: outcome.runId,
        status: outcome.status,
        ...(outcome.failure ? { failure: outcome.failure } : {}),
      };
      index.entries[i] = entry;
      this.deps.experimentStore.putRuns(checked.experimentId, index);
      // LogContext 只有 run_id / attempt_number / repair_number 三个槽位，
      // 实验身份直接写在消息里，不硬塞进不属于它的字段
      this.deps.logger.info(
        `experiment ${checked.experimentId} sample ${i + 1}/${plans.length} ` +
          `${plan.variantId}#${plan.repetition} → ${outcome.status}`,
      );
    }

    const completedAt = new Date().toISOString();
    // 分数只读一次：引用（给界面每一行）与汇总（给均值）必须看到同一批数字，
    // 分两次读就给了它们互相矛盾的机会
    const scoresByRun = scoresByRunId(this.deps.artifactStore, index.entries);
    const result: ExperimentResult = {
      experimentId: checked.experimentId,
      status: statusOf(index),
      runs: referencesOf(index, scoresByRun),
      summary: {
        ...experimentCountsOf(index.entries),
        variants: summarizeExperiment(checked, index.entries, this.deps.artifactStore),
      },
      startedAt,
      completedAt,
    };
    this.deps.experimentStore.putResults(checked.experimentId, result);
    return result;
  }

  /**
   * 跑一个格子。
   *
   * fixed 模式走 runWithPlan（所有 Variant 共用同一份骨架），regenerate 模式走 run
   * （每个样本自己过 Planner）。两条路都会把 experiment 出身带进 Manifest。
   */
  private async runOne(
    plan: ExperimentRunPlan,
    definition: ExperimentDefinition,
  ): Promise<{ runId: string | null; status: "completed" | "failed"; failure?: string }> {
    const runtime = {
      ...(plan.config.model ? { model: plan.config.model } : {}),
      ...(plan.config.temperature !== undefined ? { temperature: plan.config.temperature } : {}),
    };
    const provenance = {
      experimentId: definition.experimentId,
      variantId: plan.variantId,
      repetition: plan.repetition,
    };

    try {
      // 每个样本单独建一条 Pipeline：model 是烤进 LLMClient 的，
      // 换个模型就得换个客户端；温度按调用传入，可以共用（这里仍按样本建，行为一致最好推）
      const generate = this.deps.generate ?? missingPipelineFactory;
      const pipeline = await generate(runtime, this.deps);
      const result = plan.config.beatPlan
        ? await pipeline.runWithPlan(
            plan.config.storyConfig,
            plan.config.beatPlan,
            runtime,
            plan.config.retryPolicy,
            provenance,
          )
        : await pipeline.run(
            plan.config.storyConfig,
            runtime,
            plan.config.retryPolicy,
            provenance,
          );
      return { runId: result.run_id, status: "completed" };
    } catch (e) {
      const err = failureSummaryOf(e);
      this.deps.logger.warning(
        `experiment ${definition.experimentId} sample ${plan.variantId}#${plan.repetition} ` +
          `failed (${err.code}): ${err.message}`,
      );
      return { runId: err.runId, status: "failed", failure: `${err.stage ?? "unknown"}: ${err.message}` };
    }
  }
}

/** §28 整体状态：全成 → completed；有成有败 → partial；全败 → failed。 */
function statusOf(index: ExperimentRunIndex): ExperimentStatus {
  const counts = experimentCountsOf(index.entries);
  if (counts.runCount === 0) return "failed";
  if (counts.failureCount === 0) return "completed";
  if (counts.successCount === 0) return "failed";
  return "partial";
}

/**
 * results.json 里的样本引用：顺序与 runs.json 一致（不按成绩重排）。
 *
 * v1.7.0 起每条引用带上这条样本自己的两个分数（没有就是 null）：
 * v1.7.0 漏了这一步，界面上每一行样本都显示「整体 — · 商业 —」，
 * 明明分数就写在那条 Run 的 quality.json / commercial-review.json 里。
 */
function referencesOf(
  index: ExperimentRunIndex,
  scores: Map<string, ExperimentRunScores>,
): ExperimentRunReference[] {
  const refs: ExperimentRunReference[] = [];
  for (const entry of index.entries) {
    if (entry.runId === null) continue;
    const own = scores.get(entry.runId);
    refs.push({
      variantId: entry.variantId,
      repetition: entry.repetition,
      runId: entry.runId,
      status: entry.status === "failed" ? "failed" : "completed",
      overallScore: own?.overallScore ?? null,
      commercialScore: own?.commercialScore ?? null,
    });
  }
  return refs;
}

/** 每个跑出 runId 的格子读一次自己的产物；读不到就整格不进表（分数按 null 算）。 */
function scoresByRunId(store: ArtifactStore, entries: ExperimentRunIndexEntry[]): Map<string, ExperimentRunScores> {
  const out = new Map<string, ExperimentRunScores>();
  for (const entry of entries) {
    if (entry.runId === null || out.has(entry.runId)) continue;
    out.set(entry.runId, runScoresOf(entry.runId, store));
  }
  return out;
}

/** 便捷入口：存储与生成路径都由调用方交进来（预检在 service 层做，见 src/analysis/experiment-service.ts）。 */
export async function runExperiment(definition: ExperimentDefinition, deps: ExperimentRunnerDeps): Promise<ExperimentResult> {
  return new ExperimentRunner(deps).run(definition);
}
