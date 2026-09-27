/**
 * v2.0.0：运行号生成。
 * 从 domain/run-context.ts 里拆出来——Domain 不该知道 node:crypto，
 * 而「一个 Run 怎么被命名」是基础设施策略（可换成计数器、可换成雪花）。
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** §8 Run ID：时间戳 + 短随机。唯一、文件系统安全、不依赖用户输入。 */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  return `${stamp}_${suffix}`;
}
