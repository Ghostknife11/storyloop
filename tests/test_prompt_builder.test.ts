import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptBuilder } from "@/lib/prompt-builder";
import { PromptTemplateError } from "@/lib/prompt-template";
import { validateStoryConfig } from "@/types/story-config";

const baseConfig = validateStoryConfig({
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  setting: "现代一线城市，庭审前夜。",
  protagonist: { name: "陈岚", identity: "刑警", goal: "找到证人", motivation: "履行保护责任" },
  conflict: "证人失踪与嫌疑人有关。",
  stakes: "证人缺席将导致案件失败。",
  ending: "证人主动设计了失踪。",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要超自然元素。",
});

const builder = new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));

describe("PromptBuilder.build（StoryConfig 新字段 §79）", () => {
  it("setting appears", () => {
    expect(builder.build(baseConfig)).toContain("现代一线城市，庭审前夜。");
  });

  it("protagonist appears（name/identity/goal/motivation）", () => {
    const p = builder.build(baseConfig);
    expect(p).toContain("陈岚");
    expect(p).toContain("刑警");
    expect(p).toContain("找到证人");
    expect(p).toContain("履行保护责任");
  });

  it("conflict / stakes / ending appear", () => {
    const p = builder.build(baseConfig);
    expect(p).toContain("证人失踪与嫌疑人有关。");
    expect(p).toContain("证人缺席将导致案件失败。");
    expect(p).toContain("证人主动设计了失踪。");
  });

  it("§88 空 ending / style / extra_requirements 渲染为归一化文案，不出现 None/null/undefined", () => {
    const p = builder.build(validateStoryConfig({ ...baseConfig, ending: undefined, style: undefined, extra_requirements: undefined }));
    expect(p).toContain("未指定，由作者自行决定");
    expect(p).not.toMatch(/None|undefined|null/);
  });

  it("§88 空 protagonist 字段同样归一化", () => {
    const p = builder.build(validateStoryConfig({ ...baseConfig, protagonist: { name: "陈岚" } }));
    expect(p).toContain("姓名：陈岚");
    expect(p).toContain("身份：未指定");
  });

  it("v0.1.0 请求（无新字段）仍可生成", () => {
    const legacy = validateStoryConfig({
      config_version: "1",
      title: "旧版配置",
      genre: "悬疑",
      premise: "旧版 premise。",
      target_words: 3000,
    });
    const p = builder.build(legacy);
    expect(p).toContain("旧版配置");
    expect(p).toContain("未指定");
  });
});

describe("PromptBuilder 模板错误", () => {
  it("missing template fails clearly（Case F）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "storyloop-tpl-"));
    try {
      expect(() => new PromptBuilder(join(tmp, "missing.txt"))).toThrow(PromptTemplateError);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
