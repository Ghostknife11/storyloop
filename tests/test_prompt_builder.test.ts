import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptBuilder } from "@/lib/prompt-builder";
import { PromptTemplateError } from "@/lib/prompt-template";
import type { StoryRequest } from "@/lib/story-request";

const request: StoryRequest = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要超自然元素。",
};

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function writeTemplate(content: string): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-tpl-"));
  const path = join(tmp, "story.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("PromptBuilder.build", () => {
  it("title appears", () => {
    const p = new PromptBuilder(writeTemplate("标题：{{title}}")).build(request);
    expect(p).toContain("消失的目击者");
  });

  it("genre appears", () => {
    const p = new PromptBuilder(writeTemplate("题材：{{genre}}")).build(request);
    expect(p).toContain("悬疑");
  });

  it("premise appears", () => {
    const p = new PromptBuilder(writeTemplate("设定：{{premise}}")).build(request);
    expect(p).toContain("唯一证人在出庭前一天突然失踪。");
  });

  it("target_words appears", () => {
    const p = new PromptBuilder(writeTemplate("长度：约 {{target_words}} 字")).build(request);
    expect(p).toContain("约 5000 字");
  });

  it("style appears", () => {
    const p = new PromptBuilder(writeTemplate("风格：{{style}}")).build(request);
    expect(p).toContain("冷峻、节奏紧凑");
  });

  it("extra_requirements appears", () => {
    const p = new PromptBuilder(writeTemplate("附加：{{extra_requirements}}")).build(request);
    expect(p).toContain("不要超自然元素。");
  });

  it("§87 空可选字段不产生 None/undefined/null", () => {
    const p = new PromptBuilder(writeTemplate("风格：{{style}}\n附加：{{extra_requirements}}")).build({
      ...request,
      style: undefined,
      extra_requirements: "",
    });
    expect(p).toContain("未指定");
    expect(p).not.toMatch(/None|undefined|null/);
  });

  it("模板包含未支持的占位符 → 明确报错", () => {
    expect(() => new PromptBuilder(writeTemplate("{{unknown_var}}")).build(request)).toThrow(PromptTemplateError);
  });
});
