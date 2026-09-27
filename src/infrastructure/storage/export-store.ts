import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { exportHistoryOf, type ExportResult } from "@/domain/export-artifact";
import { isWorkspaceId } from "@/domain/workspace";
import type { ExportRepository } from "@/ports/export-store";

/**
 * v2.2.0 导出存储：只管 projects/<id>/exports/（TASK §5/§31）。
 *
 * 与其它存储同一套纪律：不调 LLM、不读稿件内容、不决定导出格式，原子写入，
 * 失败消息里只有文件名（§67）。
 *
 * 布局：
 *   projects/<id>/exports/index.json    导出史（追加）
 *   projects/<id>/exports/<文件名>      导出文件本体
 *
 * 文件名一律由 domain 的 safeExportFilename 生成（限长、去危险字符、带 id 后缀）。
 * 这里仍然要当它是不可信输入再校验一遍：写盘的函数不知道调用方是谁，
 * 而 §42 的防线本来就不该建立在「上层一定乖」上面。
 */

const EXPORTS_DIR = "exports";
const INDEX_FILE = "index.json";
const TMP_PREFIX = ".";
const FILENAME_MAX = 128;

/** 磁盘满 / 权限不足。消息只带文件名（§67）。 */
export class ExportWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`导出写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "ExportWriteError";
  }
}

function failureCodeOf(cause: unknown): string {
  const detail = (cause ?? {}) as { code?: unknown; syscall?: unknown };
  const parts: string[] = [];
  if (typeof detail.code === "string" && detail.code.trim()) parts.push(detail.code.trim());
  if (typeof detail.syscall === "string" && detail.syscall.trim()) parts.push(detail.syscall.trim());
  return parts.length > 0 ? parts.join(" ") : "未知原因";
}

/**
 * §42：文件名必须是单段、不能是点开头、不能超长。
 * 不认扩展名白名单——那是导出器的职责，存储只负责「不许跑出 exports/」。
 */
function isSafeFilename(filename: unknown): filename is string {
  if (typeof filename !== "string") return false;
  if (filename.length === 0 || filename.length > FILENAME_MAX) return false;
  if (filename.startsWith(TMP_PREFIX)) return false;
  return !/[/\\]/.test(filename) && filename !== "." && filename !== "..";
}

export class FileExportRepository implements ExportRepository {
  private projectsRoot: string;

  /** 显式路径 = projects/ 根本身；缺省与 ProjectStore / DocumentStore 同源。 */
  constructor(projectsRoot?: string) {
    this.projectsRoot = resolve(projectsRoot || join(process.cwd(), "runs", "..", "projects"));
  }

  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  get root(): string {
    return this.projectsRoot;
  }

  private exportsDir(projectId: string): string {
    if (!isWorkspaceId(projectId)) throw new ExportWriteError(EXPORTS_DIR, undefined);
    const dir = resolve(this.projectsRoot, projectId, EXPORTS_DIR);
    if (dir === this.projectsRoot || !dir.startsWith(this.projectsRoot + sep)) {
      throw new ExportWriteError(EXPORTS_DIR, undefined);
    }
    return dir;
  }

  resolveExportsDir(projectId: string): string {
    return this.exportsDir(projectId);
  }

  private artifactPath(projectId: string, filename: string): string {
    if (!isSafeFilename(filename)) throw new ExportWriteError(EXPORTS_DIR, undefined);
    const dir = this.exportsDir(projectId);
    const path = resolve(dir, filename);
    if (path !== dir && !path.startsWith(dir + sep)) {
      throw new ExportWriteError(EXPORTS_DIR, undefined);
    }
    return path;
  }

  private indexPath(projectId: string): string {
    return this.artifactPath(projectId, INDEX_FILE);
  }

  /** 目录不存在 → 空数组。index.json 自己不出现在列表里，临时文件也不出现。 */
  listExportFilenames(projectId: string): string[] {
    const dir = this.exportsDir(projectId);
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
    return names.filter((name) => isSafeFilename(name) && name !== INDEX_FILE).sort();
  }

  exists(projectId: string, filename: string): boolean {
    try {
      return existsSync(this.artifactPath(projectId, filename));
    } catch {
      return false;
    }
  }

  /** 已存在就抛错：用户手里那个文件不该被一次新的导出悄悄换掉。 */
  putArtifact(projectId: string, filename: string, bytes: Uint8Array): void {
    const finalPath = this.artifactPath(projectId, filename);
    if (existsSync(finalPath)) throw new ExportWriteError(filename, undefined);
    const tmpPath = join(join(finalPath, ".."), `${TMP_PREFIX}${basename(finalPath)}.tmp`);
    try {
      mkdirSync(join(finalPath, ".."), { recursive: true });
      writeFileSync(tmpPath, bytes);
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new ExportWriteError(filename, e);
    }
  }

  readArtifact(projectId: string, filename: string): Uint8Array | null {
    const path = this.artifactPath(projectId, filename);
    if (!existsSync(path)) return null;
    try {
      const buffer = readFileSync(path);
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  /**
   * 导出史。index.json 缺失 / 读不动 / 坏条目 → 只丢掉坏的那几条。
   * 历史记录与文件是两条独立的线：文件被人删了，历史照样在（反之也说得通），
   * 用例层展示时会说明这一条对不上号。
   */
  listExports(projectId: string): ExportResult[] {
    const path = this.indexPath(projectId);
    if (!existsSync(path)) return [];
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    try {
      return exportHistoryOf(JSON.parse(text));
    } catch {
      return [];
    }
  }

  /**
   * 追加一条历史。整份重写 + rename（与其它存储同一套原子写法）。
   * 没有条数上限：一条记录几百字节，真有项目导出上万次，那也是用户在真用。
   */
  recordExport(projectId: string, result: ExportResult): void {
    const history = this.listExports(projectId);
    history.push(result);
    const finalPath = this.indexPath(projectId);
    const tmpPath = join(join(finalPath, ".."), `${TMP_PREFIX}${basename(finalPath)}.tmp`);
    try {
      mkdirSync(join(finalPath, ".."), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(history, null, 2), "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new ExportWriteError(INDEX_FILE, e);
    }
  }
}
