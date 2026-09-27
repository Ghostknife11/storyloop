/**
 * v2.2.0 工作区用例（Application）：稿件（TASK §8/§11/§20/§48）。
 *
 * §48 Release Blocker 就落在这个文件里：**编辑稿件绝不回写 Run 的 story.md**。
 * 整条保存链路只碰 documents/ 与 revisions/，一次都没有往 runs/ 写过东西——
 * 读 Run 只是创建 Draft 那一下的一次性复制。把这条边界放在用例层而不是 UI，
 * 是因为 UI 漏了还有服务端兜着，服务端漏了就只剩 UI 一层遮羞布。
 *
 * 保存的判定（§20）：contentHash 必须由**新正文**现算，不能由请求带进来。
 * 于是「编辑过之后旧的质量结论还算不算数」这个问题永远有一个可信的答案：
 * 比较稿件里记的 sourceRunId 那次 Run 的质量结论与现在的 contentHash。
 */

import {
  DOCUMENT_CONTENT_MAX,
  DOCUMENT_STATUSES,
  DOCUMENT_SOURCES,
  documentContentOf,
  splitStoryTitle,
  validateDocumentPatch,
  validateStoryDocument,
  wordCountOf,
  withDocumentPatch,
  type DocumentStatus,
  type DocumentSource,
  type StoryDocument,
} from "@/domain/story-document";
// 校验基元来自 domain/workspace：story-document 只导出稿件自己的东西
import {
  WorkspaceNotFoundError,
  WorkspaceValidationError,
  isWorkspaceId,
  optionalTextOf,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
} from "@/domain/workspace";
import { generateDocumentId } from "@/infrastructure/id/workspace-id";
import { sha256Hex } from "@/infrastructure/tracking/digest";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import type { DocumentRepository } from "@/ports/document-store";
import type { ProjectRepository } from "@/ports/project-store";

/** 用例入口收的依赖：全部可选，缺省补默认实现（测试可逐项替换）。 */
export interface DocumentCaseDeps {
  projects?: ProjectRepository;
  documents?: DocumentRepository;
  artifactStore?: ArtifactStore;
  now?: () => Date;
}

interface ResolvedDeps {
  projects: ProjectRepository;
  documents: DocumentRepository;
  storyOf: (runId: string) => string | null;
  manifestProjectId: (runId: string) => string | null;
  now: () => Date;
}

function resolve(deps: DocumentCaseDeps): ResolvedDeps {
  const artifactStore = deps.artifactStore ?? new ArtifactStore();
  return {
    projects: deps.projects ?? new FileProjectRepository(),
    documents: deps.documents ?? new FileDocumentRepository(),
    storyOf: (runId) => (isWorkspaceId(runId) ? artifactStore.readFinalStory(runId) : null),
    manifestProjectId: (runId) => (isWorkspaceId(runId) ? artifactStore.readRunManifest(runId)?.workspace?.projectId ?? null : null),
    now: deps.now ?? (() => new Date()),
  };
}

/** 列表项之外，编辑器还要知道正文有多长；正文本身不进列表（§35 边界）。 */
export interface DocumentSummary {
  id: string;
  title: string;
  status: DocumentStatus;
  source: DocumentSource;
  sourceRunId: string | null;
  wordCount: number;
  updatedAt: string;
  createdAt: string;
  isFavorite: boolean;
}

function summaryOf(document: StoryDocument): DocumentSummary {
  return {
    id: document.id,
    title: document.title,
    status: document.status,
    source: document.source,
    sourceRunId: document.sourceRunId,
    wordCount: wordCountOf(document.content),
    updatedAt: document.updatedAt,
    createdAt: document.createdAt,
    isFavorite: document.isFavorite,
  };
}

function requireProject(projects: ProjectRepository, projectId: string): void {
  if (!isWorkspaceId(projectId)) throw new WorkspaceValidationError("项目 id 不合法：只能是单个目录名");
  if (!projects.readProject(projectId)) throw new WorkspaceNotFoundError(projectId);
}

function requireDocument(documents: DocumentRepository, projectId: string, documentId: string): StoryDocument {
  if (!isWorkspaceId(documentId)) throw new WorkspaceValidationError("稿件 id 不合法：只能是单个目录名");
  const document = documents.readDocument(projectId, documentId);
  if (!document) throw new WorkspaceNotFoundError(documentId);
  return document;
}

/**
 * Run → Draft：把一次 Run 的正文复制成一份可编辑稿件（§8/§22）。
 *
 * 标题优先用运行清单里那次生成的标题（story.md 的 H1）；请求里显式带的标题优先于它；
 * 两者都没有时退回「未命名」——不猜，一个猜出来的标题会被用户当成事实。
 *
 * 归属校验：Run 的 Manifest 若声明了项目，那它只能是同一个项目。v2.2.0 之前生成的、
 * 以及直接走 /api/generate 没带 projectId 的 Run 没有这个声明，可以搬进任何项目。
 * 这条规则不是安全边界（稿件终究是用户自己的内容），而是为了不在用户看不见的地方
 * 把别人的运行产物搬进自己项目里。
 */
export async function createDocumentFromRun(
  projectId: string,
  raw: unknown,
  deps: DocumentCaseDeps = {},
): Promise<StoryDocument> {
  const { projects, documents, storyOf, manifestProjectId, now } = resolve(deps);
  requireProject(projects, projectId);
  rejectSecretBearingKeys(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(r, ["runId", "title", "status"], "document");

  const runId = optionalTextOf(r.runId, "runId", 64);
  if (!runId) throw new WorkspaceValidationError("必须带 runId：稿件是从一次运行复制来的");
  if (!isWorkspaceId(runId)) throw new WorkspaceValidationError("runId 不合法：只能是单个目录名");

  const owner = manifestProjectId(runId);
  if (owner !== null && owner !== projectId) {
    throw new WorkspaceValidationError("这次运行已经属于另一个项目：跨项目搬运要在界面上明说，不走暗路");
  }
  const story = storyOf(runId);
  if (story === null || story.trim().length === 0) {
    // 没有 story.md 说明这次运行没产出正文（硬失败 / 被手工清过）。Run 本身不动，
    // 只是无从复制——NotFound 而不是 500：调用方问的是「有没有东西可搬」
    throw new WorkspaceNotFoundError(runId);
  }

  const { title } = splitStoryTitle(story);
  // 与「质量结论是否过期」共用一个取正文的函数（§20，见 domain/story-document.ts）
  const content = documentContentOf(story);
  if (content.length > DOCUMENT_CONTENT_MAX) {
    throw new WorkspaceValidationError(`正文不能超过 ${DOCUMENT_CONTENT_MAX} 个字符`);
  }
  const finalTitle = optionalTextOf(r.title, "title", 120) ?? title ?? "未命名";
  const document = newDocument({
    projectId,
    title: finalTitle,
    content,
    source: "generated",
    sourceRunId: runId,
    status: r.status === "final" ? "final" : "draft",
    now: now(),
  });
  documents.putDocument(document);
  setCurrentDocument(projects, projectId, document.id, now());
  return document;
}

/**
 * 新建一份空白稿 / 导入一份外部正文。
 *
 * 两个来源在模型里是同一条路径，区别只有 source：粘贴进来的记 imported（第一份正文
 * 不是这个系统生成的），一个字都不带的记 edited。它不进任何路径，只为了将来
 * 用户自己能看出这篇稿子的来路（§9）。
 */
export async function createDocument(
  projectId: string,
  raw: unknown,
  deps: DocumentCaseDeps = {},
): Promise<StoryDocument> {
  const { projects, documents, now } = resolve(deps);
  requireProject(projects, projectId);
  rejectSecretBearingKeys(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(r, ["title", "content", "status", "source"], "document");

  const content = optionalTextOf(r.content, "content", DOCUMENT_CONTENT_MAX) ?? "";
  const source = r.source === undefined ? (content.trim() ? "imported" : "edited") : sourceOf(r.source);
  const document = newDocument({
    projectId,
    title: optionalTextOf(r.title, "title", 120) ?? (content.trim() ? "导入的正文" : "未命名"),
    content,
    source,
    sourceRunId: null,
    status: r.status === "final" ? "final" : "draft",
    now: now(),
  });
  documents.putDocument(document);
  setCurrentDocument(projects, projectId, document.id, now());
  return document;
}

function sourceOf(raw: unknown): DocumentSource {
  const source = String(raw);
  if (!DOCUMENT_SOURCES.includes(source as DocumentSource)) {
    throw new WorkspaceValidationError(`source 只能是 ${DOCUMENT_SOURCES.join(" / ")}`);
  }
  return source as DocumentSource;
}

function statusOf(raw: unknown): DocumentStatus {
  if (raw === undefined) return "draft";
  const status = String(raw);
  if (!DOCUMENT_STATUSES.includes(status as DocumentStatus)) {
    throw new WorkspaceValidationError(`status 只能是 ${DOCUMENT_STATUSES.join(" / ")}`);
  }
  return status as DocumentStatus;
}

function newDocument(input: {
  projectId: string;
  title: string;
  content: string;
  source: DocumentSource;
  sourceRunId: string | null;
  status: DocumentStatus;
  now: Date;
}): StoryDocument {
  const timestamp = input.now.toISOString();
  return validateStoryDocument({
    schemaVersion: "1",
    id: generateDocumentId(input.now),
    projectId: input.projectId,
    title: input.title,
    status: input.status,
    source: input.source,
    content: input.content,
    sourceRunId: input.sourceRunId,
    contentHash: sha256Hex(input.content),
    createdAt: timestamp,
    updatedAt: timestamp,
    isFavorite: false,
  });
}

function setCurrentDocument(projects: ProjectRepository, projectId: string, documentId: string, now: Date): void {
  const project = projects.readProject(projectId);
  if (project) projects.putProject({ ...project, currentDocumentId: documentId, updatedAt: now.toISOString() });
}

/**
 * 保存稿件。§48：这里写的每一笔都落在 documents/ 里，Run 的 story.md 一个字不改。
 *
 * contentHash 由新正文现算（§20）——请求体里带的任何 hash 都不被采信，
 * DocumentRepository 落盘前还会拿正文核一遍，两处都不许「声明一个哈希」。
 */
export async function saveDocument(
  projectId: string,
  documentId: string,
  raw: unknown,
  deps: DocumentCaseDeps = {},
): Promise<StoryDocument> {
  const { projects, documents, now } = resolve(deps);
  requireProject(projects, projectId);
  const current = requireDocument(documents, projectId, documentId);
  rejectSecretBearingKeys(raw);
  const patch = validateDocumentPatch(raw);
  const next = withDocumentPatch(current, patch, sha256Hex(patch.content ?? current.content), now().toISOString());
  documents.putDocument(next);
  return next;
}

export async function listDocuments(projectId: string, deps: DocumentCaseDeps = {}): Promise<DocumentSummary[]> {
  const { projects, documents } = resolve(deps);
  // 先确认项目在：一个不存在的项目名下「列出零篇稿件」和「列出稿件」都是谎话，
  // 而且不先拦的话 projectId 会被原样拼进目录路径（§42）
  requireProject(projects, projectId);
  const summaries: DocumentSummary[] = [];
  for (const id of documents.listDocumentIds(projectId)) {
    const document = documents.readDocument(projectId, id);
    if (document) summaries.push(summaryOf(document));
  }
  // 新的在前；时间戳打平时按 id 倒序收尾。比较器得自洽：相等时两个方向都
  // 返回 1 会让最终顺序取决于排序实现，同一个项目刷新两次列表顺序会变。
  summaries.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
  return summaries;
}

export async function getDocument(projectId: string, documentId: string, deps: DocumentCaseDeps = {}): Promise<StoryDocument> {
  const { projects, documents } = resolve(deps);
  requireProject(projects, projectId);
  return requireDocument(documents, projectId, documentId);
}

export async function setDocumentStatus(
  projectId: string,
  documentId: string,
  raw: unknown,
  deps: DocumentCaseDeps = {},
): Promise<StoryDocument> {
  const { projects, documents, now } = resolve(deps);
  requireProject(projects, projectId);
  const current = requireDocument(documents, projectId, documentId);
  const status = statusOf((raw as { status?: unknown } | undefined)?.status);
  const next = withDocumentPatch(current, { status }, current.contentHash, now().toISOString());
  documents.putDocument(next);
  return next;
}

export async function setDocumentFavorite(
  projectId: string,
  documentId: string,
  isFavorite: boolean,
  deps: DocumentCaseDeps = {},
): Promise<StoryDocument> {
  const { projects, documents, now } = resolve(deps);
  requireProject(projects, projectId);
  const current = requireDocument(documents, projectId, documentId);
  const next = withDocumentPatch(current, { isFavorite }, current.contentHash, now().toISOString());
  documents.putDocument(next);
  return next;
}

/**
 * 删除一份稿件。
 *
 * 只删 documents/<id>.json 与它的 revisions/，绝不碰 runs/——那一边是不可变的。
 * 项目的 currentDocumentId 若正指向它，一并清掉：一个指向不存在稿件的指针
 * 会让工作区首页每次打开都报错，而用户删它的时候并不想再被问一次。
 *
 * 删除不可恢复，所以 API 路由要求显式 confirm，这一层不做「温柔版」。
 */
export async function deleteDocument(projectId: string, documentId: string, deps: DocumentCaseDeps = {}): Promise<void> {
  const { projects, documents, now } = resolve(deps);
  requireProject(projects, projectId);
  const current = requireDocument(documents, projectId, documentId);
  documents.deleteDocument(projectId, documentId);
  const project = projects.readProject(projectId);
  if (project && project.currentDocumentId === current.id) {
    projects.putProject({ ...project, currentDocumentId: null, updatedAt: now().toISOString() });
  }
}
