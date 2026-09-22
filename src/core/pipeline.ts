import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult, ReviewStatus } from "@/types/review-result";
import type { ValidationResult, ValidationStatus } from "@/types/validation-result";
import type { RunContext, RunStatus } from "@/core/run-context";
import { createRunContext, transitionStage, failRun } from "@/core/run-context";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { ArtifactStore } from "@/storage/artifact-store";
import type { GenerateRuntime } from "@/lib/generate-service";
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  validateRetryPolicy,
  type RetryDecision,
  type RetryPolicy,
} from "@/core/retry-policy";
import type { GenerationAttempt } from "@/core/generation-attempt";
import { RepairStrategy } from "@/core/repair-strategy";
import type { RepairRecord } from "@/types/repair";
import { repairRequestOf } from "@/types/repair";
import { logger } from "@/lib/logger";
import { projectVersion as readProjectVersion } from "@/lib/version";

/**
 * §28 PipelineError：不吞异常，带 run_id / stage / message。
 * 技术日志记原始异常，用户 API 只拿这里的 message。
 * cause 保留被包裹的原始异常，供错误码映射区分 LLM 失败与其它生成失败（§11）。
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public runId: string,
    public stage: string,
    public readonly cause?: unknown,
  ) {
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
  /** §18：Repair 开关与上限同样写进 metadata，中断后能看出当时生效的策略。 */
  enable_repair?: boolean;
  max_repairs_per_attempt?: number;
  repair_count?: number;
  validation_status?: ValidationStatus;
  validation?: ValidationResult | null;
  validation_error?: string | null;
  review_status?: ReviewStatus;
  review_error?: string | null;
  review?: ReviewResult | null;
}

/** §25 Run 级策略字段：写进 metadata，中断后也能看到当时生效的策略。 */
function policyPatch(policy: RetryPolicy): Partial<MetaPatch> {
  return {
    max_attempts: policy.max_attempts,
    min_review_score: policy.min_review_score,
    enable_repair: policy.enable_repair,
    max_repairs_per_attempt: policy.max_repairs_per_attempt,
  };
}

/**
 * 一轮 Validate + Review 的结论。initial 与 repair 之后共用同一结构，
 * §12 的组件自身异常只影响对应的 status 字段，不动另一个。
 */
interface StoryCheck {
  validation: ValidationResult | null;
  validation_status: ValidationStatus;
  validation_error: string | null;
  review: ReviewResult | null;
  review_status: ReviewStatus;
  review_error: string | null;
}

/**
 * Pipeline 内部记录：§5 的 GenerationAttempt 加上各阶段 status / error。
 * §5 规定 Attempt 对外只有那几个字段，status 只在这里和 metadata / GenerationResult 里出现。
 */
interface AttemptRecord {
  attempt: GenerationAttempt;
  validation_status: ValidationStatus;
  validation_error: string | null;
  review_status: ReviewStatus;
  review_error: string | null;
  /** 生成阶段原始异常：只用于错误码映射（§11），绝不写入任何产物或响应。 */
  failure?: unknown;
}

/**
 * §3/§25 GenerationPipeline：把一次完整生成组织成一个 Run。
 * v0.7.0 固定顺序（§19）：
 *   Config → Planning → [ Attempt n: Generate → Save Story → Validate → Review → Decide → Retry? ] → Finalize
 * v0.8.0 在 Attempt 内部插入 Repair-before-Retry（§20/§33）：
 *   Generate → Save Story → Validate → Review → 未过且有可修问题且允许修订
 *   → Repair → Revalidate → Re-review → 再判一次 → 仍不过才 Full Retry。
 * §8/§9：BeatPlan 与 StoryConfig 只确定一次，同一 Run 内所有 Attempt 复用，
 * 不自动换 Model / 改温度 / 改 Config（§70）。Repair 同样不碰它们（§65）。
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
    /** §9 可选：不注入就完全没有 Repair 能力，Attempt 流程与 v0.7.0 逐字一致。 */
    private repairer?: StoryRepairer,
    /** §12 固定规则策略；不注入时用默认实例，仍然不学习、不调 LLM。 */
    private repairStrategy: RepairStrategy = new RepairStrategy(),
    /** §42 版本号单一来源：VERSION 文件（§43），不在代码里硬编码。 */
    private projectVersion: string = readProjectVersion(),
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
        logger.child({ run_id: rid }).info("planning started");
        beatPlan = await this.planner.plan(config, runtime?.temperature ?? 0.7);
        logger.child({ run_id: rid }).info(`planning completed（${beatPlan.beats.length} beats）`);
      }
      this.artifactStore.putBeatPlan(rid, beatPlan);

      // §19 重试循环：硬上限来自 policy.max_attempts（§15 禁止无限重试）。
      const records: AttemptRecord[] = [];
      for (let attemptNumber = 1; attemptNumber <= policy.max_attempts; attemptNumber++) {
        const record = await this.runAttempt(ctx, rid, config, beatPlan, runtime, policy, attemptNumber);
        records.push(record);
        // §9：Attempt 结束时记一条 run/attempt 级日志，重试与采纳在日志里可定位
        logger
          .child({ run_id: rid, attempt_number: attemptNumber })
          .info(record.attempt.accepted ? "attempt accepted" : `attempt not accepted（${record.attempt.retry_reason ?? "unknown"}）`);
        if (record.attempt.accepted) break;
        // §11.1/§20：生成失败也按策略再试（continue_if_allowed）；
        // 只有最后一次允许的 Attempt 仍拿不到正文 → Run 失败，
        // 与 v0.6.0 一致：阶段可定位到 generating，已产出的 attempt 产物不删除。
        if (record.attempt.story === null && attemptNumber >= policy.max_attempts) {
          throw new PipelineError(
            `Run ${rid} failed at generating: ${record.attempt.error ?? "未知错误"}`,
            rid,
            "generating",
            record.failure,
          );
        }
      }

      // §17：第一个满足策略的 Attempt；全部 exhausted 时取最后一个（§16）。
      const selected = records.find((r) => r.attempt.accepted) ?? records[records.length - 1];
      const qualityStatus: QualityStatus = selected.attempt.accepted ? "accepted" : "exhausted";
      // §40：Run 级 repair_count = 各 Attempt 修订次数之和（Repair 不新增 Attempt，§17）。
      const repairCount = records.reduce((sum, r) => sum + r.attempt.repairs.length, 0);

      // §23/§28：根目录 story.md / validation.json / review.json 对应 selected attempt。
      this.artifactStore.promoteAttempt(rid, selected.attempt.attempt_number);

      transitionStage(ctx, "completed", "completed");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          ...policyPatch(policy),
          attempt_count: records.length,
          selected_attempt: selected.attempt.attempt_number,
          quality_status: qualityStatus,
          repair_count: repairCount,
          validation_status: selected.validation_status,
          validation: selected.attempt.validation,
          validation_error: selected.validation_error,
          review_status: selected.review_status,
          review: selected.attempt.review,
          review_error: selected.review_error,
        }),
      );

      return {
        run_id: rid,
        config,
        beat_plan: beatPlan,
        story: selected.attempt.story ?? "",
        validation: selected.attempt.validation,
        validation_status: selected.validation_status,
        validation_error: selected.validation_error,
        review: selected.attempt.review,
        review_status: selected.review_status,
        review_error: selected.review_error,
        attempt_count: records.length,
        selected_attempt: selected.attempt.attempt_number,
        quality_status: qualityStatus,
        attempts: records.map((r) => r.attempt),
        status: "completed",
        artifacts: artifactsOf(selected.attempt.validation, selected.attempt.review),
        started_at: ctx.started_at,
        finished_at: new Date().toISOString(),
      };
    } catch (e) {
      // §18/§19/§20：失败阶段可识别，已产出的文件不删除
      const detail = safeDetail(errorDetail(e));
      // §28/§9：原始异常只进服务端日志，带 run_id 与失败阶段
      logger.child({ run_id: rid }).error(`run failed at ${ctx.current_stage ?? "unknown"}`, e);
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
        e,
      );
    }
  }

  /**
   * §19/§20 单次 Attempt：Generate → Save Story → Validate → Review → RetryDecision。
   * v0.8.0 在判定未过之后插入 Repair-before-Retry（§20/§33）：
   *   未过 + 有可修问题 + 允许修订 → Repair → Revalidate → Re-review → 再判一次
   *   仍不过 → 交给外层 Attempt 循环做 Full Retry；没有可修问题 → 直接 Full Retry。
   * §12 Reviewer / Validator 自身异常不升级为 Story 失败，只记录各自 status。
   * §17 Repair 全程挂在这一个 attempt_number 下，不新增 GenerationAttempt。
   */
  private async runAttempt(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    plan: BeatPlan,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    attemptNumber: number,
  ): Promise<AttemptRecord> {
    let story: string | null = null;
    let generationError: string | null = null;
    let generationFailure: unknown = null;

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
      generationFailure = e;
      // §28/§9：原始异常只进服务端日志
      logger.child({ run_id: rid, attempt_number: attemptNumber }).error("generation failed", e);
    }

    // §17：先保存 Story，再 Validate / Review。
    if (story !== null) {
      transitionStage(ctx, "saving", "saving");
      this.artifactStore.putAttemptStory(rid, attemptNumber, config.title, story);
    }

    let check: StoryCheck = {
      validation: null,
      validation_status: "not_started",
      validation_error: null,
      review: null,
      review_status: "not_started",
      review_error: null,
    };
    let decision: RetryDecision;
    let repairs: RepairRecord[] = [];

    if (story === null) {
      // §22 生成失败：没有正文可校验，也没有正文可修订——直接交给重试决策。
      decision = decideRetry({
        policy,
        attempt_number: attemptNumber,
        generation_error: generationError,
        validation: null,
        review: null,
      });
    } else {
      check = await this.checkStory(ctx, rid, config, story, attemptNumber, runtime, policy, {
        stage: "validating",
        reviewStage: "reviewing",
      });
      decision = this.decide(policy, attemptNumber, generationError, check);

      // §20 Repair-before-Retry：先试着定点修订，修不动才整篇重生。
      // 已经满足策略的 Attempt 什么都不动（§21：Accept 只由 decideRetry 产生）。
      if (decision.reason !== null && this.canRepair(policy)) {
        const repaired = await this.repairLoop(
          ctx, rid, config, plan, story, attemptNumber, runtime, policy, check, decision,
        );
        story = repaired.story;
        check = repaired.check;
        decision = repaired.decision;
        repairs = repaired.repairs;
      }
    }

    // §5/§16：accepted 表示这一次满足了策略，与 retry_reason 互斥。
    // 到达 max_attempts 但质量仍未通过时 should_retry=false、reason 非空 → 不算采纳。
    const accepted = decision.reason === null;
    const attemptError = generationError ?? check.validation_error ?? check.review_error;

    // §24 Attempt metadata：编号 / 是否被接受 / 重试原因 / 分数 / 校验结论 / 修订记录（§17）。
    this.artifactStore.putAttemptMetadata(rid, attemptNumber, {
      attempt_number: attemptNumber,
      accepted,
      retry_reason: decision.reason,
      review_score: check.review ? check.review.score : null,
      validation_passed: check.validation ? check.validation.passed : null,
      validation_status: check.validation_status,
      review_status: check.review_status,
      repair_count: repairs.length,
      repairs,
      ...(check.validation_error ? { validation_error: check.validation_error } : {}),
      ...(check.review_error ? { review_error: check.review_error } : {}),
      ...(attemptError ? { error: attemptError } : {}),
    });

    return {
      attempt: {
        attempt_number: attemptNumber,
        story,
        validation: check.validation,
        review: check.review,
        accepted,
        retry_reason: decision.reason,
        error: attemptError,
        repairs,
      },
      validation_status: check.validation_status,
      validation_error: check.validation_error,
      review_status: check.review_status,
      review_error: check.review_error,
      failure: generationFailure,
    };
  }

  /** §18：没有 Repairer、策略关闭、或上限为 0 时，Attempt 流程与 v0.7.0 完全一致（§51-E）。 */
  private canRepair(policy: RetryPolicy): boolean {
    return (
      this.repairer !== undefined && policy.enable_repair && policy.max_repairs_per_attempt > 0
    );
  }

  /** §11 质量判定：组件自身异常只作废对应那一路判据，与 v0.7.0 语义一致。 */
  private decide(
    policy: RetryPolicy,
    attemptNumber: number,
    generationError: string | null,
    check: StoryCheck,
  ): RetryDecision {
    return decideRetry({
      policy,
      attempt_number: attemptNumber,
      generation_error: generationError,
      validator_error: check.validation_status === "failed",
      reviewer_error: check.review_status === "failed",
      validation: check.validation,
      review: check.review,
    });
  }

  /**
   * §15/§16 Validate → Review。初始校验与修订后复核只有阶段名不同
   * （validating/reviewing → revalidating/rereviewing，§35），判定规则完全同一套。
   * §29 产物落点由 repairNumber 决定：修订后写 repairs/NN/，初始写 attempt 根目录。
   */
  private async checkStory(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    story: string,
    attemptNumber: number,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    stages: { stage: RunStatus; reviewStage: RunStatus },
    repairNumber?: number,
  ): Promise<StoryCheck> {
    let validation: ValidationResult | null = null;
    let validationStatus: ValidationStatus = "not_started";
    let validationError: string | null = null;

    transitionStage(ctx, stages.stage, stages.stage);
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
      this.putCheck(rid, attemptNumber, repairNumber, "validation.json", validation);
      validationStatus = "completed";
    } catch (e) {
      // §12：Validator 自身异常 ≠ Story Failed。
      validation = null;
      validationStatus = "failed";
      validationError = safeDetail(errorDetail(e));
      logger.child({ run_id: rid, attempt_number: attemptNumber }).error("validation failed", e);
    }

    let review: ReviewResult | null = null;
    let reviewStatus: ReviewStatus = "not_started";
    let reviewError: string | null = null;

    // §16/§34：Review 失败不丢弃已生成的正文，也不把 Run 判为失败。
    // §18：EMPTY_CONTENT 时没有可审阅内容，跳过 Review。
    if (!skipReviewFor(validation)) {
      transitionStage(ctx, stages.reviewStage, stages.reviewStage);
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
        this.putCheck(rid, attemptNumber, repairNumber, "review.json", review);
        reviewStatus = "completed";
      } catch (e) {
        // §12：Reviewer 自身异常 ≠ Story Retry Trigger。
        review = null;
        reviewStatus = "failed";
        reviewError = safeDetail(errorDetail(e));
        logger.child({ run_id: rid, attempt_number: attemptNumber }).error("review failed", e);
      }
    }

    return {
      validation,
      validation_status: validationStatus,
      validation_error: validationError,
      review,
      review_status: reviewStatus,
      review_error: reviewError,
    };
  }

  /** §29：同一份校验 / 审阅结论，按是否属于某次 Repair 决定落盘位置。 */
  private putCheck(
    rid: string,
    attemptNumber: number,
    repairNumber: number | undefined,
    filename: string,
    data: ValidationResult | ReviewResult,
  ): void {
    if (repairNumber === undefined) {
      if (filename === "validation.json") {
        this.artifactStore.putAttemptValidation(rid, attemptNumber, data as ValidationResult);
      } else {
        this.artifactStore.putAttemptReview(rid, attemptNumber, data as ReviewResult);
      }
      return;
    }
    if (filename === "validation.json") {
      this.artifactStore.putRepairValidation(rid, attemptNumber, repairNumber, data as ValidationResult);
    } else {
      this.artifactStore.putRepairReview(rid, attemptNumber, repairNumber, data as ReviewResult);
    }
  }

  /**
   * §20/§33 Repair-before-Retry 主循环。
   * §14：一次只修一个主要问题。§19：次数上限来自 max_repairs_per_attempt，绝不无限修。
   * §21：是否 Accepted 每一轮都重新交给 decideRetry，不另立 Acceptance 规则。
   *
   * 返回这个 Attempt 的最终状态：修订后的正文 + 最后一轮的校验 / 审阅结论 + 判定。
   * 修订失败或修完仍不过时保留最后一版正文（通常比初始版本更接近可接受），
   * 是否整篇重生由外层 Attempt 循环决定。
   */
  private async repairLoop(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    plan: BeatPlan,
    story: string,
    attemptNumber: number,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    initialCheck: StoryCheck,
    initialDecision: RetryDecision,
  ): Promise<{ story: string; check: StoryCheck; decision: RetryDecision; repairs: RepairRecord[] }> {
    const repairer = this.repairer as StoryRepairer;
    let current = story;
    let check = initialCheck;
    let decision = initialDecision;
    const repairs: RepairRecord[] = [];

    // §19：循环上界就是策略里的 max_repairs_per_attempt，写进条件里就不可能无限修。
    while (repairs.length < policy.max_repairs_per_attempt) {
      const target = this.repairStrategy.choose(check.validation, check.review);
      // §22：EMPTY_CONTENT / INVALID_OUTPUT / 没有可归类的问题 → 不修，直接 Full Retry。
      if (!target) break;

      const repairNumber = repairs.length + 1;
      const beforeValidation = check.validation;
      const beforeScore = check.review ? check.review.score : null;

      // §30：初始正文只在第一次修订前保存；attempt 根目录的 story.md 始终是最新版。
      if (repairs.length === 0) {
        this.artifactStore.putAttemptInitialStory(rid, attemptNumber, config.title, current);
      }
      // §31：修订请求先落盘，再接 LLM——中断后也看得出这次想修什么。
      this.artifactStore.putRepairRequest(rid, attemptNumber, {
        repair_number: repairNumber,
        issue_type: target.issue_type,
        issue_message: target.issue_message,
      });

      transitionStage(ctx, `Attempt ${attemptNumber} — Repairing`, "repairing");
      const outcome = await repairer.repair(repairRequestOf(target, current, config, plan));

      if (!outcome.success) {
        // §22：LLM 异常或空输出 = 没修好。正文与结论保持修订前的样子，交给 Full Retry。
        repairs.push({
          repair_number: repairNumber,
          issue_type: target.issue_type,
          issue_message: target.issue_message,
          before_validation: beforeValidation,
          after_validation: null,
          before_review_score: beforeScore,
          after_review_score: null,
          success: false,
        });
        this.artifactStore.putRepairMetadata(rid, attemptNumber, repairNumber, {
          repair_number: repairNumber,
          issue_type: target.issue_type,
          success: false,
          before_review_score: beforeScore,
          after_review_score: null,
          before_validation_passed: beforeValidation ? beforeValidation.passed : null,
          after_validation_passed: null,
        });
        logger
          .child({ run_id: rid, attempt_number: attemptNumber, repair_number: repairNumber })
          .error("repair failed", outcome.notes ?? "未给出原因");
        break;
      }

      // §15/§16：修订成功 ≠ 通过。必须重新 Validate + Review 才知道有没有真的修好。
      const after = await this.checkStory(
        ctx, rid, config, outcome.repaired_story, attemptNumber, runtime, policy,
        { stage: "revalidating", reviewStage: "rereviewing" },
        repairNumber,
      );
      current = outcome.repaired_story;
      check = after;
      decision = this.decide(policy, attemptNumber, null, check);
      const success = decision.reason === null;
      // §9：修订结束记一条 run/attempt/repair 级日志，成没成都能定位到第几次修订
      logger
        .child({ run_id: rid, attempt_number: attemptNumber, repair_number: repairNumber })
        .info(`repair completed（${target.issue_type}）→ ${success ? "accepted" : "still failing"}`);

      repairs.push({
        repair_number: repairNumber,
        issue_type: target.issue_type,
        issue_message: target.issue_message,
        before_validation: beforeValidation,
        after_validation: after.validation,
        before_review_score: beforeScore,
        after_review_score: after.review ? after.review.score : null,
        success,
      });

      // §30：attempt 根目录的 story.md 代表这个 Attempt 的最终版本 = 修订后版本。
      this.artifactStore.putAttemptStory(rid, attemptNumber, config.title, current);
      // §29：修订后的正文在 repairs/NN/story.md 里也留一份。
      this.artifactStore.putRepairStory(rid, attemptNumber, repairNumber, config.title, current);
      // §32：只记录这次修订的前后对比，不做历史 Repair Analytics。
      this.artifactStore.putRepairMetadata(rid, attemptNumber, repairNumber, {
        repair_number: repairNumber,
        issue_type: target.issue_type,
        success,
        before_review_score: beforeScore,
        after_review_score: after.review ? after.review.score : null,
        before_validation_passed: beforeValidation ? beforeValidation.passed : null,
        after_validation_passed: after.validation ? after.validation.passed : null,
      });

      if (success) break;
    }

    return { story: current, check, decision, repairs };
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
    // §18：Repair 策略同样落 metadata，中断后看得出当时允不允许修、最多修几次。
    if (patch.enable_repair !== undefined) meta.enable_repair = patch.enable_repair;
    if (patch.max_repairs_per_attempt !== undefined) {
      meta.max_repairs_per_attempt = patch.max_repairs_per_attempt;
    }
    if (patch.repair_count !== undefined) meta.repair_count = patch.repair_count;
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
