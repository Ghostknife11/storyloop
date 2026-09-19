import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoryGenerator } from "@/lib/story-generator";
import { LLMError } from "@/lib/llm";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/** §14/§15/§16 StoryGenerator：StoryConfig + BeatPlan → Story Prompt → LLM → 正文。 */

const config: StoryConfig = validateStoryConfig({
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
  extra_requirements: "不要使用超自然元素。",
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  summary: "从失踪到真相",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"], conflict: "只剩三分钟" },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "周衡"], expected_outcome: "真相公开" },
  ],
});

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function spyLLM(out: string) {
  const calls: Array<{ prompt: string; temperature: number; system: string }> = [];
  return {
    calls,
    generate: async (prompt: string, temperature: number, system: string) => {
      calls.push({ prompt, temperature, system });
      return out;
    },
  };
}

describe("StoryGenerator", () => {
  it("模板缺失时构造失败，错误信息带路径", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-storygen-"));
    const missing = join(tmp, "nope.txt");
    expect(() => new StoryGenerator({ generate: async () => "" } as never, missing)).toThrow(/Story 模板读取失败/);
  });

  it("§16 renderBeatPlan：按 Beat 顺序输出 Purpose/Event/Characters/Conflict/Outcome", () => {
    const text = new StoryGenerator({ generate: async () => "" } as never).renderBeatPlan(plan);
    expect(text).toContain("Beat 1");
    expect(text).toContain("Purpose: 建立危机");
    expect(text).toContain("Event: 证人失踪。");
    expect(text).toContain("Characters: 陈岚");
    expect(text).toContain("Conflict: 只剩三分钟");
    expect(text).toContain("Expected Outcome: 真相公开");
    expect(text.indexOf("Beat 1")).toBeLessThan(text.indexOf("Beat 2"));
    // 可选字段缺失时不输出空行占位
    expect(text).not.toContain("Conflict: undefined");
  });

  it("§15 Story Prompt 同时包含 StoryConfig 与 BeatPlan，无残留占位符", () => {
    const prompt = new StoryGenerator({ generate: async () => "" } as never).buildStoryPrompt(config, plan);
    expect(prompt).toContain("消失的目击者");
    expect(prompt).toContain("唯一证人在出庭前一天突然消失。");
    expect(prompt).toContain("履行保护责任");
    expect(prompt).toContain("冷峻、节奏紧凑");
    expect(prompt).toContain("不要使用超自然元素。");
    expect(prompt).toContain("5000");
    expect(prompt).toContain("Beat 1");
    expect(prompt).toContain("Beat 2");
    expect(prompt.indexOf("Beat 1")).toBeLessThan(prompt.indexOf("Beat 2"));
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("可选字段为空 → 未指定，由作者自行决定（不输出 undefined/null）", () => {
    const minimal = validateStoryConfig({ title: "空白", genre: "散文", premise: "一个人回家。", target_words: 3000 });
    const emptyPlan = validateBeatPlan({
      beat_plan_version: "1",
      beats: [{ id: 1, purpose: "独行", event: "回家。", characters: [] }],
    });
    const prompt = new StoryGenerator({ generate: async () => "" } as never).buildStoryPrompt(minimal, emptyPlan);
    expect(prompt).toContain("未指定");
    expect(prompt).toContain("由作者自行决定");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  it("generate()：默认 temperature 0.8，system 指向 Beat Plan 创作", async () => {
    const llm = spyLLM("正文内容");
    const out = await new StoryGenerator(llm as never).generate(config, plan);
    expect(out).toBe("正文内容");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].temperature).toBe(0.8);
    expect(llm.calls[0].system).toContain("Story Beat Plan");
    expect(llm.calls[0].prompt).toContain("Beat 2");
  });

  it("generate()：可覆盖 temperature 与 system", async () => {
    const llm = spyLLM("正文内容");
    await new StoryGenerator(llm as never).generate(config, plan, 0.3, "自定义系统提示");
    expect(llm.calls[0].temperature).toBe(0.3);
    expect(llm.calls[0].system).toBe("自定义系统提示");
  });

  it("generate()：LLM 出错 → LLMError 透传（§53 语义保留给上层映射 502）", async () => {
    const llm = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
    await expect(new StoryGenerator(llm as never).generate(config, plan)).rejects.toThrow(/401/);
  });
});
