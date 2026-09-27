/**
 * v2.2.0 导出契约（TASK §22/§23/§24/§28）。
 *
 * 导出的源永远是 StoryDocument——用户编辑过的那一份，不是 Run 落盘的 story.md（§22）。
 * 这条边界由类型保证：ExportRequest 里只有 documentId，没有 runId 这个字段。
 *
 * 三条约定：
 *   1. artifactPath 是**项目内的相对路径**（exports/<文件名>）。服务器绝对路径
 *      一律不进响应体（§67），所以这里存的就不是绝对路径，而不是「存了再截断」。
 *   2. contentHash 记录的是**导出那一刻正文的摘要**。之后稿件再改，这条记录不变，
 *      重新导出才会生成新的 ExportResult（§28）——所以历史导出永远对得上它导出时的正文。
 *   3. 文件名来自用户标题，属于不可信输入：safeExportFilename 才是唯一允许把标题
 *      变成文件名的地方（§25/§52）。
 */

import {
  WORKSPACE_ID_MAX,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceValidationError,
  isoTimestampOf,
  isWorkspaceId,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
  textOf,
} from "@/domain/workspace";

/** §23 导出的两种格式。 */
export type ExportFormat = "docx" | "epub";

export const EXPORT_FORMATS = ["docx", "epub"] as const;

/** §23 ExportRequest。 */
export interface ExportRequest {
  projectId: string;
  documentId: string;
  format: ExportFormat;
}

/** §23 请求体：三种格式各一个扩展名与 MIME，Domain 只知道对应关系，不碰任何库。 */
export const EXPORT_MIME: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
};

/** §24 ExportResult：落在 projects/<id>/exports/index.json 里的那一条。 */
export interface ExportResult {
  schemaVersion: string;
  id: string;
  projectId: string;
  documentId: string;
  format: ExportFormat;
  /** 项目内相对路径（exports/<文件名>），不是服务器绝对路径（§67）。 */
  artifactPath: string;
  /** 导出那一刻正文的 SHA-256。 */
  contentHash: string;
  /** 落盘的文件名（已清洗）。 */
  filename: string;
  byteSize: number;
  createdAt: string;
}

const EXPORT_RESULT_KEYS = [
  "schemaVersion",
  "id",
  "projectId",
  "documentId",
  "format",
  "artifactPath",
  "contentHash",
  "filename",
  "byteSize",
  "createdAt",
] as const;

/** §51 结构校验。 */
export function validateExportResult(raw: unknown): ExportResult {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, EXPORT_RESULT_KEYS, "export");

  const schemaVersion = textOf(r.schemaVersion, "schemaVersion", 16);
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(`schemaVersion 只支持 ${WORKSPACE_SCHEMA_VERSION}（实际 ${schemaVersion}）`);
  }
  const id = textOf(r.id, "id", WORKSPACE_ID_MAX);
  const projectId = textOf(r.projectId, "projectId", WORKSPACE_ID_MAX);
  const documentId = textOf(r.documentId, "documentId", WORKSPACE_ID_MAX);
  for (const [field, value] of [["id", id], ["projectId", projectId], ["documentId", documentId]] as const) {
    if (!isWorkspaceId(value)) throw new WorkspaceValidationError(`${field} 不合法：只能是单个目录名`);
  }
  if (r.format !== "docx" && r.format !== "epub") {
    throw new WorkspaceValidationError(`format 只能是 docx / epub（实际 ${String(r.format)}）`);
  }
  if (typeof r.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(r.contentHash)) {
    throw new WorkspaceValidationError("contentHash 必须是 SHA-256 十六进制摘要");
  }

  return {
    schemaVersion,
    id,
    projectId,
    documentId,
    format: r.format,
    artifactPath: textOf(r.artifactPath, "artifactPath", 200),
    contentHash: r.contentHash,
    filename: textOf(r.filename, "filename", 120),
    byteSize: typeof r.byteSize === "number" && Number.isFinite(r.byteSize) && r.byteSize >= 0 ? Math.floor(r.byteSize) : 0,
    createdAt: isoTimestampOf(r.createdAt, "createdAt"),
  };
}

/** 读回时归一化：磁盘上的导出史被手改坏时返回 null。 */
export function exportResultOf(raw: unknown): ExportResult | null {
  try {
    return validateExportResult(raw);
  } catch {
    return null;
  }
}

/** 导出史只增不改：读回来的数组逐条归一化，坏的那条整条丢掉，不影响其它条。 */
export function exportHistoryOf(raw: unknown): ExportResult[] {
  if (typeof raw !== "object" || raw === null) return [];
  const entries = (raw as { exports?: unknown }).exports;
  if (!Array.isArray(entries)) return [];
  const out: ExportResult[] = [];
  for (const entry of entries) {
    const parsed = exportResultOf(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文件名清洗（§25/§42/§52）
// ---------------------------------------------------------------------------

/** 文件名里一律不许出现的字符：路径分隔符 + Windows 保留字符 + 控制类。 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;

/** 文件名主干上限：留出扩展名与唯一性尾巴的空间。 */
const FILENAME_STEM_MAX = 60;

/**
 * 用户标题 → 安全的文件名主干。
 *
 * 标题是不可信输入（§42）：它可以含 `../`、控制字符、上千个字符。这里做的事只有三件：
 *   1. 换掉一切分隔符与保留字符（连字符比下划线更可读，但下划线更不容易和空格混）；
 *   2. 去掉前导点——`..`、`.hidden` 都不该出现在导出目录里；
 *   3. 截断到定长——超长文件名在 Windows 上直接写不进去。
 * 剩下的一切原样保留：中文标题仍是中文标题，这里不做音译、不做「只为安全而毁掉可读性」。
 */
export function safeFileStem(title: string): string {
  const cleaned = title
    .replace(UNSAFE_FILENAME_CHARS, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/_+$/, "")
    .trim();
  const stem = cleaned.length > 0 ? cleaned.slice(0, FILENAME_STEM_MAX) : "untitled";
  return stem;
}

/**
 * 导出的完整文件名：`<清洗后的标题>_<唯一尾巴>.<扩展名>`。
 *
 * 唯一尾巴取 id 末 6 位：同一个项目里同一个标题导出两次，两份文件各自留痕（§28「旧 Export 不变」），
 * 而 6 位随机已经让撞名的概率低到不值得为它再套一层查重。
 */
export function safeExportFilename(title: string, format: ExportFormat, id: string): string {
  const tail = id.replace(/[^A-Za-z0-9]/g, "").slice(-6) || "export";
  return `${safeFileStem(title)}_${tail}.${format}`;
}

/**
 * 下载响应里的 Content-Disposition。
 * 非 ASCII 文件名必须走 RFC 5987 的 filename*，否则浏览器会得到乱码文件名；
 * filename="..." 保留一份纯 ASCII 兜底，给不认 filename* 的老客户端。
 */
export function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "export";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
