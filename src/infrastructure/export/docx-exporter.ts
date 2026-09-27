import { safeExportFilename } from "@/domain/export-artifact";
import type { DocumentExporter, ExportArtifact, ExportInput } from "@/ports/document-exporter";
import { parseMarkdownBlocks, xmlSafeText } from "@/infrastructure/export/markdown-blocks";
import { buildZip } from "@/infrastructure/export/zip-writer";

/**
 * v2.2.0 DOCX 导出器（TASK §23/§27）。
 *
 * Word 的 .docx 就是一个 ZIP，里面有五个必需部件：内容类型声明、包级关系、
 * 正文、样式表、编号定义。这里全部手写，不引 docx/template 库——短篇小说的正文
 * 用不到文档库那 5% 才会碰的功能，而引一个库就要多背一条供应链和一个版本矩阵。
 *
 * 输出对同一输入是逐字节确定的：正文、样式、编号表全是静态模板，
 * ZIP 时间戳固定 DOS 下界（见 zip-writer.ts），连 docProps 都不写——
 * 没有 created 时间戳，两次导出同一篇就能逐字节比对。
 */

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** 列表用的编号 id：1 = 圆点，2 = 阿拉伯数字。定义在 numbering.xml。 */
const BULLET_NUM_ID = 1;
const DECIMAL_NUM_ID = 2;

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  "</Types>";

const PACKAGE_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const DOCUMENT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
  "</Relationships>";

/**
 * 样式表：只放本篇正文真正会用到的六种。
 * eastAsia 字体显式给 SimSun——不给的话中文在部分 Word 版本上会落到宋体以外的
 * 回退字体上，而这是导出文件里唯一「看起来不对」的地方。
 */
const STYLES =
  XML_DECL +
  `<w:styles xmlns:w="${W}">` +
  "<w:docDefaults>" +
  '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:ind w:left="480"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="80"/></w:pPr></w:style>' +
  "</w:styles>";

/** 编号定义。abstractNum 必须全部排在 num 之前（CT_Numbering 的序列顺序）。 */
const NUMBERING =
  XML_DECL +
  `<w:numbering xmlns:w="${W}">` +
  '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
  '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
  "</w:numbering>";

/** 一段（或一节）的页面设置：A4 + 2.54cm 页边距。sectPr 是 body 的最后一个子元素。 */
const SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>';

/** 正文里的一段文字。空段也要占一行（Markdown 的空行在正文里是有意义的）。 */
function runXml(text: string): string {
  const parts = xmlSafeText(text).split("\n");
  return "<w:r>" + parts.map((p) => `<w:t xml:space="preserve">${p}</w:t>`).join("<w:br/>") + "</w:r>";
}

function paragraphXml(style: string | null, runs: string, extraProps = ""): string {
  const pPr = style || extraProps ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extraProps}</w:pPr>` : "";
  return `<w:p>${pPr}${runs}</w:p>`;
}

function listItemXml(style: string, numId: number, text: string): string {
  return paragraphXml(style, runXml(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
}

function documentXml(title: string, content: string): string {
  const parts: string[] = [paragraphXml("Title", runXml(title))];

  for (const block of parseMarkdownBlocks(content)) {
    switch (block.kind) {
      case "heading": {
        // 正文里 ## 已经算章了，映射到 Heading1；### → Heading2；四级以下一律 Heading3。
        const style = Math.min(block.level, 4) <= 2 ? `Heading${block.level - 1}` : "Heading3";
        parts.push(paragraphXml(style, runXml(block.text)));
        break;
      }
      case "paragraph":
        parts.push(paragraphXml(null, runXml(block.text)));
        break;
      case "quote":
        // 引用块内的软换行保留为上标分隔：回车用 w:br 表达，Word 里看得见
        parts.push(paragraphXml("Quote", runXml(block.text)));
        break;
      case "divider":
        parts.push(
          paragraphXml(null, "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>'),
        );
        break;
      case "list":
        for (const item of block.items) {
          parts.push(listItemXml("ListParagraph", block.ordered ? DECIMAL_NUM_ID : BULLET_NUM_ID, item));
        }
        break;
    }
  }

  return (
    XML_DECL +
    `<w:document xmlns:w="${W}"><w:body>${parts.join("")}${SECTION}</w:body></w:document>`
  );
}

export const docxExporter: DocumentExporter = {
  format: "docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  render(input: ExportInput): ExportArtifact {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: PACKAGE_RELS },
      { name: "word/document.xml", data: documentXml(input.document.title, input.document.content) },
      { name: "word/styles.xml", data: STYLES },
      { name: "word/numbering.xml", data: NUMBERING },
      { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
    ]);
    return {
      filename: safeExportFilename(input.document.title, input.format, input.document.id),
      mimeType: this.mimeType,
      bytes: zip,
      containerDescription: "Office Open XML (OOXML) 字处理文档",
    };
  },
};
