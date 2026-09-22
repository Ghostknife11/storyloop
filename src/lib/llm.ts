/**
 * v0.9.0 LLM 客户端加固（TASK §14/§15/§16）。
 *
 * 所有模型调用仍走这一个类：Planner / Generator / Reviewer / Repairer 都不自己实现
 * timeout / auth / request（§14）。薄客户端，刻意不做 Provider Registry /
 * Model Router / Fallback（§70）。
 *
 * Transport Retry（§15）：
 *   - 只对 timeout、429 与临时 5xx（500/502/503/504）重试，其它情况立即失败；
 *   - 硬上限 MAX_TRANSPORT_RETRIES = 2，即最多 3 次请求，绝不无限重试；
 *   - Transport Retry ≠ GenerationAttempt Retry：后者是 Pipeline / RetryPolicy 的事，
 *     一次 Attempt 内部的 transport 重试不增加 attempt_number。
 */

import { llmSettings, type LLMOverrides } from "@/lib/app-config";

/** §16 轻量异常体系：三个类，不建巨大层级。 */
export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

/** §16 超时：请求在 timeoutMs 内没有完成（含 transport 重试全部超时）。 */
export class LLMTimeoutError extends LLMError {
  constructor(message = "LLM 请求超时") {
    super(message);
    this.name = "LLMTimeoutError";
  }
}

/** §16 请求失败：网络异常或 API 返回非 2xx（429 / 5xx 重试耗尽后也归这里）。 */
export class LLMRequestError extends LLMError {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LLMRequestError";
  }
}

/** §15 硬上限：1 次首发 + 2 次重试 = 最多 3 次请求。 */
export const MAX_TRANSPORT_RETRIES = 2;

/** §15 值得重试的状态码：429 限流 + 临时性 5xx。 */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 500;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

export interface LLMClientOptions {
  timeoutMs?: number;
  maxTransportRetries?: number;
}

export class LLMClient {
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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestOnce(url, messages, temperature, timeoutMs);
      } catch (e) {
        lastError = e as LLMError;
        const retryable =
          e instanceof LLMTimeoutError || (e instanceof LLMRequestError && e.status !== undefined && retryableStatus(e.status));
        if (!retryable || attempt === maxRetries) throw lastError;
      }
    }
    throw lastError;
  }

  /** 单次请求：超时 / 状态码 / 空内容都在这里变成稳定的 LLMError 子类。 */
  private async requestOnce(
    url: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number,
    timeoutMs: number,
  ): Promise<string> {
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
    };
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new LLMRequestError("LLM 返回内容为空");
    }
    return text;
  }
}

/** 从服务端配置构建客户端；前端只允许传非敏感的 model/baseUrl/temperature 覆盖。 */
export function clientFromEnv(overrides: LLMOverrides = {}): LLMClient {
  const settings = llmSettings(overrides);
  return new LLMClient(settings.baseUrl, process.env.LLM_API_KEY || "", settings.model, {
    timeoutMs: settings.timeoutMs,
  });
}
