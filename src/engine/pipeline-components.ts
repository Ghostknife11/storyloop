/**
 * v2.0.0 Pipeline 的可注入部件与工厂签名（Engine）。
 *
 * v1.x 这些形状长在 `src/lib/generate-service.ts`（Application）里，叫 `RunDeps`。
 * 于是 Analysis 的实验执行器为了「按同样的依赖跑一条 Pipeline」必须 import
 * Application，和 Application → Engine 的组装依赖合成一个环（§72）。
 *
 * 拆开之后：
 *   Engine    认得出「一份可注入部件」和「一个能把它组装成 Pipeline 的工厂」；
 *   Analysis  只 import Engine（§30：实验执行器调用正式的那条生成路径，而不是
 *             自己拼引擎内部流程）；
 *   Application 的 buildPipeline 就是这个工厂的生产实现（组合根）。
 *
 * 名字沿用 v1.x 的 RunDeps（generate-service 里仍按这个名字 re-export），
 * 字段一个没改——换的是位置，不是契约。
 */

import type { BeatPlanner } from "@/engine/beat-planner";
import type { StoryGenerator } from "@/engine/story-generator";
import type { StoryValidator } from "@/engine/story-validator";
import type { BasicReviewer } from "@/engine/basic-reviewer";
import type { StoryRepairer } from "@/engine/story-repairer";
import type { RepairStrategy } from "@/engine/repair-strategy";
import type { BeatValidator } from "@/engine/beat-validator";
import type { CommercialReviewer } from "@/engine/commercial-reviewer";
import type { ArtifactStore } from "@/ports/artifact-store";
import type { TelemetryCollector } from "@/infrastructure/telemetry/telemetry-collector";
import type { LLMClient } from "@/ports/llm-client";
import type { GenerateRuntime } from "@/domain/run-config";
import type { GenerationPipeline } from "@/engine/pipeline";

/** §5 依赖注入：测试用 Mock LLM / 假 Planner / 假 Validator / 假 Reviewer，绝不打真实付费 API。 */
export interface PipelineComponents {
  llm?: LLMClient;
  planner?: BeatPlanner;
  generator?: StoryGenerator;
  validator?: StoryValidator;
  reviewer?: BasicReviewer;
  repairer?: StoryRepairer;
  repairStrategy?: RepairStrategy;
  /** v1.4.0 §5：不注入就没有 BeatPlan 结构校验这一步。 */
  beatValidator?: BeatValidator;
  /** v1.5.0 TASK §5：不注入就没有商业可读性审阅这一步，其余流程与 v1.4.0 一致。 */
  commercialReviewer?: CommercialReviewer;
  artifactStore?: ArtifactStore;
  /** v1.8.0：测试可注入自己的采集器；不注入就由工厂新建一个。 */
  telemetry?: TelemetryCollector;
}

/**
 * 生成路径的唯一正式入口（§30）。
 *
 * runtime 决定「这一次用哪个模型 / 温度 / 地址」；components 只用于测试替身。
 * 生产实现是 Application 组合根里的 buildPipeline：它会过 url guard、
 * 从服务端环境读密钥、按 prompts/ 装配各部件。
 */
export type PipelineFactory = (
  runtime: GenerateRuntime,
  components?: PipelineComponents,
) => Promise<GenerationPipeline>;

/** 没拿到工厂时的明确失败：宁可 500 说清楚，也不要 silently 换一条生成路径。 */
export function missingPipelineFactory(): never {
  throw new Error(
    "没有注入生成路径（PipelineFactory）。实验执行器不自己拼引擎流程，" +
      "请在依赖里提供 generate（生产实现是 Application 组合根的 buildPipeline）。",
  );
}
