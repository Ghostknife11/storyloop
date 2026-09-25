import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.5.2 主题 token 回归。
 *
 * 1.5.1 之前的一部分界面颜色是写死的（border-white/10、bg-white/[0.03]、text-zinc-300、
 * bg-zinc-800/60……）。这些值只在深色背景下成立：浅色模式下面板边框几乎看不见、原生
 * select 变成一块黑、正文浅灰压在近白底上读不清。v1.5.2 把它们统一换成 globals.css
 * 的主题 token（border-border / bg-muted / text-foreground / bg-input），让浅色与深色
 * 两套主题下都成立。
 *
 * 这几个用例都是源码级断言，目的是让「别再写死颜色」这件事在回归里被挡住，而不是靠
 * 每次肉眼看截图。
 */

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 剥掉注释再扫描：类名只出现在 JSX 里，注释里的说明文字不算数。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const UI_FILES = listSourceFiles(join("src", "components")).concat(
  listSourceFiles(join("src", "app")),
);

describe("v1.5.2 边框与卡片底色只用主题 token", () => {
  it("没有写死的白/锌色边框或底色（border-white/*、bg-white/*、bg-zinc-*、text-zinc-*）", () => {
    const hits: string[] = [];
    for (const file of UI_FILES) {
      const src = codeOnly(readFileSync(file, "utf8"));
      for (const re of [
        /border-white\/\d/,
        /bg-white\//,
        /bg-zinc-\d/,
        /text-zinc-\d/,
      ]) {
        if (re.test(src)) hits.push(`${file}:${re.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("bg-black/* 只允许出现在整屏遮罩上，不能拿来做面板底色", () => {
    const hits: string[] = [];
    for (const file of UI_FILES) {
      const src = codeOnly(readFileSync(file, "utf8"));
      for (const line of src.split("\n")) {
        if (/bg-black\/\d/.test(line) && !/fixed inset-0/.test(line)) {
          hits.push(`${file}:${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("强调色的浅色档（300/400）必须成对写 dark: 前缀，浅色模式不会用浅色字", () => {
    const pale = /text-(?:emerald|amber|red|violet|rose|sky|blue)-(?:300|400)\b/;
    const hits: string[] = [];
    for (const file of UI_FILES) {
      // 先把深色限定的一支去掉，剩下的就是浅色模式下也会生效的浅色档文字
      const bare = codeOnly(readFileSync(file, "utf8")).replace(
        /dark:text-(?:emerald|amber|red|violet|rose|sky|blue)-(?:300|400)\b/g,
        "",
      );
      const found = bare.match(new RegExp(pale.source, "g"));
      if (found) hits.push(`${file}:${found.join(",")}`);
    }
    expect(hits).toEqual([]);
  });

  it("面板边框不再用 border-border/50 这种半透明档，浅色模式要看得见", () => {
    const hits: string[] = [];
    for (const file of UI_FILES) {
      if (/border-border\/\d/.test(codeOnly(readFileSync(file, "utf8")))) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

describe("v1.5.2 主工作区外框包裹内容", () => {
  const src = readFileSync(join("src", "app", "page.tsx"), "utf8");

  it("两列布局本身是 min-h-0，不把子项撑出可视高度", () => {
    const grid = src.match(/<div className="[^"]*grid-cols-1 lg:grid-cols-2[^"]*"/)?.[0] ?? "";
    expect(grid).toContain("min-h-0");
  });

  it("两列都设了 min-h-0 + overflow-y-auto，内容超高时在框内滚动", () => {
    const sections = [...src.matchAll(/<section className="([^"]*)"/g)].map((m) => m[1]);
    expect(sections).toHaveLength(2);
    for (const cls of sections) {
      expect(cls).toContain("min-h-0");
      expect(cls).toContain("overflow-y-auto");
    }
  });

  it("嵌套内层面板用 lg 圆角，不再和外层 3xl 圆角错档", () => {
    const inner = src.match(/rounded-lg border border-border bg-muted\/30/g) ?? [];
    expect(inner).toHaveLength(3);
    expect(src).not.toMatch(/rounded-2xl border border-white/);
  });
});

describe("v1.5.2 表单控件跟随主题", () => {
  /** 剥掉 dark: 前缀后剩下的部分，就是浅色模式下也会生效的那一半类名。 */
  function lightOnly(cls: string): string {
    return cls.replace(/dark:[\w/\-.]+/g, "");
  }

  it("原生 select 与 <Input> 同一套输入态：border-input 配 bg-transparent，不是 bg-input", () => {
    const files = [join("src", "app", "page.tsx"), join("src", "components", "repair-panel.tsx")];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const selects = src.match(/<select[\s\S]*?<\/select>/g) ?? [];
      expect(selects.length, `${file} 应当有一个原生 select`).toBeGreaterThan(0);
      for (const select of selects) {
        const cls = select.match(/className="([^"]*)"/)?.[1] ?? "";
        expect(cls, `${file} 的 select 缺少实现`).not.toBe("");
        expect(cls).toContain("border border-input");
        // 浅色模式下 --border 与 --input 是同一个值，bg-input 会让边框和底色互相抵消
        expect(cls).toContain("bg-transparent");
        expect(lightOnly(cls), `${file} 的 select 不该在浅色下用 bg-input`).not.toContain("bg-input");
        expect(cls).toContain("focus-visible:ring-ring/50");
        // 焦点环不能退回写死的紫色
        expect(cls).not.toMatch(/focus:outline-none|focus:ring-violet/);
        expect(select).toContain("<option");
        expect(select).toContain('className="bg-card"');
      }
    }
  });

  it("<Input> / <textarea> 本身也是 border-input 配 bg-transparent，没有写死底色", () => {
    for (const name of ["input.tsx", "textarea.tsx", "select.tsx"]) {
      const src = readFileSync(join("src", "components", "ui", name), "utf8");
      expect(src, `${name} 应使用 border-input`).toContain("border border-input");
      expect(src, `${name} 浅色下应是透明底`).toContain("bg-transparent");
      expect(src, `${name} 不该写死 focus ring 颜色`).not.toMatch(/focus:ring-violet|focus:outline-none/);
    }
  });
});

describe("v1.5.2 侧栏与结果面板", () => {
  it("侧栏不再为深色单独覆盖一层 bg-zinc-900/70 与 border-white/10", () => {
    const src = readFileSync(join("src", "components", "shell.tsx"), "utf8");
    expect(src).not.toMatch(/dark:bg-zinc-/);
    expect(src).not.toMatch(/dark:border-white\//);
  });

  it("Quality / Review / Commercial 面板的分数与正文用前景色，不用 text-zinc-300", () => {
    for (const name of ["quality-panel.tsx", "review-panel.tsx", "commercial-panel.tsx"]) {
      const src = codeOnly(readFileSync(join("src", "components", name), "utf8"));
      expect(src).not.toMatch(/text-zinc-\d/);
      expect(src).not.toMatch(/bg-white\//);
      expect(src).toContain("border border-border");
    }
  });
});

describe("v1.5.2 右列结果区可以滚到底", () => {
  /**
   * 1.5.1 及以前，右列是 flex 弹性布局："生成结果" 面板挂着 flex-1 min-h-[280px]，
   * 在 overflow-y-auto 的 section 里会拿到一个确定高度，于是它自己的内容溢出永远不会
   * 变成 section 的滚动高度。结果 Attempts / Quality / Validation / Review / Commercial
   * 全部渲染在 section 的可视高度之外，section 报 scrollHeight == clientHeight，滚不动，
   * 用户根本到不了那几个面板（浏览器里实测过：右列 737px 高，标题排到了 top 2629）。
   *
   * 修法：面板改用 grow shrink-0——flex-basis 回到 auto，按内容量出高度，没有内容时用
   * grow 把剩下的空间填满，有内容时靠 shrink-0 顶住不压缩，section 成为唯一滚动面。
   */
  const page = readFileSync(join("src", "app", "page.tsx"), "utf8");

  it("「生成结果」面板按内容撑开，不写 flex-1 也不写 min-h 的弹性底", () => {
    expect(page, "生成结果面板必须是 grow shrink-0").toContain(
      'className="grow shrink-0 flex flex-col rounded-3xl border border-border bg-card/60 glass shadow-soft overflow-hidden"',
    );
    expect(page).not.toMatch(/flex-1 min-h-\[280px\]/);
    expect(page).not.toMatch(/min-h-\[280px\] flex-1 flex-col/);
  });

  it("正文滚动区不写死高度：右列只有 section 一个滚动面", () => {
    expect(page).not.toMatch(/<ScrollArea className="h-full">/);
    // 兜底状态仍然要撑出高度，不然「生成结果」会塌成一条标题栏
    expect(page).toContain('min-h-[280px]');
  });
});
