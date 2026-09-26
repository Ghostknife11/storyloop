import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type {
  BeatValidationResult,
  BeatValidationStatus,
} from "@/types/beat-validation";
import { reviewOverallScore, type ReviewResult, type ReviewStatus } from "@/types/review-result";
import type { ValidationResult, ValidationStatus } from "@/types/validation-result";
import type { RunContext, RunStatus } from "@/core/run-context";
import { createRunContext, transitionStage, failRun } from "@/core/run-context";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import {
  commercialOverallScore,
  type CommercialReviewResult,
  type CommercialReviewStatus,
} from "@/types/commercial-review";
import { BeatValidator } from "@/lib/beat-validator";
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
import { QualityAssembler } from "@/core/quality-assembler";
import type { QualityResult } from "@/types/quality";
import { logger } from "@/lib/logger";
import { safeText } from "@/lib/safe-text";
import { llmSettings } from "@/lib/app-config";
import { LLMTimeoutError } from "@/lib/llm";
import { isStageName } from "@/types/telemetry";
import { TelemetryCollector, type TelemetryErrorCode } from "@/core/telemetry-collector";
import type { RunTelemetry } from "@/types/telemetry";
import { projectVersion as readProjectVersion } from "@/lib/version";
import type { RunManifest, ExperimentProvenance } from "@/types/run-manifest";
import { buildRunManifest, type ManifestAttemptInput } from "@/lib/tracking/manifest-builder";
import { analyzeStoredRun, failureAnalysisMetadataPatch } from "@/lib/failure-analysis-service";
import type { FailureAnalysisResult } from "@/types/failure-analysis";
import { errorCodesOf } from "@/lib/failure-rules";

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
  /** v1.4.0 §4：BeatPlan 的结构校验结论；没注入 BeatValidator 时是 null。 */
  beat_validation: BeatValidationResult | null;
  beat_validation_status: BeatValidationStatus;
  /** v1.4.1 §26：BeatValidator 自身异常时的安全摘要；与 validation_error / review_error 同口径。
   *  只校验这一步跳过（没有注入 BeatValidator）时是 null。 */
  beat_validation_error: string | null;
  story: string;
  validation: ValidationResult | null;
  validation_status: ValidationStatus;
  validation_error: string | null;
  review: ReviewResult | null;
  review_status: ReviewStatus;
  review_error: string | null;
  /** v1.5.0 TASK §13/§16：入选 Attempt 的商业可读性结论；没接这一步或它自身失败时为 null。 */
  commercial_review: CommercialReviewResult | null;
  commercial_review_status: CommercialReviewStatus;
  /** v1.5.0 TASK §24：CommercialReviewer 自身异常时的安全摘要；没跑这一步时是 null。 */
  commercial_review_error: string | null;
  /** v1.2.0 §4：入选 Attempt 的统一质量快照，与 story 是同一份正文的结论。 */
  quality: QualityResult;
  attempt_count: number;
  selected_attempt: number;
  quality_status: QualityStatus;
  attempts: GenerationAttempt[];
  status: string;
  artifacts: Record<string, string>;
  started_at: string;
  finished_at: string;
  /** v1.6.0 这次 Run 的出身清单（run-manifest.json 的同一内容）。
   *  只在本进程里拼得出来、也写进去了才有；写盘失败时是 null，但不影响 Run 结果。 */
  manifest: RunManifest | null;
}

/** §27/§28/§67 安全错误信息：node:fs 的异常文本带服务器绝对路径，LLM/HTTP 客户端的
 *  异常文本可能带回请求头，两者都不该进用户可见的 message / metadata。
 *  规则统一放在 src/lib/safe-text.ts，与 toApiError 共用一份，不各写一套正则。 */
function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * v1.8.0 异常 → 稳定错误码（§22）。
 *
 * 与 api-error.ts 的 toApiError 是同一套判定的两个出口：先看最内层异常
 * （LLM 失败要保留专属码），再看 PipelineError 的阶段壳。码表不同——
 * 遥测这边只记「哪一类失败」，不记 HTTP 状态码那一套。
 * 于是同一个失败在 API 响应里是 LLM_TIMEOUT，在 telemetry.json 里也是 LLM_TIMEOUT，
 * 两边对得上；异常原文一个字都不进产物（§22）。
 */
export function telemetryCodeOf(e: unknown): TelemetryErrorCode {
  let current: unknown = e;
  const seen = new Set<unknown>();
  while (current instanceof PipelineError && current.cause !== undefined && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  if (current instanceof LLMTimeoutError) return "LLM_TIMEOUT";
  if (current instanceof Error) {
    if (current.message.includes("内容为空")) return "LLM_EMPTY_RESPONSE";
    if (current.name === "LLMRequestError") return "LLM_REQUEST_FAILED";
    if (current.name === "LLMTimeoutError") return "LLM_TIMEOUT";
    switch (current.name) {
      case "BeatParseError":
        return "GENERATION_FAILED";
      case "ReviewParseError":
        return "REVIEW_COMPONENT_FAILED";
      case "CommercialReviewParseError":
      case "CommercialReviewValidationError":
        return "COMMERCIAL_REVIEW_COMPONENT_FAILED";
      case "ValidatorError":
        return "VALIDATION_COMPONENT_FAILED";
      case "BeatValidationParseError":
      case "BeatValidationValidationError":
        return "BEAT_VALIDATION_COMPONENT_FAILED";
      case "ArtifactWriteError":
        return "ARTIFACT_WRITE_FAILED";
    }
  }
  // 骨架没过是流程给出的结论，不是异常——阶段壳上能认出来（§13）
  if (e instanceof PipelineError) {
    if (e.stage === "validating_beat_plan") return "BEAT_PLAN_REJECTED";
    if (e.stage === "planning") return "GENERATION_FAILED";
    return "GENERATION_FAILED";
  }
  return "RUN_FAILED";
}

/**
 * v1.9.1 阶段收尾用的稳定码：异常链上认得出就用它的码，认不出就用这一步自己的码。
 *
 * 「这一步自己」指非阻断失败：模型跳超时归 LLM_TIMEOUT，校验组件自己抛了个普通异常
 * 归 VALIDATION_COMPONENT_FAILED——都不是 RUN_FAILED，那是一个 Run 兜底码，
 * 安在单独一个阶段上会让人以为整次 Run 都说不清是什么毛病。
 */
function stageFailureCode(e: unknown, fallback: TelemetryErrorCode): TelemetryErrorCode {
  const code = telemetryCodeOf(e);
  return code === "RUN_FAILED" ? fallback : code;
}

/** §18 EMPTY_CONTENT 时没有可审阅的正文，跳过 Review；其它失败仍继续（§18 推荐）。 */
function skipReviewFor(validation: ValidationResult | null): boolean {
  if (!validation) return false;
  return validation.issues.some((i) => i.code === "EMPTY_CONTENT");
}

/** §22 成功 Run 的产物清单；validation.json / review.json / commercial-review.json
 *  只在各自成功时出现。 */
function artifactsOf(
  validation: ValidationResult | null,
  review: ReviewResult | null,
  quality: QualityResult | null = null,
  // v1.4.0 §20：beat-validation.json 是运行级产物，只在实际校验过时出现
  beatValidation: BeatValidationResult | null = null,
  // v1.5.0 TASK §16：commercial-review.json 只在商业审阅成功时出现
  commercialReview: CommercialReviewResult | null = null,
): Record<string, string> {
  const artifacts: Record<string, string> = {
    config: "config.json",
    beat_plan: "beats.json",
    story: "story.md",
    metadata: "metadata.json",
  };
  if (beatValidation) artifacts.beat_validation = "beat-validation.json";
  if (validation) artifacts.validation = "validation.json";
  if (review) artifacts.review = "review.json";
  // v1.2.0 §20：quality.json 与 metadata 同口径（修订后），装配过就一定有这个文件
  if (quality) artifacts.quality = "quality.json";
  // v1.5.0 TASK §16：商业结论与 quality.json 同口径——跑成了才有这个文件
  if (commercialReview) artifacts.commercial_review = "commercial-review.json";
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
  /**
   * v1.4.0 additive：BeatPlan 结构校验。写入时派生出 beat_validation_passed /
   * beat_validation_issue_count 两个字段——与 validation_* 同一套派生方式，不新增口径。
   */
  beat_validation_status?: BeatValidationStatus;
  beat_validation?: BeatValidationResult | null;
  beat_validation_error?: string | null;
  review_status?: ReviewStatus;
  review_error?: string | null;
  review?: ReviewResult | null;
  /**
   * v1.5.0 TASK §33 additive：商业可读性审阅。写入时派生出 commercial_score——
   * 与 review_score / overall_score 同一套派生方式，不新增口径。
   */
  commercial_review_status?: CommercialReviewStatus;
  commercial_review?: CommercialReviewResult | null;
  commercial_review_error?: string | null;
  /**
   * v1.2.0 §28 additive：统一质量快照。写入时派生出 quality_assembly_status /
   * overall_score / quality_issue_count 三个字段——不复用已被 accepted / exhausted
   * 占用的 quality_status（§29）。
   */
  quality?: QualityResult | null;
  /**
   * v1.8.0 §33 additive：两个摘要数，主数据源仍是 telemetry.json。
   * 只在 Run 收尾时写（那时才知道全程多久、一共调了几次）。
   */
  duration_ms?: number | null;
  llm_call_count?: number | null;
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
  /** v1.2.0：这次 Attempt 的最终质量快照（发生过修订时就是修订后那一轮）。 */
  quality: QualityResult;
  validation_status: ValidationStatus;
  validation_error: string | null;
  review_status: ReviewStatus;
  review_error: string | null;
  /** v1.5.0 TASK §13/§18：这次 Attempt 最终留下的那一版正文的商业可读性结论。 */
  commercial_review: CommercialReviewResult | null;
  commercial_review_status: CommercialReviewStatus;
  commercial_review_error: string | null;
  /** 生成阶段原始异常：只用于错误码映射（§11），绝不写入任何产物或响应。 */
  failure?: unknown;
}

/**
 * v1.4.0 一次 BeatPlan 结构校验的结论。BeatValidator 自身异常只影响 beat_validation_status
 * （§12），不升级为 Run 失败；只有结论里带 error 级 issue 时才阻断整个 Run（§7）。
 */
interface BeatCheck {
  beat_validation: BeatValidationResult | null;
  beat_validation_status: BeatValidationStatus;
  beat_validation_error: string | null;
}

/** v1.4.0 §5：没注入 BeatValidator 时这一路等于不存在，metadata 里一个字段都不多。 */
const BEAT_CHECK_SKIPPED: BeatCheck = {
  beat_validation: null,
  beat_validation_status: "not_started",
  beat_validation_error: null,
};

function beatCheckPatch(check: BeatCheck): Partial<MetaPatch> {
  const patch: Partial<MetaPatch> = {
    beat_validation_status: check.beat_validation_status,
    beat_validation: check.beat_validation,
  };
  if (check.beat_validation_error) patch.beat_validation_error = check.beat_validation_error;
  return patch;
}

/**
 * v1.5.0 TASK §24 一次商业可读性审阅的结论。CommercialReviewer 自身异常只让
 * commercial_review_status 变成 failed（与 §12 的 Reviewer / Validator 同一约定）：
 * 已生成的正文、校验结论、质量快照一个都不动，也不触发重试或修订。
 */
interface CommercialCheck {
  commercial_review: CommercialReviewResult | null;
  commercial_review_status: CommercialReviewStatus;
  commercial_review_error: string | null;
}

/** v1.5.0 TASK §5：没注入 CommercialReviewer 时这一路等于不存在，只留一个 not_started。 */
const COMMERCIAL_CHECK_SKIPPED: CommercialCheck = {
  commercial_review: null,
  commercial_review_status: "not_started",
  commercial_review_error: null,
};

/** v1.5.0 TASK §33：commercial_review_status 始终落盘（与 beat_validation_status 同约定），
 *  其余两个字段只在真的有结论 / 真的有错误时才出现，不写 null 占位。 */
function commercialCheckPatch(check: CommercialCheck): Partial<MetaPatch> {
  const patch: Partial<MetaPatch> = {
    commercial_review_status: check.commercial_review_status,
    commercial_review: check.commercial_review,
  };
  if (check.commercial_review_error) patch.commercial_review_error = check.commercial_review_error;
  return patch;
}

/**
 * v1.5.1 失败路径专用：只写这一步**到底跑没跑成**，不写结论本体。
 *
 * Run 失败时 promote 从未执行，运行根目录没有 commercial-review.json，所以这里不能带上
 * `commercial_review`——那会让 metadata 的 `artifacts` 索引列出一个不存在的文件，
 * 也会让 `commercial_score` 凭空出现。
 *
 * 但状态必须是真的：v1.5.0 首发时这里硬写 `COMMERCIAL_CHECK_SKIPPED`，于是「第一次尝试
 * 商业审阅跑成了、第二次尝试生成失败」的 Run，metadata 会声称这一步从没跑过，
 * 而 attempts/01/commercial-review.json 就在磁盘上。用假的 not_started 掩盖已经发生过的
 * 一步，比少写一个字段更糟：读接口与 UI 都据此把整个面板藏掉。
 */
function commercialStatusPatch(check: CommercialCheck): Partial<MetaPatch> {
  const patch: Partial<MetaPatch> = { commercial_review_status: check.commercial_review_status };
  if (check.commercial_review_error) patch.commercial_review_error = check.commercial_review_error;
  return patch;
}

/**
 * §3/§25 GenerationPipeline：把一次完整生成组织成一个 Run。
 * v0.7.0 固定顺序（§19）：
 *   Config → Planning → [ Attempt n: Generate → Save Story → Validate → Review → Decide → Retry? ] → Finalize
 * v0.8.0 在 Attempt 内部插入 Repair-before-Retry（§20/§33）：
 *   Generate → Save Story → Validate → Review → 未过且有可修问题且允许修订
 *   → Repair → Revalidate → Re-review → 再判一次 → 仍不过才 Full Retry。
 * v1.4.0 在 Planning 之后、Attempt 之前插入 BeatPlan 结构校验：
 *   Config → Planning → Validate BeatPlan → [ Attempt n: … ] → Finalize。
 * v1.5.0 在 Attempt 内部、基础审阅之后插入商业可读性审阅：
 *   … → Validate → Review → Commercial Review → Decide。
 * §8/§9：BeatPlan 与 StoryConfig 只确定一次，同一 Run 内所有 Attempt 复用，
 * 不自动换 Model / 改温度 / 改 Config（§70）。Repair 与 Beat 校验同样不碰它们（§65）。
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
    /** v1.2.0 统一质量装配：纯函数、不调 LLM、不碰文件系统；不注入时用默认实例。 */
    private qualityAssembler: QualityAssembler = new QualityAssembler(),
    /** §42 版本号单一来源：VERSION 文件（§43），不在代码里硬编码。 */
    private projectVersion: string = readProjectVersion(),
    /** v1.4.0 §5 可选：不注入就完全没有 BeatPlan 结构校验，流程与 v1.3.0 逐字一致。 */
    private beatValidator?: BeatValidator,
    /** v1.5.0 TASK §5/§12 可选：不注入就完全没有商业可读性审阅，流程与 v1.4.0 逐字一致。
     *  与 BasicReviewer 是两个独立审阅者，不共用 Prompt、不共用结论。 */
    private commercialReviewer?: CommercialReviewer,
    /**
     * v1.8.0 可观测性采集器：一个 Run 一个。默认自带一个实例——
     * 于是「记不记遥测」不是 Pipeline 的开关，遥测永远在记；接不接只决定
     * LLM 调用数从哪儿来（§19 统一入口在共享客户端上）。
     */
    private telemetry: TelemetryCollector = new TelemetryCollector(),
  ) {}

  /** §6 Automatic：StoryConfig → Plan → 若干 Attempt → 选中的那一个。 */
  async run(
    config: StoryConfig,
    runtime?: GenerateRuntime,
    retryPolicy?: RetryPolicy,
    /** v1.7.0：这次 Run 是某个受控实验的样本时带上实验出身；普通 Run 不传。 */
    experiment?: ExperimentProvenance,
  ): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, undefined, runtime, retryPolicy, experiment);
  }

  /** §29 Manual：用户编辑后的 BeatPlan 直接进入生成，仍形成一个 Run。 */
  async runWithPlan(
    config: StoryConfig,
    beatPlan: BeatPlan,
    runtime?: GenerateRuntime,
    retryPolicy?: RetryPolicy,
    /** v1.7.0 同 run()：实验样本的出身由调用方（实验执行器）传入。 */
    experiment?: ExperimentProvenance,
  ): Promise<GenerationResult> {
    return this.runStages(createRunContext(this.projectVersion), config, beatPlan, runtime, retryPolicy, experiment);
  }

  /**
   * v1.8.0 阶段推进的唯一入口：ctx 与遥测一起动（§17 低侵入）。
   *
   * 采集器不知道这一步该不该进、也不判断成败——它只按这个名字计时，
   * 收尾状态由 finish / failOpen 单独给。route 上「进下一个阶段」就等于
   * 「上一个阶段结束」，所以 Pipeline 不需要给每一步套 try/finally。
   *
   * completed / failed 是 RunStatus 但不是遥测阶段：它们结束整次 Run，
   * 由 finishTelemetry 统一结算，这里不另开一个阶段（否则会多出一条
   * 没有起点可归的尾巴）。
   */
  private enter(ctx: RunContext, stage: RunStatus, attemptNumber: number | null = null): void {
    transitionStage(ctx, stage, stage);
    if (isStageName(stage)) this.telemetry.enter(stage, attemptNumber);
  }

  /**
   * v1.8.0 telemetry.json：每次 Run 都写，失败的那次也写（§15）。
   *
   * 写完把这份遥测交回去，metadata 的两个摘要数（duration_ms / llm_call_count）
   * 直接取它的 totals——主数据源只有一个，不在这儿另算一套。
   * 写盘失败只留日志：可观测性缺失不能让一次成功的生成变成失败。
   */
  private finishTelemetry(
    rid: string,
    status: "completed" | "failed",
    failure?: { stage?: string | null; code?: string | null },
  ): RunTelemetry | null {
    try {
      const telemetry = this.telemetry.finish(status, failure);
      this.artifactStore.putTelemetry(rid, telemetry);
      return telemetry;
    } catch (e) {
      logger.child({ run_id: rid }).warning(`telemetry write failed: ${safeText(errorDetail(e))}`);
      return null;
    }
  }

  /**
   * v1.9.0 failure-analysis.json：每次 Run 都写，成功的那次也写（§27/§28）。
   *
   * 做法与遥测不同：这里不持有内存状态，而是**回头读盘**——metadata、
   * Manifest、遥测、各份结论文件都在盘上之后才分析。于是证据指向
   * validation.json，读者打开那个文件就能对上（§3/§48）。
   *
   * §29 分析器自身出错（或写盘失败）绝不让一次成功的 Run 变失败：
   * 只留一条 warning，metadata 里记 failure_analysis_status = unavailable，
   * **不写任何猜测出来的类别**。
   *
   * §30：顺手把两个摘要字段补进 metadata。补不上去也不影响分析本身。
   */
  private writeFailureAnalysis(rid: string, extraCodes: string[] = []): void {
    // 分析跑通、且真的落盘了，才算「有这份分析」。写盘失败同样按 unavailable 记——
    // metadata 说 detected 而盘上根本没有那份文件，比没有这个字段更糟。
    let analysis: FailureAnalysisResult | null = null;
    try {
      const produced = analyzeStoredRun(rid, this.artifactStore, extraCodes);
      this.artifactStore.putFailureAnalysis(rid, produced);
      analysis = produced;
    } catch (e) {
      logger
        .child({ run_id: rid })
        .warning(`failure analysis unavailable: ${safeText(errorDetail(e))}`);
    }
    try {
      const meta = this.artifactStore.readRunMetadata(rid);
      if (meta) {
        this.artifactStore.putMetadata(rid, {
          ...meta,
          ...failureAnalysisMetadataPatch(analysis),
        });
      }
    } catch (e) {
      logger
        .child({ run_id: rid })
        .warning(`failure analysis summary not written: ${safeText(errorDetail(e))}`);
    }
  }

  private async runStages(
    ctx: RunContext,
    config: StoryConfig,
    suppliedPlan: BeatPlan | undefined,
    runtime?: GenerateRuntime,
    retryPolicyArg?: RetryPolicy,
    /** v1.7.0 实验出身：一路带到 Manifest，不参与任何流程判断。 */
    experiment?: ExperimentProvenance,
  ): Promise<GenerationResult> {
    const rid = ctx.run_id;
    // v1.8.0：run_id 生成之后才补得上（采集器在 Pipeline 构造时就建好了）
    this.telemetry.bindRun(rid);
    let beatPlan: BeatPlan | undefined = suppliedPlan;
    const policy = validateRetryPolicy(retryPolicyArg ?? this.retryPolicy);
    const beatCheck: BeatCheck = { ...BEAT_CHECK_SKIPPED };
    // v1.5.1：与 beatCheck 同一套「跨 Attempt 记住最后一次真实结论」的可变持有者。
    // 缺了它，失败路径只能二选一：写一个假的 not_started，或者干脆不写这个字段。
    const commercialLast: CommercialCheck = { ...COMMERCIAL_CHECK_SKIPPED };
    // v1.6.0：提到 try 外面，失败路径才能把「已经跑过的 Attempt」如实写进 Manifest。
    let records: AttemptRecord[] = [];
    let selectedAttemptNumber: number | null = null;

    try {
      this.artifactStore.createRunDirectory(rid);
      this.artifactStore.putConfig(rid, config);

      this.enter(ctx, "planning");
      this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime, { ...policyPatch(policy) }));
      // §8：Plan once——不要每次 Retry 都重新规划。
      if (!beatPlan) {
        logger.child({ run_id: rid }).info("planning started");
        beatPlan = await this.planner.plan(config, runtime?.temperature ?? 0.7);
        logger.child({ run_id: rid }).info(`planning completed（${beatPlan.beats.length} beats）`);
      }
      this.artifactStore.putBeatPlan(rid, beatPlan);

      // v1.4.0 §7：BeatPlan 先过结构校验，再进入 Attempt 循环。
      // 骨架都站不住时不写正文——不产生 attempt 产物，也不消耗生成额度。
      await this.validateBeatPlan(ctx, rid, config, beatPlan, runtime, policy, beatCheck);

      // §19 重试循环：硬上限来自 policy.max_attempts（§15 禁止无限重试）。
      records = [];
      for (let attemptNumber = 1; attemptNumber <= policy.max_attempts; attemptNumber++) {
        const record = await this.runAttempt(ctx, rid, config, beatPlan, runtime, policy, attemptNumber, commercialLast);
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
      selectedAttemptNumber = selected.attempt.attempt_number;
      const qualityStatus: QualityStatus = selected.attempt.accepted ? "accepted" : "exhausted";
      // §40：Run 级 repair_count = 各 Attempt 修订次数之和（Repair 不新增 Attempt，§17）。
      const repairCount = records.reduce((sum, r) => sum + r.attempt.repairs.length, 0);

      // §23/§28：根目录 story.md / validation.json / review.json 对应 selected attempt。
      // v1.2.0 §57：quality.json 一起晋升，根目录快照因此与 selected attempt 逐字一致。
      // v1.5.0 TASK §39：commercial-review.json 同样跟着晋升，于是根目录那份商业结论
      // 描述的正是 selected attempt 的 story.md，不会张冠李戴。
      // v1.8.0：产物晋升是真实发生的一步，值得单独计时。它不是 RunStatus，
      // 所以 metadata 的 current_stage 不写它。
      // v1.9.1：但 current_stage 照样跟着推——它就是给人看的阶段标签（repairing
      // 那一步已经写过「Attempt N — Repairing」）。否则 promote 失败时，
      // 失败阶段只能指到上一个早就跑完的步骤，遥测里 artifact_promotion 记着
      // failed，failureStage 说的却是别的地方，两句话对不上。
      this.telemetry.enter("artifact_promotion");
      ctx.current_stage = "artifact_promotion";
      this.artifactStore.promoteAttempt(rid, selected.attempt.attempt_number);

      this.enter(ctx, "completed");
      // v1.8.0：先收遥测再写 metadata——两个摘要数从这里取，不另算一套
      const telemetry = this.finishTelemetry(rid, "completed");
      this.artifactStore.putMetadata(
        rid,
        this.metaFor(ctx, runtime, {
          ...policyPatch(policy),
          ...beatCheckPatch(beatCheck),
          ...commercialCheckPatch(selected),
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
          quality: selected.quality,
          duration_ms: telemetry?.totals.durationMs ?? null,
          llm_call_count: telemetry?.totals.llmCalls ?? null,
        }),
      );
      // v1.9.0：先落 Manifest 再读盘做失败分析——分析要能看到尝试与修订的出身（§27）
      const manifest = this.writeManifest(
        ctx,
        rid,
        runtime,
        policy,
        records,
        selectedAttemptNumber,
        experiment,
      );
      this.writeFailureAnalysis(rid);

      return {
        run_id: rid,
        config,
        beat_plan: beatPlan,
        beat_validation: beatCheck.beat_validation,
        beat_validation_status: beatCheck.beat_validation_status,
        beat_validation_error: beatCheck.beat_validation_error,
        story: selected.attempt.story ?? "",
        validation: selected.attempt.validation,
        validation_status: selected.validation_status,
        validation_error: selected.validation_error,
        review: selected.attempt.review,
        review_status: selected.review_status,
        review_error: selected.review_error,
        commercial_review: selected.commercial_review,
        commercial_review_status: selected.commercial_review_status,
        commercial_review_error: selected.commercial_review_error,
        quality: selected.quality,
        attempt_count: records.length,
        selected_attempt: selected.attempt.attempt_number,
        quality_status: qualityStatus,
        attempts: records.map((r) => r.attempt),
        status: "completed",
        artifacts: artifactsOf(
          selected.attempt.validation,
          selected.attempt.review,
          selected.quality,
          beatCheck.beat_validation,
          selected.commercial_review,
        ),
        started_at: ctx.started_at,
        finished_at: new Date().toISOString(),
        manifest,
      };
    } catch (e) {
      // §18/§19/§20：失败阶段可识别，已产出的文件不删除
      const detail = safeText(errorDetail(e));
      // §28/§9：原始异常只进服务端日志，带 run_id 与失败阶段
      logger.child({ run_id: rid }).error(`run failed at ${ctx.current_stage ?? "unknown"}`, e);
      failRun(ctx, ctx.current_stage ?? "unknown", detail);
      // v1.8.0 §15：失败 Run 也留遥测——已跑完的阶段原样保留，开着的那个按 failed 收尾，
      // failureStage 只记「在哪儿结束的」，不记为什么（§13/§60）。
      const telemetry = this.finishTelemetry(rid, "failed", {
        stage: ctx.current_stage ?? null,
        code: telemetryCodeOf(e),
      });
      try {
        this.artifactStore.putMetadata(
          rid,
          this.metaFor(ctx, runtime, {
            ...policyPatch(policy),
            ...beatCheckPatch(beatCheck),
            // v1.5.1：状态说真话（这步跑成了就是 completed、它自己失败了就是 failed、
            // 一次都没跑到才是 not_started），但不带结论本体——运行根目录那份文件
            // 要等 promote，而 promote 在失败路径上从未执行。
            ...commercialStatusPatch(commercialLast),
            duration_ms: telemetry?.totals.durationMs ?? null,
            llm_call_count: telemetry?.totals.llmCalls ?? null,
          }),
        );
      } catch {
        /* metadata 保存失败时保留原始错误 */
      }
      // v1.6.0：失败也要留下出身记录——「这个 Run 死在哪个版本、哪次 Attempt、用了什么参数」
      // 正是最需要查的一件事。此时没有 promote，运行根目录里只有 config / beats 与 attempt 级文件，
      // Manifest 如实只列这些（selectedAttemptId 不出现）。
      this.writeManifest(ctx, rid, runtime, policy, records, null, experiment);
      // v1.9.0：失败的 Run 也要有失败分析——它正是最需要分类的那一次（§27）。
      // 异常链上的真实错误码一并交给分析器（§40），遥测那边只记最内层一个。
      this.writeFailureAnalysis(rid, errorCodesOf(e));
      throw new PipelineError(
        ["Run", rid, "failed at", ctx.current_stage ?? "unknown", ":", detail].join(" "),
        rid,
        ctx.current_stage ?? "unknown",
        e,
      );
    }
  }

  /**
   * v1.6.0 出身清单：把这次 Run「跑在什么上面」收敛成 run-manifest.json，与 metadata.json 并列。
   *
   * 时机：所有已有产物都落盘之后（成功路径在 promote 之后、失败路径在 metadata 之后）。
   * 因此清单里的摘要是照磁盘上那一份文件现算的，不是拿内存里的对象猜的。
   *
   * 失败取舍：故事已经产出，记录出身不该把成功的 Run 判失败；但不悄悄吞掉，
   * 日志留告警，并返回 null 让调用方知道这份 Run 没有 Manifest。
   *
   * v1.7.0：experiment 原样进清单（不参与上面的判断，也不因它失败）。
   */
  private writeManifest(
    ctx: RunContext,
    runId: string,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    records: AttemptRecord[],
    selectedAttemptNumber: number | null,
    experiment?: ExperimentProvenance,
  ): RunManifest | null {
    const attempts: ManifestAttemptInput[] = records.map((r) => ({
      attemptNumber: r.attempt.attempt_number,
      accepted: r.attempt.accepted,
      retryReason: r.attempt.retry_reason,
      repairs: r.attempt.repairs.map((p) => ({
        repairNumber: p.repair_number,
        issueType: p.issue_type,
        success: p.success,
      })),
    }));
    try {
      const manifest = buildRunManifest(
        { runId, startedAt: ctx.started_at, runtime, policy, attempts, selectedAttemptNumber, experiment },
        this.artifactStore,
      );
      this.artifactStore.putManifest(runId, manifest);
      return manifest;
    } catch (e) {
      logger.child({ run_id: runId }).warning(`run manifest write failed: ${safeText(errorDetail(e))}`);
      return null;
    }
  }

  /**
   * v1.4.0 BeatPlan 结构校验（§7/§10）：只跑一次，位置在 Planning 之后、第一个 Attempt 之前。
   * §4 只校验、不修改——既不会自动重排 beat，也不会顺手补一拍再试。
   * §12 BeatValidator 自身异常（模型超时 / 输出非法）只让 beat_validation_status 变成 failed，
   *     生成照常继续，不把 Run 判失败。
   * §7 结论里带 error 级 issue 才算硬失败：此时一个 Attempt 都不跑。
   */
  private async validateBeatPlan(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    plan: BeatPlan,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    /** §7 结论先记进这个盒子再抛：硬失败时 runStages 的 catch 也要把它写进 metadata。 */
    out: BeatCheck,
  ): Promise<void> {
    // §5：没接这一步时如实记 skipped——「没接」与「坏了」是两件事
    if (!this.beatValidator) {
      this.telemetry.skip("validating_beat_plan");
      return;
    }

    this.enter(ctx, "validating_beat_plan");
    this.artifactStore.putMetadata(
      rid,
      this.metaFor(ctx, runtime, {
        ...policyPatch(policy),
        beat_validation_status: "validating",
      }),
    );

    let beatValidation: BeatValidationResult | null = null;
    let beatValidationError: string | null = null;
    try {
      // §10：与故事生成、审阅各自独立拿一份结论；这里不用 runtime.temperature，
      // 结构判断需要一个稳定的低温度，不跟着正文的创作温度走。
      beatValidation = await this.beatValidator.validate(config, plan);
    } catch (e) {
      // §12：校验器自身崩溃 ≠ BeatPlan 有问题。保留骨架，继续生成。
      // v1.9.1：这一步的非阻断失败也要在遥测里说实话——进入下一步之前先把开着的
      // 阶段按 failed 收尾，不然后面的 enter 会把它记成 completed。
      beatValidation = null;
      beatValidationError = safeText(errorDetail(e));
      this.telemetry.failOpen(stageFailureCode(e, "BEAT_VALIDATION_COMPONENT_FAILED"));
      logger.child({ run_id: rid }).error("beat validation failed", e);
    }

    out.beat_validation = beatValidation;
    out.beat_validation_status = beatValidation ? "completed" : "failed";
    out.beat_validation_error = beatValidationError;
    // §8：passed 与 failed 都落盘——骨架没过时更要能看出是哪儿没过。
    if (beatValidation) {
      this.artifactStore.putBeatValidation(rid, beatValidation);
      logger
        .child({ run_id: rid })
        .info(`beat validation completed → ${beatValidation.passed ? "passed" : "not passed"}（${beatValidation.issues.length} issues）`);
    }
    this.artifactStore.putMetadata(rid, this.metaFor(ctx, runtime, { ...policyPatch(policy), ...beatCheckPatch(out) }));

    if (beatValidation && !beatValidation.passed) {
      const codes = [...new Set(beatValidation.issues.map((i) => i.code))].join("、");
      throw new PipelineError(
        `Beat plan 结构校验未通过：${beatValidation.summary}${codes ? `（${codes}）` : ""}`,
        rid,
        "validating_beat_plan",
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
    /** v1.5.1 跨 Attempt 的真实状态持有者：与 beatCheck 同一个套路，由 runStages 传入并就地更新。 */
    commercialLast: CommercialCheck,
  ): Promise<AttemptRecord> {
    let story: string | null = null;
    let generationError: string | null = null;
    let generationFailure: unknown = null;

    // v1.8.0 §9：Attempt 的作用域从 entering generating 算起；编号与 attempts/NN 一致
    this.telemetry.beginAttempt(attemptNumber);
    this.enter(ctx, "generating", attemptNumber);
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
      // §22 生成失败：没有正文可校验，也没有正文可修订——直接交给重试决策。
      // v1.9.1：这一步以失败收尾；重试成功也不抹掉它发生过（遥测记的是事实）。
      generationError = safeText(errorDetail(e));
      generationFailure = e;
      this.telemetry.failOpen(stageFailureCode(e, "GENERATION_FAILED"));
      // §28/§9：原始异常只进服务端日志
      logger.child({ run_id: rid, attempt_number: attemptNumber }).error("generation failed", e);
    }

    // §17：先保存 Story，再 Validate / Review。
    if (story !== null) {
      this.enter(ctx, "saving", attemptNumber);
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
    // v1.5.0 TASK §13：这一次尝试的商业可读性结论。生成失败时没有正文可评，
    // 保持 skipped（一个字段都不多写，与 v1.4.0 的产物布局一致）。
    let commercial: CommercialCheck = { ...COMMERCIAL_CHECK_SKIPPED };

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

      commercial = await this.reviewCommercial(
        ctx, rid, config, story, attemptNumber, runtime, policy, check.validation,
      );
      // v1.5.1：不管这一步是跑成了、失败了还是被跳过，都把最后一次的真实结果记下来，
      // 失败路径的 metadata 要用它说实话。
      commercialLast.commercial_review = commercial.commercial_review;
      commercialLast.commercial_review_status = commercial.commercial_review_status;
      commercialLast.commercial_review_error = commercial.commercial_review_error;
    }

    // §5/§16：accepted 表示这一次满足了策略，与 retry_reason 互斥。
    // 到达 max_attempts 但质量仍未通过时 should_retry=false、reason 非空 → 不算采纳。
    const accepted = decision.reason === null;
    const attemptError = generationError ?? check.validation_error ?? check.review_error;

    // v1.2.0 §21/§56：Attempt 级质量快照取**最终**结论——修订后重新校验 / 审阅过的
    // 那一轮，因此它描述的正是这个 Attempt 最终留下的 story.md。
    // §7/§12：校验或审阅自身失败时对应字段是 null，不伪造结论。
    const quality = this.qualityAssembler.assemble({
      validation: check.validation,
      review: check.review,
      accepted,
    });
    this.artifactStore.putAttemptQuality(rid, attemptNumber, quality);

    // §24 Attempt metadata：编号 / 是否被接受 / 重试原因 / 分数 / 校验结论 / 修订记录（§17）。
    // v1.0.0 冻结字段（TASK §10）：error 始终存在，没有错误时是 null——
    // 有条件出现的字段会让「缺字段」与「没错误」无法区分。
    this.artifactStore.putAttemptMetadata(rid, attemptNumber, {
      attempt_number: attemptNumber,
      accepted,
      retry_reason: decision.reason,
      review_score: check.review ? reviewOverallScore(check.review) : null,
      validation_passed: check.validation ? check.validation.passed : null,
      validation_status: check.validation_status,
      review_status: check.review_status,
      repair_count: repairs.length,
      repairs,
      error: attemptError ?? null,
      ...(check.validation_error ? { validation_error: check.validation_error } : {}),
      ...(check.review_error ? { review_error: check.review_error } : {}),
      // §28/§29：与运行级 metadata 同一套派生字段。快照本体放在
      // attempts/NN/quality.json，这里只留摘要，不把整个 QualityResult 嵌进来。
      quality_assembly_status: "completed",
      overall_score: quality.overall_score,
      quality_issue_count: quality.issues.length,
    });

    // v1.8.0 §9：这一次 Attempt 的结局。生成失败 = 没跑出正文；未采纳 = 还会重试。
    this.telemetry.endAttempt(accepted ? "accepted" : story === null ? "failed" : "retried");

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
      quality,
      validation_status: check.validation_status,
      validation_error: check.validation_error,
      review_status: check.review_status,
      review_error: check.review_error,
      commercial_review: commercial.commercial_review,
      commercial_review_status: commercial.commercial_review_status,
      commercial_review_error: commercial.commercial_review_error,
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

    this.enter(ctx, stages.stage, attemptNumber);
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
      // v1.9.1：同样先把 validating 这一段按失败收尾，读者才看得出是这一步没得出结论
      validation = null;
      validationStatus = "failed";
      validationError = safeText(errorDetail(e));
      this.telemetry.failOpen(stageFailureCode(e, "VALIDATION_COMPONENT_FAILED"));
      logger.child({ run_id: rid, attempt_number: attemptNumber }).error("validation failed", e);
    }

    let review: ReviewResult | null = null;
    let reviewStatus: ReviewStatus = "not_started";
    let reviewError: string | null = null;

    // §16/§34：Review 失败不丢弃已生成的正文，也不把 Run 判为失败。
    // §18：EMPTY_CONTENT 时没有可审阅内容，跳过 Review。
    if (!skipReviewFor(validation)) {
      this.enter(ctx, stages.reviewStage, attemptNumber);
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
        // v1.9.1：reviewing 这一段按失败收尾，不冒充 completed
        review = null;
        reviewStatus = "failed";
        reviewError = safeText(errorDetail(e));
        this.telemetry.failOpen(stageFailureCode(e, "REVIEW_COMPONENT_FAILED"));
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

  /**
   * v1.5.0 TASK §13/§14 商业可读性审阅：Story → CommercialReviewer → CommercialReviewResult。
   * 位置在基础审阅之后（TASK §13），看的是调用方传进来的那一版正文——由调用方负责
   * 传入「这个 Attempt 最终留下的那一版」，于是 attempts/NN/commercial-review.json
   * 永远与同目录 story.md 严格对应（TASK §17/§18）。
   *
   * §14/§15 只 evaluate / persist：返回的结论不参与 decideRetry、不进 QualityResult、
   * 不改写正文。§24 这一路自身失败只让 commercial_review_status 变成 failed，
   * 已产出的正文 / 校验 / 质量结论一个都不动（§25：评价器失败不等于故事坏了）。
   */
  private async reviewCommercial(
    ctx: RunContext,
    rid: string,
    config: StoryConfig,
    story: string,
    attemptNumber: number,
    runtime: GenerateRuntime | undefined,
    policy: RetryPolicy,
    validation: ValidationResult | null,
  ): Promise<CommercialCheck> {
    // §18 同一条规矩：正文是空的就没有商业表现可评，这一步直接跳过。
    // 两种「没跑到」都如实记 skipped，与 metadata 的 not_started 同一个意思。
    if (!this.commercialReviewer || skipReviewFor(validation)) {
      this.telemetry.skip("reviewing_commercial", attemptNumber);
      return { ...COMMERCIAL_CHECK_SKIPPED };
    }

    this.enter(ctx, "reviewing_commercial", attemptNumber);
    this.artifactStore.putMetadata(
      rid,
      this.metaFor(ctx, runtime, {
        ...policyPatch(policy),
        attempt_number: attemptNumber,
        commercial_review_status: "reviewing",
      }),
    );

    let commercialReview: CommercialReviewResult | null = null;
    let commercialReviewError: string | null = null;
    try {
      // §11：与基础审阅同一份输入口径，但用独立 Prompt 与独立 schema。
      // 温度取 CommercialReviewer 自己的默认值，不跟着正文的创作温度走。
      commercialReview = await this.commercialReviewer.review(config, story);
    } catch (e) {
      // §24：这一路失败只让 commercial_review_status 变成 failed。
      // v1.9.1：reviewing_commercial 这一段同样按失败收尾
      commercialReview = null;
      commercialReviewError = safeText(errorDetail(e));
      this.telemetry.failOpen(stageFailureCode(e, "COMMERCIAL_REVIEW_COMPONENT_FAILED"));
      logger.child({ run_id: rid, attempt_number: attemptNumber }).error("commercial review failed", e);
    }

    // §16/§17：跑成了才落盘。失败时这个文件不出现，API 里对应字段是 null。
    if (commercialReview) {
      this.artifactStore.putAttemptCommercialReview(rid, attemptNumber, commercialReview);
    }
    const check: CommercialCheck = {
      commercial_review: commercialReview,
      commercial_review_status: commercialReview ? "completed" : "failed",
      commercial_review_error: commercialReviewError,
    };
    this.artifactStore.putMetadata(
      rid,
      this.metaFor(ctx, runtime, {
        ...policyPatch(policy),
        attempt_number: attemptNumber,
        ...commercialCheckPatch(check),
      }),
    );
    return check;
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
      const beforeScore = check.review ? reviewOverallScore(check.review) : null;

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

      // v1.8.0 §10：修订作用域从这一刻开到「重新校验 / 重新审阅也跑完」为止，
      // 于是 llmCalls 记的是这次修订引发的全部调用，不只是修正文那一次。
      this.telemetry.beginRepair(target.issue_type);
      transitionStage(ctx, `Attempt ${attemptNumber} — Repairing`, "repairing");
      this.telemetry.enter("repairing", attemptNumber);
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
        this.telemetry.endRepair("failed");
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
        after_review_score: after.review ? reviewOverallScore(after.review) : null,
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
        after_review_score: after.review ? reviewOverallScore(after.review) : null,
        before_validation_passed: beforeValidation ? beforeValidation.passed : null,
        after_validation_passed: after.validation ? after.validation.passed : null,
      });

      if (success) {
        this.telemetry.endRepair("success");
        break;
      }
      // 修是修出来了，但重新校验 / 审阅之后仍没过——与 repairs/NN/metadata.json 的
      // success=false 同一个口径（§21：采纳只由 decideRetry 说话）
      this.telemetry.endRepair("failed");
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
      // v1.0.0 冻结字段（TASK §9）：model 必须存在。取「本次调用真正生效的模型」——
      // 请求覆盖 → 环境变量 → 默认值，与 LLM 客户端用的是同一个解析结果。
      model: llmSettings({ model: runtime?.model }).model,
    };
    if (ctx.current_stage) meta.current_stage = ctx.current_stage;
    if (ctx.error) meta.error = ctx.error;
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
    // v1.4.0 additive：BeatPlan 结构校验的四个字段，与 validation_* 同口径
    if (patch.beat_validation_status) meta.beat_validation_status = patch.beat_validation_status;
    if (patch.beat_validation) {
      meta.beat_validation_passed = patch.beat_validation.passed;
      meta.beat_validation_issue_count = patch.beat_validation.issues.length;
    }
    if (patch.beat_validation_error) meta.beat_validation_error = patch.beat_validation_error;
    if (patch.review_status) meta.review_status = patch.review_status;
    if (patch.review_error) meta.review_error = patch.review_error;
    if (patch.review) meta.review_score = reviewOverallScore(patch.review);
    // v1.5.0 TASK §33：商业可读性审阅的三个字段，与 review_* 同一套派生方式。
    // commercial_review_status 与 beat_validation_status 一样始终落盘——
    // 读 metadata 就能看出这一步到底跑没跑过。
    if (patch.commercial_review_status) {
      meta.commercial_review_status = patch.commercial_review_status;
    }
    if (patch.commercial_review) {
      // §11：只有一个口径，就是四维均分，与 commercial-review.json 里的 score 一致
      meta.commercial_score = commercialOverallScore(patch.commercial_review);
    }
    if (patch.commercial_review_error) meta.commercial_review_error = patch.commercial_review_error;
    if (patch.quality) {
      // §28/§29：不复用 quality_status（它已经是 accepted / exhausted），
      // 统一质量层的状态另起 quality_assembly_status 这个名字。
      meta.quality_assembly_status = "completed";
      meta.overall_score = patch.quality.overall_score;
      meta.quality_issue_count = patch.quality.issues.length;
    }
    // v1.8.0 §33：两个摘要数是遥测的转述，主数据源是 telemetry.json。
    // 遥测没拿到（只在采集器本身坏掉的极端情况下）就不写这两个键，绝不补 0；
    // v1.9.1：调用方传 null 也按「没拿到」处理，于是注释里这句话对调用方也成立。
    if (patch.duration_ms != null) meta.duration_ms = patch.duration_ms;
    if (patch.llm_call_count != null) meta.llm_call_count = patch.llm_call_count;
    if (ctx.status === "completed" || ctx.status === "failed") {
      meta.finished_at = new Date().toISOString();
    }
    meta.artifacts = artifactsOf(
      patch.validation ?? null,
      patch.review ?? null,
      patch.quality ?? null,
      patch.beat_validation ?? null,
      patch.commercial_review ?? null,
    );
    return meta;
  }
}
