/**
 * v2.2.0 导出用正文解析：把 Markdown 拆成块，并转成 XML 安全文本。
 *
 * 只认这几种块——标题、段落、引用、列表、分隔线。不认表格、脚注、代码围栏，
 * 不是因为难，而是因为导出的对象是「小说正文」：它由 story / outline / draft
 * 三级生成，产出形状本来就固定。多认一种语法就多一条要在 DOCX 与 EPUB
 * 两条渲染路径上各测一遍的分支，而这条分支对用户没有任何可见收益。
 *
 * 认不出来的行一律当段落文本收下——绝不丢内容。导出丢字是最难解释的事故，
 * 而「渲染得朴素一点」只是难看。
 */

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "divider" };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const RULE_RE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;

/**
 * 行内 Markdown → 纯文本。只做减法，不解析语义：
 * 图片 ![alt](src) 留 alt，链接 [text](url) 留 text，强调/代码标记直接删。
 */
export function inlineTextOf(raw: string): string {
  return stripEmphasis(raw.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).trim();
}

/**
 * 行内标记删除。
 *
 * `*` `` ` `` `~` 一律删——散文里它们不会单独承载意义。下划线不行：`user_name`
 * 里的下划线是人家的名字，删掉就把词改坏了。判据只有一条：一串下划线两侧都是
 * 单词字符时它是词的一部分（留住），否则才是强调标记（删掉）。这个判据对
 * `_强调_`、`a *b* c` 都成立，也不会碰 `1_000_000`。
 */
function stripEmphasis(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    if (char === "*" || char === "`" || char === "~") {
      while (i < value.length && value[i] === char) i++;
      continue;
    }
    if (char === "_") {
      let j = i;
      while (j < value.length && value[j] === "_") j++;
      const run = value.slice(i, j);
      const leftWord = i > 0 && /[\w]/.test(value[i - 1]);
      const rightWord = j < value.length && /[\w]/.test(value[j]);
      i = j;
      if (leftWord && rightWord) out += run;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** 段落合并：Markdown 的软换行在正文里就是同一段。空行分段。 */
function listItemOf(line: string): { ordered: boolean; text: string } | null {
  const bullet = line.match(BULLET_RE);
  if (bullet) return { ordered: false, text: bullet[1] };
  const ordered = line.match(ORDERED_RE);
  if (ordered) return { ordered: true, text: ordered[1] };
  return null;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: inlineTextOf(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    const heading = trimmed.match(HEADING_RE);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: inlineTextOf(heading[2]) });
      continue;
    }

    if (RULE_RE.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "divider" });
      continue;
    }

    const listItem = listItemOf(line);
    if (listItem) {
      flushParagraph();
      const items = [listItem.text];
      // 连续同型列表项合成一块，换型或插了别的块就断开
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim().length === 0) break;
        const nextItem = listItemOf(next);
        if (!nextItem || nextItem.ordered !== listItem.ordered) break;
        i++;
        items.push(nextItem.text);
      }
      blocks.push({ kind: "list", ordered: listItem.ordered, items: items.map(inlineTextOf) });
      continue;
    }

    const quote = trimmed.match(QUOTE_RE);
    if (quote) {
      flushParagraph();
      const quoted = [quote[1]];
      while (i + 1 < lines.length) {
        const nextQuote = lines[i + 1].trim().match(QUOTE_RE);
        if (!nextQuote) break;
        i++;
        quoted.push(nextQuote[1]);
      }
      blocks.push({ kind: "quote", text: inlineTextOf(quoted.join("\n")) });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

/** XML 1.0 里必须转义的五个字符。& 必须先转，否则会把后转的 < 又变回实体。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * XML 1.0 合法字符过滤：去掉 C0 控制字符（\t \n \r 除外）与代理区半字符。
 * 一个孤立的低位代理会让整个 XHTML 解析失败——EPUB 阅读器对此零容忍，
 * 而稿件正文可能带用户从别处粘进来的脏字符。
 */
export function sanitizeXmlText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += char;
    else if (code >= 0x20 && code <= 0xd7ff) out += char;
    else if (code >= 0xe000 && code <= 0xfffd) out += char;
    else if (code >= 0x10000 && code <= 0x10ffff) out += char;
  }
  return out;
}

/** XML 安全且保留可读转义的正文文本（EPUB / OOXML 共用）。 */
export function xmlSafeText(value: string): string {
  return escapeXml(sanitizeXmlText(value));
}
