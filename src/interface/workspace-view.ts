/**
 * v2.2.0 工作区界面的唯一状态推导（与 experiment-view / quality-view 同一套模式）。
 *
 * 这里全部是纯函数：把 API 回来的项目 / 稿件 / 导出 / 健康整理成「界面上要摆出来的行」。
 * 边界写死在实现里，因为它们分别是这个版本承诺过的几件事：
 *
 *   1. **只显示真实数据**（TASK §39）。没有的东西显示「—」，不补 0、不补「略」，
 *      更不编估摸出来的百分比。健康面板尤其如此：那里一个数字都没有，
 *      只有事实清单，因为「创作效率 92%」这种伪指标本版本禁止出现。
 *   2. **信号认码不认文案**（§17）。message 会改，code 不改；界面按 code 决定
 *      摆在哪一区、用什么语气，不按 message 里出现的关键字猜。
 *   3. **没有绝对路径**（§67）。这里所有行都不含 artifactPath 之外的路径，
 *      而 artifactPath 服务端给的就是项目内相对路径。
 */

import type {
  DocumentSummaryApi,
  ExportResultApi,
  ProjectHealthApi,
  ProjectSummaryApi,
} from "@/interface/api";
import type { HealthStatus } from "@/domain/project-health";

/** 语气：good / warn / bad 只用于「这件事本身是好是坏」，neutral 用于「只是陈述」。 */
export type Tone = "neutral" | "good" | "warn" | "bad";

/** §36 项目列表的一行。 */
export interface ProjectRow {
  id: string;
  name: string;
  status: "active" | "archived";
  isFavorite: boolean;
  runCount: number;
  /** 当前稿件的标题；还没有稿时是 null（不显示"无"，显示"还没有稿件"）。 */
  currentDocumentTitle: string | null;
  updatedAt: string;
}

/** §31/§37 项目内的稿件列表一行。 */
export interface DocumentRow {
  id: string;
  title: string;
  status: "draft" | "final";
  statusLabel: string;
  tone: Tone;
  sourceLabel: string;
  wordCount: number;
  isFavorite: boolean;
  updatedAt: string;
}

/** §15 Overview 上的一行：一个事实、一个值。 */
export interface OverviewRow {
  label: string;
  value: string;
  tone: Tone;
}

/** §39 健康面板上的一条信号。 */
export interface HealthSignalRow {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  source: string | null;
}

/** §39 健康面板。status 是结论，rows 按 severity 分组摆，不是按 message 排。 */
export interface HealthView {
  status: HealthStatus;
  statusLabel: string;
  tone: Tone;
  signals: HealthSignalRow[];
}

/** §38 编辑器要的那几样。 */
export interface EditorView {
  id: string;
  title: string;
  content: string;
  status: "draft" | "final";
  wordCount: number;
  sourceRunId: string | null;
  updatedAt: string;
  contentHash: string;
}

/** §32 导出历史的一行。 */
export interface ExportRow {
  id: string;
  filename: string;
  format: "docx" | "epub";
  byteSize: number;
  createdAt: string;
  documentId: string;
  contentHash: string;
}

/** 列表排序：收藏在前，未归档在前，再按更新时间倒序（与服务端一致，UI 不再自作主张）。 */
export function projectRowOf(item: ProjectSummaryApi, documentTitles: Map<string, string> = new Map()): ProjectRow {
  return {
    id: item.project.id,
    name: item.project.name,
    status: item.project.status,
    isFavorite: item.project.isFavorite,
    runCount: item.runCount,
    currentDocumentTitle: item.project.currentDocumentId
      ? documentTitles.get(item.project.currentDocumentId) ?? null
      : null,
    updatedAt: item.project.updatedAt,
  };
}

/** 归档状态 → 一行文案。语气中性：归档是整理，不是失败。 */
export function projectStatusLabel(status: string): { label: string; tone: Tone } {
  return status === "archived" ? { label: "已归档", tone: "neutral" } : { label: "进行中", tone: "good" };
}

/** §31 稿件列表行。 */
export function documentRowOf(item: DocumentSummaryApi): DocumentRow {
  const status = documentStatusLabel(item.status);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    statusLabel: status.label,
    tone: status.Tone,
    sourceLabel: documentSourceLabel(item.source, item.sourceRunId),
    wordCount: item.wordCount,
    isFavorite: item.isFavorite,
    updatedAt: item.updatedAt,
  };
}

/** 稿件状态 → 一行文案。 */
export function documentStatusLabel(status: string): { label: string; Tone: Tone } {
  return status === "final" ? { label: "定稿", Tone: "good" } : { label: "草稿", Tone: "neutral" };
}

/** 正文来源 → 一行文案：说明第一份正文从哪来，不夸大其词。 */
export function documentSourceLabel(source: string, sourceRunId: string | null): string {
  switch (source) {
    case "generated":
      return sourceRunId ? `来自 Run ${sourceRunId}` : "来自 Run";
    case "edited":
      return "手动编辑过";
    case "imported":
      return "从外部导入";
    default:
      return "来源未知";
  }
}

/** 健康结论 → 标签与语气。blocked 是"有 error 级事实"，不是"项目坏了"。 */
export function healthStatusLabel(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "healthy":
      return { label: "可以继续写", tone: "good" };
    case "attention":
      return { label: "有几件事要处理", tone: "warn" };
    case "blocked":
      return { label: "有必须处理的事", tone: "bad" };
    default:
      return { label: "状态未知", tone: "neutral" };
  }
}

/**
 * 健康结论 → 面板视图。信号按 severity 分组（error → warning → info），
 * 同组内保持服务端给的码序：顺序必须确定，否则同一个项目刷新一次换一次位置。
 */
export function healthViewOf(health: ProjectHealthApi): HealthView {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const status = healthStatusLabel(health.status);
  return {
    status: health.status as HealthStatus,
    statusLabel: status.label,
    tone: status.tone,
    signals: [...health.signals]
      .sort((a, b) => order[a.severity] - order[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((signal) => ({
        code: signal.code,
        severity: signal.severity,
        message: signal.message,
        source: signal.source ?? null,
      })),
  };
}

/** §38 编辑器视图。wordCount 服务端已经算好，这里原样带出，不二次统计。 */
export function editorViewOf(document: {
  id: string;
  title: string;
  status: "draft" | "final";
  content: string;
  sourceRunId: string | null;
  updatedAt: string;
  contentHash: string;
}, wordCount: number): EditorView {
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    status: document.status,
    wordCount,
    sourceRunId: document.sourceRunId,
    updatedAt: document.updatedAt,
    contentHash: document.contentHash,
  };
}

/** §32 导出历史行。字节数转成「KB / MB」只在这一处做。 */
export function exportRowOf(item: ExportResultApi): ExportRow {
  return {
    id: item.id,
    filename: item.filename,
    format: item.format,
    byteSize: item.byteSize,
    createdAt: item.createdAt,
    documentId: item.documentId,
    contentHash: item.contentHash,
  };
}

/** 字节数 → 人话。没有一个基准单位能覆盖 DOCX 与 EPUB，所以按大小换档。 */
export function byteSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 时间戳 → 界面上的一句话。解析不出来原样返回，不显示 Invalid Date。 */
export function timestampLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 稿件标题 → 摘要行：还没有稿时给一句中性说明，不给"null"。 */
export function currentDocumentLabel(title: string | null): string {
  return title ?? "还没有稿件";
}

/** 项目名搜索（TASK §41，允许但不做 Gate）。大小写不敏感，空查询匹配全部。 */
export function matchesProjectQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

/** 文档标题搜索（§41 同一套规则）。 */
export function matchesDocumentQuery(title: string, query: string): boolean {
  return matchesProjectQuery(title, query);
}

/** 导出格式 → 一句话说明。不吹"最佳格式"，只说它是什么。 */
export function exportFormatLabel(format: string): string {
  return format === "docx" ? "Word 文档 (.docx)" : "EPUB 电子书 (.epub)";
}

/** §24 文件名安全说明：导出的文件名由服务端清洗，这里只负责展示，不参与拼接。 */
export function exportArtifactPathLabel(path: string): string {
  return path;
}
