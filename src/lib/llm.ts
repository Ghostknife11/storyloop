export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

/**
 * v0.0.1 薄 LLM 客户端 —— 只讲 OpenAI-compatible /chat/completions。
 * 刻意不做 Provider Registry / Router / Fallback（TASK v0.1.0 §50：本版本不大改 LLM 层）。
 * v0.1.0 新增：可选 system 消息（§51）。
 */
export class LLMClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
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

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, messages, temperature }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "请求超时" : String(e);
      throw new LLMError(`LLM 请求失败：${reason}`);
    }
    if (!res.ok) {
      throw new LLMError(`LLM API 返回 ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new LLMError("LLM 返回内容为空");
    }
    return text;
  }
}

export interface LLMOverrides {
  model?: string;
  baseUrl?: string;
}

/** 从服务端 .env 构建客户端；前端只允许传非敏感的 model/baseUrl 覆盖。 */
export function clientFromEnv(overrides: LLMOverrides = {}): LLMClient {
  const baseUrl = overrides.baseUrl?.trim() || process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.LLM_API_KEY || "";
  const model = overrides.model?.trim() || process.env.LLM_MODEL || "gpt-4o-mini";
  return new LLMClient(baseUrl, apiKey, model);
}
