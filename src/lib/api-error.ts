/**
 * v0.9.0 统一 API 错误（TASK §11/§12/§13）。
 *
 * 所有失败响应都是同一个形状：
 *   { "error": { "code": "PLANNER_INVALID_OUTPUT", "message": "...", "run_id": "..." } }
 *
 * code 是稳定枚举（§11），message 是给人看的一句话，run_id / stage 有就带。
 * 用户错误（配置非法、Run 不存在）与运行时错误（超时、写盘失败）分开映射状态码（§12），
 * 不所有错误都返 500；堆栈只进服务端日志，响应里永远不出现（§13）。
 */

import { PipelineError } from "@/core/pipeline";
import { LLMError, LLMTimeoutError } from "@/lib/llm";

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
    return new ApiError("LLM_TIMEOUT", inner.message, 504, runIdOf(e), stageOf(e));
  }
  if (inner instanceof LLMError) {
    return new ApiError("LLM_REQUEST_FAILED", inner.message, 502, runIdOf(e), stageOf(e));
  }
  if (e instanceof PipelineError) {
    const code: ApiErrorCode = e.stage === "planning" ? "PLANNER_INVALID_OUTPUT" : "GENERATION_FAILED";
    return new ApiError(code, e.message, 502, e.runId, e.stage);
  }
  if (inner instanceof Error) {
    if (inner.name === "BeatParseError") {
      return new ApiError("PLANNER_INVALID_OUTPUT", `Plan generation failed. 原因：${inner.message}`, 502, runIdOf(e), stageOf(e));
    }
    if (inner.name === "ReviewParseError") {
      return new ApiError("REVIEW_FAILED", `Review failed. 原因：${inner.message}`, 502, runIdOf(e), stageOf(e));
    }
    if (inner.name === "ValidatorError") {
      return new ApiError("VALIDATION_FAILED_INTERNAL", `Validation failed. 原因：${inner.message}`, 500, runIdOf(e), stageOf(e));
    }
    if (USER_ERROR_NAMES.has(inner.name)) {
      return new ApiError("CONFIG_INVALID", inner.message, 400, runIdOf(e), stageOf(e));
    }
  }
  // §13：未预期异常只给一句话，原始异常由调用方记服务端日志。
  const message = e instanceof Error ? e.message : String(e);
  return new ApiError("INTERNAL_ERROR", `服务器内部错误：${message}`, 500, runIdOf(e), stageOf(e));
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
