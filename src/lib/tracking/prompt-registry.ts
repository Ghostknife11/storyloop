/**
 * v1.6.0 提示词登记表：六个阶段各自的提示词文件、版本号与原文摘要。
 *
 * `metadata.json` 里只有一个 `model`，看不出「这一版跑的时候提示词长什么样」；
 * v1.6.0 把六个提示词各登记一条：角色 + 版本 + SHA-256 摘要。
 *
 * 版本号在 `PROMPT_VERSIONS` 里手维护——改了提示词文案就在这里 +1。
 * 摘要由代码现算，所以「改了文案却没 bump 版本」不会悄悄溜过去：摘要变了、
 * 版本没变，读 Manifest 的人一眼看得出这次改动没记账。摘要与版本是两个独立信号，
 * 刻意不让其中一个从另一个推出来。
 *
 * 只登记**真实存在**的六个提示词文件。StoryValidator 是纯规则、QualityAssembler 是纯装配，
 * 两者都不调模型、都没有提示词，所以这里没有它们的条目。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPT_ROLES,
  type PromptRole,
  type PromptSnapshot,
} from "@/types/run-manifest";
import { sha256Hex } from "@/lib/tracking/digest";

/** 模块加载时锁定项目根，与 `src/lib/prompt-template.ts` 同一套做法（测试 chdir 之后不漂移）。 */
const PROJECT_ROOT = process.cwd();

/** 角色 → prompts/ 下的文件名。 */
const PROMPT_FILES: Record<PromptRole, string> = {
  planner: "beat_planner.txt",
  generator: "story.txt",
  "beat-validator": "beat_validator.txt",
  reviewer: "reviewer.txt",
  "commercial-reviewer": "commercial_reviewer.txt",
  repairer: "repair.txt",
};

/**
 * 各提示词的版本号。v1.6.0 首次登记，六个都从 1 开始；
 * 之后每次改动对应角色的文案就在这里 +1（摘要会同步变，两者互相印证）。
 */
export const PROMPT_VERSIONS: Record<PromptRole, string> = {
  planner: "1",
  generator: "1",
  "beat-validator": "1",
  reviewer: "1",
  "commercial-reviewer": "1",
  repairer: "1",
};

/** 提示词目录（相对项目根）。 */
export const PROMPT_DIR = "prompts";

/** 某个角色的提示词文件名。 */
export function promptFileNameOf(role: PromptRole): string {
  return PROMPT_FILES[role];
}

/**
 * 读一份提示词原文；文件缺失或读不到时返回 `null`（对应 Manifest 里 digest 键不出现）。
 * 这里刻意不抛异常：提示词读不到不该让一次已经跑完的 Run 记不成 Manifest。
 */
export function readPromptText(role: PromptRole): string | null {
  try {
    return readFileSync(join(PROJECT_ROOT, PROMPT_DIR, PROMPT_FILES[role]), "utf8");
  } catch {
    return null;
  }
}

/** 六个角色的登记项，顺序固定为 PROMPT_ROLES（与 `prompts: PromptSnapshot[]` 一致）。 */
export function promptSnapshots(): PromptSnapshot[] {
  return PROMPT_ROLES.map((role) => {
    const snapshot: PromptSnapshot = { role, version: PROMPT_VERSIONS[role] };
    const text = readPromptText(role);
    if (text !== null) snapshot.digest = sha256Hex(text);
    return snapshot;
  });
}
