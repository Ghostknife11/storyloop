import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { storyDocumentOf, type StoryDocument } from "@/domain/story-document";
import { isWorkspaceId } from "@/domain/workspace";
import { sha256Hex } from "@/infrastructure/tracking/digest";
import type { DocumentRepository } from "@/ports/document-store";

/**
 * v2.2.0 稿件存储：只管 projects/<id>/documents/<docId>.json（TASK §5/§7）。
 * 与 ArtifactStore / ProjectStore 同一套纪律：不调 LLM、不分析内容、不决定流程，
 * 原子写入，失败时消息里只有相对文件名（§67）。
 *
 * 目录布局（TASK §5）：
 *   projects/<project_id>/documents/<document_id>.json   整份稿件（含正文）
 *   projects/<project_id>/revisions/<document_id>/       轻量修订（见 document-revision）
 *   projects/<project_id>/exports/                       导出物与导出史
 *
 * 落盘前核对 contentHash 与正文一致——这是这个存储唯一比「写个 JSON」多做的一件事，
 * 也是必须做的一件：contentHash 是「编辑过之后质量结论还算不算数」的唯一依据
 * （TASK §20）。如果允许调用方随手写一个哈希进去，整套陈旧判定就成了一句空话。
 * 核对不过就抛错，不落盘、不静默修正。
 */

const DOCUMENTS_DIR = "documents";

/** 磁盘满 / 权限不足 / 哈希对不上。消息只带相对文件名（§67）。 */
export class DocumentWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`稿件写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "DocumentWriteError";
  }
}

/** 从 node:fs 异常里取不带路径的失败码；没有就用固定文案。 */
function failureCodeOf(cause: unknown): string {
  const detail = (cause ?? {}) as { code?: unknown; syscall?: unknown };
  const parts: string[] = [];
  if (typeof detail.code === "string" && detail.code.trim()) parts.push(detail.code.trim());
  if (typeof detail.syscall === "string" && detail.syscall.trim()) parts.push(detail.syscall.trim());
  return parts.length > 0 ? parts.join(" ") : "未知原因";
}

/**
 * 落盘前核对 contentHash 与正文不一致。
 *
 * 单独一类错误，而不是笼统的「写入失败」：它说明的不是磁盘或权限出了问题，
 * 而是调用方交进来的一份稿件自相矛盾（哈希与正文对不上）。这种稿件一旦写下去，
 * 「编辑过之后旧质量结论还算不算数」的判定就永久失真——所以宁可拒绝，不落盘。
 */
export class DocumentHashError extends Error {
  constructor(readonly documentId: string) {
    super(`稿件正文与 contentHash 不一致：${documentId}`);
    this.name = "DocumentHashError";
  }
}

export class FileDocumentRepository implements DocumentRepository {
  private projectsRoot: string;

  /** 显式路径 = projects/ 根本身；缺省取 <cwd>/runs 的兄弟目录 projects/（与 ProjectStore 同源）。 */
  constructor(projectsRoot?: string) {
    this.projectsRoot = resolve(projectsRoot || join(process.cwd(), "runs", "..", "projects"));
  }

  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  get root(): string {
    return this.projectsRoot;
  }

  /**
   * §42 Path Traversal 防护：projectId 已由领域层校验，这里再做一次 containment check。
   * 根目录自身也不算——把 projects/ 根本身当成一个项目来读写，等于能摸到所有项目。
   */
  private documentsDir(projectId: string): string {
    if (!isWorkspaceId(projectId)) throw new DocumentWriteError(DOCUMENTS_DIR, undefined);
    const dir = resolve(this.projectsRoot, projectId, DOCUMENTS_DIR);
    if (dir === this.projectsRoot || !dir.startsWith(this.projectsRoot + sep)) {
      throw new DocumentWriteError(DOCUMENTS_DIR, undefined);
    }
    return dir;
  }

  resolveDocumentsDir(projectId: string): string {
    return this.documentsDir(projectId);
  }

  /** 路径拼接后必须仍落在该项目的 documents/ 内（§42）。 */
  private documentPath(projectId: string, documentId: string): string {
    if (!isWorkspaceId(documentId)) throw new DocumentWriteError(documentId, undefined);
    const dir = this.documentsDir(projectId);
    const path = resolve(dir, `${documentId}.json`);
    if (path !== dir && !path.startsWith(dir + sep)) {
      throw new DocumentWriteError(documentId, undefined);
    }
    return path;
  }

  exists(projectId: string, documentId: string): boolean {
    try {
      return this.readDocument(projectId, documentId) !== null;
    } catch {
      return false;
    }
  }

  /** 目录不存在（项目刚建、还没写过稿件）→ 空数组，不抛。 */
  listDocumentIds(projectId: string): string[] {
    const dir = this.documentsDir(projectId);
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name.slice(0, -".json".length));
    } catch {
      return [];
    }
    // 手放进来的文件名也可能不是合法 id：列不出来就别列，更不该拿它去拼路径
    return names.filter((name) => isWorkspaceId(name) && this.exists(projectId, name)).sort();
  }

  /**
   * 写稿件。先核对 contentHash，再原子落盘。
   * 目录被手删了也能写回来（mkdirSync recursive）——稿件不该因为有人动了
   * documents/ 就永久写不进去。
   */
  putDocument(document: StoryDocument): void {
    // 先核对再落盘：哈希与正文对不上的稿件不许进磁盘（见 DocumentHashError）
    if (sha256Hex(document.content) !== document.contentHash) {
      throw new DocumentHashError(document.id);
    }
    const finalPath = this.documentPath(document.projectId, document.id);
    const tmpPath = join(join(finalPath, ".."), `.${basename(finalPath)}.tmp`);
    try {
      mkdirSync(join(finalPath, ".."), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new DocumentWriteError(document.id, e);
    }
  }

  /** 文件缺失 / JSON 坏 / 校验不过 → null，调用方按「不存在」处理。 */
  readDocument(projectId: string, documentId: string): StoryDocument | null {
    const path = this.documentPath(projectId, documentId);
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // 文件在但读不动：与「文件不存在」同一个口径，读的一侧不该把接口变成 500
      return null;
    }
    try {
      return storyDocumentOf(JSON.parse(text));
    } catch {
      return null;
    }
  }
}
