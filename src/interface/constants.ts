/**
 * 界面层常量入口（v2.0.0）。
 *
 * 内容已经搬到 Domain：PROVIDERS / DEFAULT_GENERATION_PARAMS 是与 UI 无关的
 * 事实表，设置页、Manifest、安全关卡都要读，所以放在最底层（见
 * src/domain/provider.ts）。这里保留 re-export 只是让界面侧的 import 路径不变；
 * 新代码请直接从 Domain 导入——让 Infrastructure 为了一张表去 import 界面层，
 * 就把依赖方向倒过来了（§12）。
 */

export { DEFAULT_GENERATION_PARAMS, PROVIDERS, type ProviderInfo } from "@/domain/provider";
