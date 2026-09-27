/**
 * v2.2.0 导出用例（Application）：渲染 → 落盘 → 记账 → 列历史（TASK §22/§24/§25/§28）。
 *
 * 四步的次序是刻意的：
 *   1. 渲染（源是 StoryDocument，导出器在 Infrastructure）；
 *   2. 落盘（FileExportRepository 拒绝覆盖已存在的文件名）；
 *   3. 记账（index.json 追加一条 ExportResult，只增不改）；
 *   4. 返回。
 *
 * 为什么先落盘再记账：反过来的话，历史里会出现一条指向不存在文件的记录，
 * 用户点了下载得到 404，而记录说「导出过」。反过来做最坏只是多一个孤儿文件——
 * 用户看不见它，也没有任何界面会声称它存在。
 *
 * 导出的源永远是稿件（StoryDocument），不是 Run 的 story.md。这不是实现偏好，
 * 是 §22 的要求：用户在编辑器里改了三天的稿子，导不出来才叫导出。
 */

import {
  EXPORT_FORMATS,
  EXPORT_MIME,
  contentDisposition,
  safeExportFilename,
  validateExportResult,
  type ExportFormat,
  type ExportResult,
} from "@/domain/export-artifact";
import {
  WorkspaceNotFoundError,
  WorkspaceValidationError,
  isWorkspaceId,
  optionalTextOf,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
} from "@/domain/workspace";
import type { DocumentExporter } from "@/ports/document-exporter";
import type { ExportRepository } from "@/ports/export-store";
import type { DocumentRepository } from "@/ports/document-store";
import type { ProjectRepository } from "@/ports/project-store";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { docxExporter } from "@/infrastructure/export/docx-exporter";
import { epubExporter } from "@/infrastructure/export/epub-exporter";
import { generateExportId } from "@/infrastructure/id/workspace-id";

/** 两类格式各自的导出器。加一种格式只改这一处与 EXPORT_FORMATS。 */
const EXPORTERS: Record<ExportFormat, DocumentExporter> = {
  docx: docxExporter,
  epub: epubExporter,
};

export interface ExportCaseDeps {
  projects?: ProjectRepository;
  documents?: DocumentRepository;
  exports?: ExportRepository;
  /** 可按格式替换导出器（测试用假渲染器；生产环境用默认那两个）。 */
  exporters?: Partial<Record<ExportFormat, DocumentExporter>>;
  now?: () => Date;
}

interface ResolvedExportDeps {
  projects: ProjectRepository;
  documents: DocumentRepository;
  exports: ExportRepository;
  exporters: Record<ExportFormat, DocumentExporter>;
  now: () => Date;
}

function resolve(deps: ExportCaseDeps): ResolvedExportDeps {
  return {
    projects: deps.projects ?? new FileProjectRepository(),
    documents: deps.documents ?? new FileDocumentRepository(),
    exports: deps.exports ?? new FileExportRepository(),
    exporters: { ...EXPORTERS, ...deps.exporters },
    now: deps.now ?? (() => new Date()),
  };
}

function exporterFor(exporters: Record<ExportFormat, DocumentExporter>, format: ExportFormat): DocumentExporter {
  const exporter = exporters[format];
  if (!exporter) throw new WorkspaceValidationError(`没有可用于 ${format} 的导出器`);
  return exporter;
}

function formatOf(raw: unknown): ExportFormat {
  if (typeof raw !== "string" || !EXPORT_FORMATS.includes(raw as ExportFormat)) {
    throw new WorkspaceValidationError(`format 只能是 ${EXPORT_FORMATS.join(" / ")}`);
  }
  return raw as ExportFormat;
}

/** 导出之后要用的那几样：账上那条 + 浏览器下载时要的响应头。 */
export interface ExportOutcome {
  result: ExportResult;
  /** Content-Disposition（RFC 5987 双轨，中文标题也能带回正确文件名）。 */
  download: string;
  mimeType: string;
  byteSize: number;
}

/**
 * 下载用的那一份：比 ExportOutcome 多一样——文件字节本身。
 *
 * 刻意单独一个类型：导出记录（列表、详情）从头到尾都不该带字节，
 * 而下载路径非要不可。合成一个类型的话，迟早有一次"顺手把 outcome 序列化进 JSON"
 * 会把整个 docx 塞进响应体。
 */
export interface ExportDownload extends ExportOutcome {
  bytes: Uint8Array;
}

/**
 * 导出一次稿件。
 *
 * contentHash 记的是**稿件正文**的摘要，所以「这次导出对得上哪一版」有了答案：
 * 之后稿件再改，这条记录不变，重新导出才会生成新记录（§28）。
 */
export async function exportDocument(projectId: string, raw: unknown, deps: ExportCaseDeps = {}): Promise<ExportOutcome> {
  const { projects, documents, exports: exports_, exporters, now } = resolve(deps);
  if (!isWorkspaceId(projectId)) throw new WorkspaceValidationError("项目 id 不合法：只能是单个目录名");
  if (!projects.readProject(projectId)) throw new WorkspaceNotFoundError(projectId);

  rejectSecretBearingKeys(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(r, ["documentId", "format"], "export");
  const format = formatOf(r.format);

  const documentId = optionalTextOf(r.documentId, "documentId", 64);
  if (!documentId) throw new WorkspaceValidationError("必须带 documentId");
  if (!isWorkspaceId(documentId)) throw new WorkspaceValidationError("documentId 不合法：只能是单个目录名");
  const document = documents.readDocument(projectId, documentId);
  if (!document) throw new WorkspaceNotFoundError(documentId);

  const at = now();
  const id = generateExportId(at);
  const artifact = exporterFor(exporters, format).render({
    document,
    format,
    exportedAt: at.toISOString(),
  });

  // 标题来自用户，属于不可信输入；safeExportFilename 是唯一允许把标题变成文件名的地方（§25/§52）
  const filename = safeExportFilename(document.title, format, id);
  exports_.putArtifact(projectId, filename, artifact.bytes);

  const result = validateExportResult({
    schemaVersion: "1",
    id,
    projectId,
    documentId,
    format,
    artifactPath: `exports/${filename}`,
    contentHash: document.contentHash,
    filename,
    byteSize: artifact.bytes.length,
    createdAt: at.toISOString(),
  });
  exports_.recordExport(projectId, result);
  return { result, download: contentDisposition(filename), mimeType: artifact.mimeType, byteSize: result.byteSize };
}

/** 导出历史（index.json），按时间正序。没有导出过 → 空数组。 */
export async function listProjectExports(projectId: string, deps: ExportCaseDeps = {}): Promise<ExportResult[]> {
  const { exports: exports_ } = resolve(deps);
  if (!isWorkspaceId(projectId)) throw new WorkspaceValidationError("项目 id 不合法：只能是单个目录名");
  return exports_.listExports(projectId);
}

/** 下载一次已导出的文件：只按 index.json 里记的文件名读，不接外部路径（§42）。 */
export async function readExportArtifact(
  projectId: string,
  resultId: string,
  deps: ExportCaseDeps = {},
): Promise<ExportDownload | null> {
  const { exports: exports_ } = resolve(deps);
  if (!isWorkspaceId(projectId) || !isWorkspaceId(resultId)) {
    throw new WorkspaceValidationError("项目 id 与导出 id 不合法：只能是单个目录名");
  }
  const found = exports_.listExports(projectId).find((r) => r.id === resultId);
  if (!found) return null;
  const bytes = exports_.readArtifact(projectId, found.filename);
  if (bytes === null) return null;
  return {
    result: found,
    download: contentDisposition(found.filename),
    mimeType: EXPORT_MIME[found.format],
    byteSize: bytes.length,
    bytes,
  };
}
