export interface ProviderInfo {
  name: string;
  defaultBaseURL: string;
  models: string[];
}

/**
 * v0.0.1 只支持 OpenAI-compatible 端点（§18）。
 * API Key 永远只存服务端 .env（§24），浏览器不保存密钥。
 */
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

export const DEFAULT_GENERATION_PARAMS = {
  temperature: 0.8,
} as const;
