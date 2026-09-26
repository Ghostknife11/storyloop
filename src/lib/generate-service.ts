import { join } from "node:path";
import { clientFromEnv, LLMClient } from "@/lib/llm";
import { assertPublicBaseUrl } from "@/lib/url-guard";
import { validateStoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import { BeatValidator } from "@/lib/beat-validator";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { GenerationPipeline, type GenerationResult } from "@/core/pipeline";
import type { RunManifest } from "@/types/run-manifest";
import { ArtifactStore } from "@/storage/artifact-store";
import { logger } from "@/lib/logger";
import { appSettings } from "@/lib/app-config";
import { errorBody, toApiError, type ApiErrorBody } from "@/lib/api-error";
import { reviewOverallScore, type ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { RepairDetail, RepairIssueType, RepairResult, RepairSummary } from "@/types/repair";
import {
  repairDetail,
  repairRequestOf,
  repairSummary,
  validateRepairIssueType,
  validateRepairRecord,
} from "@/types/repair";
import {
  DEFAULT_RETRY_POLICY,
  RETRY_REASONS,
  validateRetryPolicy,
  type RetryPolicy,
  type RetryReason,
} from "@/core/retry-policy";
import {
  attemptSummary,
  validateAttemptNumber,
  type AttemptSummary,
} from "@/core/generation-attempt";
import { QualityAssembler } from "@/core/quality-assembler";
import { qualityResultOf, type QualityResult } from "@/types/quality";
import { TelemetryCollector } from "@/core/telemetry-collector";
import type { QualityStatus } from "@/core/pipeline";
import { projectVersion as readProjectVersion } from "@/lib/version";
import type { BeatValidationResult } from "@/types/beat-validation";
import type {
  CommercialReviewResult,
  CommercialReviewStatus,
} from "@/types/commercial-review";

export { ConfigValidationError, UnsupportedConfigVersionError } from "@/types/story-config";
export { LLMError } from "@/lib/llm";
export { BeatParseError } from "@/lib/beat-parser";
export { BeatPlanValidationError } from "@/types/beat-plan";
export { ReviewValidationError } from "@/types/review-result";
export { ReviewParseError } from "@/lib/review-parser";
export { ValidationValidationError } from "@/types/validation-result";
export { RepairValidationError } from "@/types/repair";
export { BeatValidationValidationError } from "@/types/beat-validation";
export { BeatValidationParseError } from "@/lib/beat-validation-parser";
export { CommercialReviewValidationError } from "@/types/commercial-review";
export { CommercialReviewParseError } from "@/lib/commercial-review-parser";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

export interface GenerateRuntime {
  model?: string;
  baseUrl?: string;
  temperature?: number;
}

/** §26 兼容：旧请求 {title, prompt} → premise + 默认 target_words。 */
function normalizeLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (typeof out.prompt === "string" && out.prompt.trim() && !out.premise) {
    out.genre = typeof out.genre === "string" && out.genre.trim() ? out.genre : "其他";
    out.premise = out.prompt;
  }
  if (typeof out.target_words !== "number" || !Number.isInteger(out.target_words)) {
    if (out.target_words === undefined || out.target_words === null || out.target_words === "") {
      out.target_words = 5000;
    }
  }
  return out;
}

function runtimeOf(raw: Record<string, unknown>): GenerateRuntime {
  return {
    model: typeof raw.model === "string" ? raw.model : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
  };
}

/**
 * 请求体里的 baseUrl 覆盖决定服务端把 LLM_API_KEY 发到哪里（clientFromEnv 把它作为
 * Bearer token 发出），所以真要建客户端之前先校验那个地址：不是 http/https，或指向
 * 本机 / 环回 / 私网 / 保留段的，一律按 400 CONFIG_INVALID 拒掉，一个字节都还没发。
 *
 * 注入了 llm（测试的假模型、调用方自带客户端）时这个地址根本用不到，也就不必校验——
 * 否则「服务端指向本地假模型」的联调用法会被自己挡掉。同理，运维在 LLM_BASE_URL
 * 里配的地址是受信配置，不走这里（它不来自请求体）。
 */
async function clientFor(
  runtime: GenerateRuntime,
  injected?: LLMClient,
  /** v1.8.0：真构造客户端时把采集器接上——注入进来的客户端是调用方自己的，不动它。 */
  telemetry?: TelemetryCollector,
): Promise<LLMClient> {
  if (injected) return injected;
  await assertPublicBaseUrl(runtime.baseUrl);
  return clientFromEnv(runtime, { telemetry });
}

/**
 * §28 POST /api/plan 的服务层：StoryConfig → BeatPlanner → BeatPlan。
 * §2：两个明确函数顺序工作，不是 GenerationPipeline。
 */
export async function planStory(
  body: unknown,
  llm?: LLMClient,
  planner?: BeatPlanner,
): Promise<{ status: number; json: BeatPlan | ApiErrorBody }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const config = validateStoryConfig(raw);
    const runtime = runtimeOf(raw);
    const p = planner ?? new BeatPlanner(
      await clientFor(runtime, llm),
      join(PROJECT_ROOT, "prompts", "beat_planner.txt"),
    );
    const plan = await p.plan(config, runtime.temperature ?? 0.7);
    return { status: 200, json: plan };
  } catch (e) {
    // §11/§12/§13：统一错误形状；堆栈只进服务端日志，响应里只有一句话
    const err = toApiError(e);
    logger.error(`plan failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

/** §32 v0.5.0 Run 响应：run_id / 状态 / 正文 / 评价 / 产物文件名，不返回本地绝对路径（§67）。
 *  v0.6.0 增加 validation / validation_status / validation_error（§26）。
 *  v0.7.0 增加 attempt_count / selected_attempt / quality_status / attempts（§38）。
 *  v0.8.0 增加 repair_count 与 attempts[].repairs 摘要（§40）。
 *  v1.2.0 增加 quality（§25）：新增的是统一质量层，原有字段一个不动。
 *  v1.4.0 增加 beat_validation / beat_validation_status（§26）：同样是纯追加。
 *  v1.5.0 增加 commercial_review / commercial_review_status（TASK §30）：同样是纯追加。 */
export interface RunOk {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  /** v1.4.0 §26：BeatPlan 结构校验结论；没跑这一步时为 null。 */
  beat_validation: BeatValidationResult | null;
  beat_validation_status: string;
  /** v1.4.1 §26：BeatValidator 自身异常时的安全摘要；
   *  只校验这一步跳过（没有注入 BeatValidator）时整个键不出现。 */
  beat_validation_error?: string;
  /** §26：硬性有效性检查结果；Validator 自身异常时为 null。 */
  validation: ValidationResult | null;
  validation_status: string;
  validation_error?: string;
  /** §28：Review 失败时为 null，但 story 仍然返回。 */
  review: ReviewResult | null;
  review_status: string;
  review_error?: string;
  /** §25/§26：统一质量快照。POST 响应里一定有；读旧 Run 的接口上它可能是 null。 */
  quality: QualityResult | null;
  /** v1.5.0 TASK §30：商业可读性结论；这一步跳过或它自身失败时为 null（故事本身不受影响）。 */
  commercial_review: CommercialReviewResult | null;
  commercial_review_status: CommercialReviewStatus;
  /** v1.5.0 TASK §24：CommercialReviewer 自身异常时的安全摘要；没跑这一步时整个键不出现。 */
  commercial_review_error?: string;
  artifacts: Record<string, string>;
  /** §16/§38：accepted = 某次 Attempt 满足策略；exhausted = 次数用尽仍未满足。 */
  quality_status: "accepted" | "exhausted";
  /** §7/§38：本次 Run 实际跑过的 Attempt 数量。 */
  attempt_count: number;
  /** §17/§38：最终采用的 Attempt 编号（exhausted 时为最后一次）。 */
  selected_attempt: number;
  /** §40：本次 Run 发生的定点修订总次数（Repair 不新增 Attempt）。 */
  repair_count: number;
  /** §38：只含摘要，不带完整正文。 */
  attempts: AttemptSummary[];
  /** v1.6.0 这次 Run 的出身清单（run-manifest.json 的同一内容）；写盘失败时是 null。 */
  manifest: RunManifest | null;
}

/** §11 统一错误响应体：{error:{code,message,run_id?,stage?}}。 */
export type RunError = ApiErrorBody;

export type RunResult = { status: number; json: RunOk | RunError };

/** §5 依赖注入：测试用 Mock LLM / 假 Planner / 假 Validator / 假 Reviewer，绝不打真实付费 API。 */
export interface RunDeps {
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
  /** v1.8.0：测试可注入自己的采集器；不注入就由 buildPipeline 新建一个。 */
  telemetry?: TelemetryCollector;
}

/**
 * §23 组装 GenerationPipeline。runs/ 根在调用时解析（而非模块加载时），
 * 让测试可以在临时目录里跑完整 Run。
 * §25 Writer 与 Reviewer 使用同一个 LLMClient——不引入 Reviewer Model / Model Router。
 * §3 Validator 是纯规则，不需要 LLM。
 * §9 Repairer 用同一个 LLMClient；不注入 Repairer 时 Pipeline 完全不修（§51-E）。
 * §44 TASK §44：CommercialReviewer 的 LLMClient 与其它组件走同一条安全构建路径
 * （clientFor → assertPublicBaseUrl → clientFromEnv），不另开一条不受校验的入口。
 * v1.8.0 §19：这一次 Run 的采集器在这里建，同时接给共享客户端与 Pipeline——
 * 于是 LLM 调用数从同一个 wrapper 出来，阶段归属由 Pipeline 的阶段推进决定。
 */
export async function buildPipeline(runtime: GenerateRuntime, deps: RunDeps = {}): Promise<GenerationPipeline> {
  const telemetry = deps.telemetry ?? new TelemetryCollector();
  const llm = await clientFor(runtime, deps.llm, telemetry);
  const planner = deps.planner ?? new BeatPlanner(
    llm,
    join(PROJECT_ROOT, "prompts", "beat_planner.txt"),
  );
  const generator = deps.generator ?? new StoryGenerator(
    llm,
    join(PROJECT_ROOT, "prompts", "story.txt"),
  );
  const validator = deps.validator ?? new StoryValidator();
  const reviewer = deps.reviewer ?? new BasicReviewer(
    llm,
    join(PROJECT_ROOT, "prompts", "reviewer.txt"),
  );
  const artifactStore = deps.artifactStore ?? new ArtifactStore(appSettings().runsDir);
  const repairer = deps.repairer ?? new StoryRepairer(
    llm,
    join(PROJECT_ROOT, "prompts", "repair.txt"),
  );
  const repairStrategy = deps.repairStrategy ?? new RepairStrategy();
  const beatValidator = deps.beatValidator ?? new BeatValidator(
    llm,
    join(PROJECT_ROOT, "prompts", "beat_validator.txt"),
  );
  // v1.5.0 TASK §12：商业审阅者与 BasicReviewer 分离，共用同一个 LLMClient。
  const commercialReviewer = deps.commercialReviewer ?? new CommercialReviewer(
    llm,
    join(PROJECT_ROOT, "prompts", "commercial_reviewer.txt"),
  );
  return new GenerationPipeline(
    planner, generator, validator, reviewer, artifactStore, DEFAULT_RETRY_POLICY,
    repairer, repairStrategy, new QualityAssembler(), readProjectVersion(), beatValidator,
    commercialReviewer, telemetry,
  );
}

function runOkOf(result: GenerationResult): RunOk {
  const ok: RunOk = {
    run_id: result.run_id,
    status: result.status,
    story: result.story,
    beat_plan: result.beat_plan,
    beat_validation: result.beat_validation,
    beat_validation_status: result.beat_validation_status,
    validation: result.validation,
    validation_status: result.validation_status,
    review: result.review,
    review_status: result.review_status,
    // v1.5.0 TASK §16/§30：商业可读性结论与结构审阅并列回传，互不覆盖
    commercial_review: result.commercial_review,
    commercial_review_status: result.commercial_review_status,
    quality: result.quality,
    artifacts: result.artifacts,
    quality_status: result.quality_status,
    attempt_count: result.attempt_count,
    selected_attempt: result.selected_attempt,
    // §40：Run 级 repair_count 由各 Attempt 的修订次数累加，不另建统计口径。
    repair_count: result.attempts.reduce((sum, a) => sum + a.repairs.length, 0),
    attempts: result.attempts.map(attemptSummary),
    // v1.6.0：出身清单与 run-manifest.json 一字不差，POST 直接就把它带回来
    manifest: result.manifest,
  };
  if (result.validation_error) ok.validation_error = result.validation_error;
  if (result.review_error) ok.review_error = result.review_error;
  // v1.4.1 §26：与 validation_error / review_error 同一套「有错误才带这个键」的约定
  if (result.beat_validation_error) ok.beat_validation_error = result.beat_validation_error;
  // v1.5.0 TASK §24：CommercialReviewer 自身异常时的摘要；没跑这一步时整个键不出现
  if (result.commercial_review_error) ok.commercial_review_error = result.commercial_review_error;
  return ok;
}

/** §37 retry_policy 在请求体里，不属于 StoryConfig；缺省用默认策略，越界一律 400。 */
function retryPolicyOf(raw: Record<string, unknown>): RetryPolicy {
  return validateRetryPolicy(raw.retry_policy ?? DEFAULT_RETRY_POLICY);
}

/** §28/§11 错误映射：阶段来自 PipelineError，用户拿得到失败阶段与 run_id。 */
function runFail(e: unknown): RunResult {
  const err = toApiError(e);
  logger.error(`run failed (${err.code})`, e);
  return { status: err.httpStatus, json: err.body() };
}

/** §6/§32 Automatic Run：StoryConfig → Config → Planning → Generation → Persistence。 */
export async function startRun(body: unknown, deps: RunDeps = {}): Promise<RunResult> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));
    const runtime = runtimeOf(raw);
    const policy = retryPolicyOf(raw);
    const result = await (await buildPipeline(runtime, deps)).run(config, runtime, policy);
    return { status: 200, json: runOkOf(result) };
  } catch (e) {
    return runFail(e);
  }
}

/** §29 Manual Run：config + beat_plan 复用同一条 Pipeline，run_id 由 Pipeline 统一生成。 */
export async function startRunFromPlan(body: unknown, deps: RunDeps = {}): Promise<RunResult> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    if (raw.beat_plan === undefined || raw.beat_plan === null) {
      return {
        status: 400,
        json: errorBody(
          "CONFIG_INVALID",
          "beat_plan is required——先生成剧情骨架（Generate Plan），再生成正文",
        ),
      };
    }
    const plan = validateBeatPlan(raw.beat_plan);

    const runtime = runtimeOf(raw);
    const policy = retryPolicyOf(raw);
    const result = await (await buildPipeline(runtime, deps)).runWithPlan(config, plan, runtime, policy);
    return { status: 200, json: runOkOf(result) };
  } catch (e) {
    return runFail(e);
  }
}

/**
 * §29/§35 POST /api/generate 的服务层：保留的兼容入口，内部走 Manual Run。
 * 没有 beat_plan → 400（§29：不建议偷偷自己再调 Planner）。
 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
  generator?: StoryGenerator,
): Promise<RunResult> {
  return startRunFromPlan(body, { llm, generator });
}

/** §30 preview：config 校验 + story 模板渲染（beat_plan 可选，用于完整预览）。 */
export async function previewPrompt(
  body: unknown,
  generator?: StoryGenerator,
): Promise<{ status: number; json: { prompt: string } | ApiErrorBody }> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));
    const gen = generator ?? new StoryGenerator(
      await clientFor(runtimeOf(raw)),
      join(PROJECT_ROOT, "prompts", "story.txt"),
    );
    const planPart = raw.beat_plan;
    const plan = planPart ? validateBeatPlan(planPart) : undefined;
    const prompt = plan
      ? gen.buildStoryPrompt(config, plan)
      : gen.buildStoryPrompt(config, {
        beat_plan_version: "1",
        beats: [{ id: 1, purpose: "（beat_plan 未生成——Generate Plan 后可获得完整 Prompt）", event: "（同上）", characters: [] }],
      });
    return { status: 200, json: { prompt } };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`prompt preview failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

/** §29/§30 手动审阅结果：成功回 ReviewResult；失败回统一错误体。 */
export type ReviewOutcome =
  | { status: number; json: ReviewResult }
  | { status: number; json: ApiErrorBody };

/**
 * §29 POST /api/review 的服务层：{config, story}（可选 run_id）→ BasicReviewer → ReviewResult。
 * §30 带上 run_id 时覆盖该 Run 的 review.json——不建立 review_v1 / review_history。
 * §3/§4 只审阅，不据此重新生成或改写正文。
 */
export async function reviewStory(body: unknown, deps: RunDeps = {}): Promise<ReviewOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    const story = typeof raw.story === "string" ? raw.story.trim() : "";
    if (!story) {
      return { status: 400, json: errorBody("CONFIG_INVALID", "story is required——提供需要审阅的小说正文") };
    }

    const runtime = runtimeOf(raw);
    const reviewer = deps.reviewer ?? new BasicReviewer(
      await clientFor(runtime, deps.llm),
      join(PROJECT_ROOT, "prompts", "reviewer.txt"),
    );
    const review = await reviewer.review(config, story);

    // §30：re-review 覆盖当前 review.json（run_id 越界由 ArtifactStore 拦截）
    const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
    if (runId) {
      const store = deps.artifactStore ?? new ArtifactStore(appSettings().runsDir);
      let exists: boolean;
      try {
        exists = store.runExists(runId);
      } catch {
        return { status: 400, json: errorBody("CONFIG_INVALID", `run_id 非法：${runId}`) };
      }
      if (!exists) {
        // §12：Run 不存在是用户错误，用 404 而不是 500
        return {
          status: 404,
          json: errorBody("RUN_NOT_FOUND", `run_id 不存在：${runId}（只能覆盖已存在 Run 的 review.json）`),
        };
      }
      store.putReview(runId, review);
    }

    return { status: 200, json: review };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`review failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

// ---------------------------------------------------------------------------
// v1.5.0 商业可读性审阅：POST /api/review/commercial
// 与 /api/review 完全并列的第二个入口，共用同一个 CommercialReviewer（§31/§57：
// 两个审阅者各自独立，不合成一个「8 维大 Prompt」，也不互相改写对方的产物）。
// ---------------------------------------------------------------------------

/** v1.5.0 CommercialReviewOutcome：成功回 CommercialReviewResult；失败回统一错误体。 */
export type CommercialReviewOutcome =
  | { status: 200; json: CommercialReviewResult }
  | { status: number; json: ApiErrorBody };

/**
 * v1.5.0 POST /api/review/commercial 的服务层：{config, story}（可选 run_id）→ CommercialReviewResult。
 * §30 带上 run_id 时覆盖该 Run 的 commercial-review.json——不建立 commercial_review_history。
 * §15/§57：只读商业可读性，不驱动重试或修订；也不参考 / 更新结构审阅的 review.json。
 */
export async function reviewStoryCommercial(body: unknown, deps: RunDeps = {}): Promise<CommercialReviewOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    const story = typeof raw.story === "string" ? raw.story.trim() : "";
    if (!story) {
      return { status: 400, json: errorBody("CONFIG_INVALID", "story is required——提供需要商业审阅的小说正文") };
    }

    const runtime = runtimeOf(raw);

    // §30/§12：带上 run_id 时先判 Run 存在再调模型——404 不该先花掉一次付费请求。
    // 这与 docs/api.md 里「带 run_id 且该 Run 不存在时 404，不会调用模型」一致；
    // /api/review 目前仍是先审阅后判（v1.0.0 冻结时的既有行为），这里不复刻那个顺序。
    const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
    let store: ArtifactStore | null = null;
    if (runId) {
      store = deps.artifactStore ?? new ArtifactStore(appSettings().runsDir);
      let exists: boolean;
      try {
        exists = store.runExists(runId);
      } catch {
        return { status: 400, json: errorBody("CONFIG_INVALID", `run_id 非法：${runId}`) };
      }
      if (!exists) {
        return {
          status: 404,
          json: errorBody("RUN_NOT_FOUND", `run_id 不存在：${runId}（只能覆盖已存在 Run 的 commercial-review.json）`),
        };
      }
    }

    const reviewer = deps.commercialReviewer ?? new CommercialReviewer(
      await clientFor(runtime, deps.llm),
      join(PROJECT_ROOT, "prompts", "commercial_reviewer.txt"),
    );
    const review = await reviewer.review(config, story);

    // §30：re-review 覆盖当前 commercial-review.json，不建立 commercial_review_history
    store?.putCommercialReview(runId, review);

    return { status: 200, json: review };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`commercial review failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

/** §27 手动校验结果：成功回 ValidationResult；失败回统一错误体。 */
export type ValidationOutcome =
  | { status: number; json: ValidationResult }
  | { status: number; json: ApiErrorBody };

/**
 * §27 POST /api/validate 的服务层：{config, story}（可选 run_id）→ StoryValidator → ValidationResult。
 * §27 带上 run_id 时覆盖该 Run 的 validation.json——不建立 validation_history。
 * §2/§59 只做硬性有效性检查，不调用 Reviewer，也不参考 Review 分数。
 */
export async function validateStory(body: unknown, deps: RunDeps = {}): Promise<ValidationOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    // §27：story 字段缺失或类型不对属于请求格式错误（400）；
    // 而「有值却全是空白」是内容层面的硬失败，交给 EMPTY_CONTENT 规则报告（§10/§16）。
    if (typeof raw.story !== "string") {
      return { status: 400, json: errorBody("CONFIG_INVALID", "story is required——提供需要校验的小说正文") };
    }
    const story = raw.story;

    const validator = deps.validator ?? new StoryValidator();
    const validation = validator.validate(config, story);

    // §27：re-validate 覆盖当前 validation.json（run_id 越界由 ArtifactStore 拦截）
    const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
    if (runId) {
      const store = deps.artifactStore ?? new ArtifactStore(appSettings().runsDir);
      let exists: boolean;
      try {
        exists = store.runExists(runId);
      } catch {
        return { status: 400, json: errorBody("CONFIG_INVALID", `run_id 非法：${runId}`) };
      }
      if (!exists) {
        // §12：Run 不存在是用户错误，用 404 而不是 500
        return {
          status: 404,
          json: errorBody("RUN_NOT_FOUND", `run_id 不存在：${runId}（只能覆盖已存在 Run 的 validation.json）`),
        };
      }
      store.putValidation(runId, validation);
    }

    return { status: 200, json: validation };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`validate failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

// ---------------------------------------------------------------------------
// v1.4.0 BeatPlan 结构校验：POST /api/validate-beats
// 与 Pipeline 内部那一次校验复用同一个 BeatValidator（§62 只新增不重写）。
// 只读、只判断：不改 BeatPlan、不重排、不据此重新规划（§4）。
// ---------------------------------------------------------------------------

/** v1.4.0 BeatValidationOutcome：成功回 BeatValidationResult；失败回统一错误体。 */
export type BeatValidationOutcome =
  | { status: 200; json: BeatValidationResult }
  | { status: number; json: ApiErrorBody };

/**
 * v1.4.0 POST /api/validate-beats 的服务层：{config, beat_plan} → BeatValidationResult。
 * §7 与 /api/validate 的差别：这里检查的是剧情骨架，失败也不影响任何已存在的 Run
 * ——不写 beat-validation.json，不覆盖任何产物（Run 里那一份由 Pipeline 自己写）。
 */
export async function validateStoryBeats(body: unknown, deps: RunDeps = {}): Promise<BeatValidationOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    if (raw.beat_plan === undefined || raw.beat_plan === null) {
      return {
        status: 400,
        json: errorBody(
          "CONFIG_INVALID",
          "beat_plan is required——提供需要校验的剧情骨架",
        ),
      };
    }
    const plan = validateBeatPlan(raw.beat_plan);

    const runtime = runtimeOf(raw);
    const validator = deps.beatValidator ?? new BeatValidator(
      await clientFor(runtime, deps.llm),
      join(PROJECT_ROOT, "prompts", "beat_validator.txt"),
    );
    const beatValidation = await validator.validate(config, plan);
    return { status: 200, json: beatValidation };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`beat validation failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

// ---------------------------------------------------------------------------
// §38 Manual Repair API：POST /api/repair
// 手动触发一次定点修订——和 Pipeline 内部的 Repair-before-Retry 复用同一个
// StoryRepairer + RepairStrategy，不引入第二套修订实现（§62 只新增不重写）。
// ---------------------------------------------------------------------------

/** §38 RepairOutcome：成功回 repaired_story + issue_type + success；失败回统一错误体。 */
export type RepairOutcome =
  | { status: 200; json: RepairResult }
  | { status: number; json: ApiErrorBody };

/**
 * §38 POST /api/repair 的服务层：
 * {config, beat_plan, story, issue_type, issue_message} → {repaired_story, issue_type, success}。
 * §9/§65：只修订正文，不改 StoryConfig / BeatPlan / 模型 / 温度，也不决定是否重试。
 * §10/§11：走独立 repair.txt 提示词，返回完整修订后正文（不是 diff / patch）。
 */
export async function repairStory(body: unknown, deps: RunDeps = {}): Promise<RepairOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));
    const plan = validateBeatPlan(raw.beat_plan);

    if (typeof raw.story !== "string" || !raw.story.trim()) {
      return { status: 400, json: errorBody("CONFIG_INVALID", "story is required——提供需要修订的小说正文") };
    }
    const issueType: RepairIssueType = validateRepairIssueType(raw.issue_type);
    const issueMessage = typeof raw.issue_message === "string" ? raw.issue_message.trim() : "";
    if (!issueMessage) {
      return { status: 400, json: errorBody("CONFIG_INVALID", "issue_message is required——说明要修的问题") };
    }

    const runtime = runtimeOf(raw);
    const repairer = deps.repairer ?? new StoryRepairer(
      await clientFor(runtime, deps.llm),
      join(PROJECT_ROOT, "prompts", "repair.txt"),
    );
    const result = await repairer.repair(
      repairRequestOf({ issue_type: issueType, issue_message: issueMessage }, raw.story, config, plan),
    );
    return { status: 200, json: result };
  } catch (e) {
    const err = toApiError(e);
    logger.error(`repair failed (${err.code})`, e);
    return { status: err.httpStatus, json: err.body() };
  }
}

// ---------------------------------------------------------------------------
// §39 GET /api/runs/{run_id} 与 /api/runs/{run_id}/attempts/{attempt_number}
// 只读已存在的产物。不提供 GET /api/runs 全局历史列表（§40）。
// ---------------------------------------------------------------------------

/** §38/§39 Run 详情：与 RunOk 同源，只是从磁盘读回，不带绝对路径（§67）。 */
export interface RunDetail {
  run_id: string;
  status: string;
  quality_status: QualityStatus | null;
  attempt_count: number;
  selected_attempt: number;
  max_attempts: number | null;
  min_review_score: number | null;
  /** §39：Run 级 Repair 策略回显，前端据此展示当时允不允许修。 */
  enable_repair: boolean | null;
  max_repairs_per_attempt: number | null;
  repair_count: number;
  story: string;
  /** v1.4.0 §26：BeatPlan 结构校验结论；v1.4.0 之前的 Run 没有 beat-validation.json，为 null。 */
  beat_validation: BeatValidationResult | null;
  beat_validation_status: string;
  validation: ValidationResult | null;
  validation_status: string;
  review: ReviewResult | null;
  review_status: string;
  /** v1.5.0 TASK §16/§32：入选 Attempt 的商业可读性结论；v1.5.0 之前的 Run 没有
   *  commercial-review.json，这里是 null（面板据此隐藏，不报错）。 */
  commercial_review: CommercialReviewResult | null;
  commercial_review_status: string;
  /** §26：统一质量快照。v1.2.0 之前的 Run 没有 quality.json，按同一套规则临时装配。 */
  quality: QualityResult | null;
  /** v1.6.0 出身清单；v1.6.0 之前生成的 Run 没有 run-manifest.json，为 null。 */
  manifest: RunManifest | null;
  attempts: AttemptSummary[];
}

/** §35/§39 单个 Attempt 详情：正文 + 独立 Validation / Review + 采纳结论。
 *  v0.8.0 增加修订详情与 initial_story（§36：Repair 结果面板；§37：Before / After Story）。 */
export interface AttemptDetail {
  run_id: string;
  attempt_number: number;
  accepted: boolean | null;
  retry_reason: RetryReason | null;
  selected: boolean;
  /** §30：该 Attempt 的最终版本（修订后的正文）。 */
  story: string;
  /** §30：发生过修订时，修订前的初始正文；没有修订时为 null。 */
  initial_story: string | null;
  repair_count: number;
  /** §36：类型 / 原因 / 前后分数 / 校验变化；不带修订正文全文。 */
  repairs: RepairDetail[];
  validation: ValidationResult | null;
  review: ReviewResult | null;
  /** v1.5.0 TASK §17/§18：这次尝试最终留下的那一版正文的商业可读性结论；
   *  v1.5.0 之前的 Attempt 没有 attempts/NN/commercial-review.json，为 null。 */
  commercial_review: CommercialReviewResult | null;
  /** §26：统一质量快照；没有 quality.json 的旧 Attempt 按同一套规则临时装配。 */
  quality: QualityResult | null;
}

export type RunLookupResult =
  | { status: 200; json: RunDetail }
  | { status: 400; json: RunError }
  | { status: 404; json: RunError };

export type AttemptLookupResult =
  | { status: 200; json: AttemptDetail }
  | { status: 400; json: RunError }
  | { status: 404; json: RunError };

/** §50 run_id 只允许单层目录名：先挡掉路径穿越，再由 ArtifactStore 做 containment check。 */
function runIdOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const id = raw.trim();
  if (id === "." || id === ".." || id.includes("/") || id.includes("\\")) return null;
  return id;
}

function intOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

function strOf(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/** 磁盘上的 retry_reason 可能是被手改坏的，只认白名单值。 */
function reasonOf(raw: unknown): RetryReason | null {
  return typeof raw === "string" && RETRY_REASONS.includes(raw as RetryReason)
    ? (raw as RetryReason)
    : null;
}

/** §26/§27 质量快照读取：优先用落盘的 quality.json；v1.2.0 之前的 Run 没有这个文件，
 *  或文件被手改坏时，用同一套确定性规则从这一次尝试**最终留下的那一版**结论临时装配。
 *  装配器是纯函数，所以临时装配的结果与当年落盘的那份逐字一致，也不需要迁移框架。 */
const qualityAssembler = new QualityAssembler();

function qualityOf(
  stored: QualityResult | null,
  validation: ValidationResult | null,
  review: ReviewResult | null,
  accepted: boolean,
): QualityResult {
  return (
    qualityResultOf(stored) ??
    qualityAssembler.assemble({ validation, review, accepted })
  );
}

/**
 * §26/§27 兜底装配取哪一轮的结论：与落盘的 quality.json 同口径——这次尝试最终留下的那一版。
 * 发生过修订时，attempt 目录下的 validation.json / review.json 是**首次**结论，最终结论在
 * 最后一次真正跑过校验 / 审阅的修订目录里（修订失败则不写这两个文件，要往前找）。
 * v1.2.0 的 bug：这里原先直接读 attempt 目录，于是旧 Run 装配出的分数描述的是修订前那版
 * 正文，与同一次尝试的 metadata.review_score / repairs[].after_review_score 对不上。
 */
function finalCheckOf(
  store: ArtifactStore,
  runId: string,
  attemptNumber: number,
): { validation: ValidationResult | null; review: ReviewResult | null } {
  if (attemptNumber >= 1) {
    const repairs = store.listRepairNumbers(runId, attemptNumber);
    for (let i = repairs.length - 1; i >= 0; i -= 1) {
      const review = store.readRepairReview(runId, attemptNumber, repairs[i]);
      const validation = store.readRepairValidation(runId, attemptNumber, repairs[i]);
      if (review !== null || validation !== null) return { validation, review };
    }
  }
  return {
    validation: attemptNumber >= 1 ? store.readAttemptValidation(runId, attemptNumber) : null,
    review: attemptNumber >= 1 ? store.readAttemptReview(runId, attemptNumber) : null,
  };
}

/** §40 attempts[].repairs：只保留编号 / 类型 / 成败；条目被手改坏就跳过，不让整个详情 500。 */
function repairsOf(meta: Record<string, unknown> | null): RepairSummary[] {
  const raw = meta?.repairs;
  if (!Array.isArray(raw)) return [];
  const out: RepairSummary[] = [];
  for (const item of raw) {
    try {
      out.push(repairSummary(validateRepairRecord(item)));
    } catch {
      /* 单条损坏不影响其它修订记录 */
    }
  }
  return out;
}

/** §36 单个 Attempt 详情的修订视图：多出问题说明与前后分数 / 校验结论。 */
function repairDetailsOf(meta: Record<string, unknown> | null): RepairDetail[] {
  const raw = meta?.repairs;
  if (!Array.isArray(raw)) return [];
  const out: RepairDetail[] = [];
  for (const item of raw) {
    try {
      out.push(repairDetail(validateRepairRecord(item)));
    } catch {
      /* 单条损坏不影响其它修订记录 */
    }
  }
  return out;
}

function attemptSummaryFromDisk(
  runId: string,
  n: number,
  meta: Record<string, unknown> | null,
  store: ArtifactStore,
): AttemptSummary {
  const review = store.readAttemptReview(runId, n);
  const validation = store.readAttemptValidation(runId, n);
  const repairs = repairsOf(meta);
  return {
    attempt_number: n,
    accepted: typeof meta?.accepted === "boolean" ? meta.accepted : false,
    retry_reason: reasonOf(meta?.retry_reason),
    review_score: review ? reviewOverallScore(review) : intOf(meta?.review_score),
    validation_passed: validation ? validation.passed : null,
    repair_count: repairs.length,
    repairs,
  };
}

/**
 * §39 GET /api/runs/{run_id}：从 attempts/ 与 metadata.json 还原这次 Run。
 * §40 没有 history 浏览器，一次请求只看一个 Run。
 */
export async function getRun(
  runIdRaw: unknown,
  store: ArtifactStore = new ArtifactStore(appSettings().runsDir),
): Promise<RunLookupResult> {
  const runId = runIdOf(runIdRaw);
  if (runId === null) {
    return { status: 400, json: errorBody("CONFIG_INVALID", "run_id 非法：必须是单个目录名") };
  }
  let exists: boolean;
  try {
    exists = store.runExists(runId);
  } catch {
    return { status: 400, json: errorBody("CONFIG_INVALID", `run_id 非法：${runId}`) };
  }
  if (!exists) {
    return { status: 404, json: errorBody("RUN_NOT_FOUND", `run_id 不存在：${runId}`) };
  }

  const meta = store.readRunMetadata(runId);
  const numbers = store.listAttemptNumbers(runId);
  const attempts = numbers.map((n) =>
    attemptSummaryFromDisk(runId, n, store.readAttemptMetadata(runId, n), store),
  );
  const qualityStatus = (strOf(meta?.quality_status) as QualityStatus | null) ?? null;
  const finalValidation = store.readFinalValidation(runId);
  const finalReview = store.readFinalReview(runId);
  const finalCommercialReview = store.readFinalCommercialReview(runId);
  const selectedAttempt = intOf(meta?.selected_attempt) ?? (numbers.length > 0 ? numbers[numbers.length - 1] : 0);
  // §26/§27：三级兜底都指向「入选 Attempt 最终留下的那一版正文」——运行根的 quality.json、
  // 入选 Attempt 自己的 quality.json、再用最终结论临时装配。
  const storedQuality =
    store.readFinalQuality(runId) ??
    (selectedAttempt >= 1 ? store.readAttemptQuality(runId, selectedAttempt) : null);
  const finalCheck = finalCheckOf(store, runId, selectedAttempt);

  return {
    status: 200,
    json: {
      run_id: runId,
      status: strOf(meta?.status) ?? "unknown",
      quality_status: qualityStatus,
      attempt_count: intOf(meta?.attempt_count) ?? numbers.length,
      selected_attempt: selectedAttempt,
      max_attempts: intOf(meta?.max_attempts),
      min_review_score: intOf(meta?.min_review_score),
      enable_repair: typeof meta?.enable_repair === "boolean" ? meta.enable_repair : null,
      max_repairs_per_attempt: intOf(meta?.max_repairs_per_attempt),
      // §40：Run 级 repair_count 从各 attempt 的修订记录累加，与 POST 响应同一口径。
      repair_count: attempts.reduce((sum, a) => sum + a.repair_count, 0),
      story: store.readFinalStory(runId) ?? "",
      // v1.4.0 §26：骨架校验结论是运行级的，直接读根目录那份；缺文件就是没跑过这一步
      beat_validation: store.readFinalBeatValidation(runId),
      beat_validation_status: strOf(meta?.beat_validation_status) ?? "not_started",
      validation: finalValidation,
      validation_status: strOf(meta?.validation_status) ?? "not_started",
      review: finalReview,
      review_status: strOf(meta?.review_status) ?? "not_started",
      // v1.5.0 TASK §16：运行根那份商业结论，与 story.md 严格同版（§39）；
      // v1.5.0 之前的 Run 读不到文件，status 兜底 not_started，前端据此隐藏面板。
      commercial_review: finalCommercialReview,
      commercial_review_status: strOf(meta?.commercial_review_status) ?? "not_started",
      // §26/§27：三级兜底都是同一版正文（见上面的 storedQuality / finalCheck）。
      quality: qualityOf(
        storedQuality,
        finalCheck.validation,
        finalCheck.review,
        // §8：采纳结论沿用 Run 级 quality_status，不另立一套判定
        qualityStatus === "accepted",
      ),
      // v1.6.0：出身清单按文件读。读不到（v1.6.0 之前的 Run）或文件被手改坏，
      // 都归一成 null——与 qualityResultOf / beatValidationResultOf 同一套容错约定，
      // 不让坏数据进响应，也不让读接口 500（compatibility §16）。
      manifest: store.readRunManifest(runId),
      attempts,
    },
  };
}

/**
 * §39 GET /api/runs/{run_id}/attempts/{attempt_number}。
 * §35：只返回这一次 Attempt 的实体，不做横向比较 / 排名 / Score Delta。
 */
export async function getRunAttempt(
  runIdRaw: unknown,
  attemptNumberRaw: unknown,
  store: ArtifactStore = new ArtifactStore(appSettings().runsDir),
): Promise<AttemptLookupResult> {
  const runId = runIdOf(runIdRaw);
  if (runId === null) {
    return { status: 400, json: errorBody("CONFIG_INVALID", "run_id 非法：必须是单个目录名") };
  }
  let attemptNumber: number;
  try {
    attemptNumber = validateAttemptNumber(intOf(attemptNumberRaw) ?? 0);
  } catch {
    return { status: 400, json: errorBody("CONFIG_INVALID", "attempt_number 必须是大于 0 的整数") };
  }
  if (attemptNumber > 99) {
    return { status: 400, json: errorBody("CONFIG_INVALID", "attempt_number 不能超过 99") };
  }

  let exists: boolean;
  try {
    exists = store.runExists(runId);
  } catch {
    return { status: 400, json: errorBody("CONFIG_INVALID", `run_id 非法：${runId}`) };
  }
  if (!exists) {
    return { status: 404, json: errorBody("RUN_NOT_FOUND", `run_id 不存在：${runId}`) };
  }
  let attemptExists: boolean;
  try {
    attemptExists = store.attemptExists(runId, attemptNumber);
  } catch {
    return { status: 400, json: errorBody("CONFIG_INVALID", `attempt_number 非法：${attemptNumber}`) };
  }
  if (!attemptExists) {
    return { status: 404, json: errorBody("RUN_NOT_FOUND", `Attempt ${attemptNumber} 不存在于 Run ${runId}`) };
  }

  const meta = store.readRunMetadata(runId);
  const attemptMeta = store.readAttemptMetadata(runId, attemptNumber);
  const accepted = attemptMeta && typeof attemptMeta.accepted === "boolean" ? attemptMeta.accepted : null;
  const repairs = repairDetailsOf(attemptMeta);
  // §26/§27：兜底装配用这次尝试最终留下的那一版结论（有修订就是最后一次修订的）。
  const finalCheck = finalCheckOf(store, runId, attemptNumber);

  return {
    status: 200,
    json: {
      run_id: runId,
      attempt_number: attemptNumber,
      accepted,
      retry_reason: accepted ? null : reasonOf(attemptMeta?.retry_reason),
      selected: intOf(meta?.selected_attempt) === attemptNumber,
      story: store.readAttemptStory(runId, attemptNumber) ?? "",
      // §30/§37：修订前的正文单独存放，UI 用它做 Before / After 两个 Tab。
      initial_story: store.readAttemptInitialStory(runId, attemptNumber),
      repair_count: repairs.length,
      repairs,
      validation: store.readAttemptValidation(runId, attemptNumber),
      review: store.readAttemptReview(runId, attemptNumber),
      // v1.5.0 TASK §17/§18：attempt 目录那份商业结论只描述这一次尝试最终留下的
      // story.md；这一步被跳过或自身失败时没有文件，返回 null
      commercial_review: store.readAttemptCommercialReview(runId, attemptNumber),
      // §26/§27：与运行根那份同口径——先读这份快照，缺失或被改坏时用这次尝试最终留下的
      // 结论（有修订就是最后一次修订的）临时装配。
      quality: qualityOf(
        store.readAttemptQuality(runId, attemptNumber),
        finalCheck.validation,
        finalCheck.review,
        accepted === true,
      ),
    },
  };
}
