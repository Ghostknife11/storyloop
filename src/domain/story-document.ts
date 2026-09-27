/**
 * v2.2.0 StoryDocument：用户的创作副本（TASK §7/§8）。
 *
 * 最高原则「Runs are immutable; documents are editable」落在这个模型上：
 *   - Run 的 story.md 永远不再被写第二遍（管线只往 attempts/ 与运行根写）；
 *   - 用户改的每一行都改的是这里，改完与那次 Run 再无关系。
 *
 * 三条不变的约定：
 *   1. contentHash 是正文的 SHA-256，由基础设施算、由存储层核对后才落盘——
 *      它不是 JSON 里的一句声明，任何一份盘上的稿件都能被验证（TASK §20/§24）。
 *   2. sourceRunId 只是引用。创建 Draft 时整份正文被复制进来，之后两份各自演化：
 *      编辑稿件绝不会回写 Run，重新导出 Run 也不会覆盖稿件（§48 Release Blocker）。
 *   3. source 记录**第一份正文从哪来**，之后不再变：generated = 来自某次 Run，
 *      imported = 用户粘贴 / 导入的，edited = 用户从零写的。它不进任何路径。
 */

import {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_NAME_MAX,
  WorkspaceValidationError,
  flagOf,
  isoTimestampOf,
  isWorkspaceId,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
  textOf,
} from "@/domain/workspace";

/** 文档状态：final 只是标记，不是不可编辑锁（TASK §11）。 */
export type DocumentStatus = "draft" | "final";

export const DOCUMENT_STATUSES = ["draft", "final"] as const;

/** 正文来源：第一份正文从哪来。 */
export type DocumentSource = "generated" | "edited" | "imported";

export const DOCUMENT_SOURCES = ["generated", "edited", "imported"] as const;

/**
 * 正文长度上限。三万字的短篇按 UTF-8 约 90KB，这里放到 40 万字符仍留有余量；
 * 上限存在的理由不是「装不下」，而是编辑器一次要把它读进内存（§35 边界）。
 */
export const DOCUMENT_CONTENT_MAX = 400_000;

/** contentHash 的形状：小写十六进制 SHA-256。 */
const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** TASK §7 稿件模型。 */
export interface StoryDocument {
  schemaVersion: string;
  id: string;
  projectId: string;
  /** 不可信输入：只做展示与导出标题，绝不参与路径拼接（§42）。 */
  title: string;
  status: DocumentStatus;
  source: DocumentSource;
  content: string;
  /** 来自哪次 Run；用户从零写的稿子是 null。 */
  sourceRunId: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
}

/** TASK §31/§38 列表项：元数据进来，正文不进来（列表不该把每篇都读一遍正文）。 */
export interface DocumentListItem {
  id: string;
  projectId: string;
  title: string;
  status: DocumentStatus;
  source: DocumentSource;
  sourceRunId: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
  /** 正文字数（§9）。 */
  wordCount: number;
}

export function documentListItemOf(doc: StoryDocument): DocumentListItem {
  return {
    id: doc.id,
    projectId: doc.projectId,
    title: doc.title,
    status: doc.status,
    source: doc.source,
    sourceRunId: doc.sourceRunId,
    contentHash: doc.contentHash,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    isFavorite: doc.isFavorite,
    wordCount: wordCountOf(doc.content),
  };
}

/**
 * §9 字数统计：中日韩汉字逐字计，拉丁字母与数字按词计。
 *
 * 纯函数、无 I/O：UI 与服务端必须给出同一个数，所以只能有一份实现，
 * 且它必须住在 Domain（两边都 import 得到的地方）。
 */
export function wordCountOf(content: string): number {
  if (!content) return 0;
  const cjk = content.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = content.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return cjk + latin;
}

const DOCUMENT_KEYS = [
  "schemaVersion",
  "id",
  "projectId",
  "title",
  "status",
  "source",
  "content",
  "sourceRunId",
  "contentHash",
  "createdAt",
  "updatedAt",
  "isFavorite",
] as const;

function contentOf(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new WorkspaceValidationError("content 必须是字符串");
  }
  if (raw.length > DOCUMENT_CONTENT_MAX) {
    throw new WorkspaceValidationError(`content 不能超过 ${DOCUMENT_CONTENT_MAX} 个字符`);
  }
  return raw;
}

function contentHashOf(raw: unknown): string {
  if (typeof raw !== "string" || !CONTENT_HASH.test(raw)) {
    throw new WorkspaceValidationError("contentHash 必须是 SHA-256 十六进制摘要");
  }
  return raw;
}

function sourceRunIdOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // Run id 由 generateRunId 生成（YYYYMMDD_HHMMSS_xxxxxx），天然满足单段规则；
  // 这里只做形状校验，不去读 runs/——那是用例层的事
  if (!isWorkspaceId(raw)) {
    throw new WorkspaceValidationError("sourceRunId 不合法：只能是单个目录名");
  }
  return raw;
}

/** §47 结构校验：形状不对就抛 WorkspaceValidationError。 */
export function validateStoryDocument(raw: unknown): StoryDocument {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, DOCUMENT_KEYS, "document");

  const schemaVersion = textOf(r.schemaVersion, "schemaVersion", 16);
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(`schemaVersion 只支持 ${WORKSPACE_SCHEMA_VERSION}（实际 ${schemaVersion}）`);
  }
  if (!isWorkspaceId(r.id)) throw new WorkspaceValidationError("id 不合法：只能是单个目录名");
  if (!isWorkspaceId(r.projectId)) throw new WorkspaceValidationError("projectId 不合法：只能是单个目录名");
  if (r.status !== "draft" && r.status !== "final") {
    throw new WorkspaceValidationError(`status 只能是 draft / final（实际 ${String(r.status)}）`);
  }
  if (r.source !== "generated" && r.source !== "edited" && r.source !== "imported") {
    throw new WorkspaceValidationError(`source 只能是 generated / edited / imported（实际 ${String(r.source)}）`);
  }

  return {
    schemaVersion,
    id: r.id,
    projectId: r.projectId,
    title: textOf(r.title, "title", WORKSPACE_NAME_MAX),
    status: r.status,
    source: r.source,
    content: contentOf(r.content),
    sourceRunId: sourceRunIdOf(r.sourceRunId),
    contentHash: contentHashOf(r.contentHash),
    createdAt: isoTimestampOf(r.createdAt, "createdAt"),
    updatedAt: isoTimestampOf(r.updatedAt, "updatedAt"),
    isFavorite: flagOf(r.isFavorite, "isFavorite", false),
  };
}

/** 读回时归一化：磁盘上的稿件被手改坏时返回 null，由调用方按「不存在」处理。 */
export function storyDocumentOf(raw: unknown): StoryDocument | null {
  try {
    return validateStoryDocument(raw);
  } catch {
    return null;
  }
}

/**
 * TASK §10/§31 保存的白名单：标题、正文、状态、收藏。
 * id / projectId / createdAt / contentHash / sourceRunId 不在这里：
 *   - id / projectId 改了就是把稿件搬到别的项目，那是另一个动作（本版本没有）；
 *   - contentHash 只能由正文算出来，不接受请求体里直接给（否则等于允许伪造身份）；
 *   - sourceRunId 创建时定下就不再变——改了就会把旧 Run 的质量结论安到别的 Run 上（§20）。
 */
const DOCUMENT_PATCH_KEYS = ["title", "content", "status", "isFavorite"] as const;

export interface DocumentPatch {
  title?: string;
  content?: string;
  status?: DocumentStatus;
  isFavorite?: boolean;
}

/** 保存请求：只做结构检查，合并、算哈希、写修订都由用例负责。 */
export function validateDocumentPatch(raw: unknown): DocumentPatch {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, DOCUMENT_PATCH_KEYS, "document");
  if (Object.keys(r).length === 0) {
    throw new WorkspaceValidationError("保存请求至少要带一个可改字段");
  }

  const patch: DocumentPatch = {};
  if (r.title !== undefined) patch.title = textOf(r.title, "title", WORKSPACE_NAME_MAX);
  if (r.content !== undefined) patch.content = contentOf(r.content);
  if (r.status !== undefined) {
    if (r.status !== "draft" && r.status !== "final") {
      throw new WorkspaceValidationError(`status 只能是 draft / final（实际 ${String(r.status)}）`);
    }
    patch.status = r.status;
  }
  if (r.isFavorite !== undefined) patch.isFavorite = flagOf(r.isFavorite, "isFavorite", false);
  return patch;
}

/** 保存后的新文档对象：contentHash 由调用方按新正文现算（这里只负责拼装与再校验）。 */
export function withDocumentPatch(doc: StoryDocument, patch: DocumentPatch, contentHash: string, updatedAt: string): StoryDocument {
  return validateStoryDocument({
    ...doc,
    ...patch,
    contentHash,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: doc.id,
    projectId: doc.projectId,
    createdAt: doc.createdAt,
    updatedAt: isoTimestampOf(updatedAt, "updatedAt"),
  });
}

/** 新建请求的正文来源：run → generated；带了正文 → imported；空白 → edited。 */
export function documentSourceOf(input: { sourceRunId?: string | null; content?: string }): DocumentSource {
  if (input.sourceRunId) return "generated";
  return input.content && input.content.trim() ? "imported" : "edited";
}

/**
 * Run 的 story.md → 稿件的标题与正文。
 *
 * 生成路径落盘的 story.md 第一行是 `# <标题>`。搬进稿件时这一行要变成独立字段：
 * 编辑器不会把标题当正文让你改（§11），导出时标题也要单独进 docProps / OPF（§27）。
 * 于是这里只把**第一行**拆出来，其余一字不改地留下——包括它后面的空行，
 * 正文里多一个空行只是排版，少一行可能就是两段并成一段。
 *
 * 第一行不是 H1 时（老版本 Run、或用户手改过的 story.md）标题给 null：
 * 猜一个标题比没有标题更糟，调用方该拿请求里的 storyConfig.title 之类的实事兜底。
 */
export function splitStoryTitle(story: string): { title: string | null; body: string } {
  const match = story.match(/^\s*#[ \t]+(.+?)[ \t]*$/m);
  if (!match || match.index === undefined) {
    return { title: null, body: story };
  }
  const heading = match[1].trim();
  if (heading.length === 0) {
    return { title: null, body: story };
  }
  // H1 必须真的是第一行（只允许前面有空白行）；正文中间的 H1 是章节标题，不动它
  const leading = story.slice(0, match.index);
  if (leading.trim().length > 0) {
    return { title: null, body: story };
  }
  const body = story.slice(match.index + match[0].length).replace(/^\n+/, "");
  return { title: textOf(heading, "title", WORKSPACE_NAME_MAX), body };
}

/**
 * 从一次 Run 的 story.md 取出「稿件正文」。
 *
 * 建稿（Run→Draft）与「质量结论是否过期」（§20）必须得到同一个字符串，否则后者
 * 永远对不上：一个说「编辑过之后旧结论不算数」，另一个却拿 story.md 全文去比，
 * 于是每一篇稿子在界面上都显示「已过期」。所以这两件事共用这一个函数，
 * 谁也不许自己再写一遍「去掉 H1」。
 *
 * 没有 H1（老版本 Run、或用户手改过的 story.md）时原样返回全文：那时候正文就是
 * 全部内容，硬扣掉第一行只会让故事少一段。
 */
export function documentContentOf(story: string): string {
  const { body } = splitStoryTitle(story);
  return body.trim().length > 0 ? body : story;
}
