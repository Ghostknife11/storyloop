/**
 * v1.6.0 摘要工具：产物与提示词原文的 SHA-256 十六进制摘要。
 *
 * 只做一件事——把一段 UTF-8 文本变成固定长度的摘要。不在这个文件里读文件、
 * 不判断「该不该记」，读盘由调用方（ArtifactStore / PromptRegistry）负责。
 */

import { createHash } from "node:crypto";

/** 文本的 SHA-256 十六进制摘要（小写）。同一个输入永远得到同一个结果。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
