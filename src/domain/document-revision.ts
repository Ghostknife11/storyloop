/**
 * v2.2.0 轻量修订：一篇稿件的历次落盘快照（TASK §20）。
 *
 * 修订存在的理由只有一个：用户在编辑器里改了几千字，然后想回到两小时前那一版。
 * 不是版本控制系统，不做 diff，不合并，不解决冲突——一个短篇创作工具不需要
 * 把 git 的那套搬进浏览器。这里存的是一串**完整正文快照**加一条索引。
 *
 * 三条约定：
 *   1. 一稿一版，contentHash 记录这一版正文的摘要，与快照一一对应；
 *   2. 索引与正文分开存：revisions.json 只放元信息（哪一版、何时、多少字、
 *      从哪来），正文在 <revId>.md 里。于是列修订史不必把几千字读进内存；
 *   3. origin 只区分「用户手动存的一版」与「自动保存留下的一版」——
 *      自动保存不该无名无姓地盖掉用户手动存的那一版，这个标记就是给用户在界面上
 *      分清两者的依据。
 */

import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceValidationError,
  isWorkspaceId,
  isoTimestampOf,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
  textOf,
} from "@/domain/workspace";

/** 修订的来源：手动保存 / 自动保存。 */
export type RevisionOrigin = "manual" | "autosave";

export const REVISION_ORIGINS = ["manual", "autosave"] as const;

/** 修订索引条目（不含正文）。 */
export interface DocumentRevision {
  schemaVersion: string;
  id: string;
  documentId: string;
  /** 这一版正文的 SHA-256；与 <id>.md 的内容一一对应。 */
  contentHash: string;
  origin: RevisionOrigin;
  createdAt: string;
  wordCount: number;
}

/** 修订索引条目 + 正文（只在真的要看那一版时才用这个形状）。 */
export interface RevisionWithContent {
  revision: DocumentRevision;
  content: string;
}

const REVISION_KEYS = [
  "schemaVersion",
  "id",
  "documentId",
  "contentHash",
  "origin",
  "createdAt",
  "wordCount",
] as const;

const HASH = /^[0-9a-f]{64}$/;

/** §47 结构校验：形状不对就抛 WorkspaceValidationError。 */
export function validateDocumentRevision(raw: unknown): DocumentRevision {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, REVISION_KEYS, "revision");

  const schemaVersion = textOf(r.schemaVersion, "schemaVersion", 16);
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(`schemaVersion 只支持 ${WORKSPACE_SCHEMA_VERSION}（实际 ${schemaVersion}）`);
  }
  const id = textOf(r.id, "id", 64);
  const documentId = textOf(r.documentId, "documentId", 64);
  if (!isWorkspaceId(id) || !isWorkspaceId(documentId)) {
    throw new WorkspaceValidationError("修订 id 与稿件 id 不合法：只能是单个目录名");
  }
  const contentHash = textOf(r.contentHash, "contentHash", 64);
  if (!HASH.test(contentHash)) {
    throw new WorkspaceValidationError("contentHash 必须是 SHA-256 十六进制摘要");
  }
  const origin = textOf(r.origin, "origin", 16);
  if (!REVISION_ORIGINS.includes(origin as RevisionOrigin)) {
    throw new WorkspaceValidationError(`origin 只能是 ${REVISION_ORIGINS.join(" / ")}`);
  }
  return {
    schemaVersion,
    id,
    documentId,
    contentHash,
    origin: origin as RevisionOrigin,
    createdAt: isoTimestampOf(r.createdAt, "createdAt"),
    wordCount: typeof r.wordCount === "number" && Number.isFinite(r.wordCount) && r.wordCount >= 0 ? Math.floor(r.wordCount) : 0,
  };
}

/** 读回时归一化：坏条目整条丢掉，不影响索引里其它条。 */
export function documentRevisionOf(raw: unknown): DocumentRevision | null {
  try {
    return validateDocumentRevision(raw);
  } catch {
    return null;
  }
}

/** 修订索引：数组形态（`{"revisions": [...]}`），读坏了的条目不进结果。 */
export function revisionHistoryOf(raw: unknown): DocumentRevision[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries = (raw as { revisions?: unknown }).revisions;
  if (!Array.isArray(entries)) return [];
  const out: DocumentRevision[] = [];
  for (const entry of entries) {
    const parsed = documentRevisionOf(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
