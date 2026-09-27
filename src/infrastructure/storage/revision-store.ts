import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { revisionHistoryOf, type DocumentRevision } from "@/domain/document-revision";
import { isWorkspaceId } from "@/domain/workspace";
import type { RevisionRepository } from "@/ports/revision-store";

/**
 * v2.2.0 修订存储：只管 projects/<id>/revisions/<docId>/（TASK §5/§31）。
 *
 * 布局：
 *   projects/<id>/revisions/<docId>/revisions.json   修订索引（追加）
 *   projects/<id>/revisions/<docId>/<revId>.md       某一版的完整正文
 *
 * 与其它存储同一套纪律：原子写入（tmp + rename）、失败消息里只有文件名（§67）、
 * 路径全部过 containment check（§42）。修订是会一直增长的用户数据，所以这里的
 * 每一条判断都要经得起「用户存了两千次」——index.json 整份重写每次只多几百字节，
 * 但 rename 保证了它不会写一半。
 */

const REVISIONS_DIR = "revisions";
const INDEX_FILE = "revisions.json";
const TMP_PREFIX = ".";

/** 磁盘满 / 权限不足。消息只带文件名（§67）。 */
export class RevisionWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`修订写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "RevisionWriteError";
  }
}

function failureCodeOf(cause: unknown): string {
  const detail = (cause ?? {}) as { code?: unknown; syscall?: unknown };
  const parts: string[] = [];
  if (typeof detail.code === "string" && detail.code.trim()) parts.push(detail.code.trim());
  if (typeof detail.syscall === "string" && detail.syscall.trim()) parts.push(detail.syscall.trim());
  return parts.length > 0 ? parts.join(" ") : "未知原因";
}

function putText(path: string, text: string, filename: string): void {
  const tmp = join(join(path, ".."), `${TMP_PREFIX}${filename}.tmp`);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    throw new RevisionWriteError(filename, e);
  }
}

export class FileRevisionRepository implements RevisionRepository {
  private projectsRoot: string;

  /** 显式路径 = projects/ 根本身；缺省与 ProjectStore / DocumentStore / ExportStore 同源。 */
  constructor(projectsRoot?: string) {
    this.projectsRoot = resolve(projectsRoot || join(process.cwd(), "runs", "..", "projects"));
  }

  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  get root(): string {
    return this.projectsRoot;
  }

  private revisionsDir(projectId: string, documentId: string): string {
    if (!isWorkspaceId(projectId) || !isWorkspaceId(documentId)) {
      throw new RevisionWriteError(INDEX_FILE, undefined);
    }
    const dir = resolve(this.projectsRoot, projectId, REVISIONS_DIR, documentId);
    if (dir === this.projectsRoot || !dir.startsWith(this.projectsRoot + sep)) {
      throw new RevisionWriteError(INDEX_FILE, undefined);
    }
    return dir;
  }

  private indexPath(projectId: string, documentId: string): string {
    return join(this.revisionsDir(projectId, documentId), INDEX_FILE);
  }

  private revisionPath(projectId: string, documentId: string, revisionId: string): string {
    if (!isWorkspaceId(revisionId)) throw new RevisionWriteError(INDEX_FILE, undefined);
    const dir = this.revisionsDir(projectId, documentId);
    const path = resolve(dir, `${revisionId}.md`);
    if (path !== dir && !path.startsWith(dir + sep)) throw new RevisionWriteError(INDEX_FILE, undefined);
    return path;
  }

  listRevisions(projectId: string, documentId: string): DocumentRevision[] {
    const path = this.indexPath(projectId, documentId);
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    try {
      return revisionHistoryOf(JSON.parse(text));
    } catch {
      return [];
    }
  }

  countRevisions(projectId: string, documentId: string): number {
    return this.listRevisions(projectId, documentId).length;
  }

  readRevision(projectId: string, documentId: string, revisionId: string): { revision: DocumentRevision; content: string } | null {
    const found = this.listRevisions(projectId, documentId).find((r) => r.id === revisionId);
    if (!found) return null;
    const path = this.revisionPath(projectId, documentId, revisionId);
    if (!existsSync(path)) return null;
    try {
      return { revision: found, content: readFileSync(path, "utf8") };
    } catch {
      return null;
    }
  }

  /**
   * 落一条修订。先写正文再追加索引——顺序是刻意选的：
   * 反过来写的话，索引里会先出现一条指向空文件的记录，而「有一条对不上号的修订史」
   * 比「有一条没进索引的修订」更难解释。前者会被当成 bug，后者只是多一个孤儿文件。
   */
  putRevision(projectId: string, revision: DocumentRevision, content: string): void {
    // documentId 取 revision.documentId 而不是另收一个参数：修订一旦写进另一个
    // 稿件的目录，它就永远对不上了，而两个参数天然可以被写成不一致的一对
    const documentId = revision.documentId;
    const contentPath = this.revisionPath(projectId, documentId, revision.id);
    if (existsSync(contentPath)) throw new RevisionWriteError(revision.id, undefined);
    putText(contentPath, content, `${revision.id}.md`);

    const history = this.listRevisions(projectId, documentId);
    history.push(revision);
    putText(this.indexPath(projectId, documentId), JSON.stringify({ revisions: history }, null, 2), INDEX_FILE);
  }
}
