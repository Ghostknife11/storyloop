/**
 * v2.2.0 Ports：修订仓储端口（TASK §31 RevisionRepository）。
 *
 * 与 DocumentRepository / ExportRepository 同一套纪律：同步方法、只认稿件 id、
 * 不判断这一版该不该留（那是用例层的事）。
 *
 * 索引与正文分开读是刻意的：列修订史只需要 revisions.json 里的几百字节，
 * 正文要等到用户真的点开某一版才读（§35 边界）。
 */

import type { DocumentRevision, RevisionWithContent } from "@/domain/document-revision";

export interface RevisionRepository {
  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  readonly root: string;

  /** 某篇稿件的修订史，按时间正序；目录不存在 / 索引损坏 → 空数组。 */
  listRevisions(projectId: string, documentId: string): DocumentRevision[];

  /** 落一条修订：正文写 <revId>.md，索引追加到 revisions.json。 */
  putRevision(projectId: string, revision: DocumentRevision, content: string): void;

  /** 读某一版正文；不存在 → null。 */
  readRevision(projectId: string, documentId: string, revisionId: string): RevisionWithContent | null;

  /** 某篇稿件一共有多少版（工作区要显示「已存 N 版」，不必把索引读出来）。 */
  countRevisions(projectId: string, documentId: string): number;
}
