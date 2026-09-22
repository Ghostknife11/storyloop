/**
 * v0.9.0 版本号单一来源（TASK §42/§43）。
 *
 * VERSION 文件是唯一真源；/api/version、About 页、Pipeline metadata 的 project_version
 * 全部从这里读，不再各自硬编码。文件缺失时用内置兜底值，保证接口不 500。
 *
 * 读取在调用时发生（不缓存）：改 VERSION 文件后无需重新构建即可生效。
 * 定位顺序：当前工作目录 → 由本文件位置推算的仓库根。
 * 后者保证测试 chdir 进临时目录后，读到的仍是仓库的 VERSION，而不是兜底值。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** VERSION 文件读不到时的兜底值；与仓库 VERSION 保持一致，由测试守护。 */
export const FALLBACK_VERSION = "0.9.0";

/** src/lib/version.ts → 仓库根目录。 */
function repoRootFromModule(): string {
  try {
    return fileURLToPath(new URL("../../", import.meta.url));
  } catch {
    return "";
  }
}

export function projectVersion(): string {
  const candidates = [process.cwd(), repoRootFromModule()].filter((dir) => dir !== "");
  for (const dir of candidates) {
    try {
      const raw = readFileSync(join(dir, "VERSION"), "utf8").trim();
      if (raw) return raw;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return FALLBACK_VERSION;
}
