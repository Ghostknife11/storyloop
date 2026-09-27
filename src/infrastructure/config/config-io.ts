/**
 * v2.0.0：配置的序列化 / 解析 / 文件名规则搬到 Domain 了
 * （src/domain/story-config.ts）——它们是纯函数，浏览器里的设置页也要用；
 * 让界面层为了拿三个字符串函数去 import 配置模块，就把依赖方向倒过来了（§12）。
 *
 * 这个文件只剩 re-export，让 `@/infrastructure/config/config-io` 这个旧路径
 * 继续可用；新代码请直接从 Domain 导入。
 */

export {
  ConfigLoadError,
  configFilename,
  parseStoryConfig,
  serializeStoryConfig,
} from "@/domain/story-config";
