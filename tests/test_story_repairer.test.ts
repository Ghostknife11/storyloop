import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPAIR_TEMPERATURE, StoryRepairer } from "@/lib/story-repairer";
import { repairRequestOf, type RepairRequest } from "@/types/repair";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { LLMClient } from "@/lib/llm";

/**
 * §44 StoryRepairer：LLM 必须 Mock（绝不打真实付费 API）。
 * §44 要求 Prompt 至少包含 StoryConfig / BeatPlan / Issue Type / Issue Message / Existing Story。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
});

const STORY = "陈岚走进雨夜，故事在这里断了。";

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** 假 LLM：记录 prompt / 温度 / system，返回编排好的结果或抛错。 */
function fakeLLM(reply: string | (() => never)) {
  const calls: Array<{ prompt: string; temperature: number; system?: string }> = [];
  const llm = {
    generate: async (prompt: string, temperature: number, system?: string) => {
      calls.push({ prompt, temperature, system });
      if (typeof reply === "function") return reply();
      return reply;
    },
  };
  return { llm: llm as unknown as LLMClient, calls };
}

function withTemplateDir(body: string) {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-repairer-"));
  process.chdir(tmp);
  writeFileSync(join(tmp, "repair.txt"), body, "utf8");
  return tmp;
}

describe("§44 Prompt 内容", () => {
  it("至少包含 StoryConfig / BeatPlan / Issue Type / Issue Message / Existing Story", async () => {
    withTemplateDir("{{story_config}}\n{{beat_plan}}\n{{issue_type}}\n{{issue_message}}\n{{story}}");
    const { llm, calls } = fakeLLM("修订后的正文。");
    const repairer = new StoryRepairer(llm, join(process.cwd(), "repair.txt"));
    const request2 = repairRequestOf(
      { issue_type: "ending", issue_message: "故事缺少明确结局" },
      STORY,
      config,
      plan,
    );
    await repairer.repair(request2);

    expect(calls).toHaveLength(1);
    const prompt = calls[0].prompt;
    expect(prompt).toContain("消失的目击者");
    expect(prompt).toContain("悬疑");
    expect(prompt).toContain("唯一证人在出庭前一天突然消失。");
    expect(prompt).toContain("Beat 1");
    expect(prompt).toContain("对峙揭相。");
    expect(prompt).toContain("ending");
    expect(prompt).toContain("故事缺少明确结局");
    expect(prompt).toContain(STORY);
    // §10：模板是独立 repair.txt，不是 story.txt 加 flag
    expect(prompt).not.toContain("{{");
  });

  it("config 未填字段渲染成占位文本，不出现 undefined", async () => {
    withTemplateDir("{{story_config}}");
    const { llm, calls } = fakeLLM("正文。");
    const repairer = new StoryRepairer(llm, join(process.cwd(), "repair.txt"));
    await repairer.repair(
      repairRequestOf({ issue_type: "general", issue_message: "整体偏平" }, STORY, config, plan),
    );
    expect(calls[0].prompt).not.toContain("undefined");
    expect(calls[0].prompt).toContain("未指定");
  });

  it("模板里有未支持的占位符 → 直接抛错，不发给模型", async () => {
    withTemplateDir("{{story_config}}\n{{unknown_thing}}");
    const { llm, calls } = fakeLLM("正文。");
    const repairer = new StoryRepairer(llm, join(process.cwd(), "repair.txt"));
    const result = await repairer.repair(
      repairRequestOf({ issue_type: "general", issue_message: "整体偏平" }, STORY, config, plan),
    );
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.notes).toContain("未支持的占位符");
  });

  it("模板读不到 → 构造阶段就失败，不静默降级", () => {
    expect(() => new StoryRepairer(fakeLLM("x").llm, join(tmpdir(), "no-such-repair.txt"))).toThrow(
      /模板读取失败/,
    );
  });
});

describe("§4 repair() 返回值", () => {
  function repairerFor(reply: string | (() => never)) {
    withTemplateDir("{{story_config}}\n{{issue_type}}\n{{issue_message}}\n{{story}}");
    const fake = fakeLLM(reply);
    return {
      calls: fake.calls,
      repairer: new StoryRepairer(fake.llm, join(process.cwd(), "repair.txt")),
    };
  }

  it("成功：返回完整修订后正文 + issue_type + success=true", async () => {
    const { repairer, calls } = repairerFor("修订后的完整正文。");
    const result = await repairer.repair(
      repairRequestOf({ issue_type: "length", issue_message: "正文太短" }, STORY, config, plan),
    );
    expect(result).toEqual({
      repaired_story: "修订后的完整正文。",
      issue_type: "length",
      success: true,
      notes: null,
    });
    // §11：返回完整正文，不是 diff / patch
    expect(result.repaired_story).not.toContain("+");
    expect(calls[0].temperature).toBe(REPAIR_TEMPERATURE);
    expect(calls[0].system).toContain("修订");
  });

  it("§9 职责边界：不修改 story / config / beat_plan，temperature 固定", async () => {
    const { repairer, calls } = repairerFor("修订后的完整正文。");
    const req = repairRequestOf({ issue_type: "ending", issue_message: "缺结尾" }, STORY, config, plan);
    await repairer.repair(req);
    expect(req.story).toBe(STORY);
    expect(req.config).toBe(config);
    expect(req.beat_plan).toBe(plan);
    expect(calls[0].temperature).toBe(0.5);
  });

  it("LLM 抛异常 → success=false， notes 带原因，不把异常抛给调用方", async () => {
    const { repairer } = repairerFor(() => {
      throw new Error("LLM API 返回 500");
    });
    const result = await repairer.repair(
      repairRequestOf({ issue_type: "ending", issue_message: "缺结尾" }, STORY, config, plan),
    );
    expect(result.success).toBe(false);
    expect(result.repaired_story).toBe("");
    expect(result.issue_type).toBe("ending");
    expect(result.notes).toContain("修订失败");
    expect(result.notes).toContain("500");
  });

  it("修订返回空白 → success=false，不算修好", async () => {
    const { repairer } = repairerFor("   \n  ");
    const result = await repairer.repair(
      repairRequestOf({ issue_type: "ending", issue_message: "缺结尾" }, STORY, config, plan),
    );
    expect(result).toEqual({
      repaired_story: "",
      issue_type: "ending",
      success: false,
      notes: "修订结果为空",
    });
  });

  it("§22 没有可修订的正文：不发请求，直接失败", async () => {
    const { repairer, calls } = repairerFor("修订后的正文。");
    const result = await repairer.repair(
      repairRequestOf({ issue_type: "length", issue_message: "太短" }, "   ", config, plan),
    );
    expect(result.success).toBe(false);
    expect(result.notes).toBe("没有可修订的正文");
    expect(calls).toHaveLength(0);
  });
});

describe("BeatPlan 渲染", () => {
  it("beats 逐条渲染，空人物列表不出现空 Characters", () => {
    withTemplateDir("{{beat_plan}}");
    const repairer = new StoryRepairer(fakeLLM("x").llm, join(process.cwd(), "repair.txt"));
    const text = repairer.renderBeatPlan(
      validateBeatPlan({
        beat_plan_version: "1",
        beats: [{ id: 1, purpose: "开场", event: "事件", characters: [] }],
      }),
    );
    expect(text).toContain("Beat 1");
    expect(text).toContain("Characters: 未指定");
  });
});
