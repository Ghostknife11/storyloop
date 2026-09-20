import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { RunContext } from "@/core/run-context";
import { createRunContext, transitionStage, failRun } from "@/core/run-context";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { ArtifactStore } from "@/storage/artifact-store";
import type { GenerateRuntime } from "@/lib/generate-service";

/**
 * §28 PipelineError：不吞异常，带 run_id / stage / message。
 * 技术日志记原始异常，用户 API 只拿这里的 message。
 */
export class PipelineError extends Error {
  constructor(message: string, public runId: string, public stage: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/** §12 GenerationResult：禁止 review / score / validation / repair / retry_count 等未来字段。 */
export interface GenerationResult {
  run_id: string;
  config: StoryConfig;
  beat_plan: BeatPlan;
  story: string;
  status: string;
  artifacts: Record<string, string>;
  started_at: string;
  finished_at: string;
}

/**
 * §3/§25 GenerationPipeline：把 v0.3.0 的两个独立步骤组织成一个 Run。
 * 固定顺序 Config → Planning → Generation → Persistence（§7），
 * 只暴露 run() 与 runWithPlan()（§30），不做 Stage Registry / DAG / Plugin。
 */
export class GenerationPipeline {
  constructor(
    private planner: BeatPlanner,
    private generator: StoryGenerator,
    private artifactStore: ArtifactStore,
    private projectVersion = "0.4.0",
  ) {}

  /** §6 Automatic：StoryConfig → Plan → Generate → Persist。 */
  async run(config: StoryConfig, runtime?: GenerateRuntime): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, undefined, runtime);
  }

  /** §29 Manual：用户编辑后的 BeatPlan 直接进入生成，仍形成一个 Run。 */
  async runWithPlan(config: StoryConfig, beatPlan: BeatPlan, runtime?: GenerateRuntime): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, beatPlan, runtime);
  }

  private async runStages(
    ctx: RunContext,
    config: StoryConfig,
    suppliedPlan: BeatPlan | undefined,
    runtime?: GenerateRuntime,
  ): Promise<GenerationResult> {
    const rid = ctx.run_id;
    let beatPlan: BeatPlan | undefined = suppliedPlan;

    try {
      this.artifactStore.createRunDirectory(rid);
      this.artifactStore.putConfig(rid, config);

      transitionStage(ctx, "planning", "planning");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      if (!beatPlan) {
        beatPlan = await this.planner.plan(config, runtime?.temperature ?? 0.7);
      }
      this.artifactStore.putBeatPlan(rid, beatPlan);

      transitionStage(ctx, "generating", "generating");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      const story = await this.generator.generate(config, beatPlan, runtime?.temperature ?? 0.8);

      transitionStage(ctx, "saving", "saving");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      this.artifactStore.putStory(rid, config.title, story);

      transitionStage(ctx, "completed", "completed");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));

      return {
        run_id: rid,
        config,
        beat_plan: beatPlan,
        story,
        status: "completed",
        artifacts: { config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" },
        started_at: ctx.started_at,
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      // §18/§19/§20：失败阶段可识别，已产出的文件不删除
      failRun(ctx, ctx.current_stage ?? "unknown", e instanceof Error ? e.message : String(e));
      try {
        this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      } catch {
        /* metadata 保存失败时保留原始错误 */
      }
      const detail = e instanceof Error ? e.message : String(e);
      throw new PipelineError(
        ["Run", rid, "failed at", ctx.current_stage ?? "unknown", ":", detail].join(" "),
        rid,
        ctx.current_stage ?? "unknown",
      );
    }
  }

  /** §17 metadata：只记录 run_id / 版本 / 状态 / 阶段 / 时间 / 模型 / 产物名。 */
  private metaFor(ctx: RunContext, runtime?: GenerateRuntime): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      run_id: ctx.run_id,
      project_version: ctx.project_version,
      status: ctx.status,
      started_at: ctx.started_at,
    };
    if (ctx.current_stage) meta.current_stage = ctx.current_stage;
    if (ctx.error) meta.error = ctx.error;
    if (runtime?.model) meta.model = runtime.model;
    if (ctx.status === "completed" || ctx.status === "failed") {
      meta.finished_at = new Date().toISOString();
    }
    meta.artifacts = { config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" };
    return meta;
  }
}
