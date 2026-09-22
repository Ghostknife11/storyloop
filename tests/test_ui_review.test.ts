import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewStory } from "@/lib/api";
import { formatScore, reviewPanelState } from "@/lib/review-view";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import type { ReviewResult } from "@/types/review-result";

/**
 * v0.5.0 Review UI 契约（§31~§34/§47）：
 * Review Again 只重新审阅当前正文（§50），Review 失败不丢正文（§34）。
 * 浏览器渲染逻辑（面板 / 分数 / 列表）跑在 React 里，这里覆盖它依赖的
 * API 客户端函数与纯状态推导函数。
 */

const config: StoryConfig = validateStoryConfig({
  config_version: STORY_CONFIG_VERSION,
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
});

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Review Again：reviewStory（§29/§47）", () => {
  it("请求携带 config 与 story，并原样进入请求体", async () => {
    const fetchMock = stubJson(review);
    const r = await reviewStory(config, "正文——陈岚走进雨夜。", { model: "m", temperature: 0.8 });
    expect(r).toEqual(review);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/review");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.config).toMatchObject({ title: config.title, premise: config.premise });
    expect(body.story).toBe("正文——陈岚走进雨夜。");
    expect(body.temperature).toBe(0.8);
  });

  it("§30 带 runId 时服务端覆盖该 Run 的 review.json", async () => {
    const fetchMock = stubJson(review);
    await reviewStory(config, "正文", {}, "20260921_101500_ab12cd");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.run_id).toBe("20260921_101500_ab12cd");
  });

  it("不带 runId 时不发送 run_id 字段", async () => {
    const fetchMock = stubJson(review);
    await reviewStory(config, "正文");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("run_id");
  });

  it("§15 Reviewer 返回非法 JSON（502）→ 抛出可读错误，不自动重试", async () => {
    stubJson({ error: { code: "REVIEW_FAILED", message: "Review failed. 原因：Reviewer 输出不是合法 JSON" } }, false, 502);
    await expect(reviewStory(config, "正文", {})).rejects.toThrow(/Reviewer 输出不是合法 JSON/);
  });

  it("§29 story 缺失（400）→ 抛出明确错误", async () => {
    stubJson({ error: { code: "CONFIG_INVALID", message: "story is required——提供需要审阅的小说正文" } }, false, 400);
    await expect(reviewStory(config, "正文", {})).rejects.toThrow(/story is required/);
  });
});

describe("formatScore（§32）", () => {
  it("只渲染「74 / 100」，不做 PASS / FAIL / 等级", () => {
    expect(formatScore(74)).toBe("74");
    expect(formatScore(0)).toBe("0");
    expect(formatScore(100)).toBe("100");
    expect(formatScore(74.5)).toBe("74.5");
  });
});

describe("reviewPanelState（§31/§34/§47）", () => {
  it("ready：分数 / 总结 / 优点 / 问题全部可渲染", () => {
    const state = reviewPanelState({ review, reviewStatus: "completed" });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.scoreText).toBe("74");
    expect(state.summary).toContain("故事整体完整");
    expect(state.strengths).toHaveLength(2);
    expect(state.problems).toHaveLength(2);
  });

  it("loading：重新审阅中显示加载态", () => {
    const state = reviewPanelState({ review, reviewStatus: "completed", reReviewing: true });
    expect(state.kind).toBe("loading");
  });

  it("failed：Review 失败只是面板失败，Story 仍可用（§34）", () => {
    const state = reviewPanelState({
      review: null,
      reviewStatus: "failed",
      reviewError: "Reviewer 输出不是合法 JSON",
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.error).toContain("不是合法 JSON");
  });

  it("failed 且没有错误信息时给出兜底文案", () => {
    const state = reviewPanelState({ review: null, reviewStatus: "failed" });
    expect(state).toEqual({ kind: "failed", error: "Reviewer 未返回有效评价" });
  });

  it("hidden：没有评价且未失败时不渲染面板", () => {
    expect(reviewPanelState({ review: null, reviewStatus: "not_started" })).toEqual({ kind: "hidden" });
  });

  it("重新审阅成功后面板回到 ready（review 覆盖旧的失败态）", () => {
    const state = reviewPanelState({ review, reviewStatus: "completed", reviewError: "上一次失败" });
    expect(state.kind).toBe("ready");
  });
});
