/**
 * v2.0.0 Ports：工程日志端口（§28）。
 *
 * 分析层、引擎层只要「记一句」这个能力，不需要知道它写 stdout 还是写文件、
 * 也不需要知道 LOG_LEVEL 怎么读。实现在 Infrastructure（src/infrastructure/logging/
 * logger.ts）：写控制台、按等级过滤、每条消息过一遍脱敏。
 *
 * 只声明写日志用得到的方法。`child()` / `enabled()` 是具体实现自己方便用的，
 * 不进端口——端口照着调用方需要的样子长，不是照着实现长。
 */

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warning(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}
