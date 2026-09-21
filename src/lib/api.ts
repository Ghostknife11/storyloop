import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

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
 *  v0.8.0 增加 repair_count 与每个 Attempt 的 repairs 摘要（§40）。 */
export interface RunApiResult {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  /** §26：硬性有效性检查结果；Validator 自身异常时为 null。 */
  validation: ValidationResult | null;
  validation_status: string;
  validation_error?: string;
  /** §27/§28：Review 失败时为 null，story 仍然返回。 */
  review: ReviewResult | null;
  review_status: string;
  review_error?: string;
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

/** §28 失败时带上 run_id 与 stage，让 UI 能指出失败阶段（不猜）。 */
export class RunApiError extends Error {
  constructor(message: string, public runId?: string, public stage?: string) {
    super(message);
    this.name = "RunApiError";
  }
}

async function postRun(url: string, payload: unknown): Promise<RunApiResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data as { error?: string; run_id?: string; stage?: string };
    throw new RunApiError(err?.error || `生成失败（HTTP ${res.status}）`, err?.run_id, err?.stage);
  }
  return data as RunApiResult;
}

/** §27/§28 第一阶段：StoryConfig → BeatPlanner → BeatPlan。 */
export async function planStory(
  config: StoryConfig,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<BeatPlan> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ...runtime }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `规划失败（HTTP ${res.status}）`);
  return data as BeatPlan;
}

/** §37 RetryPolicy 由设置页下发，不属于 StoryConfig。 */
export interface RetryPolicyApi {
  max_attempts: number;
  min_review_score: number;
  retry_on_validation_failure: boolean;
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
  story: string;
  validation: ValidationResult | null;
  validation_status: string;
  review: ReviewResult | null;
  review_status: string;
  attempts: AttemptSummaryApi[];
}

/** §35/§38 Attempt 详情：正文 + 这一次独立的校验 / 审阅结论。 */
export interface AttemptDetailApi {
  run_id: string;
  attempt_number: number;
  accepted: boolean | null;
  retry_reason: string | null;
  selected: boolean;
  story: string;
  validation: ValidationResult | null;
  review: ReviewResult | null;
}

/**
 * §39 GET /api/runs/<run_id>：读回一次 Run 的 Attempt 摘要。
 * §40 没有全局 Run 历史接口，前端也不做历史列表。
 */
export async function fetchRun(runId: string): Promise<RunDetailApi> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `读取 Run 失败（HTTP ${res.status}）`);
  return data as RunDetailApi;
}

/**
 * §39 GET /api/runs/<run_id>/attempts/<n>：读回某一次 Attempt。
 * §35 只做查看，前端不生成比较表 / Score Delta / 排名。
 */
export async function fetchRunAttempt(runId: string, attemptNumber: number): Promise<AttemptDetailApi> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/attempts/${attemptNumber}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `读取 Attempt 失败（HTTP ${res.status}）`);
  return data as AttemptDetailApi;
}

/** §30 Prompt Preview（config 必填，beat_plan 可选）。 */
export async function previewPrompt(
  config: StoryConfig,
  plan?: BeatPlan,
): Promise<string> {
  const res = await fetch("/api/prompt/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan ? { config, beat_plan: plan } : config),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `预览失败（HTTP ${res.status}）`);
  return data.prompt as string;
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
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, story, ...runtime, ...(runId ? { run_id: runId } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `审阅失败（HTTP ${res.status}）`);
  return data as ReviewResult;
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
  const res = await fetch("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, story, ...(runId ? { run_id: runId } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `校验失败（HTTP ${res.status}）`);
  return data as ValidationResult;
}
