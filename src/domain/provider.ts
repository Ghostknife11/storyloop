/**
 * v0.0.1 只支持 OpenAI-compatible 端点（§18）。
 * API Key 永远只存服务端 .env（§24），浏览器不保存密钥。
 */

/**
 * 提供商元数据：默认地址 + 该地址下 UI 可选的模型名。
 *
 * 放在 Domain 而不是 Interface：它同时被三处需要——设置页要列出可选模型、
 * Manifest 要从生效地址反推提供商名、安全关卡要判断这个地址是不是公开已知
 * 端点。它是一张与 UI 无关的事实表（哪个地址属于谁），谁都能读，因此属于最底层。
 * 反过来让 Infrastructure 去 import Interface，就把依赖方向倒过来了（§12）。
 */
export interface ProviderInfo {
  name: string;
  defaultBaseURL: string;
  models: string[];
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  openai: {
    name: "OpenAI",
    defaultBaseURL: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
  deepseek: {
    name: "DeepSeek",
    defaultBaseURL: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  siliconflow: {
    name: "硅基流动",
    defaultBaseURL: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
  },
  custom: {
    name: "自定义中转站",
    defaultBaseURL: "",
    models: [],
  },
};

/** 生成参数的默认值（没有覆盖时用这一组）。 */
export const DEFAULT_GENERATION_PARAMS = {
  temperature: 0.8,
} as const;
