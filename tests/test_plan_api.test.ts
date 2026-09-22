import { describe, expect, it } from "vitest";
import { planStory } from "@/lib/generate-service";
import { BeatParseError } from "@/lib/beat-parser";
import { LLMError } from "@/lib/llm";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import { apiErrorOf } from "./helpers/fixtures";

/** §28 POST /api/plan 服务层：StoryConfig → BeatPlanner → BeatPlan。 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
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

/** 直接注入假 BeatPlanner，避免测试碰真实 LLM 与模板。 */
function fakePlanner(out: string | Error, calls?: Array<{ temperature: number }>) {
  return {
    plan: async (_config: StoryConfig, temperature: number) => {
      calls?.push({ temperature });
      if (out instanceof Error) throw out;
      return JSON.parse(out) as BeatPlan;
    },
  };
}

describe("planStory（/api/plan 服务层）", () => {
  it("合法请求 → 200 + 解析后的 BeatPlan", async () => {
    const r = await planStory({ ...config }, undefined, fakePlanner(planJson) as never);
    expect(r.status).toBe(200);
    const plan = r.json as BeatPlan;
    expect(plan.beats).toHaveLength(2);
    expect(plan.beats[0].purpose).toBe("建立危机");
  });

  it("运行时参数透传给 planner（§28 model/baseUrl/temperature）", async () => {
    const calls: Array<{ temperature: number }> = [];
    const r = await planStory(
      { ...config, model: "gpt-4o-mini", temperature: 0.25 },
      undefined,
      fakePlanner(planJson, calls) as never,
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ temperature: 0.25 }]);
  });

  it("未指定 temperature → 默认 0.7", async () => {
    const calls: Array<{ temperature: number }> = [];
    await planStory({ ...config }, undefined, fakePlanner(planJson, calls) as never);
    expect(calls[0].temperature).toBe(0.7);
  });

  it("非法 StoryConfig → 400 且带具体原因", async () => {
    const r = await planStory({ title: "", genre: "悬疑", premise: "有设定。" }, undefined, fakePlanner(planJson) as never);
    expect(r.status).toBe(400);
    expect(apiErrorOf(r.json).message).toContain("标题");
  });

  it("不支持的 config_version → 400", async () => {
    const r = await planStory(
      { ...config, config_version: "999" },
      undefined,
      fakePlanner(planJson) as never,
    );
    expect(r.status).toBe(400);
    expect(apiErrorOf(r.json).message).toContain("config_version");
  });

  it("§26 legacy {title, prompt} → 归一化为 premise 后正常规划", async () => {
    const r = await planStory(
      { title: "旧版请求", prompt: "旧版自由文本需求。" },
      undefined,
      fakePlanner(planJson) as never,
    );
    expect(r.status).toBe(200);
  });

  it("§13 Planner 输出非法 JSON → BeatParseError → 502（不自动重试）", async () => {
    const r = await planStory(
      { ...config },
      undefined,
      fakePlanner(new BeatParseError("Planner 输出不是合法 JSON")) as never,
    );
    expect(r.status).toBe(502);
    expect(apiErrorOf(r.json).code).toBe("PLANNER_INVALID_OUTPUT");
    expect(apiErrorOf(r.json).message).toContain("Plan generation failed");
    expect(apiErrorOf(r.json).message).toContain("不是合法 JSON");
  });

  it("LLM 失败 → LLMError → 502", async () => {
    const r = await planStory(
      { ...config },
      undefined,
      fakePlanner(new LLMError("LLM API 返回 401")) as never,
    );
    expect(r.status).toBe(502);
    expect(apiErrorOf(r.json).code).toBe("LLM_REQUEST_FAILED");
    expect(apiErrorOf(r.json).message).toContain("401");
  });

  it("§2 没有 Pipeline：planStory 只返回 BeatPlan，不含正文字段", async () => {
    const r = await planStory({ ...config }, undefined, fakePlanner(planJson) as never);
    expect(r.json).not.toHaveProperty("content");
    expect(r.json).not.toHaveProperty("saved_to");
  });
});
