/**
 * v2.2.0 工作区标识生成（TASK §5）。
 *
 * 与 run-id.ts 同一条理由从 Domain 拆出来：Domain 不该知道 node:crypto，
 * 而「一个项目怎么被命名」是基础设施策略（可以换成计数器、可以换成雪花）。
 *
 * 四类标识共用一个形状：`<前缀>_<日期>_<时刻>_<6 位随机>`。时间戳打头是为了
 * 目录列举天然按创建顺序排（项目多了以后靠名字排序会随时漂），随机尾巴保证
 * 同一秒内连建两个也不会撞名。前缀让人一眼看出 projects/ 下哪个目录是什么，
 * 也避免与 runs/ 的时间戳目录名混淆。
 *
 * 生成出来的串 must 满足 domain/workspace.ts 的 isWorkspaceId：单段、以字母
 * 开头、只含字母数字点下划线连字符——由 generateWorkspaceId 自己保证，
 * 调用方不需要再校验一次。
 */

import { randomBytes } from "node:crypto";

/** 四类工作区对象：项目 / 稿件 / 导出 / 修订。 */
export type WorkspaceIdKind = "prj" | "doc" | "out" | "rev";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function stampOf(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function suffixOf(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function generateWorkspaceId(kind: WorkspaceIdKind, now: Date = new Date()): string {
  return `${kind}_${stampOf(now)}_${suffixOf()}`;
}

export function generateProjectId(now: Date = new Date()): string {
  return generateWorkspaceId("prj", now);
}

export function generateDocumentId(now: Date = new Date()): string {
  return generateWorkspaceId("doc", now);
}

export function generateExportId(now: Date = new Date()): string {
  return generateWorkspaceId("out", now);
}

export function generateRevisionId(now: Date = new Date()): string {
  return generateWorkspaceId("rev", now);
}
