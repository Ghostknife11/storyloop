import { safeExportFilename } from "@/domain/export-artifact";
import type { DocumentExporter, ExportArtifact, ExportInput } from "@/ports/document-exporter";
import {
  parseMarkdownBlocks,
  type MarkdownBlock,
  xmlSafeText,
} from "@/infrastructure/export/markdown-blocks";
import { buildZip } from "@/infrastructure/export/zip-writer";

/**
 * v2.2.0 EPUB 3 导出器（TASK §23/§27）。
 *
 * 同样是手写的 ZIP，但 EPUB 比 DOCX 更挑：
 *   - mimetype 必须是第一个条目、STORED、不带额外字段、内容固定为
 *     "application/epub+zip"——这是规范里少有的逐字节要求（见 zip-writer.ts
 *     的存储方式说明）；
 *   - META-INF/container.xml 指明 OPF 在哪；
 *   - OPF 里的 dcterms:modified 是必填项，且格式固定，读不到就当包是坏的。
 *
 * 分章：按正文的 ## 章标题切。没有章标题就整篇一章——读者拿到的是一个合法 EPUB，
 * 只是目录里只有一条，这比为了「看起来有结构」硬拆一段正文要好。
 */

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

interface Chapter {
  title: string;
  blocks: MarkdownBlock[];
}

/** 语言标记：有 CJK 字符就按中文，否则英文。导出器不猜更多细节。 */
function languageOf(content: string): string {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(content) ? "zh-CN" : "en";
}

/** EPUB 3 的 dcterms:modified 要精确到秒；读时钟的只有调用方（exportedAt）。 */
function epubTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "2020-01-01T00:00:00Z";
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** 标识符必须是全局唯一的；用本项目的既有 ID 拼一个 URN，不引入随机数。 */
function bookIdentifier(projectId: string, documentId: string): string {
  return `urn:storyloop:${projectId}:${documentId}`;
}

function splitChapters(title: string, blocks: MarkdownBlock[]): Chapter[] {
  const chapters: Chapter[] = [];
  let current: Chapter | null = null;

  for (const block of blocks) {
    // ## 以上（章 / 部）开新章；正文里的 # 一级标题视为部，同样开新章
    if (block.kind === "heading" && block.level <= 2 && block.text.length > 0) {
      current = { title: block.text, blocks: [] };
      chapters.push(current);
      continue;
    }
    if (current === null) {
      current = { title, blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(block);
  }

  if (chapters.length === 0) chapters.push({ title, blocks: [] });
  return chapters;
}

function escapeAttr(value: string): string {
  return xmlSafeText(value);
}

function chapterHtml(chapter: Chapter): string {
  const body: string[] = [`<h1 class="chapter-title">${xmlSafeText(chapter.title)}</h1>`];

  for (const block of chapter.blocks) {
    switch (block.kind) {
      case "heading":
        body.push(`<h2>${xmlSafeText(block.text)}</h2>`);
        break;
      case "paragraph":
        body.push(`<p>${xmlSafeText(block.text).replace(/\n/g, "<br/>")}</p>`);
        break;
      case "quote":
        body.push(`<blockquote><p>${xmlSafeText(block.text).replace(/\n/g, "<br/>")}</p></blockquote>`);
        break;
      case "divider":
        body.push('<hr class="divider"/>');
        break;
      case "list":
        body.push(
          block.ordered ? "<ol>" : "<ul>",
          ...block.items.map((item) => `<li>${xmlSafeText(item)}</li>`),
          block.ordered ? "</ol>" : "</ul>",
        );
        break;
    }
  }

  return (
    XML_DECL +
    `<html xmlns="${XHTML_NS}" xml:lang="zh-CN" lang="zh-CN"><head><title>${escapeAttr(chapter.title)}</title>` +
    '<link rel="stylesheet" type="text/css" href="../style.css"/></head>' +
    `<body><section class="chapter">${body.join("")}</section></body></html>`
  );
}

const NAV_TEMPLATE = (chapters: Chapter[], title: string): string =>
  XML_DECL +
  `<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">` +
  "<head><title>目录</title></head><body>" +
  '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>' +
  chapters.map((c, i) => `<li><a href="text/chapter${i + 1}.xhtml">${xmlSafeText(c.title)}</a></li>`).join("") +
  "</ol></nav>" +
  '<nav epub:type="landmarks" id="landmarks" hidden="hidden"><h2>导航</h2><ol>' +
  `<li><a epub:type="bodymatter" href="text/chapter1.xhtml">${xmlSafeText(title)}</a></li>` +
  "</ol></nav></body></html>";

export const epubExporter: DocumentExporter = {
  format: "epub",
  mimeType: "application/epub+zip",

  render(input: ExportInput): ExportArtifact {
    const blocks = parseMarkdownBlocks(input.document.content);
    const chapters = splitChapters(input.document.title, blocks);
    const language = languageOf(input.document.content);
    const identifier = bookIdentifier(input.document.projectId, input.document.id);

    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="css" href="style.css" media-type="text/css"/>',
      ...chapters.map((_, i) => `<item id="chapter${i + 1}" href="text/chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`),
    ].join("");

    const spine = [
      '<itemref idref="nav"/>',
      ...chapters.map((_, i) => `<itemref idref="chapter${i + 1}"/>`),
    ].join("");

    const opf =
      XML_DECL +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="' +
      language +
      '">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:identifier id="book-id">${escapeAttr(identifier)}</dc:identifier>` +
      `<dc:title>${xmlSafeText(input.document.title)}</dc:title>` +
      `<dc:language>${language}</dc:language>` +
      `<meta property="dcterms:modified">${epubTimestamp(input.exportedAt)}</meta>` +
      "</metadata>" +
      `<manifest>${manifest}</manifest><spine>${spine}</spine></package>`;

    const container =
      XML_DECL +
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
      "</container>";

    const styles =
      "body { font-family: serif; line-height: 1.7; margin: 0 1em; }\n" +
      "h1.chapter-title { text-align: center; font-size: 1.6em; margin: 2em 0 1.5em; }\n" +
      "h2 { font-size: 1.2em; margin: 1.6em 0 0.8em; }\n" +
      "p { text-indent: 2em; margin: 0 0 0.6em; }\n" +
      "blockquote { border-left: 2px solid #999; margin: 1em 0; padding-left: 1em; color: #555; }\n" +
      "hr.divider { border: none; text-align: center; margin: 1.5em 0; }\n" +
      "hr.divider::after { content: \"＊\"; color: #999; }\n";

    // mimetype 必须在第一位且保持 STORED（zip-writer 的 buildZip 按数组顺序写入）
    const zip = buildZip([
      { name: "mimetype", data: "application/epub+zip" },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/style.css", data: styles },
      { name: "OEBPS/nav.xhtml", data: NAV_TEMPLATE(chapters, input.document.title) },
      ...chapters.map((chapter, i) => ({ name: `OEBPS/text/chapter${i + 1}.xhtml`, data: chapterHtml(chapter) })),
    ]);

    return {
      filename: safeExportFilename(input.document.title, input.format, input.document.id),
      mimeType: this.mimeType,
      bytes: zip,
      containerDescription: "EPUB 3 电子书（OEBPS ZIP）",
    };
  },
};
