/**
 * v2.0.0 组合根（TASK §14/§34）。
 *
 * 这是全仓唯一「new 出具体实现」的地方：FileArtifactStore、ExperimentStore、
 * 以及按请求现建的模型客户端，都只在这里落地；用例、门面、路由、CLI 拿到的
 * 都是已经装好的依赖（§16），因此 Interface 里看不见 new StoryGenerator()。
 *
 * §34 的用法就是本文件这三个导出：
 *   const deps = createDependencies(config);
 *   const app  = createStoryLoopApplication(deps);
 *   await app.service.generate(body);
 *
 * 每次调用都重新解析一次环境与目录（不在模块级缓存）：RUNS_DIR / LLM_* 是服务端
 * 运维旋钮，测试 chdir 进临时目录后也必须立刻生效——这是 v1.x 起就守住的约定，
 * 组合根不能把它改回 import 时求值。
 */

import {
  createStoryLoopService,
  type StoryLoopDependencies,
  type StoryLoopService,
} from "@/application/story-loop-service";
import { assembleHealthReport, type HealthReport } from "@/application/health";
import { buildPipeline } from "@/application/generate-service";
import { appSettings } from "@/infrastructure/config/app-config";
import { dirname, join, resolve } from "node:path";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { ExperimentStore } from "@/infrastructure/storage/experiment-store";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { healthProbes, providerConfigured } from "@/infrastructure/health/health-probe";
import type { ArtifactStore as ArtifactStorePort } from "@/ports/artifact-store";
import type { LLMClient } from "@/ports/llm-client";
import type { PipelineFactory } from "@/engine/pipeline-components";
import {
  assessProjectHealthUseCase,
  type HealthCaseDeps,
} from "@/application/workspace-health";
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

/** 组合根的入参：全部可选，缺省值一律来自服务端配置（§33 只在这里读）。 */
export interface StoryLoopOptions {
  /** 产物根目录；缺省取 RUNS_DIR 或仓库下的 runs/。 */
  runsDir?: string;
  /** 调用方自带的模型客户端（测试替身 / CLI / 嵌入方）。
   *  缺省时由用例按请求体与服务端环境现建，URL 关卡照旧生效（§24）。 */
  llm?: LLMClient;
  artifactStore?: ArtifactStorePort;
  experimentStore?: ExperimentStore;
}

/** 装好的依赖：两个袋子的部件 + 两个存储实例（实例只为渲染与探测留一份）。 */
export interface StoryLoopDependenciesBundle extends StoryLoopDependencies {
  runsDir: string;
  artifactStore: ArtifactStorePort;
  experimentStore: ExperimentStore;
}

/** §14 第一步：把 Infrastructure 的实现装配成用例可用的依赖。 */
export function createDependencies(options: StoryLoopOptions = {}): StoryLoopDependenciesBundle {
  const runsDir = options.runsDir?.trim() || appSettings().runsDir;
  const artifactStore = options.artifactStore ?? new ArtifactStore(runsDir);
  const experimentStore = options.experimentStore ?? new ExperimentStore(runsDir);
  const shared = options.llm ? { llm: options.llm } : {};
  return {
    runsDir,
    artifactStore,
    experimentStore,
    run: { ...shared, artifactStore },
    // §30：实验与普通 Run 走同一条正式生成路径，这里由组合根把它交到实验用例手上；
    // 凭据探针同样在这里落地——分析层只问一句，自己不去摸环境变量（§33）
    experiment: { ...shared, artifactStore, experimentStore, generate: buildPipeline, providerProbe: providerConfigured },
  };
}

/** §14 第二步：把依赖绑成可用的应用（门面 + 健康）。 */
export interface StoryLoopApplication {
  /** §17 公共服务门面：API / CLI / UI 数据层只面向它。 */
  service: StoryLoopService;
  /** 原始依赖（CLI 渲染产物时要直接读存储的那条路）。 */
  deps: StoryLoopDependenciesBundle;
  /** §30 生成路径的唯一正式入口。 */
  generate: PipelineFactory;
  /** §46 健康与能力：真查出来的布尔，不带任何凭据。 */
  health(): HealthReport;
}

export function createStoryLoopApplication(
  deps: StoryLoopDependenciesBundle = createDependencies(),
): StoryLoopApplication {
  const service = createStoryLoopService(deps);
  const generate: PipelineFactory = deps.experiment?.generate ?? buildPipeline;
  return {
    service,
    deps,
    generate,
    health: () => assembleHealthReport(healthProbes(deps.runsDir)),
  };
}

/** 一步拿到装好的应用：路由与 CLI 的常规入口。 */
export function createStoryLoop(options: StoryLoopOptions = {}): StoryLoopApplication {
  return createStoryLoopApplication(createDependencies(options));
}

// ---------------------------------------------------------------------------
// v2.2.0 Creator Workspace（TASK §14/§34/§35）
// ---------------------------------------------------------------------------

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

/** 四个仓储 + 已注入用例依赖的三个袋子。路由只碰 WorkspaceCases，不碰仓储。 */
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

/** §33 的九个 Workspace 用例，每个都是现取依赖、现调用——组合根不缓存实例。 */
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
