import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BasicReviewer, REVIEW_TEMPERATURE } from "@/lib/basic-reviewer";
import { ReviewParseError } from "@/lib/review-parser";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import type { LLMClient } from "@/lib/llm";

/**
 * §42 BasicReviewer：StoryConfig + Story → Review Prompt → Mock LLM → ReviewResult。
 * LLM 一律用注入的假客户端，绝不调用真实收费模型。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  setting: "南方多雨的港口城市",
  protagonist: { name: "陈岚", identity: "刑警", goal: "保住证人" },
  conflict: "保护行动内部有人泄密",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
});

const story = "陈岚走进雨夜，码头尽头空无一人。";

interface Call { prompt: string; temperature: number; system?: string }

/** 假 LLM：记录调用参数，返回预设文本。 */
function fakeLLM(out: string, calls: Call[] = []) {
  return {
    generate: async (prompt: string, temperature = 0.8, system?: string) => {
      calls.push({ prompt, temperature, system });
      return out;
    },
  } as unknown as LLMClient;
}

const reviewJson = JSON.stringify({
  score: 74,
  summary: "故事整体完整，主线清楚。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
});

describe("BasicReviewer（§12/§42）", () => {
  it("StoryConfig + Story → Review Prompt → Mock LLM → ReviewResult", async () => {
    const calls: Call[] = [];
    const reviewer = new BasicReviewer(fakeLLM(reviewJson, calls));

    const review = await reviewer.review(config, story);
    expect(review).toEqual({
      score: 74,
      summary: "故事整体完整，主线清楚。",
      strengths: ["开篇冲突建立迅速"],
      problems: ["中段线索重复"],
    });

    expect(calls).toHaveLength(1);
    // §42：Prompt 里同时带着 StoryConfig 与最终正文
    expect(calls[0].prompt).toContain("消失的目击者");
    expect(calls[0].prompt).toContain("唯一证人在出庭前一天突然消失。");
    expect(calls[0].prompt).toContain(story);
    expect(calls[0].prompt).toContain("陈岚");
  });

  it("§26 Reviewer 使用内部较低温度（0.2 ~ 0.5），不跟随生成温度", async () => {
    const calls: Call[] = [];
    const reviewer = new BasicReviewer(fakeLLM(reviewJson, calls));
    await reviewer.review(config, story);
    expect(REVIEW_TEMPERATURE).toBeGreaterThanOrEqual(0.2);
    expect(REVIEW_TEMPERATURE).toBeLessThanOrEqual(0.5);
    expect(calls[0].temperature).toBe(REVIEW_TEMPERATURE);
  });

  it("§25 Reviewer 使用同一个 LLMClient（Writer/Reviewer 同模型，无 Model Router）", async () => {
    const calls: Call[] = [];
    const llm = fakeLLM(reviewJson, calls);
    const reviewer = new BasicReviewer(llm);
    await reviewer.review(config, story);
    // 同一个客户端实例：调用计数递增说明复用，而不是新建第二个客户端
    await reviewer.review(config, story);
    expect(calls).toHaveLength(2);
  });

  it("system 消息声明基础审阅者身份且要求只输出 JSON", async () => {
    const calls: Call[] = [];
    const reviewer = new BasicReviewer(fakeLLM(reviewJson, calls));
    await reviewer.review(config, story);
    expect(calls[0].system).toContain("审阅");
    expect(calls[0].system).toContain("只输出 JSON");
  });

  it("markdown code fence 输出也能解析（§15 轻量清理）", async () => {
    const reviewer = new BasicReviewer(fakeLLM("```json\n" + reviewJson + "\n```"));
    await expect(reviewer.review(config, story)).resolves.toMatchObject({ score: 74 });
  });

  it("§16 Reviewer 输出非法 JSON → 抛错，由调用方决定保留正文", async () => {
    const reviewer = new BasicReviewer(fakeLLM("我觉得这篇故事还行"));
    await expect(reviewer.review(config, story)).rejects.toThrow(ReviewParseError);
  });

  it("§4 Reviewer 只返回评价，不修改正文：返回值里没有 story 字段", async () => {
    const reviewer = new BasicReviewer(fakeLLM(reviewJson));
    const review = (await reviewer.review(config, story)) as unknown as Record<string, unknown>;
    expect(Object.keys(review).sort()).toEqual(["problems", "score", "strengths", "summary"]);
  });

  it("模板缺失时报错清晰（含模板路径）", () => {
    expect(() => new BasicReviewer(fakeLLM(""), "Z:/nope/reviewer.txt")).toThrow(/Review 模板读取失败/);
  });

  it("模板含未支持占位符 → 明确报错（防止静默漏填）", () => {
    const dir = mkdtempSync(join(tmpdir(), "storyloop-reviewer-tpl-"));
    const tpl = join(dir, "reviewer.txt");
    writeFileSync(tpl, "标题 {{title}} · 未知占位符 {{unknown_thing}}", "utf8");
    try {
      const reviewer = new BasicReviewer(fakeLLM(reviewJson), tpl);
      expect(() => reviewer.buildReviewPrompt(config, story)).toThrow(/未支持的占位符/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
