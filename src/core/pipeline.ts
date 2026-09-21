import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult, ReviewStatus } from "@/types/review-result";
import type { RunContext } from "@/core/run-context";
import { createRunContext, transitionStage, failRun } from "@/core/run-context";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { BasicReviewer } from "@/lib/basic-reviewer";
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

/**
 * §20 GenerationResult。v0.5.0 新增 review / review_status / review_error：
 * Story 成功但 Review 失败时 review 为 null，Run 本身仍是 completed（§16）。
 */
export interface GenerationResult {
  run_id: string;
  config: StoryConfig;
  beat_plan: BeatPlan;
  story: string;
  review: ReviewResult | null;
  review_status: ReviewStatus;
  review_error: string | null;
  status: string;
  artifacts: Record<string, string>;
  started_at: string;
  finished_at: string;
}

/** §27/§28/§67 安全错误信息：node:fs 的异常文本带服务器绝对路径，
 * 进用户可见的 message / metadata 前先抹掉；原始异常只进服务端技术日志。 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/][^\s'"]*/g;

function safeDetail(raw: string): string {
  return raw.replace(ABSOLUTE_PATH, "<path>");
}

/** §22 成功 Run 的产物清单；review.json 只在审阅成功时出现。 */
function artifactsOf(review: ReviewResult | null): Record<string, string> {
  const artifacts: Record<string, string> = {
    config: "config.json",
    beat_plan: "beats.json",
    story: "story.md",
    metadata: "metadata.json",
  };
  if (review) artifacts.review = "review.json";
  return artifacts;
}

/**
 * §3/§25 GenerationPipeline：把一次完整生成组织成一个 Run。
 * v0.5.0 固定顺序（§18）：
 *   Config → Planning → Generation → Save Story → Review → Save Review → Finalize Metadata
 * 只暴露 run() 与 runWithPlan()（§30），不做 Stage Registry / DAG / Plugin。
 * §19 构造器只接受 planner / generator / reviewer / artifact_store——不提前加入
 * validator / retry_policy / repairer。
 */
export class GenerationPipeline {
  constructor(
    private planner: BeatPlanner,
    private generator: StoryGenerator,
    private reviewer: BasicReviewer,
    private artifactStore: ArtifactStore,
    private projectVersion = "0.5.0",
  ) {}

  /** §6 Automatic：StoryConfig → Plan → Generate → Save → Review。 */
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

      // §18：先保存 Story，再 Review——Review 出问题时正文必须已经落盘。
      transitionStage(ctx, "saving", "saving");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      this.artifactStore.putStory(rid, config.title, story);

      // §16/§34：Review 失败不丢弃已生成的正文，也不把 Run 判为失败。
      let review: ReviewResult | null = null;
      let reviewStatus: ReviewStatus = "not_started";
      let reviewError: string | null = null;

      transitionStage(ctx, "reviewing", "reviewing");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime, { review_status: "reviewing" }));
      try {
        const produced = await this.reviewer.review(config, story);
        this.artifactStore.putReview(rid, produced);
        review = produced;
        reviewStatus = "completed";
      } catch (e) {
        reviewStatus = "failed";
        reviewError = safeDetail(e instanceof Error ? e.message : String(e));
        // §28：原始异常只进服务端技术日志
        console.error(`[pipeline] run ${rid} review failed:`, e);
      }

      transitionStage(ctx, "completed", "completed");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          review_status: reviewStatus,
          review_error: reviewError,
          review,
        }),
      );

      return {
        run_id: rid,
        config,
        beat_plan: beatPlan,
        story,
        review,
        review_status: reviewStatus,
        review_error: reviewError,
        status: "completed",
        artifacts: artifactsOf(review),
        started_at: ctx.started_at,
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      // §18/§19/§20：失败阶段可识别，已产出的文件不删除
      const detail = safeDetail(e instanceof Error ? e.message : String(e));
      // §28：原始异常只进服务端技术日志
      console.error(`[pipeline] run ${rid} failed at ${ctx.current_stage ?? "unknown"}:`, e);
      failRun(ctx, ctx.current_stage ?? "unknown", detail);
      try {
        this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      } catch {
        /* metadata 保存失败时保留原始错误 */
      }
      throw new PipelineError(
        ["Run", rid, "failed at", ctx.current_stage ?? "unknown", ":", detail].join(" "),
        rid,
        ctx.current_stage ?? "unknown",
      );
    }
  }

  /** §17/§24 metadata：run_id / 版本 / 状态 / 阶段 / 时间 / 模型 / 产物名 / Review 状态。 */
  private metaFor(
    ctx: RunContext,
    runtime?: GenerateRuntime,
    review?: { review_status?: ReviewStatus; review_error?: string | null; review?: ReviewResult | null },
  ): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      run_id: ctx.run_id,
      project_version: ctx.project_version,
      status: ctx.status,
      started_at: ctx.started_at,
    };
    if (ctx.current_stage) meta.current_stage = ctx.current_stage;
    if (ctx.error) meta.error = ctx.error;
    if (runtime?.model) meta.model = runtime.model;
    if (review?.review_status) meta.review_status = review.review_status;
    if (review?.review_error) meta.review_error = review.review_error;
    if (review?.review) meta.review_score = review.review.score;
    if (ctx.status === "completed" || ctx.status === "failed") {
      meta.finished_at = new Date().toISOString();
    }
    meta.artifacts = artifactsOf(review?.review ?? null);
    return meta;
  }
}
