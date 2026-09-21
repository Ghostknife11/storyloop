import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult, ReviewStatus } from "@/types/review-result";
import type { ValidationResult, ValidationStatus } from "@/types/validation-result";
import type { RunContext } from "@/core/run-context";
import { createRunContext, transitionStage, failRun } from "@/core/run-context";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
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
 * v0.6.0 新增 validation / validation_status / validation_error（§20）：
 * Validation Failed 同样是业务结果，Run 仍为 completed；Validator 自身异常时
 * validation 为 null、validation_status 为 failed（§25）。
 */
export interface GenerationResult {
  run_id: string;
  config: StoryConfig;
  beat_plan: BeatPlan;
  story: string;
  validation: ValidationResult | null;
  validation_status: ValidationStatus;
  validation_error: string | null;
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

/** §18 EMPTY_CONTENT 时没有可审阅的正文，跳过 Review；其它失败仍继续（§18 推荐）。 */
function skipReviewFor(validation: ValidationResult | null): boolean {
  if (!validation) return false;
  return validation.issues.some((i) => i.code === "EMPTY_CONTENT");
}

/** §22 成功 Run 的产物清单；validation.json / review.json 只在各自成功时出现。 */
function artifactsOf(
  validation: ValidationResult | null,
  review: ReviewResult | null,
): Record<string, string> {
  const artifacts: Record<string, string> = {
    config: "config.json",
    beat_plan: "beats.json",
    story: "story.md",
    metadata: "metadata.json",
  };
  if (validation) artifacts.validation = "validation.json";
  if (review) artifacts.review = "review.json";
  return artifacts;
}

/** §17/§24 metadata 补丁：把当前已知的 validation / review 状态写进 metadata.json。 */
interface MetaPatch {
  validation_status?: ValidationStatus;
  validation?: ValidationResult | null;
  validation_error?: string | null;
  review_status?: ReviewStatus;
  review_error?: string | null;
  review?: ReviewResult | null;
}

/**
 * §3/§25 GenerationPipeline：把一次完整生成组织成一个 Run。
 * v0.6.0 固定顺序（§17）：
 *   Config → Planning → Generation → Save Story → Validate → Save Validation
 *   → Review → Save Review → Finalize Metadata
 * 只暴露 run() 与 runWithPlan()（§30），不做 Stage Registry / DAG / Plugin。
 * §19 构造器只接受 planner / generator / validator / reviewer / artifact_store——
 * 不提前加入 retry_policy / repairer。
 */
export class GenerationPipeline {
  constructor(
    private planner: BeatPlanner,
    private generator: StoryGenerator,
    private validator: StoryValidator,
    private reviewer: BasicReviewer,
    private artifactStore: ArtifactStore,
    private projectVersion = "0.6.0",
  ) {}

  /** §6 Automatic：StoryConfig → Plan → Generate → Save → Validate → Review。 */
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

      // §17：先保存 Story，再 Validate / Review——后续阶段出问题时正文必须已经落盘。
      transitionStage(ctx, "saving", "saving");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime));
      this.artifactStore.putStory(rid, config.title, story);

      // §25 Validation Failed（passed=false）与 Validator Error（自身异常）分开记录。
      let validation: ValidationResult | null = null;
      let validationStatus: ValidationStatus = "not_started";
      let validationError: string | null = null;

      transitionStage(ctx, "validating", "validating");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, { validation_status: "validating" }),
      );
      try {
        // §8 StoryValidator.validate 是同步纯函数；await 让注入的异步 Validator 同样成立
        validation = await this.validator.validate(config, story);
        validationStatus = "completed";
        this.artifactStore.putValidation(rid, validation);
      } catch (e) {
        validationStatus = "failed";
        validationError = safeDetail(e instanceof Error ? e.message : String(e));
        // §28：原始异常只进服务端技术日志
        console.error(`[pipeline] run ${rid} validation failed:`, e);
      }

      // §16/§34：Review 失败不丢弃已生成的正文，也不把 Run 判为失败。
      // §18：EMPTY_CONTENT 时没有可审阅内容，跳过 Review。
      let review: ReviewResult | null = null;
      let reviewStatus: ReviewStatus = "not_started";
      let reviewError: string | null = null;

      if (!skipReviewFor(validation)) {
        transitionStage(ctx, "reviewing", "reviewing");
        this.artifactStore.putMetadata(
          rid,
          this.metaFor(ctx, runtime, {
            validation_status: validationStatus,
            validation: validation,
            validation_error: validationError,
            review_status: "reviewing",
          }),
        );
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
      }

      transitionStage(ctx, "completed", "completed");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          validation_status: validationStatus,
          validation: validation,
          validation_error: validationError,
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
        validation,
        validation_status: validationStatus,
        validation_error: validationError,
        review,
        review_status: reviewStatus,
        review_error: reviewError,
        status: "completed",
        artifacts: artifactsOf(validation, review),
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

  /** §17/§24 metadata：run_id / 版本 / 状态 / 阶段 / 时间 / 模型 / 产物名 / 校验与审阅状态。 */
  private metaFor(ctx: RunContext, runtime?: GenerateRuntime, patch: MetaPatch = {}): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      run_id: ctx.run_id,
      project_version: ctx.project_version,
      status: ctx.status,
      started_at: ctx.started_at,
    };
    if (ctx.current_stage) meta.current_stage = ctx.current_stage;
    if (ctx.error) meta.error = ctx.error;
    if (runtime?.model) meta.model = runtime.model;
    if (patch.validation_status) meta.validation_status = patch.validation_status;
    if (patch.validation) {
      meta.validation_passed = patch.validation.passed;
      meta.validation_issue_count = patch.validation.issues.length;
    }
    if (patch.validation_error) meta.validation_error = patch.validation_error;
    if (patch.review_status) meta.review_status = patch.review_status;
    if (patch.review_error) meta.review_error = patch.review_error;
    if (patch.review) meta.review_score = patch.review.score;
    if (ctx.status === "completed" || ctx.status === "failed") {
      meta.finished_at = new Date().toISOString();
    }
    meta.artifacts = artifactsOf(patch.validation ?? null, patch.review ?? null);
    return meta;
  }
}
