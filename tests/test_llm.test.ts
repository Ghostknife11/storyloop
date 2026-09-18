import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient, LLMError } from "@/lib/llm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLMClient", () => {
  it("发送 OpenAI-compatible 请求并解析 content", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "# 故事" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

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

  it("HTTP 非 2xx 抛 LLMError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
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
