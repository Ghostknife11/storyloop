import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildZip, crc32, type ZipEntry } from "@/infrastructure/export/zip-writer";
import {
  escapeXml,
  inlineTextOf,
  parseMarkdownBlocks,
  sanitizeXmlText,
  xmlSafeText,
} from "@/infrastructure/export/markdown-blocks";
import { docxExporter } from "@/infrastructure/export/docx-exporter";
import { epubExporter } from "@/infrastructure/export/epub-exporter";
import { contentDisposition, safeExportFilename, safeFileStem } from "@/domain/export-artifact";
import { documentListItemOf, storyDocumentOf, wordCountOf, type StoryDocument } from "@/domain/story-document";
import { sha256Hex } from "@/infrastructure/tracking/digest";

/**
 * v2.2.0 导出链测试（TASK §27）。
 *
 * 只测「字节从哪来」：ZIP 结构、正文分块、两种容器的 XML 安全、文件名安全。
 * 不测存储端（见 test_workspace_export_store.test.ts），也不测工作流判定
 * （见 test_workspace_lifecycle.test.ts）。导出链最容易出的不是业务错误，
 * 而是「用户正文里的一个 <script> 把整个文件变成坏包」这种事——所以这里
 * 有一段专门的恶意正文用例。
 */

const encoder = new TextEncoder();

/** 从 ZIP 的中央目录读回条目。只按格式文档解析，不调用写入器的任何代码。 */
function readCentralDirectory(bytes: Uint8Array): { name: string; method: number; offset: number; compressed: number; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("找不到 EOCD");
  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries: { name: string; method: number; offset: number; compressed: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pointer, true)).toBe(0x02014b50);
    const method = view.getUint16(pointer + 10, true);
    const compressed = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const offset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    entries.push({ name, method, offset, compressed, size });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 按中央目录指回本地头，取出真实内容。STORED 条目直接切片。 */
function readEntry(bytes: Uint8Array, name: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = readCentralDirectory(bytes).find((e) => e.name === name);
  if (!found) throw new Error(`ZIP 里没有 ${name}`);
  expect(view.getUint32(found.offset, true)).toBe(0x04034b50);
  const nameLength = view.getUint16(found.offset + 26, true);
  const extraLength = view.getUint16(found.offset + 28, true);
  const start = found.offset + 30 + nameLength + extraLength;
  return new TextDecoder().decode(bytes.subarray(start, start + found.size));
}

/**
 * 极简配平校验：XML 里每个开标签都要有配对的闭标签。
 * 这里按正则逐个过标签，是为了把「转义好的 &lt;script&gt;」和「真的标签」区分开——
 * 后者会让配对彻底乱掉，而前者本来就不该进标签流。
 */
function assertTagsBalanced(xml: string): void {
  const stack: string[] = [];
  const opened: string[] = [];
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing === "/") continue;
    if (closing === "/") {
      expect(stack.pop(), `多余的闭标签 </${name}>`).toBe(name);
    } else {
      stack.push(name);
      opened.push(match[0]);
    }
  }
  expect(stack, `未闭合的标签：${opened.join(" ")}`).toEqual([]);
}

const SAMPLE_CONTENT =
  "## 第一章\n\n她在夜行列车上**醒来**。\n\n> 车窗外没有月亮\n\n- 第一夜\n- 第二夜\n\n1. 上车\n2. 下车\n\n---\n\n结尾段落。";

const SAMPLE_DOC: StoryDocument = {
  schemaVersion: "1",
  id: "doc_20260927_101500_j442h6",
  projectId: "prj_20260927_101500_a1b2c3",
  title: "夜行列车",
  status: "draft",
  source: "generated",
  content: SAMPLE_CONTENT,
  sourceRunId: "run_20260927_101500_zz9999",
  contentHash: sha256Hex(SAMPLE_CONTENT),
  createdAt: "2026-09-27T10:15:00.000Z",
  updatedAt: "2026-09-27T10:15:00.000Z",
  isFavorite: false,
};

function documentWith(title: string, content: string): StoryDocument {
  return { ...SAMPLE_DOC, title, content, contentHash: sha256Hex(content) };
}

const EXPORTED_AT = "2026-09-27T10:15:00.000Z";

describe("crc32", () => {
  it("与参考实现一致：空串 0，hello world 0x0d4a1185，mimetype 0x2cab616f", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(encoder.encode("hello world"))).toBe(0x0d4a1185);
    expect(crc32(encoder.encode("application/epub+zip"))).toBe(0x2cab616f);
  });

  it("改一个字，校验和就变", () => {
    expect(crc32(encoder.encode("同一份内容"))).not.toBe(crc32(encoder.encode("同一份内窑")));
  });
});

describe("buildZip", () => {
  const entries: ZipEntry[] = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "a/b.txt", data: "hello world" },
    { name: "empty.txt", data: "" },
  ];

  it("中央目录与本地头对得上，条目全部 STORED", () => {
    const zip = buildZip(entries);
    const central = readCentralDirectory(zip);
    expect(central.map((e) => e.name)).toEqual(["mimetype", "a/b.txt", "empty.txt"]);
    for (const entry of central) {
      expect(entry.method).toBe(0);
      expect(entry.compressed).toBe(entry.size);
    }
  });

  it("内容能原样读回来", () => {
    const zip = buildZip(entries);
    expect(readEntry(zip, "mimetype")).toBe("application/epub+zip");
    expect(readEntry(zip, "a/b.txt")).toBe("hello world");
    expect(readEntry(zip, "empty.txt")).toBe("");
  });

  it("同一份输入永远得到同一串字节——导出不该因为今天几号而变", () => {
    expect(Array.from(buildZip(entries))).toEqual(Array.from(buildZip(entries)));
  });

  it("EPUB 的 mimetype 是第一个条目，本地头不带额外字段、时间戳取下界", () => {
    const zip = buildZip(entries);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(4, true)).toBe(20); // 所需版本
    expect(view.getUint16(6, true)).toBe(0x0800); // UTF-8 文件名标志
    expect(view.getUint16(8, true)).toBe(0); // STORED
    expect(view.getUint16(10, true)).toBe(0); // DOS 时间下界
    expect(view.getUint16(12, true)).toBe(0x0021); // DOS 日期下界：1980-01-01
    expect(view.getUint32(14, true)).toBe(crc32(encoder.encode("application/epub+zip")));
    expect(view.getUint32(18, true)).toBe(20); // 压缩后大小 = mimetype 内容长度
    expect(view.getUint32(22, true)).toBe(20); // 未压缩大小（STORED 下两者相等）
    expect(view.getUint16(26, true)).toBe(8); // "mimetype" 名字长度
    expect(view.getUint16(28, true)).toBe(0); // 额外字段长度必须为 0
  });

  it("非 ASCII 条目名按 UTF-8 写（不置标志位的中文名会被读成乱码）", () => {
    const zip = buildZip([{ name: "章节/第一章.xhtml", data: "正文" }]);
    expect(readCentralDirectory(zip)[0].name).toBe("章节/第一章.xhtml");
    expect(readEntry(zip, "章节/第一章.xhtml")).toBe("正文");
  });

  it("空 ZIP 也是一个合法空包", () => {
    const zip = buildZip([]);
    expect(readCentralDirectory(zip)).toEqual([]);
    expect(zip.length).toBe(22);
  });
});

describe("parseMarkdownBlocks", () => {
  it("认出标题、段落、引用、列表、分隔线", () => {
    const blocks = parseMarkdownBlocks("# 部\n\n段落一\n段落二\n\n## 章\n\n> 引用\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n---\n");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "heading", "quote", "list", "list", "divider"]);
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "部" });
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "段落一\n段落二" });
    expect(blocks[4]).toEqual({ kind: "list", ordered: false, items: ["甲", "乙"] });
    expect(blocks[5]).toEqual({ kind: "list", ordered: true, items: ["一", "二"] });
  });

  it("认不出来的行当段落收下，标记去掉、内容不丢", () => {
    const blocks = parseMarkdownBlocks("```json\n{\"a\":1}\n```\n| 甲 | 乙 |\n| --- | --- |");
    // 没有空行分隔，软折成同一段；围栏与表格线是语法不是内容，被清掉
    expect(blocks).toEqual([{ kind: "paragraph", text: "json\n{\"a\":1}\n\n| 甲 | 乙 |\n| --- | --- |" }]);
  });

  it("软换行不会把一段切成两段", () => {
    expect(parseMarkdownBlocks("第一行\n第二行")).toEqual([{ kind: "paragraph", text: "第一行\n第二行" }]);
  });

  it("空输入得到空结果", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    expect(parseMarkdownBlocks("\n\n  \n")).toEqual([]);
  });

  it("CRLF 与 LF 一视同仁", () => {
    expect(parseMarkdownBlocks("# 章\r\n\r\n正文\r\n")).toEqual([
      { kind: "heading", level: 1, text: "章" },
      { kind: "paragraph", text: "正文" },
    ]);
  });

  it("列表中间插了别的块就断开", () => {
    const blocks = parseMarkdownBlocks("- 甲\n\n普通段落\n\n- 乙");
    expect(blocks.map((b) => b.kind)).toEqual(["list", "paragraph", "list"]);
    expect(blocks[2]).toEqual({ kind: "list", ordered: false, items: ["乙"] });
  });

  it("引用块跨行合并", () => {
    expect(parseMarkdownBlocks("> 第一句\n> 第二句")).toEqual([{ kind: "quote", text: "第一句\n第二句" }]);
  });
});

describe("inlineTextOf", () => {
  it("链接留文字、图片留 alt、强调标记删掉", () => {
    expect(inlineTextOf("[故事开头](https://example.com)")).toBe("故事开头");
    expect(inlineTextOf("![封面](cover.png)")).toBe("封面");
    expect(inlineTextOf("**粗** *斜* `码` ~~删~~")).toBe("粗 斜 码 删");
  });

  it("下划线在 snake_case 里要留住，作为强调才删", () => {
    expect(inlineTextOf("user_name 与 _强调_")).toBe("user_name 与 强调");
    expect(inlineTextOf("1_000_000 元")).toBe("1_000_000 元");
    expect(inlineTextOf("a __粗__ b")).toBe("a 粗 b");
  });

  it("普通标点不动", () => {
    expect(inlineTextOf("她问：真的吗？（三遍）")).toBe("她问：真的吗？（三遍）");
  });
});

describe("XML 安全", () => {
  it("五个必转字符都转掉，且 & 不会被二次转义", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("C0 控制字符被丢掉，换行制表保留", () => {
    expect(sanitizeXmlText("a\u0000b\u001fc\td\ne")).toBe("abc\td\ne");
  });

  it("孤立代理字符被丢掉——否则整个 XHTML 解析失败", () => {
    expect(sanitizeXmlText("ab\uDC00cd\uD83D")).toBe("abcd");
  });

  it("合法的辅助平面字符（如 emoji）留住", () => {
    expect(sanitizeXmlText("笑\u{1F600}了")).toBe("笑\u{1F600}了");
  });

  it("xmlSafeText 先清洗再转义", () => {
    expect(xmlSafeText("<b>\u0007</b>")).toBe("&lt;b&gt;&lt;/b&gt;");
  });
});

describe("docxExporter", () => {
  const artifact = docxExporter.render({ document: documentWith("夜行列车", SAMPLE_CONTENT), format: "docx", exportedAt: EXPORTED_AT });

  it("六个部件齐全，且都是 STORED", () => {
    const central = readCentralDirectory(artifact.bytes);
    expect(central.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/_rels/document.xml.rels",
    ]);
    for (const entry of central) expect(entry.method).toBe(0);
  });

  it("内容类型覆盖声明了三个 OOXML 部件", () => {
    const types = readEntry(artifact.bytes, "[Content_Types].xml");
    expect(types).toContain('PartName="/word/document.xml"');
    expect(types).toContain('PartName="/word/styles.xml"');
    expect(types).toContain('PartName="/word/numbering.xml"');
  });

  it("关系声明里引用的部件都真的在包里", () => {
    const names = readCentralDirectory(artifact.bytes).map((e) => e.name);
    const rels = readEntry(artifact.bytes, "word/_rels/document.xml.rels");
    for (const target of ["styles.xml", "numbering.xml"]) {
      expect(rels).toContain(`Target="${target}"`);
      expect(names).toContain(`word/${target}`);
    }
  });

  it("正文、样式、编号表的 XML 都配平", () => {
    for (const part of ["word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"]) {
      assertTagsBalanced(readEntry(artifact.bytes, part));
    }
  });

  it("标题进 Title 样式，章标题进 Heading1，引用进 Quote，两种列表各有编号", () => {
    const document = readEntry(artifact.bytes, "word/document.xml");
    expect(document).toContain('<w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">夜行列车</w:t>');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
    expect(document).toContain('<w:numId w:val="1"/>'); // 圆点
    expect(document).toContain('<w:numId w:val="2"/>'); // 有序
    expect(document.endsWith("</w:sectPr></w:body></w:document>")).toBe(true);
  });

  it("两种列表都映射到 numbering.xml 里真实存在的 numId，且 abstractNum 排在 num 前", () => {
    const numbering = readEntry(artifact.bytes, "word/numbering.xml");
    expect(numbering).toContain('<w:num w:numId="1">');
    expect(numbering).toContain('<w:num w:numId="2">');
    // CT_Numbering 要求 abstractNum 全部排在 num 之前
    expect(numbering.lastIndexOf("<w:abstractNum ")).toBeLessThan(numbering.indexOf('<w:num w:numId="1">'));
  });

  it("同一篇稿件两次导出得到同一串字节", () => {
    const again = docxExporter.render({ document: documentWith("夜行列车", SAMPLE_CONTENT), format: "docx", exportedAt: EXPORTED_AT });
    expect(Array.from(artifact.bytes)).toEqual(Array.from(again.bytes));
  });

  it("文件名带扩展名，MIME 是 DOCX 的", () => {
    expect(artifact.filename.endsWith(".docx")).toBe(true);
    expect(artifact.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(artifact.containerDescription).toContain("OOXML");
  });
});

describe("epubExporter", () => {
  const artifact = epubExporter.render({ document: documentWith("夜行列车", SAMPLE_CONTENT), format: "epub", exportedAt: EXPORTED_AT });

  it("mimetype 占第一位且内容固定", () => {
    expect(readCentralDirectory(artifact.bytes)[0].name).toBe("mimetype");
    expect(readEntry(artifact.bytes, "mimetype")).toBe("application/epub+zip");
  });

  it("container.xml 指向 OPF，OPF 引用的每个文件都在包里", () => {
    const container = readEntry(artifact.bytes, "META-INF/container.xml");
    expect(container).toContain('full-path="OEBPS/content.opf"');
    const names = readCentralDirectory(artifact.bytes).map((e) => e.name);
    const opf = readEntry(artifact.bytes, "OEBPS/content.opf");
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => `OEBPS/${m[1]}`);
    expect(hrefs).toHaveLength(3); // nav + css + 一章
    for (const href of hrefs) expect(names, `OPF 引用了不存在的 ${href}`).toContain(href);
  });

  it("OPF 必填项齐全：identifier、title、language、dcterms:modified", () => {
    const opf = readEntry(artifact.bytes, "OEBPS/content.opf");
    expect(opf).toContain('unique-identifier="book-id"');
    expect(opf).toContain(`urn:storyloop:${SAMPLE_DOC.projectId}:${SAMPLE_DOC.id}`);
    expect(opf).toContain("夜行列车");
    expect(opf).toContain("<dc:language>zh-CN</dc:language>");
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
  });

  it("spine 里每个 itemref 都指向 manifest 里的 item（css 只在 manifest，不进 spine）", () => {
    const opf = readEntry(artifact.bytes, "OEBPS/content.opf");
    const manifestIds = [...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
    const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    expect(manifestIds).toContain("css");
    expect(spineIds).not.toContain("css");
    expect(spineIds.length).toBe(manifestIds.length - 1);
    for (const id of spineIds) expect(manifestIds).toContain(id);
  });

  it("按 ## 章标题分章，nav 的目录条目数与章数一致", () => {
    const names = readCentralDirectory(artifact.bytes).map((e) => e.name);
    expect(names).toContain("OEBPS/nav.xhtml");
    expect(names).toContain("OEBPS/text/chapter1.xhtml");
    const nav = readEntry(artifact.bytes, "OEBPS/nav.xhtml");
    expect(nav).toContain('epub:type="toc"');
    const toc = nav.slice(0, nav.indexOf("</nav>"));
    expect([...toc.matchAll(/chapter\d+\.xhtml/g)]).toHaveLength(1);
    const chapter = readEntry(artifact.bytes, "OEBPS/text/chapter1.xhtml");
    expect(chapter).toContain('<h1 class="chapter-title">第一章</h1>');
    expect(chapter).toContain("<blockquote>");
    expect(chapter).toContain("<li>第一夜</li>");
    expect(chapter).toContain('<hr class="divider"/>');
    assertTagsBalanced(chapter);
    assertTagsBalanced(nav);
    assertTagsBalanced(readEntry(artifact.bytes, "OEBPS/content.opf"));
  });

  it("整篇没有章标题时仍是一章，目录里至少有一条", () => {
    const flat = epubExporter.render({ document: documentWith("夜行列车", "只有一段正文。"), format: "epub", exportedAt: EXPORTED_AT });
    expect(readCentralDirectory(flat.bytes).map((e) => e.name).filter((n) => n.startsWith("OEBPS/text/"))).toHaveLength(1);
    expect(readEntry(flat.bytes, "OEBPS/nav.xhtml")).toContain("夜行列车");
  });

  it("英文正文判成 en，中文判成 zh-CN", () => {
    const english = epubExporter.render({ document: documentWith("Night Train", "She woke up."), format: "epub", exportedAt: EXPORTED_AT });
    expect(readEntry(english.bytes, "OEBPS/content.opf")).toContain("<dc:language>en</dc:language>");
    expect(readEntry(artifact.bytes, "OEBPS/content.opf")).toContain("<dc:language>zh-CN</dc:language>");
  });

  it("同一篇稿件两次导出得到同一串字节", () => {
    const again = epubExporter.render({ document: documentWith("夜行列车", SAMPLE_CONTENT), format: "epub", exportedAt: EXPORTED_AT });
    expect(Array.from(artifact.bytes)).toEqual(Array.from(again.bytes));
  });
});

describe("两种导出器都扛得住恶意正文", () => {
  const hostile = documentWith(
    "注入标题</w:t></w:r><w:r><w:t>X",
    "</w:t></w:r><w:r><w:t>注入</w:t></w:r>\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n&amp;\u0007\uDC00",
  );

  for (const exporter of [docxExporter, epubExporter]) {
    it(`${exporter.format}：注入文本被转义成实体，标签依然配平`, () => {
      const artifact = exporter.render({ document: hostile, format: exporter.format, exportedAt: EXPORTED_AT });
      const parts = readCentralDirectory(artifact.bytes)
        .map((e) => e.name)
        .filter((n) => n.endsWith(".xml") || n.endsWith(".xhtml"))
        .map((n) => readEntry(artifact.bytes, n));
      expect(parts.length).toBeGreaterThan(2);
      const joined = parts.join("\n");
      expect(joined).toContain("&lt;script&gt;");
      expect(joined).toContain("&lt;img");
      expect(joined).toContain("注入");
      // 注入的闭合标签必须变成实体，而不是变成真标签
      expect(joined).not.toContain("<w:t>注入</w:t>");
      expect(joined).not.toContain("<script>");
      expect(joined).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      expect(joined).not.toContain("\uDC00");
      for (const part of parts) assertTagsBalanced(part);
    });
  }

  it("孤立代理字符不会让任何一种格式产出坏包", () => {
    const loneSurrogate = documentWith("孤代理", "前\uDC00后");
    for (const exporter of [docxExporter, epubExporter]) {
      const artifact = exporter.render({ document: loneSurrogate, format: exporter.format, exportedAt: EXPORTED_AT });
      const parts = readCentralDirectory(artifact.bytes)
        .map((e) => e.name)
        .filter((n) => n.endsWith(".xml") || n.endsWith(".xhtml"))
        .map((n) => readEntry(artifact.bytes, n));
      for (const part of parts) assertTagsBalanced(part);
    }
  });
});

describe("文件名与下载头", () => {
  it("危险字符与路径片段都换成下划线", () => {
    expect(safeFileStem("../..")).toBe("untitled");
    expect(safeFileStem("a/b:c*d?e\"f<g>h|i")).toBe("a_b_c_d_e_f_g_h_i");
    expect(safeFileStem("   夜行列车   ")).toBe("夜行列车");
    expect(safeFileStem("...")).toBe("untitled");
    expect(safeFileStem("")).toBe("untitled");
    expect(safeFileStem("标题\u0000\u0001结尾")).toBe("标题__结尾");
  });

  it("超长标题被截断，不会把文件名写爆", () => {
    const stem = safeFileStem("夜".repeat(300));
    expect(stem.length).toBeLessThanOrEqual(60);
    expect(safeExportFilename("夜".repeat(300), "docx", "doc_20260927_101500_j442h6")).toBe(`${stem}_j442h6.docx`);
  });

  it("导出文件名带 id 后缀——两个同名稿件的文件不会互相覆盖", () => {
    const a = safeExportFilename("夜行列车", "docx", "doc_20260927_101500_j442h6");
    const b = safeExportFilename("夜行列车", "docx", "doc_20260927_201500_zzzzz1");
    expect(a).not.toBe(b);
    expect(a.endsWith("j442h6.docx")).toBe(true);
  });

  it("ASCII 与中文文件名都同时给 filename 与 filename*（RFC 6266）", () => {
    expect(contentDisposition("night_train_j442h6.docx")).toBe(
      'attachment; filename="night_train_j442h6.docx"; filename*=UTF-8\'\'night_train_j442h6.docx',
    );
    const utf8 = contentDisposition("夜行列车_j442h6.docx");
    expect(utf8).toContain("filename*=UTF-8''");
    // filename* 走百分号编码，解回来必须还是原来的名字
    const encoded = utf8.slice(utf8.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
    expect(decodeURIComponent(encoded)).toBe("夜行列车_j442h6.docx");
    // filename 兜底那份只含 ASCII（四个汉字换成下划线），给不认 filename* 的老客户端
    expect(utf8).toContain('filename="_____j442h6.docx"');
    expect(utf8).not.toContain("\n");
    expect(utf8).not.toContain("\r");
  });
});

describe("导出链是纯函数", () => {
  it("导出的输入是稿件本身，读的是 content 字段而不是磁盘上的 story.md", () => {
    const artifact = docxExporter.render({
      document: documentWith("改过的标题", "改过的正文"),
      format: "docx",
      exportedAt: EXPORTED_AT,
    });
    const document = readEntry(artifact.bytes, "word/document.xml");
    expect(document).toContain("改过的标题");
    expect(document).toContain("改过的正文");
    expect(document).not.toContain("夜行列车");
  });

  it("同一个 exportedAt 下两次渲染字节一致（渲染不读时钟）", () => {
    const a = epubExporter.render({ document: documentWith("夜行列车", "正文"), format: "epub", exportedAt: EXPORTED_AT });
    const b = epubExporter.render({ document: documentWith("夜行列车", "正文"), format: "epub", exportedAt: EXPORTED_AT });
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("export/ 目录下的源码不碰 node: 模块，也不发请求", () => {
    const dir = join(process.cwd(), "src", "infrastructure", "export");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(3);
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source, `${name} 引入了 node: 模块`).not.toContain("node:");
      expect(source, `${name} 里出现了 fetch`).not.toContain("fetch(");
    }
  });
});

describe("文档列表项", () => {
  it("中英混排按「汉字按字、西文按词」计", () => {
    expect(wordCountOf("她在 night train 上")).toBe(5);
    expect(wordCountOf("")).toBe(0);
  });

  it("列表项不带正文，只带汇总字段", () => {
    const doc = storyDocumentOf(SAMPLE_DOC);
    expect(doc).not.toBeNull();
    const item = documentListItemOf(doc!);
    expect(item).not.toHaveProperty("content");
    expect(item.wordCount).toBe(wordCountOf(SAMPLE_CONTENT));
    expect(item.id).toBe(SAMPLE_DOC.id);
  });
});
