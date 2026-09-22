/**
 * v0.9.1 响应脱敏（TASK §67）。
 *
 * 这一个模块决定「什么能被允许进 API 响应」。两件事：
 *   1. 服务器绝对路径一律换成 <path> —— node:fs 的异常文本天生带着完整路径，
 *      原样传出去就是 §67 明令禁止的泄漏。
 *   2. 密钥形态的串打码，与日志脱敏复用同一套规则（redactSecrets）。
 *
 * v0.9.1 修的两个坑：
 *   - 正则加了前置边界。旧版没有边界，`attempts/01/story.md` 里的 `/01/`
 *     会被当成绝对路径一起吃成 <path>，用户拿到的错误消息读不了。
 *   - 调用方不再各自拼 cause.message。ArtifactWriteError 就是在那儿把
 *     绝对路径一路带进 500 响应体的（见 artifact-store.ts 的说明）。
 */

import { redactSecrets } from "@/lib/logger";

/**
 * 前置边界：绝对路径前面只能是空白 / 引号 / 括号 / 冒号 / 行首。
 * 换成人话：紧跟在普通字符后面的 `/` 或 `\` 是相对文件名的一部分，不是绝对路径。
 */
const ABSOLUTE_PATH = /(?<![^\s'"(（:：])(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/][^\s'"]*/g;

/** 把可能带服务器绝对路径与凭据的文本，清理成可以进响应的文本。 */
export function safeText(raw: string): string {
  return redactSecrets(raw.replace(ABSOLUTE_PATH, "<path>"));
}

/** 只用于测试与自查：当前生效的绝对路径规则。 */
export const ABSOLUTE_PATH_PATTERN = ABSOLUTE_PATH;
