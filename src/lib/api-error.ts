/**
 * 统一 API 错误（TASK §11/§12/§13）。
 *
 * 所有失败响应都是同一个形状：
 *   { "error": { "code": "PLANNER_INVALID_OUTPUT", "message": "...", "run_id": "..." } }
 *
 * code 是稳定枚举（§11），message 是给人看的一句话，run_id / stage 有就带。
 * 用户错误（配置非法、Run 不存在）与运行时错误（超时、写盘失败）分开映射状态码（§12），
 * 不所有错误都返 500；堆栈只进服务端日志，响应里永远不出现（§13）。
 *
 * v0.9.1 两条改动：
 *   - 每条来自异常的 message 都过 safeText：绝对路径换成 <path>、凭据打码。
 *   - 具体异常的分支排在 PipelineError 之前。此前 PipelineError 抢先命中，
 *     让 ARTIFACT_WRITE_FAILED 等分支在主链路上成了死码。
 */

import { PipelineError } from "@/core/pipeline";
import { LLMError, LLMTimeoutError } from "@/lib/llm";
import { safeText } from "@/lib/safe-text";

/** §11 稳定错误码。新增错误必须复用这里的码，不允许每个路由自造字符串。 */
export const API_ERROR_CODES = [
  "CONFIG_INVALID",
  "RUN_NOT_FOUND",
  "LLM_TIMEOUT",
  "LLM_REQUEST_FAILED",
  "PLANNER_INVALID_OUTPUT",
  "GENERATION_FAILED",
  "VALIDATION_FAILED_INTERNAL",
  "REVIEW_FAILED",
  "REPAIR_FAILED",
  "ARTIFACT_WRITE_FAILED",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetail {
  code: ApiErrorCode;
  message: string;
  run_id?: string;
  stage?: string;
}

export interface ApiErrorBody {
  error: ApiErrorDetail;
}

/** 可带 HTTP 状态码的统一错误：service 层抛出，路由层只负责转成响应。 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly runId?: string,
    readonly stage?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  body(): ApiErrorBody {
    const detail: ApiErrorDetail = { code: this.code, message: this.message };
    if (this.runId) detail.run_id = this.runId;
    if (this.stage) detail.stage = this.stage;
    return { error: detail };
  }
}

/** 直接构造一个错误响应体（不抛异常的路径用）。 */
export function errorBody(
  code: ApiErrorCode,
  message: string,
  extra: { run_id?: string; stage?: string } = {},
): ApiErrorBody {
  const detail: ApiErrorDetail = { code, message };
  if (extra.run_id) detail.run_id = extra.run_id;
  if (extra.stage) detail.stage = extra.stage;
  return { error: detail };
}

/** 从服务层返回体取用户可读的错误文本：CLI 与前端共用同一套解析。 */
export function errorMessageOf(json: unknown): string {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as { message: unknown }).message);
    }
    if (typeof err === "string") return err;
  }
  return "未知错误";
}

/** §12 用户/请求错误：调用方改请求就能解决，一律 4xx。 */
const USER_ERROR_NAMES = new Set([
  "ConfigValidationError",
  "RequestValidationError",
  "UnsupportedConfigVersionError",
  "RetryPolicyError",
  "RepairValidationError",
  "BeatPlanValidationError",
  "ReviewValidationError",
  "ValidationValidationError",
]);

/** §12 把已抛出的异常映射成统一错误；未知异常按内部错误处理，消息不带堆栈。 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;

  // PipelineError 只是阶段外壳：先看它包裹的原始异常，
  // LLM 失败要保留专属错误码（LLM_TIMEOUT / LLM_REQUEST_FAILED），不能一律 GENERATION_FAILED。
  const inner = rootCause(e);

  if (inner instanceof LLMTimeoutError) {
    return new ApiError("LLM_TIMEOUT", safeText(inner.message), 504, runIdOf(e), stageOf(e));
  }
  if (inner instanceof LLMError) {
    return new ApiError("LLM_REQUEST_FAILED", safeText(inner.message), 502, runIdOf(e), stageOf(e));
  }
  // 接下来这一组按「具体是什么坏了」定位错误码。必须排在 PipelineError 之前：
  // v0.9.0 把 PipelineError 放在这儿，导致这些分支在主链路上全是死码，
  // 写盘失败被报成 GENERATION_FAILED/502，而不是 ARTIFACT_WRITE_FAILED/500。
  if (inner instanceof Error) {
    if (inner.name === "BeatParseError") {
      return new ApiError("PLANNER_INVALID_OUTPUT", `Plan generation failed. 原因：${safeText(inner.message)}`, 502, runIdOf(e), stageOf(e));
    }
    if (inner.name === "ReviewParseError") {
      return new ApiError("REVIEW_FAILED", `Review failed. 原因：${safeText(inner.message)}`, 502, runIdOf(e), stageOf(e));
    }
    if (inner.name === "ValidatorError") {
      return new ApiError("VALIDATION_FAILED_INTERNAL", `Validation failed. 原因：${safeText(inner.message)}`, 500, runIdOf(e), stageOf(e));
    }
    if (inner.name === "ArtifactWriteError") {
      return new ApiError("ARTIFACT_WRITE_FAILED", safeText(inner.message), 500, runIdOf(e), stageOf(e));
    }
    if (USER_ERROR_NAMES.has(inner.name)) {
      return new ApiError("CONFIG_INVALID", safeText(inner.message), 400, runIdOf(e), stageOf(e));
    }
  }
  // 具体类型都没命中，才退回 PipelineError 的阶段壳：阶段能定位，但不值得单独一个码。
  if (e instanceof PipelineError) {
    const code: ApiErrorCode = e.stage === "planning" ? "PLANNER_INVALID_OUTPUT" : "GENERATION_FAILED";
    return new ApiError(code, safeText(e.message), 502, e.runId, e.stage);
  }
  // §13：未预期异常只给这一句。原始异常由调用方记服务端日志——拼进响应既没信息量，
  // 又把异常文本（可能含绝对路径 / 请求头 / 密钥）送到用户手上。
  return new ApiError("INTERNAL_ERROR", "服务器内部错误", 500, runIdOf(e), stageOf(e));
}

function runIdOf(e: unknown): string | undefined {
  return e instanceof PipelineError ? e.runId : undefined;
}

function stageOf(e: unknown): string | undefined {
  return e instanceof PipelineError ? e.stage : undefined;
}

/** 沿 PipelineError.cause 一路解到最内层异常；没有 cause 时返回外层本身。 */
function rootCause(e: unknown): unknown {
  let current = e;
  const seen = new Set<unknown>();
  while (current instanceof PipelineError && current.cause !== undefined && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}
