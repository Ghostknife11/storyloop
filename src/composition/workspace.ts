/**
 * v2.2.0 组合根——Workspace 半边（TASK §33/§34/§35）。
 *
 * 为什么单独一个文件，而不是并进 index.ts：安全扫描按模块导入图报过七条工作区
 * 路由「2 跳到达 SSRF」——`@/composition` 这一个模块里同时挂着生成管线
 * （createStoryLoop → buildPipeline → 模型客户端 → 本仓唯一一处 fetch）与工作区。
 * 两条路的**代码**从来没有相通（createWorkspace 只 new 三个文件仓储），但静态图
 * 看不出这件事，于是每次提交都要人工解释一遍。
 *
 * 拆开之后，Import 图自己就会说话：一个路由如果只需要读写 projects/，它的依赖图
 * 里就连一个 HTTP 客户端都不存在。这条性质由 tests/test_workspace_network_boundary.ts
 * 当场验（哪个模块能出现在工作区路由的闭包里）。
 *
 * 注意别把 barrel 引回来：index.ts 仍然 re-export 这里的东西（给 CLI 与旧调用方
 * 一个稳定入口），但路由必须直接 import "@/composition/workspace"——绕回 index
 * 就等于把上面那件事又撤销了。
 *
 * 每次调用都重新解析一次环境与目录（不在模块级缓存）：RUNS_DIR 是服务端运维旋钮，
 * 测试 chdir 进临时目录后也必须立刻生效——v1.x 起就守住的约定。
 */

import { appSettings } from "@/infrastructure/config/app-config";
import { dirname, join, resolve } from "node:path";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import type { ArtifactStore as ArtifactStorePort } from "@/ports/artifact-store";
import { assessProjectHealthUseCase, type HealthCaseDeps } from "@/application/workspace-health";
import {
  exportDocument,
  listProjectExports,
  readExportArtifact,
  type ExportCaseDeps,
  type ExportDownload,
  type ExportOutcome,
} from "@/application/workspace-exports";
import {
  createDocumentFromRun,
  getDocument,
  listDocuments,
  saveDocument,
  type DocumentCaseDeps,
  type DocumentSummary,
} from "@/application/workspace-documents";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  type ProjectCaseDeps,
  type ProjectDetail,
  type ProjectSummary,
} from "@/application/workspace-projects";
import type { Project } from "@/domain/project";
import type { ProjectHealthResult } from "@/domain/project-health";
import type { ExportResult } from "@/domain/export-artifact";
import type { StoryDocument } from "@/domain/story-document";

/**
 * Workspace 的目录：projects/ 与 runs/ 同级。
 *
 * 之所以跟着 runsDir 走而不是各写一个默认值：两边一旦分家（比如 RUNS_DIR 指到
 * 一块大盘上，projects/ 还留在仓库里），「从 Run 建稿」就会跨盘 rename，
 * 而 workspace.ts 里那条「跨项目搬运要明说」的判定也会因为读不到 Manifest 而失灵。
 */
function workspaceProjectsDir(runsDir: string): string {
  return join(dirname(resolve(runsDir)), "projects");
}

export interface WorkspaceOptions {
  runsDir?: string;
  /** projects/ 根；缺省与 runs/ 同级。 */
  projectsDir?: string;
  artifactStore?: ArtifactStorePort;
}

/** 四个仓储 + 已注入用例依赖的一个袋子。路由只碰 WorkspaceCases，不碰仓储。 */
export interface WorkspaceBundle {
  runsDir: string;
  projectsDir: string;
  projectsDeps: ProjectCaseDeps & DocumentCaseDeps & HealthCaseDeps & ExportCaseDeps;
}

/**
 * §34：把 Workspace 的仓储装配成已经注入好依赖的用例门面。
 *
 * 这里仍然是全仓唯一 new 出具体实现的地方。路由因此只剩「解析参数、调用、映射」
 * 三件事（§35）：既不会去拼文件系统路径，也不会自己生成 DOCX。
 */
export function createWorkspaceBundle(options: WorkspaceOptions = {}): WorkspaceBundle {
  const runsDir = options.runsDir?.trim() || appSettings().runsDir;
  const projectsDir = options.projectsDir?.trim() || workspaceProjectsDir(runsDir);
  const artifactStore = options.artifactStore ?? new ArtifactStore(runsDir);
  const projects = new FileProjectRepository(projectsDir);
  const documents = new FileDocumentRepository(projectsDir);
  const exports_ = new FileExportRepository(projectsDir);
  return {
    runsDir,
    projectsDir,
    projectsDeps: { artifactStore, projects, documents, exports: exports_ },
  };
}

/** Workspace 用例门面，每个都是现取依赖、现调用——组合根不缓存实例。 */
export interface WorkspaceCases {
  deps: WorkspaceBundle;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectDetail>;
  createProject(raw: unknown): Promise<Project>;
  updateProject(projectId: string, raw: unknown): Promise<Project>;
  listDocuments(projectId: string): Promise<DocumentSummary[]>;
  getDocument(projectId: string, documentId: string): Promise<StoryDocument>;
  createDocumentFromRun(projectId: string, raw: unknown): Promise<StoryDocument>;
  saveDocument(projectId: string, documentId: string, raw: unknown): Promise<StoryDocument>;
  exportDocument(projectId: string, raw: unknown): Promise<ExportOutcome>;
  listExports(projectId: string): Promise<ExportResult[]>;
  readExport(projectId: string, exportId: string): Promise<ExportDownload | null>;
  health(projectId: string): Promise<ProjectHealthResult>;
}

export function createWorkspace(options: WorkspaceOptions = {}): WorkspaceCases {
  const deps = createWorkspaceBundle(options);
  const d = deps.projectsDeps;
  return {
    deps,
    listProjects: () => listProjects(d),
    getProject: (projectId) => getProject(projectId, d),
    createProject: (raw) => createProject(raw, d),
    updateProject: (projectId, raw) => updateProject(projectId, raw, d),
    listDocuments: (projectId) => listDocuments(projectId, d),
    getDocument: (projectId, documentId) => getDocument(projectId, documentId, d),
    createDocumentFromRun: (projectId, raw) => createDocumentFromRun(projectId, raw, d),
    saveDocument: (projectId, documentId, raw) => saveDocument(projectId, documentId, raw, d),
    exportDocument: (projectId, raw) => exportDocument(projectId, raw, d),
    listExports: (projectId) => listProjectExports(projectId, d),
    readExport: (projectId, exportId) => readExportArtifact(projectId, exportId, d),
    health: (projectId) => assessProjectHealthUseCase(projectId, d),
  };
}
