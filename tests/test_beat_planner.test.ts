import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeatPlanner } from "@/lib/beat-planner";
import { BeatParseError } from "@/lib/beat-parser";
import { LLMError } from "@/lib/llm";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/** §9 BeatPlanner：只做规划，不写正文、不评质量、不自动修复。 */

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
});

const planJson = JSON.stringify({
  beat_plan_version: "1",
  summary: "从失踪到真相",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "周衡"] },
  ],
});

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

/** 捕获 prompt / temperature / system 的假 LLM。 */
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

describe("BeatPlanner", () => {
  it("模板缺失时构造失败，错误信息带路径", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-planner-"));
    const missing = join(tmp, "nope.txt");
    expect(() => new BeatPlanner({ generate: async () => "" } as never, missing)).toThrow(/Beat 规划模板读取失败/);
  });

  it("Planning Prompt 包含全部 StoryConfig 字段，无残留占位符", () => {
    const planner = new BeatPlanner({ generate: async () => "" } as never);
    const prompt = planner.buildPlanningPrompt(config);
    expect(prompt).toContain("消失的目击者");
    expect(prompt).toContain("悬疑");
    expect(prompt).toContain("唯一证人在出庭前一天突然消失。");
    expect(prompt).toContain("庭审前夜");
    expect(prompt).toContain("陈岚");
    expect(prompt).toContain("履行保护责任");
    expect(prompt).toContain("证人缺席将导致案件失败");
    expect(prompt).toContain("5000");
    expect(prompt).toContain("6~12");
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("可选字段为空 → 未指定 占位，不输出 undefined/null", () => {
    const minimal: StoryConfig = validateStoryConfig({
      title: "空白", genre: "散文", premise: "一个人回家。", target_words: 3000,
    });
    const prompt = new BeatPlanner({ generate: async () => "" } as never).buildPlanningPrompt(minimal);
    expect(prompt).toContain("未指定");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  it("plan()：假 LLM 返回 JSON → 解析成 BeatPlan，默认 temperature 0.7", async () => {
    const llm = spyLLM(planJson);
    const planner = new BeatPlanner(llm as never);
    const plan: BeatPlan = await planner.plan(config);
    expect(validateBeatPlan(plan)).toEqual(plan);
    expect(plan.beats).toHaveLength(2);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].temperature).toBe(0.7);
    expect(llm.calls[0].system).toContain("只输出 JSON");
  });

  it("plan()：可覆盖 temperature", async () => {
    const llm = spyLLM(planJson);
    await new BeatPlanner(llm as never).plan(config, 0.2);
    expect(llm.calls[0].temperature).toBe(0.2);
  });

  it("plan()：LLM 输出非法 JSON → BeatParseError（§13 不自动重试）", async () => {
    const llm = { generate: async () => { throw new BeatParseError("Planner 输出不是合法 JSON"); } };
    await expect(new BeatPlanner(llm as never).plan(config)).rejects.toThrow(BeatParseError);
  });

  it("plan()：LLM 调用失败 → LLMError 透传", async () => {
    const llm = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
    await expect(new BeatPlanner(llm as never).plan(config)).rejects.toThrow(/401/);
  });
});
