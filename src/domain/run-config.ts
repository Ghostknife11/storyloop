/**
 * v2.0.0 单次请求的运行时覆盖（非敏感项）。
 *
 * 这三个字段描述「这一次调用想用哪个模型、多高的温度、打到哪个地址」，
 * 在 v1.x 里叫 GenerateRuntime，定义在 src/lib/generate-service.ts（Application）。
 * 但 Engine 的 GenerationPipeline 每个方法都要收它——于是 Engine 为了一个纯数据类型
 * 反向 import Application，和 Application → Engine 的组装依赖合成一个环（§72）。
 *
 * 它本来就不含行为：三个可选字段，纯粹是请求体到引擎的传递载体，
 * 所以归 Domain（§18 稳定契约），Engine / Application / CLI 都从这里 import。
 */

export interface GenerateRuntime {
  model?: string;
  baseUrl?: string;
  temperature?: number;
}
