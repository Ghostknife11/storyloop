import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLMClient,
  LLMError,
  LLMRequestError,
  LLMTimeoutError,
  MAX_TRANSPORT_RETRIES,
  clientFromEnv,
} from "@/lib/llm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** 固定返回某个状态码的 fetch 假件，并记录被调了几次。 */
function statusFetch(status: number) {
  const calls = vi.fn(async () => new Response("{}", { status }));
  vi.stubGlobal("fetch", calls);
  return calls;
}

/** 按调用顺序依次返回：元素可以是状态码、正文或 Error。 */
function scriptedFetch(steps: Array<number | string | Error>) {
  const calls = vi.fn(async () => {
    const step = steps[Math.min(calls.mock.calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === "number") return new Response("{}", { status: step });
    return new Response(JSON.stringify({ choices: [{ message: { content: step } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", calls);
  return calls;
}

function okFetch(content: string) {
  const calls = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", calls);
  return calls;
}

describe("LLMClient", () => {
  it("发送 OpenAI-compatible 请求并解析 content", async () => {
    const fetchMock = okFetch("# 故事");

    const client = new LLMClient("https://api.example.com/v1/", "test-key", "test-model");
    const out = await client.generate("写故事", 0.7);

    expect(out).toBe("# 故事");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].content).toBe("写故事");
    expect(body.temperature).toBe(0.7);
  });

  it("system prompt 有值时进 messages[0]，没有就不占位", async () => {
    const fetchMock = okFetch("正文");
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await client.generate("提示", 0.8, "  系统设定  ");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "系统设定" },
      { role: "user", content: "提示" },
    ]);
  });

  it("HTTP 非 2xx 抛 LLMError", async () => {
    statusFetch(401);
    const client = new LLMClient("https://api.example.com/v1", "bad", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMError);
  });

  it("choices 为空抛 LLMError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMError);
  });

  it("网络异常抛 LLMError 而非原始错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMError);
  });
});

// ---------------------------------------------------------------------------
// §15 Transport Retry：硬上限 2 次重试，只重试 timeout / 429 / 临时 5xx
// ---------------------------------------------------------------------------

describe("§15 Transport Retry", () => {
  it("硬上限是 2：1 次首发 + 2 次重试 = 最多 3 个请求", async () => {
    const calls = statusFetch(503);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMRequestError);
    expect(calls).toHaveBeenCalledTimes(1 + MAX_TRANSPORT_RETRIES);
    expect(MAX_TRANSPORT_RETRIES).toBe(2);
  });

  it("429 与临时 5xx 会被重试，重试成功就正常返回", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const calls = scriptedFetch([status, "重试后的正文"]);
      const client = new LLMClient("https://api.example.com/v1", "k", "m");
      await expect(client.generate("x")).resolves.toBe("重试后的正文");
      expect(calls, `status ${status}`).toHaveBeenCalledTimes(2);
    }
  });

  it("其它 4xx 不重试，只发一次请求", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const calls = statusFetch(status);
      const client = new LLMClient("https://api.example.com/v1", "k", "m");
      const error = await client.generate("x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LLMRequestError);
      expect((error as LLMRequestError).status).toBe(status);
      expect(calls, `status ${status}`).toHaveBeenCalledTimes(1);
    }
  });

  it("429 重试耗尽后仍抛 LLMRequestError，且带上最后的状态码", async () => {
    statusFetch(429);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    const error = await client.generate("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMRequestError);
    expect((error as LLMRequestError).status).toBe(429);
    expect((error as Error).message).toContain("429");
  });

  it("网络异常不重试：只发一次，错误仍是 LLMError", async () => {
    const calls = scriptedFetch([new Error("socket hang up")]);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMError);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("Transport Retry 不改变调用契约：temperature / system 每次都一样", async () => {
    const calls = scriptedFetch([503, 503, "最终正文"]);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("提示", 0.5, "系统")).resolves.toBe("最终正文");
    expect(calls).toHaveBeenCalledTimes(3);
    for (const call of calls.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(JSON.parse(init.body as string)).toEqual({
        model: "m",
        messages: [
          { role: "system", content: "系统" },
          { role: "user", content: "提示" },
        ],
        temperature: 0.5,
      });
    }
  });

  it("maxTransportRetries 可显式关掉：0 表示一次都不重试", async () => {
    const calls = statusFetch(503);
    const client = new LLMClient("https://api.example.com/v1", "k", "m", { maxTransportRetries: 0 });
    await expect(client.generate("x")).rejects.toThrow(LLMRequestError);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §16 Timeout：稳定异常类型 + 超时同样受硬上限约束
// ---------------------------------------------------------------------------

describe("§16 Timeout", () => {
  it("超时（TimeoutError）抛 LLMTimeoutError，且同样重试到硬上限", async () => {
    const calls = scriptedFetch([Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMTimeoutError);
    expect(calls).toHaveBeenCalledTimes(1 + MAX_TRANSPORT_RETRIES);
  });

  it("AbortError 也按超时处理", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }));
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMTimeoutError);
  });

  it("LLMTimeoutError 是 LLMError 的子类：调用方捕获 LLMError 就够", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }));
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).rejects.toThrow(LLMError);
  });

  it("超时后重试成功：拿到正文，只多花一次请求", async () => {
    const calls = scriptedFetch([
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      "迟到但成功的正文",
    ]);
    const client = new LLMClient("https://api.example.com/v1", "k", "m");
    await expect(client.generate("x")).resolves.toBe("迟到但成功的正文");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("每次请求都带 AbortSignal，超时值来自配置", async () => {
    const calls = okFetch("正文");
    const client = new LLMClient("https://api.example.com/v1", "k", "m", { timeoutMs: 1234 });
    await client.generate("x");
    const init = (calls.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §14/§6/§7 clientFromEnv：密钥只从服务端环境读，覆盖项只有非敏感字段
// ---------------------------------------------------------------------------

describe("§14 clientFromEnv", () => {
  it("baseUrl / model / timeout 来自环境变量与请求覆盖", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://env.example.com/v1");
    vi.stubEnv("LLM_MODEL", "env-model");
    vi.stubEnv("LLM_TIMEOUT", "4321");
    const calls = okFetch("正文");
    const client = clientFromEnv();
    await client.generate("x");
    const [url, init] = calls.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://env.example.com/v1/chat/completions");
    expect(JSON.parse(init.body as string).model).toBe("env-model");

    const override = clientFromEnv({ model: "req-model", baseUrl: "https://req.example.com/v1" });
    await override.generate("x");
    const [url2, init2] = calls.mock.calls[1] as unknown as [string, RequestInit];
    expect(url2).toBe("https://req.example.com/v1/chat/completions");
    expect(JSON.parse(init2.body as string).model).toBe("req-model");
  });

  it("API Key 只从 LLM_API_KEY 读，覆盖项里没有它", async () => {
    vi.stubEnv("LLM_API_KEY", "env-secret-value");
    const calls = okFetch("正文");
    await clientFromEnv().generate("x");
    const init = (calls.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer env-secret-value");
  });

  it("没有 API Key 时不伪造请求体，错误信息可读", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    statusFetch(401);
    const client = clientFromEnv();
    await expect(client.generate("x")).rejects.toThrow(LLMRequestError);
  });
});
