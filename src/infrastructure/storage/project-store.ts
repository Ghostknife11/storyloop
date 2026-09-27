import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { projectOf, type Project } from "@/domain/project";
import { isWorkspaceId } from "@/domain/workspace";
import type { ProjectRepository } from "@/ports/project-store";

/**
 * v2.2.0 项目存储：只管 projects/<id>/project.json 一个文件的读写（TASK §5）。
 * 与 ExperimentStore 同一套纪律——不调 LLM、不分析内容、不决定流程；
 * 原子写入（临时文件 → rename），失败时消息里只有相对文件名，不带服务器
 * 绝对路径（§67）。
 *
 * 目录布局（TASK §5）：
 *   projects/
 *     <project_id>/
 *       project.json    项目本身（status / favorite / currentDocumentId）
 *       documents/      由 DocumentStore 管（稿件正文与元数据）
 *       revisions/      由 DocumentStore 管（轻量修订）
 *       exports/        由 ExportStore 管（DOCX / EPUB 与导出史）
 *
 * 根目录的位置：与 runs/ 并列的兄弟目录——`resolve(runsRoot, "..", "projects")`。
 * 刻意**不新增 PROJECTS_DIR 环境变量**：experiments/ 从 v1.7.0 起就是按
 * 「跟 runs/ 做兄弟」定的，workspace 再引入第二个旋钮只会让同一次运维里
 * 三个目录散落在三处。测试要隔离目录时直接传显式路径。
 */

const PROJECT_FILE = "project.json";

/** 磁盘满 / 权限不足 / 目录被占用。消息只带相对文件名（§67）。 */
export class ProjectWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`项目数据写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "ProjectWriteError";
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

export class FileProjectRepository implements ProjectRepository {
  private projectsRoot: string;

  /** 显式路径 = projects/ 根本身；缺省取 <cwd>/runs 的兄弟目录 projects/。 */
  constructor(projectsRoot?: string) {
    this.projectsRoot = resolve(projectsRoot || join(process.cwd(), "runs", "..", "projects"));
  }

  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  get root(): string {
    return this.projectsRoot;
  }

  /**
   * §42 Path Traversal 防护：projectId 已经过校验，这里再做一次 containment check。
   * 根目录自身也不算——`resolve(root, ".")` 等于根本身，放过去就等于把
   * projects/ 根当成一个项目来读写。
   */
  private projectDir(projectId: string): string {
    if (!isWorkspaceId(projectId)) throw new ProjectWriteError(PROJECT_FILE, undefined);
    const dir = resolve(this.projectsRoot, projectId);
    if (dir === this.projectsRoot || !dir.startsWith(this.projectsRoot + sep)) {
      throw new ProjectWriteError(PROJECT_FILE, undefined);
    }
    return dir;
  }

  resolveProjectDir(projectId: string): string {
    return this.projectDir(projectId);
  }

  /** 目录不存在（或 project.json 读不回来）→ 当作不存在。 */
  exists(projectId: string): boolean {
    try {
      return existsSync(this.projectDir(projectId)) && this.readProject(projectId) !== null;
    } catch {
      return false;
    }
  }

  /** 建目录；已存在就复用（是否允许覆盖由用例判断，存储层不判断）。 */
  createProjectDirectory(projectId: string): string {
    const dir = this.projectDir(projectId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new ProjectWriteError(PROJECT_FILE, e);
    }
    return dir;
  }

  putProject(project: Project): void {
    this.putText(project.id, PROJECT_FILE, JSON.stringify(project, null, 2));
  }

  /**
   * 读项目。文件缺失、JSON 坏掉、或与当前 schemaVersion 不兼容（读回来校验不过）
   * 都返回 null——调用方按「不存在」处理，不猜（与 `projectOf` / `runManifestOf` 同一套做法）。
   */
  readProject(projectId: string): Project | null {
    return projectOf(this.readJson(projectId, PROJECT_FILE));
  }

  /** projects/ 下所有项目 id，按目录名字典序。 */
  listProjectIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // projects/ 还不存在（全新部署、或从没建过项目）不是错误：返回空列表（TASK §55）
      return [];
    }
    // 手放进来的目录名也可能不是合法 id：列不出来就别列，更不该拿它去拼路径
    return names.filter((name) => this.exists(name)).sort();
  }

  // ---------------------------------------------------------------------------
  // 内部：路径解析与原子写入
  // ---------------------------------------------------------------------------

  /** 与 ExperimentStore 同一套原子语义：先写同目录临时文件再 rename。 */
  private putText(projectId: string, filename: string, content: string): void {
    const finalPath = resolve(this.projectDir(projectId), filename);
    const tmpPath = join(join(finalPath, ".."), `.${basename(finalPath)}.tmp`);
    try {
      mkdirSync(this.projectDir(projectId), { recursive: true });
      writeFileSync(tmpPath, content, "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new ProjectWriteError(filename, e);
    }
  }

  private readJson(projectId: string, filename: string): Record<string, unknown> | null {
    const path = resolve(this.projectDir(projectId), filename);
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
