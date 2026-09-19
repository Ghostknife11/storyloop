import { describe, expect, it } from "vitest";
import { StoryGenerator } from "@/lib/story-generator";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan } from "@/types/beat-plan";

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

const plan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "嫌疑人"] },
  ],
});

const generator = new StoryGenerator({ generate: async () => "x" } as never);

describe("StoryGenerator.buildStoryPrompt（StoryConfig 新字段 §79）", () => {
  it("setting appears", () => {
    expect(generator.buildStoryPrompt(baseConfig, plan)).toContain("现代一线城市，庭审前夜。");
  });

  it("protagonist appears（name/identity/goal/motivation）", () => {
    const p = generator.buildStoryPrompt(baseConfig, plan);
    expect(p).toContain("陈岚");
    expect(p).toContain("刑警");
    expect(p).toContain("找到证人");
    expect(p).toContain("履行保护责任");
  });

  it("conflict / stakes / ending appear", () => {
    const p = generator.buildStoryPrompt(baseConfig, plan);
    expect(p).toContain("证人失踪与嫌疑人有关。");
    expect(p).toContain("证人缺席将导致案件失败。");
    expect(p).toContain("证人主动设计了失踪。");
  });

  it("§88 空 ending / style / extra_requirements 渲染为归一化文案，不出现 None/null/undefined", () => {
    const p = generator.buildStoryPrompt(
      validateStoryConfig({ ...baseConfig, ending: undefined, style: undefined, extra_requirements: undefined }),
      plan,
    );
    expect(p).toContain("未指定，由作者自行决定");
    expect(p).not.toMatch(/None|undefined|null/);
  });

  it("§88 空 protagonist 字段同样归一化", () => {
    const p = generator.buildStoryPrompt(
      validateStoryConfig({ ...baseConfig, protagonist: { name: "陈岚" } }),
      plan,
    );
    expect(p).toContain("姓名：陈岚");
    expect(p).toContain("身份：未指定");
  });

  it("v0.1.0 请求（无新字段）仍可生成", () => {
    const legacy: StoryConfig = validateStoryConfig({
      config_version: "1",
      title: "旧版配置",
      genre: "悬疑",
      premise: "旧版 premise。",
      target_words: 3000,
    });
    const p = generator.buildStoryPrompt(legacy, plan);
    expect(p).toContain("旧版配置");
    expect(p).toContain("未指定");
  });

  it("§15 Story Prompt 同时包含 Beat Plan（按 Beat 顺序）", () => {
    const p = generator.buildStoryPrompt(baseConfig, plan);
    expect(p).toContain("【Story Beat Plan——剧情骨架】");
    expect(p).toContain("Beat 1");
    expect(p).toContain("Beat 2");
    expect(p.indexOf("Beat 1")).toBeLessThan(p.indexOf("Beat 2"));
  });
});
