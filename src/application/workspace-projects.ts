/**
 * v2.2.0 工作区用例（Application）：项目（TASK §9/§10/§12）。
 *
 * 这一层只回答「项目这一层该发生什么」，不回答「文件长在哪」：读写全部经端口出去
 * （ProjectRepository / DocumentRepository / ArtifactStore），所以测试拿一个临时
 * 目录就能跑完整生命周期，不必真起一个 Next 服务。
 *
 * 两条边界是硬约定，代码里看得见：
 *   1. 项目只组织**已存在**的 Run 与稿件，不改变生成行为（§64）。建一个项目不会
 *      让任何一次跑的模型、参数、重试策略变化——它只给 Run 一个归属标签。
 *   2. Run 是不可变的。所以「这个项目有哪些 Run」不写进 project.json，靠扫
 *      run-manifest.json 的 workspace.projectId 归纳（§19：单一事实源）。
 *      归档一个项目只改它的 status，里面的 Run 一个字不动。
 */

import {
  PROJECT_STATUSES,
  projectListItemOf,
  validateProject,
  validateProjectPatch,
  withProjectPatch,
  type Project,
  type ProjectListItem,
} from "@/domain/project";
import { WorkspaceValidationError, isWorkspaceId, optionalTextOf, rejectSecretBearingKeys, rejectUnknownKeys } from "@/domain/workspace";
import { generateProjectId } from "@/infrastructure/id/workspace-id";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { WorkspaceNotFoundError } from "@/domain/workspace";
import type { ProjectRepository } from "@/ports/project-store";
import type { DocumentRepository } from "@/ports/document-store";
import type { RunManifest } from "@/domain/run-manifest";

/** 用例入口收的依赖：全部可选，缺省补默认实现（测试可逐项替换）。 */
export interface ProjectCaseDeps {
  projects?: ProjectRepository;
  documents?: DocumentRepository;
  artifactStore?: ArtifactStore;
  now?: () => Date;
}

interface ResolvedDeps {
  projects: ProjectRepository;
  documents: DocumentRepository;
  listRunIds: () => string[];
  readManifest: (runId: string) => RunManifest | null;
  now: () => Date;
}

function resolve(deps: ProjectCaseDeps): ResolvedDeps {
  const artifactStore = deps.artifactStore ?? new ArtifactStore();
  return {
    projects: deps.projects ?? new FileProjectRepository(),
    documents: deps.documents ?? new FileDocumentRepository(),
    listRunIds: () => artifactStore.listRunIds(),
    readManifest: (runId) => artifactStore.readRunManifest(runId),
    now: deps.now ?? (() => new Date()),
  };
}

/** 项目详情：项目本身 + 归纳出来的 Run 归属 + 稿件 id。 */
export interface ProjectDetail {
  project: Project;
  /** 归这个项目的 Run id，新的在前。 */
  runIds: string[];
  /** 项目下的稿件 id（不含正文）。 */
  documentIds: string[];
}

/** 列表项 + 各自名下的 Run 数。项目列表页要同时显示这两样。 */
export interface ProjectSummary {
  project: ProjectListItem;
  runCount: number;
}

/**
 * 一次遍历把 Run 按项目分组。
 *
 * 为什么是「扫 Manifest」而不是「读 project.json 里存的 runId 列表」：那样就有两处
 * 要同步，而它们一定 diverged。Run 是不可变的，它自己记的归属就是终局——哪怕项目
 * 后来被归档、改名、甚至记录被删掉，Run 也不会改口。
 */
export function groupRunsByProject(
  runIds: string[],
  readManifest: (runId: string) => RunManifest | null,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const runId of runIds) {
    const manifest = readManifest(runId);
    const projectId = manifest?.workspace?.projectId;
    if (!projectId || !isWorkspaceId(projectId)) continue;
    const bucket = grouped.get(projectId);
    if (bucket) bucket.push(runId);
    else grouped.set(projectId, [runId]);
  }
  // run id 自带时间戳前缀，倒序即新的在前
  for (const bucket of grouped.values()) bucket.sort().reverse();
  return grouped;
}

export async function listProjects(deps: ProjectCaseDeps = {}): Promise<ProjectSummary[]> {
  const { projects, listRunIds, readManifest } = resolve(deps);
  const runCounts = new Map<string, number>();
  for (const [projectId, runIds] of groupRunsByProject(listRunIds(), readManifest)) {
    runCounts.set(projectId, runIds.length);
  }
  const summaries: ProjectSummary[] = [];
  for (const id of projects.listProjectIds()) {
    const project = projects.readProject(id);
    if (project) summaries.push({ project: projectListItemOf(project), runCount: runCounts.get(id) ?? 0 });
  }
  // 未归档的在前，再按更新时间倒序——回来先看到最近在写的那一个
  summaries.sort((a, b) => {
    if (a.project.status !== b.project.status) return a.project.status === "archived" ? 1 : -1;
    return a.project.updatedAt < b.project.updatedAt ? 1 : -1;
  });
  return summaries;
}

export async function getProject(projectId: string, deps: ProjectCaseDeps = {}): Promise<ProjectDetail> {
  const { projects, documents, listRunIds, readManifest } = resolve(deps);
  const project = requireProject(projects, projectId);
  const runIds = groupRunsByProject(listRunIds(), readManifest).get(projectId) ?? [];
  return { project, runIds, documentIds: documents.listDocumentIds(projectId) };
}

export async function createProject(raw: unknown, deps: ProjectCaseDeps = {}): Promise<Project> {
  const { projects, now } = resolve(deps);
  rejectSecretBearingKeys(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(r, ["name", "storyConfigRef", "isFavorite"], "project");

  const id = generateProjectId(now());
  const timestamp = now().toISOString();
  const project = validateProject({
    schemaVersion: "1",
    id,
    name: optionalTextOf(r.name, "name", 120) ?? "未命名项目",
    status: "active",
    storyConfigRef: optionalTextOf(r.storyConfigRef, "storyConfigRef", 200) ?? null,
    currentDocumentId: null,
    isFavorite: r.isFavorite === true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  projects.createProjectDirectory(id);
  projects.putProject(project);
  return project;
}

export async function updateProject(projectId: string, raw: unknown, deps: ProjectCaseDeps = {}): Promise<Project> {
  const { projects, now } = resolve(deps);
  const current = requireProject(projects, projectId);
  rejectSecretBearingKeys(raw);
  // status 与 currentDocumentId 的合法性由 domain/project 的 validateProjectPatch 判，
  // 这里不再判第二遍——两处规则一定会 diverged
  const patch = validateProjectPatch(raw);
  const next = withProjectPatch(current, patch, now().toISOString());
  projects.putProject(next);
  return next;
}

/**
 * 归档 / 恢复。status 由调用方显式给，不提供 toggle：一个意图模糊的开关在 UI 上
 * 会变成「点了不知道会发生什么」（§33）。归档不删任何东西（§64）。
 */
export async function setProjectStatus(projectId: string, status: string, deps: ProjectCaseDeps = {}): Promise<Project> {
  if (!PROJECT_STATUSES.includes(status as Project["status"])) {
    throw new WorkspaceValidationError(`status 只能是 ${PROJECT_STATUSES.join(" / ")}`);
  }
  return updateProject(projectId, { status }, deps);
}

export async function setProjectFavorite(projectId: string, isFavorite: boolean, deps: ProjectCaseDeps = {}): Promise<Project> {
  return updateProject(projectId, { isFavorite }, deps);
}

/**
 * 把当前稿件指到某一篇。只改 project.json 里的一个指针，不动稿件本身——
 * 「现在在写哪一篇」是项目的状态，不是文档的属性（改文档会造成一次跨项目的写入）。
 */
export async function setCurrentDocument(projectId: string, documentId: string | null, deps: ProjectCaseDeps = {}): Promise<Project> {
  if (documentId !== null && !isWorkspaceId(documentId)) {
    throw new WorkspaceValidationError("documentId 不合法：只能是单个目录名");
  }
  return updateProject(projectId, { currentDocumentId: documentId }, deps);
}

function requireProject(projects: ProjectRepository, projectId: string): Project {
  if (!isWorkspaceId(projectId)) throw new WorkspaceValidationError("项目 id 不合法：只能是单个目录名");
  const project = projects.readProject(projectId);
  if (!project) throw new WorkspaceNotFoundError(projectId);
  return project;
}

