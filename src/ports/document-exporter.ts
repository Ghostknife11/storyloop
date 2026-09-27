/**
 * v2.2.0 Ports：导出器端口（TASK §22/§31）。
 *
 * 导出的输入必须是 StoryDocument——即用户改过的这一版——而不是 Run 的 story.md。
 * 所以这里收的第一个参数就是 document，不接收 runId：从「跑一次」到「导出成品」
 * 之间隔着编辑，这一跳必须显式，不能留一条绕过编辑器的暗道（§64）。
 *
 * 端口只承诺「文档进、字节出」：不碰文件系统、不记哈希、不写历史。
 * 哈希与历史由用例层在拿到字节之后统一处理——于是两种格式都不能偷偷少记一步。
 */

import type { ExportFormat } from "@/domain/export-artifact";
import type { StoryDocument } from "@/domain/story-document";

export interface ExportInput {
  /** 要导出的稿件（已含用户编辑）。 */
  document: StoryDocument;
  format: ExportFormat;
  /** 生成时间，ISO 字符串。由调用方传入，导出器自己不读时钟——同样输入必须得到同样字节。 */
  exportedAt: string;
}

export interface ExportArtifact {
  /** 落盘用的安全文件名（已带扩展名）。 */
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** DOCX 是 OOXML ZIP、EPUB 是 OEBPS ZIP；仅用于日志与测试断言。 */
  containerDescription: string;
}

export interface DocumentExporter {
  readonly format: ExportFormat;
  readonly mimeType: string;
  render(input: ExportInput): ExportArtifact;
}
