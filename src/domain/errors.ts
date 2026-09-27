/**
 * v2.0.0 Domain 层错误契约。
 *
 * `PipelineError` 原先长在 `core/pipeline.ts` 里，于是「错误模型」这个最稳定的
 * 公开契约被绑在了一个具体引擎模块上：lib/failure-rules、lib/api-error、
 * lib/generate-service 三处为了它 import `@/engine/pipeline`，形成 v1.9.1 时
 * 已经存在的三条循环依赖——全部穿过 pipeline.ts。
 *
 * v2.0.0 按 §32 把错误模型收进 Domain：领域契约描述「失败了、在哪一阶段失败、
 * 原始异常是什么」，不描述 HTTP 400/500，也不描述退出码。HTTP 状态码与 CLI
 * 退出码由 Interface 层按 code 映射（见 application/error-model.ts）。
 *
 * 这个文件必须是纯 TypeScript：无 node:fs、无 fetch、无 Next.js、无 React。
 */

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

/**
 * §32 StoryLoopError：跨层稳定的错误形状。
 *
 * code 是稳定枚举（见 application/error-model.ts 的 API_ERROR_CODES），
 * message 是给人看的一句话，stage / runId 有就带。Domain 只承诺这个形状，
 * 不承诺它对应哪个 HTTP 状态码。
 */
export interface StoryLoopError {
  code: string;
  message: string;
  stage?: string;
  runId?: string;
  retryable?: boolean;
}

/** 判断一个未知异常是不是 PipelineError（不 import 具体引擎模块也能认）。 */
export function isPipelineError(e: unknown): e is PipelineError {
  return e instanceof PipelineError;
}

/** 沿 PipelineError.cause 一路解到最内层异常；没有 cause 时返回外层本身。 */
export function rootCause(e: unknown): unknown {
  let current: unknown = e;
  const seen = new Set<unknown>();
  while (current instanceof PipelineError && current.cause !== undefined && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

/**
 * §32/§28 失败摘要：不需要 HTTP 语义的那一小半。
 *
 * Application 的 error-model.ts 把异常映射成 `ApiError`（带状态码），但那条路
 * 要用 instanceof 判 LLM 异常，Domain 碰不得 Infrastructure。这里按异常名字
 * （name 都是各类错误自己设的）给出同一套 code 的子集，供 Analysis / CLI /
 * 实验执行器这类「只要一句话说明失败」的调用方使用——于是它们不必为了拿一个
 * code 反向 import Application（v2.0.0 之前 experiment-runner 就是这么干的）。
 */
export interface FailureSummary {
  code: string;
  message: string;
  runId: string | null;
  stage: string | null;
}

export function failureSummaryOf(e: unknown): FailureSummary {
  const runId = e instanceof PipelineError ? e.runId : null;
  const stage = e instanceof PipelineError ? e.stage : null;
  const inner = rootCause(e) as { name?: unknown; message?: unknown };
  const name = typeof inner.name === "string" ? inner.name : "";
  const message = typeof inner.message === "string" ? inner.message : "服务器内部错误";
  if (name === "LLMTimeoutError") return { code: "LLM_TIMEOUT", message, runId, stage };
  if (name === "LLMError") return { code: "LLM_REQUEST_FAILED", message, runId, stage };
  if (stage !== null) return { code: "GENERATION_FAILED", message, runId, stage };
  return { code: "INTERNAL_ERROR", message, runId, stage };
}

