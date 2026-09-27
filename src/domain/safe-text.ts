/**
 * v2.0.0 脱敏与路径清洗（§32/§46/§55）。
 *
 * 从 interface/safe-text.ts 与 interface/logger.ts 里各取一半合成这一份，放在 Domain：
 *   1. 它必须是纯函数——没有任何 I/O、没有时间、没有随机，同样的输入必然同样的输出。
 *   2. 它被三个方向同时用到：Logger（Infrastructure）、API 响应（Application）、
 *      UI（Interface）。放在 Infrastructure 会让 Application/Interface 反向依赖它，
 *      所以唯一合法位置是 Domain。
 *
 * 两件事：
 *   1. 服务器绝对路径一律换成 <path> —— node:fs 的异常文本天生带着完整路径，
 *      原样传出去就是明令禁止的泄漏。
 *   2. 密钥形态的串打码，日志与响应复用同一套规则（redactSecrets）。
 */

/**
 * 前置边界：绝对路径前面只能是空白 / 引号 / 括号 / 冒号 / 行首。
 * 换成人话：紧跟在普通字符后面的 `/` 或 `\` 是相对文件名的一部分，不是绝对路径。
 */
const ABSOLUTE_PATH = /(?<![^\s'"(（:：])(?:[A-Za-z]:)?[\\/][^\s'"]*[\\/][^\s'"]*/g;

/** §9 脱敏：密钥形态的串一律打码，日志与响应里只剩前后各几位用于定位。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/("?(?:api[_-]?key|authorization|token|password|secret)"?\s*[:=]\s*")([^"]*)(")/gi, "$1***$3");
}

/** 把可能带服务器绝对路径与凭据的文本，清理成可以进响应的文本。 */
export function safeText(raw: string): string {
  return redactSecrets(raw.replace(ABSOLUTE_PATH, "<path>"));
}

/** 只用于测试与自查：当前生效的绝对路径规则。 */
export const ABSOLUTE_PATH_PATTERN = ABSOLUTE_PATH;
