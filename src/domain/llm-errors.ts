/**
 * v2.0.0 模型调用的异常体系（Domain，§16/§25/§32）。
 *
 * 为什么在 Domain：这三个类是错误词汇表的一部分——Engine 的每个组件、
 * Analysis 的失败归类、Application 的状态码映射都要 instanceof 它们
 * （§32「Domain 不知道 HTTP」反过来也成立：HTTP 映射不能拖着一份抄错的异常层级）。
 * 放在 Infrastructure 就意味着「想知道自己为什么失败」得先 import 一个客户端实现。
 *
 * 适配器（OpenAIClient）照旧抛出这三个类；Infrastructure 那边按旧路径 re-export，
 * 既有的 `from "@/infrastructure/llm/openai-compatible-llm-client"` 导入继续可用。
 */

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
