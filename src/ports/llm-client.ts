/**
 * v2.0.0 Ports：模型客户端端口（§13/§25）。
 *
 * 这是**唯一**被允许说「我要调一次模型」的地方。Engine 的每个组件
 * （Planner / Generator / Validator / Reviewer / Repairer）都只依赖这个接口，
 * 不依赖任何具体 Provider、不 import fetch、不知道 baseUrl 与密钥。
 *
 * §13 的端口形状是 `LLMClient { complete(request) }`。这里的方法名沿用 v1.x 的
 * `generate()`，理由是 §26 与 §74：FakeLLM 与全部既有调用方必须继续可用，
 * 换方法名会带来一次没有能力收益的破坏。语义完全一致——一次逻辑补全。
 *
 * 适配器：OpenAICompatibleLLMClient（Infrastructure）。
 * 测试替身：FakeLLM（tests/）。
 */

export interface LLMClient {
  /** 一次模型补全。temperature 缺省 0.8；system 为空时只发 user 消息。 */
  generate(prompt: string, temperature?: number, system?: string): Promise<string>;
}

/** 端口抛出的轻量异常体系（§16）。由适配器定义，端口这里只做类型声明。 */
export interface LLMClientError extends Error {
  readonly name: string;
}

/** 一次补全的入参：Provider 无关，只含提示词与采样温度。 */
export interface LLMCompletionRequest {
  prompt: string;
  temperature?: number;
  system?: string;
}
