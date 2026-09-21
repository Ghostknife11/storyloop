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
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  validateRetryPolicy,
  type RetryPolicy,
} from "@/core/retry-policy";
import type { GenerationAttempt } from "@/core/generation-attempt";

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

/** §16 quality_status：accepted = 某个 Attempt 满足 RetryPolicy；exhausted = 用尽 Attempt 仍未满足。 */
export type QualityStatus = "accepted" | "exhausted";

/**
 * §20/§38 GenerationResult。validation / validation_status / review / review_status 描述
 * selected attempt（v0.6.0 语义不变）；v0.7.0 新增
 * attempt_count / selected_attempt / quality_status / attempts。
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
  attempt_count: number;
  selected_attempt: number;
  quality_status: QualityStatus;
  attempts: GenerationAttempt[];
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

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/** §17/§25 metadata 补丁：当前 Attempt 与 Run 级别的状态。 */
interface MetaPatch {
  attempt_number?: number;
  attempt_count?: number;
  selected_attempt?: number;
  quality_status?: QualityStatus;
  max_attempts?: number;
  min_review_score?: number;
  validation_status?: ValidationStatus;
  validation?: ValidationResult | null;
  validation_error?: string | null;
  review_status?: ReviewStatus;
  review_error?: string | null;
  review?: ReviewResult | null;
}

/** §25 Run 级策略字段：写进 metadata，中断后也能看到当时生效的策略。 */
function policyPatch(policy: RetryPolicy): Partial<MetaPatch> {
  return { max_attempts: policy.max_attempts, min_review_score: policy.min_review_score };
}

/**
 * §3/§25 GenerationPipeline：把一次完整生成组织成一个 Run。
 * v0.7.0 固定顺序（§19）：
 *   Config → Planning → [ Attempt n: Generate → Save Story → Validate → Review → Decide → Retry? ] → Finalize
 * §8/§9：BeatPlan 与 StoryConfig 只确定一次，同一 Run 内所有 Attempt 复用，
 * 不自动换 Model / 改温度 / 改 Config（§70）。
 * §65 只暴露 run() 与 runWithPlan()，不做 Stage Registry / DAG / Plugin。
 */
export class GenerationPipeline {
  constructor(
    private planner: BeatPlanner,
    private generator: StoryGenerator,
    private validator: StoryValidator,
    private reviewer: BasicReviewer,
    private artifactStore: ArtifactStore,
    private retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    private projectVersion = "0.7.0",
  ) {}

  /** §6 Automatic：StoryConfig → Plan → 若干 Attempt → 选中的那一个。 */
  async run(
    config: StoryConfig,
    runtime?: GenerateRuntime,
    retryPolicy?: RetryPolicy,
  ): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, undefined, runtime, retryPolicy);
  }

  /** §29 Manual：用户编辑后的 BeatPlan 直接进入生成，仍形成一个 Run。 */
  async runWithPlan(
    config: StoryConfig,
    beatPlan: BeatPlan,
    runtime?: GenerateRuntime,
    retryPolicy?: RetryPolicy,
  ): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, beatPlan, runtime, retryPolicy);
  }

  private async runStages(
    ctx: RunContext,
    config: StoryConfig,
    suppliedPlan: BeatPlan | undefined,
    runtime?: GenerateRuntime,
    retryPolicyArg?: RetryPolicy,
  ): Promise<GenerationResult> {
    const rid = ctx.run_id;
    let beatPlan: BeatPlan | undefined = suppliedPlan;
    const policy = validateRetryPolicy(retryPolicyArg ?? this.retryPolicy);

    try {
      this.artifactStore.createRunDirectory(rid);
      this.artifactStore.putConfig(rid, config);

      transitionStage(ctx, "planning", "planning");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime, { ...policyPatch(policy) }));
      // §8：Plan once——不要每次 Retry 都重新规划。
      if (!beatPlan) {
        beatPlan = await this.planner.plan(config, runtime?.temperature ?? 0.7);
      }
      this.artifactStore.putBeatPlan(rid, beatPlan);

      // §19 重试循环：硬上限来自 policy.max_attempts（§15 禁止无限重试）。
      const attempts: GenerationAttempt[] = [];
      for (let attemptNumber = 1; attemptNumber <= policy.max_attempts; attemptNumber++) {
        const attempt = await this.runAttempt(ctx, rid, config, beatPlan, runtime, policy, attemptNumber);
        attempts.push(attempt);
        if (attempt.accepted) break;
        // §11/§15：连正文都没拿到，且已是最后一次允许的 Attempt → Run 失败，
        // 与 v0.6.0 一致：阶段可定位到 generating，已产出的 attempt 产物不删除。
        if (attempt.story === null) {
          throw new PipelineError(
            `Run ${rid} failed at generating: ${attempt.error ?? "未知错误"}`,
            rid,
            "generating",
          );
        }
      }

      // §17：第一个满足策略的 Attempt；全部 exhausted 时取最后一个（§16）。
      const selected = attempts.find((a) => a.accepted) ?? attempts[attempts.length - 1];
      const qualityStatus: QualityStatus = selected.accepted ? "accepted" : "exhausted";

      // §23/§28：根目录 story.md / validation.json / review.json 对应 selected attempt。
      this.artifactStore.promoteAttempt(rid, selected.attempt_number);

      transitionStage(ctx, "completed", "completed");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          ...policyPatch(policy),
          attempt_count: attempts.length,
          selected_attempt: selected.attempt_number,
          quality_status: qualityStatus,
          validation_status: selected.validation ? "completed" : "not_started",
          validation: selected.validation,
          review_status: selected.review ? "completed" : "not_started",
          review: selected.review,
        }),
      );

      return {
        run_id: rid,
        config,
        beat_plan: beatPlan,
        story: selected.story ?? "",
        validation: selected.validation,
        validation_status: selected.validation ? "completed" : "not_started",
        validation_error: null,
        review: selected.review,
        review_status: selected.review ? "completed" : "not_started",
        review_error: null,
        attempt_count: attempts.length,
        selected_attempt: selected.attempt_number,
        quality_status: qualityStatus,
        attempts,
        status: "completed",
        artifacts: artifactsOf(selected.validation, selected.review),
        started_at: ctx.started_at,
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      // §18/§19/§20：失败阶段可识别，已产出的文件不删除
      const detail = safeDetail(errorDetail(e));
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

  /**
   * §19 单次 Attempt：Generate → Save Story → Validate → Review → RetryDecision。
   * §12 Reviewer / Validator 自身异常不升级为 Story 失败，只记录各自 status。
   */
  private async runAttempt(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    plan: BeatPlan,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    attemptNumber: number,
  ): Promise<GenerationAttempt> {
    let story: string | null = null;
    let generationError: string | null = null;

    transitionStage(ctx, "generating", "generating");
    this.artifactStore.putMetadata(
      rid,
      this.metaFor(ctx, runtime, {
        ...policyPatch(policy),
        attempt_number: attemptNumber,
      }),
    );
    try {
      // §70：重试继续用同一个 StoryConfig / BeatPlan / 温度，不自动调参。
      story = await this.generator.generate(config, plan, runtime?.temperature ?? 0.8);
    } catch (e) {
      generationError = safeDetail(errorDetail(e));
      // §28：原始异常只进服务端技术日志
      console.error(`[pipeline] run ${rid} attempt ${attemptNumber} generation failed:`, e);
    }

    // §17：先保存 Story，再 Validate / Review。
    if (story !== null) {
      transitionStage(ctx, "saving", "saving");
      this.artifactStore.putAttemptStory(rid, attemptNumber, config.title, story);
    }

    let validation: ValidationResult | null = null;
    let validationStatus: ValidationStatus = "not_started";
    let validationError: string | null = null;

    if (story !== null) {
      transitionStage(ctx, "validating", "validating");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          ...policyPatch(policy),
          attempt_number: attemptNumber,
          validation_status: "validating",
        }),
      );
      try {
        validation = await this.validator.validate(config, story);
        validationStatus = "completed";
        this.artifactStore.putAttemptValidation(rid, attemptNumber, validation);
      } catch (e) {
        // §12：Validator 自身异常 ≠ Story Failed。
        validationStatus = "failed";
        validationError = safeDetail(errorDetail(e));
        console.error(`[pipeline] run ${rid} attempt ${attemptNumber} validation failed:`, e);
      }
    }

    let review: ReviewResult | null = null;
    let reviewStatus: ReviewStatus = "not_started";
    let reviewError: string | null = null;

    // §16/§34：Review 失败不丢弃已生成的正文，也不把 Run 判为失败。
    // §18：EMPTY_CONTENT 时没有可审阅内容，跳过 Review。
    if (story !== null && !skipReviewFor(validation)) {
      transitionStage(ctx, "reviewing", "reviewing");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          ...policyPatch(policy),
          attempt_number: attemptNumber,
          validation_status: validationStatus,
          validation,
          validation_error: validationError,
          review_status: "reviewing",
        }),
      );
      try {
        review = await this.reviewer.review(config, story);
        reviewStatus = "completed";
        this.artifactStore.putAttemptReview(rid, attemptNumber, review);
      } catch (e) {
        // §12：Review Error ≠ Story Retry Trigger。
        reviewStatus = "failed";
        reviewError = safeDetail(errorDetail(e));
        console.error(`[pipeline] run ${rid} attempt ${attemptNumber} review failed:`, e);
      }
    }

    const decision = decideRetry({
      policy,
      attempt_number: attemptNumber,
      generation_error: generationError,
      validator_error: validationStatus === "failed",
      reviewer_error: reviewStatus === "failed",
      validation,
      review,
    });

    const attemptError = generationError ?? validationError ?? reviewError;

    // §24 Attempt metadata：编号 / 是否被接受 / 重试原因 / 分数 / 校验结论。
    this.artifactStore.putAttemptMetadata(rid, attemptNumber, {
      attempt_number: attemptNumber,
      accepted: !decision.should_retry,
      retry_reason: decision.reason,
      review_score: review ? review.score : null,
      validation_passed: validation ? validation.passed : null,
      validation_status: validationStatus,
      review_status: reviewStatus,
      ...(validationError ? { validation_error: validationError } : {}),
      ...(reviewError ? { review_error: reviewError } : {}),
      ...(attemptError ? { error: attemptError } : {}),
    });

    return {
      attempt_number: attemptNumber,
      story,
      validation,
      review,
      accepted: !decision.should_retry,
      retry_reason: decision.reason,
      error: attemptError,
    };
  }

  /** §17/§25 metadata：run_id / 版本 / 状态 / 阶段 / 时间 / 模型 / 策略 / Attempt 与校验审阅状态。 */
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
    if (patch.max_attempts !== undefined) meta.max_attempts = patch.max_attempts;
    if (patch.min_review_score !== undefined) meta.min_review_score = patch.min_review_score;
    if (patch.attempt_number !== undefined) meta.attempt_number = patch.attempt_number;
    if (patch.attempt_count !== undefined) meta.attempt_count = patch.attempt_count;
    if (patch.selected_attempt !== undefined) meta.selected_attempt = patch.selected_attempt;
    if (patch.quality_status) meta.quality_status = patch.quality_status;
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
