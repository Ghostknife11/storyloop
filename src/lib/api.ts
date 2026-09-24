import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { QualityResult } from "@/types/quality";
import type { BeatValidationResult } from "@/types/beat-validation";

/** §34/§38 单个 Attempt 摘要：只带结论，不带完整正文。 */
export interface AttemptSummaryApi {
  attempt_number: number;
  accepted: boolean;
  retry_reason: string | null;
  review_score: number | null;
  validation_passed: boolean | null;
  /** §40 v0.8.0：这个 Attempt 内发生过的定点修订次数（Repair 不新增 Attempt）。 */
  repair_count: number;
  /** §40 只带编号 / 类型 / 成败，不带修订正文。 */
  repairs: RepairSummaryApi[];
}

/** §40 Repair 摘要：UI 只显示类型与成败。 */
export interface RepairSummaryApi {
  repair_number: number;
  issue_type: string;
  success: boolean;
}

/** §32 Run 响应：run_id / 状态 / 正文 / 实际使用的 BeatPlan / 校验结果 / 评价 / 产物文件名。
 *  v0.7.0 增加重试结论与 Attempt 摘要（§38）。
 *  v0.8.0 增加 repair_count 与每个 Attempt 的 repairs 摘要（§40）。
 *  v1.2.0 增加 quality（§25）：统一质量层是新增字段，原有字段一个不动。
 *  v1.4.0 增加 beat_validation / beat_validation_status（§26）：同样是纯追加。 */
export interface RunApiResult {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  /** v1.4.0 §26：BeatPlan 结构校验结论；没跑这一步时为 null。 */
  beat_validation: BeatValidationResult | null;
  beat_validation_status: string;
  /** §26：硬性有效性检查结果；Validator 自身异常时为 null。 */
  validation: ValidationResult | null;
  validation_status: string;
  validation_error?: string;
  /** §27/§28：Review 失败时为 null，story 仍然返回。 */
  review: ReviewResult | null;
  review_status: string;
  review_error?: string;
  /** §25/§26：统一质量快照；更早的响应里没有这个字段，按可空处理。 */
  quality: QualityResult | null;
  artifacts: Record<string, string>;
  /** §16：accepted / exhausted。 */
  quality_status: "accepted" | "exhausted";
  attempt_count: number;
  /** §17：默认展示的就是这个 Attempt 的正文与结论（§36）。 */
  selected_attempt: number;
  /** §40 Run 级修订次数 = 各 Attempt 修订次数之和。 */
  repair_count: number;
  attempts: AttemptSummaryApi[];
}

/** §28 失败时带上 run_id 与 stage，让 UI 能指出失败阶段（不猜）。
 *  §34 kind 区分失败来源：网络 / 超时 / 响应不合法 / 服务端返回的错误码。 */
export type ApiFailureKind = "network" | "timeout" | "invalid_response" | "api";

export class RunApiError extends Error {
  constructor(
    message: string,
    public runId?: string,
    public stage?: string,
    public kind: ApiFailureKind = "api",
  ) {
    super(message);
    this.name = "RunApiError";
  }
}

/** §11 统一错误响应：{error:{code,message,run_id?,stage?}}。
 *  code 是稳定枚举，message 是给人看的一句话；run_id / stage 有就带。 */
export interface ApiErrorDetail {
  code: string;
  message: string;
  run_id?: string;
  stage?: string;
}

export interface ApiErrorBody {
  error: ApiErrorDetail;
}

/** 从响应体里取统一错误细节；形状不认识时给一句兜底话，绝不把堆栈透到前端。 */
export function apiErrorDetailOf(data: unknown, fallback: string): ApiErrorDetail {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      const detail = err as ApiErrorDetail;
      return {
        code: typeof detail.code === "string" ? detail.code : "INTERNAL_ERROR",
        message: String(detail.message ?? fallback),
        ...(detail.run_id ? { run_id: detail.run_id } : {}),
        ...(detail.stage ? { stage: detail.stage } : {}),
      };
    }
  }
  return { code: "INTERNAL_ERROR", message: fallback };
}

/** §34 客户端超时：一次 Run 可能含多次 Attempt 与 transport 重试，所以给得比
 *  服务端 LLM_TIMEOUT 宽；超时只是让 UI 不必永远转圈，不影响服务端继续跑完。 */
const REQUEST_TIMEOUT_MS = 300_000;

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * §33/§34 唯一的请求出口：Network Error / Timeout / Invalid Response / API Error
 * 四种失败都在这里变成同一类 RunApiError，消息稳定、可直接 Toast。
 * 组件不再自己 fetch，也不再各自解释异常。
 */
async function requestJson(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      ...(init?.signal ? {} : { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    });
  } catch (e) {
    if (isTimeout(e)) {
      throw new RunApiError(
        `${fallback}：请求超时（超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒无响应）`,
        undefined,
        undefined,
        "timeout",
      );
    }
    throw new RunApiError(`${fallback}：网络错误，请检查连接后重试`, undefined, undefined, "network");
  }

  // §34 Invalid Response：代理 / 中间层可能返回 HTML，res.json() 会抛 SyntaxError
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail = apiErrorDetailOf(data, `${fallback}（HTTP ${res.status}）`);
    throw new RunApiError(detail.message, detail.run_id, detail.stage);
  }
  if (data === null) {
    throw new RunApiError(`${fallback}：响应不是合法 JSON`, undefined, undefined, "invalid_response");
  }
  return data;
}

async function postRun(url: string, payload: unknown): Promise<RunApiResult> {
  return (await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, "生成失败")) as RunApiResult;
}

/** §27/§28 第一阶段：StoryConfig → BeatPlanner → BeatPlan。 */
export async function planStory(
  config: StoryConfig,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<BeatPlan> {
  return (await requestJson("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ...runtime }),
  }, "规划失败")) as BeatPlan;
}

/** §37 RetryPolicy 由设置页下发，不属于 StoryConfig。
 *  v0.8.0 增加定点修订两项（§34/§39）。 */
export interface RetryPolicyApi {
  max_attempts: number;
  min_review_score: number;
  retry_on_validation_failure: boolean;
  enable_repair: boolean;
  max_repairs_per_attempt: number;
}

/** §32 Automatic Run：StoryConfig → 一个完整 Run。 */
export async function startRun(
  config: StoryConfig,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
  retryPolicy?: RetryPolicyApi,
): Promise<RunApiResult> {
  return postRun("/api/runs", { config, ...runtime, ...(retryPolicy ? { retry_policy: retryPolicy } : {}) });
}

/** §33 Manual Run：必须携带 beat_plan（§29 不偷偷回退到自动规划）。 */
export async function generateFromPlan(
  config: StoryConfig,
  plan: BeatPlan,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
  retryPolicy?: RetryPolicyApi,
): Promise<RunApiResult> {
  return postRun("/api/runs/from-plan", {
    config,
    beat_plan: plan,
    ...runtime,
    ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
  });
}

/** §39 读回的一次 Run：与 POST 响应同源的结论字段 + 各 Attempt 摘要。 */
export interface RunDetailApi {
  run_id: string;
  status: string;
  quality_status: "accepted" | "exhausted" | null;
  attempt_count: number;
  selected_attempt: number;
  max_attempts: number | null;
  min_review_score: number | null;
  /** §39：当时生效的定点修订策略（更早的 Run 没有这两个字段时为 null）。 */
  enable_repair: boolean | null;
  max_repairs_per_attempt: number | null;
  /** §40 Run 级修订总次数。 */
  repair_count: number;
  story: string;
  /** v1.4.0 §26：BeatPlan 结构校验结论；v1.4.0 之前的 Run 没有 beat-validation.json，为 null。 */
  beat_validation: BeatValidationResult | null;
  beat_validation_status: string;
  validation: ValidationResult | null;
  validation_status: string;
  review: ReviewResult | null;
  review_status: string;
  /** §26：统一质量快照；v1.2.0 之前的 Run 没有 quality.json，服务端会临时装配后返回。 */
  quality: QualityResult | null;
  attempts: AttemptSummaryApi[];
}

/** §36 单个 Attempt 详情里的修订记录：多出问题说明与前后对比。 */
export interface RepairDetailApi {
  repair_number: number;
  issue_type: string;
  issue_message: string;
  success: boolean;
  before_review_score: number | null;
  after_review_score: number | null;
  before_validation_passed: boolean | null;
  after_validation_passed: boolean | null;
}

/** §35/§38 Attempt 详情：正文 + 这一次独立的校验 / 审阅结论。
 *  v0.8.0 增加修订详情与修订前的初始正文（§36：Repair 面板；§37：Before / After）。
 *  v1.2.0 增加这次 Attempt 的质量快照（§26）。 */
export interface AttemptDetailApi {
  run_id: string;
  attempt_number: number;
  accepted: boolean | null;
  retry_reason: string | null;
  selected: boolean;
  story: string;
  /** §30/§37：发生过修订时修订前的正文，没有修订时为 null。 */
  initial_story: string | null;
  repair_count: number;
  repairs: RepairDetailApi[];
  validation: ValidationResult | null;
  review: ReviewResult | null;
  quality: QualityResult | null;
}

/**
 * §39 GET /api/runs/<run_id>：读回一次 Run 的 Attempt 摘要。
 * §40 没有全局 Run 历史接口，前端也不做历史列表。
 */
export async function fetchRun(runId: string): Promise<RunDetailApi> {
  return (await requestJson(
    `/api/runs/${encodeURIComponent(runId)}`,
    undefined,
    "读取 Run 失败",
  )) as RunDetailApi;
}

/**
 * §39 GET /api/runs/<run_id>/attempts/<n>：读回某一次 Attempt。
 * §35 只做查看，前端不生成比较表 / Score Delta / 排名。
 */
export async function fetchRunAttempt(runId: string, attemptNumber: number): Promise<AttemptDetailApi> {
  return (await requestJson(
    `/api/runs/${encodeURIComponent(runId)}/attempts/${attemptNumber}`,
    undefined,
    "读取 Attempt 失败",
  )) as AttemptDetailApi;
}

/** §30 Prompt Preview（config 必填，beat_plan 可选）。 */
export async function previewPrompt(
  config: StoryConfig,
  plan?: BeatPlan,
): Promise<string> {
  const data = (await requestJson("/api/prompt/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan ? { config, beat_plan: plan } : config),
  }, "预览失败")) as { prompt?: unknown };
  return String(data.prompt ?? "");
}

/**
 * §29 手动审阅（Review Again）：只重新 Review，不重新生成 Story（§50）。
 * 带 runId 时服务端覆盖该 Run 的 review.json（§30）。
 */
export async function reviewStory(
  config: StoryConfig,
  story: string,
  runtime: { model?: string; baseUrl?: string; temperature?: number } = {},
  runId?: string,
): Promise<ReviewResult> {
  return (await requestJson("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, story, ...runtime, ...(runId ? { run_id: runId } : {}) }),
  }, "审阅失败")) as ReviewResult;
}

/**
 * §27 手动校验（Validate Again）：只重新跑硬性规则，不重新生成 Story，也不调用 Reviewer。
 * 带 runId 时服务端覆盖该 Run 的 validation.json（§27）。
 */
export async function validateStory(
  config: StoryConfig,
  story: string,
  runId?: string,
): Promise<ValidationResult> {
  return (await requestJson("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, story, ...(runId ? { run_id: runId } : {}) }),
  }, "校验失败")) as ValidationResult;
}

/**
 * v1.4.0 手动校验剧情骨架（Validate Beats）：只跑结构与规则检查，不生成正文、不改写骨架。
 * 与 Pipeline 里那一次校验同一个实现；这里的结果不写任何产物。
 */
export async function validateStoryBeats(
  config: StoryConfig,
  plan: BeatPlan,
): Promise<BeatValidationResult> {
  return (await requestJson("/api/validate-beats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, beat_plan: plan }),
  }, "Beat 校验失败")) as BeatValidationResult;
}

/** §38 手动定点修订结果：完整修订后正文 + 类型 + 成败（notes 是失败原因）。 */
export interface RepairResultApi {
  repaired_story: string;
  issue_type: string;
  success: boolean;
  notes: string | null;
}

/** §43 版本号集中读取：Shell 与 About 页共用同一个入口，不再各自 fetch、各自兜底一份硬编码版本。 */
export async function fetchProjectVersion(): Promise<string> {
  const data = (await requestJson("/api/version", undefined, "读取版本失败")) as { version?: unknown };
  const version = typeof data.version === "string" ? data.version.trim() : "";
  if (version === "") throw new RunApiError("读取版本失败：响应里没有版本号", undefined, undefined, "invalid_response");
  return version;
}

/** §38/§50 手动 Repair：针对一条明确问题修订当前正文。
 *  §65 只改正文，不改 StoryConfig / BeatPlan / 模型 / 温度，也不自动重试。 */
export async function repairStory(
  config: StoryConfig,
  plan: BeatPlan,
  story: string,
  issueType: string,
  issueMessage: string,
  runtime: { model?: string; baseUrl?: string; temperature?: number } = {},
): Promise<RepairResultApi> {
  return (await requestJson("/api/repair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config,
      beat_plan: plan,
      story,
      issue_type: issueType,
      issue_message: issueMessage,
      ...runtime,
    }),
  }, "修订失败")) as RepairResultApi;
}
