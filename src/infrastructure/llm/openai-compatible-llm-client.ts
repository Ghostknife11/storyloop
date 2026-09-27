/**
 * v0.9.0 LLM 客户端加固（TASK §14/§15/§16）。v2.0.0：归入 Infrastructure。
 *
 * 所有模型调用仍走这一个类：Planner / Generator / Reviewer / Repairer 都不自己实现
 * timeout / auth / request（§14）。薄客户端，刻意不做 Provider Registry /
 * Model Router / Fallback（§70）。
 *
 * v2.0.0 的两处变化，都不改行为：
 *   1. 位置：src/interface/llm.ts → src/infrastructure/llm/。它是唯一 import fetch 的
 *      业务模块，因此必须在 Infrastructure 层，并成为「安全边界」的一部分。
 *   2. 名字：类改叫 OpenAIClient（§25），旧名 LLMClient 仍等价导出——
 *      值导出指向本类，类型导出指向 ports/llm-client.ts 的端口。
 *
 * Transport Retry（§15）：
 *   - 只对 timeout、429 与临时 5xx（500/502/503/504）重试，其它情况立即失败；
 *   - 硬上限 MAX_TRANSPORT_RETRIES = 2，即最多 3 次请求，绝不无限重试；
 *   - Transport Retry ≠ GenerationAttempt Retry：后者是 Pipeline / RetryPolicy 的事，
 *     一次 Attempt 内部的 transport 重试不增加 attempt_number。
 */

import { llmSettings, type LLMOverrides } from "@/infrastructure/config/app-config";
import { Logger } from "@/infrastructure/logging/logger";
import type { LLMTelemetrySink, TelemetryErrorCode } from "@/infrastructure/telemetry/telemetry-collector";
import type { TelemetryCost } from "@/domain/telemetry";
import type { LLMClient as LLMClientPort } from "@/ports/llm-client";

// §16/§32：异常体系在 Domain（domain/llm-errors.ts），这里按旧路径 re-export，
// 让既有的 `from "@/infrastructure/llm/openai-compatible-llm-client"` 继续可用。
// 是同一个类对象，不是抄一份——instanceof 判定因此不会分叉。
export { LLMError, LLMTimeoutError, LLMRequestError } from "@/domain/llm-errors";
import { LLMError, LLMRequestError, LLMTimeoutError } from "@/domain/llm-errors";

/** §15 硬上限：1 次首发 + 2 次重试 = 最多 3 次请求。 */
export const MAX_TRANSPORT_RETRIES = 2;

/** §15 值得重试的状态码：429 限流 + 临时性 5xx。 */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 500;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * 单调时钟（毫秒）。只用 performance.now：target 是 ES2017，BigInt 字面量用不了，
 * 而 Date.now() 会受系统时间调整影响，算出来的时长可能是负的。
 */
function nowMs(): number {
  return performance.now();
}

/** §22 异常 → 稳定错误码。原文一个字都不往外传（遥测里只落这个码）。 */
export function llmErrorCodeOf(e: unknown): TelemetryErrorCode {
  if (e instanceof LLMTimeoutError) return "LLM_TIMEOUT";
  if (e instanceof LLMRequestError) {
    return e.message.includes("内容为空") ? "LLM_EMPTY_RESPONSE" : "LLM_REQUEST_FAILED";
  }
  return "LLM_REQUEST_FAILED";
}

/**
 * v1.8.0 Provider 真实返回的 usage。
 *
 * 三条规矩：只认响应里真有这个字段；拿不到整项是 undefined（调用方据此写 null，
 * 不补 0）；total 缺省时由 input + output 相加得出，两个都有才算，缺一个就不猜。
 */
export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** 从 OpenAI 兼容响应里取 usage。任何形状不合预期都返回 null，不抛、不猜。 */
export function usageOf(data: unknown): LLMUsage | null {
  if (typeof data !== "object" || data === null) return null;
  const usage = (data as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = tokenOf(u.prompt_tokens) ?? tokenOf(u.input_tokens);
  const output = tokenOf(u.completion_tokens) ?? tokenOf(u.output_tokens);
  const total = tokenOf(u.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/**
 * Provider 真实返回的费用。金额与币种必须同时在才有意义——
 * 只有一个时判断不了单位，宁可不记（§8）。这个仓库没有版本化价格表，
 * 所以价格只可能来自 Provider 自己。
 */
export function costOf(data: unknown): { amount: number; currency: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const root = data as Record<string, unknown>;
  const candidates = [root.cost, (root.usage as Record<string, unknown> | undefined)?.cost];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const c = candidate as Record<string, unknown>;
    const amount = tokenOf(c.amount) ?? tokenOf(c.total) ?? tokenOf(c.usd);
    const currency = typeof c.currency === "string" && c.currency.trim() ? c.currency.trim() : null;
    if (amount !== undefined && currency !== null) return { amount, currency };
  }
  return null;
}

function tokenOf(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

/**
 * v1.8.0 一次成功请求的产出：正文 + Provider 真实给的 usage / cost。
 * 拿不到的两项是 null（估算一个数都算造假）。
 */
export interface LLMOnceOutcome {
  text: string;
  usage: LLMUsage | null;
  cost: TelemetryCost | null;
}

export interface LLMClientOptions {
  timeoutMs?: number;
  maxTransportRetries?: number;
  /**
   * v1.8.0 可观测性出口：一次 Run 一个采集器。没接就完全不记——
   * 可观测性缺失不能让生成失败（§15 失败 Run 也保留遥测，反过来也成立：
   * 没有遥测不影响生成）。
   */
  telemetry?: LLMTelemetrySink;
}

/** §25 OpenAI 兼容适配器。实现 ports/llm-client.ts 的 LLMClient 端口。 */
export class OpenAIClient implements LLMClientPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly options: LLMClientOptions = {},
  ) {}

  async generate(
    prompt: string,
    temperature = 0.8,
    system?: string,
  ): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const messages: Array<{ role: string; content: string }> = [];
    if (system && system.trim()) {
      messages.push({ role: "system", content: system.trim() });
    }
    messages.push({ role: "user", content: prompt });

    const timeoutMs = this.options.timeoutMs ?? llmSettings().timeoutMs;
    const maxRetries = this.options.maxTransportRetries ?? MAX_TRANSPORT_RETRIES;

    let lastError: LLMError = new LLMError("LLM 请求未执行");
    const startedAt = new Date().toISOString();
    const startedMono = nowMs();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const outcome = await this.requestOnce(url, messages, temperature, timeoutMs);
        this.report("completed", startedAt, startedMono, outcome);
        return outcome.text;
      } catch (e) {
        lastError = e as LLMError;
        const retryable =
          e instanceof LLMTimeoutError || (e instanceof LLMRequestError && e.status !== undefined && retryableStatus(e.status));
        if (!retryable || attempt === maxRetries) {
          this.report("failed", startedAt, startedMono, null, llmErrorCodeOf(e));
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  /**
   * v1.8.0 向采集器报一次**逻辑**调用。
   *
   * 位置在 transport 重试之外：一次逻辑调用就是调用方眼中「调了一次模型」，
   * 内部那两三次重试是传输层的事，拆开报会让「调用次数」这个数虚高
   * （v0.9.0 §15 已经写明 Transport Retry ≠ GenerationAttempt Retry）。
   *
   * 报数失败绝不影响生成：采集器抛异常也一并吞掉，只留服务端日志。
   */
  private report(
    status: "completed" | "failed",
    startedAt: string,
    startedMono: number,
    outcome: LLMOnceOutcome | null,
    errorCode?: TelemetryErrorCode,
  ): void {
    const sink = this.options.telemetry;
    if (!sink) return;
    try {
      sink.recordLLMCall({
        model: this.model,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(Math.max(0, nowMs() - startedMono)),
        status,
        inputTokens: outcome?.usage?.inputTokens ?? null,
        outputTokens: outcome?.usage?.outputTokens ?? null,
        totalTokens: outcome?.usage?.totalTokens ?? null,
        cost: outcome?.cost ?? null,
        errorCode: errorCode ?? null,
      });
    } catch (e) {
      // 可观测性缺失不能让生成失败（§15 的镜像规则）
      new Logger().child({}).warning(`telemetry record failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** 单次请求：超时 / 状态码 / 空内容都在这里变成稳定的 LLMError 子类。 */
  private async requestOnce(
    url: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number,
    timeoutMs: number,
  ): Promise<LLMOnceOutcome> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, messages, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // §9/§16：错误信息只带原因，不带 Authorization Header 与密钥。
      if (isTimeout(e)) throw new LLMTimeoutError();
      throw new LLMRequestError(`LLM 请求失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // 429 / 5xx 由调用方决定是否 transport 重试；其余 4xx 直接失败。
      throw new LLMRequestError(`LLM API 返回 ${res.status}`, res.status);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: unknown;
      cost?: unknown;
    };
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new LLMRequestError("LLM 返回内容为空");
    }
    // v1.8.0：usage / cost 是 Provider 真实给的才有；客户端自己一个数都不估。
    // 取不到就不往上报，采集器那边按 null 落。
    return {
      text,
      usage: usageOf(data),
      cost: costOf(data),
    };
  }
}

/**
 * v1.x 导入兼容。`LLMClient` 这个名字在 2.0.0 里属于**端口**（src/ports/llm-client.ts），
 * 这里为了不破坏既有的 `new LLMClient(...)` 与 `: LLMClient` 写法，把两个名字空间都留出来：
 * 值空间是本适配器，类型空间是端口接口。
 */
export const LLMClient = OpenAIClient;
export type LLMClient = LLMClientPort;

/** 从服务端配置构建客户端；前端只允许传非敏感的 model/baseUrl/temperature 覆盖。 */
export function clientFromEnv(overrides: LLMOverrides = {}, options: LLMClientOptions = {}): LLMClientPort {
  const settings = llmSettings(overrides);
  return new OpenAIClient(settings.baseUrl, process.env.LLM_API_KEY || "", settings.model, {
    timeoutMs: settings.timeoutMs,
    telemetry: options.telemetry,
  });
}
