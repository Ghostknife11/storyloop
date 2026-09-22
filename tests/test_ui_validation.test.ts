import { afterEach, describe, expect, it, vi } from "vitest";
import { validateStory } from "@/lib/api";
import { validationPanelState } from "@/lib/validation-view";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";

/**
 * v0.6.0 Validation UI 契约（§28~§30/§43）：
 * Validation 区域与 Review 区域是两个独立面板（§2/§28），
 * Validation Failed 不丢正文、不自动重试（§18/§30/§44E）。
 * 浏览器渲染逻辑（面板 / 通过态 / 失败态 / Issues 列表）跑在 React 里，
 * 这里覆盖它依赖的 API 客户端函数与纯状态推导函数。
 */

const config: StoryConfig = validateStoryConfig({
  config_version: STORY_CONFIG_VERSION,
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const passed: ValidationResult = { passed: true, issues: [] };

const failed: ValidationResult = {
  passed: false,
  issues: [
    { code: "TOO_SHORT", severity: "error", message: "正文长度 12 低于下限 750。" },
    { code: "MISSING_ENDING", severity: "warning", message: "正文结尾不像一个完整收束。" },
  ],
};

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

describe("Validate Again：validateStory（§27/§28）", () => {
  it("请求携带 config 与 story，并原样进入请求体", async () => {
    const fetchMock = stubJson(passed);
    const r = await validateStory(config, "陈岚推开派出所的玻璃门。");
    expect(r).toEqual(passed);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/validate");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.config).toMatchObject({ title: config.title, premise: config.premise });
    expect(body.story).toBe("陈岚推开派出所的玻璃门。");
  });

  it("带 runId 时服务端覆盖该 Run 的 validation.json（§27）", async () => {
    const fetchMock = stubJson(failed);
    await validateStory(config, "正文", "20260921_101500_ab12cd");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.run_id).toBe("20260921_101500_ab12cd");
  });

  it("不带 runId 时不发送 run_id 字段", async () => {
    const fetchMock = stubJson(passed);
    await validateStory(config, "正文");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("run_id");
  });

  it("校验失败（passed=false）仍然返回结果，不抛错——它是一次业务结果（§18/§30）", async () => {
    stubJson(failed);
    const r = await validateStory(config, "太短。");
    expect(r.passed).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["TOO_SHORT", "MISSING_ENDING"]);
  });

  it("请求非法（400）→ 抛出可读错误，不自动重试", async () => {
    stubJson({ error: { code: "CONFIG_INVALID", message: "story is required——提供需要校验的小说正文" } }, false, 400);
    await expect(validateStory(config, "")).rejects.toThrow(/story is required/);
  });

  it("§57 失败响应里不得携带任何修复后的正文字段", async () => {
    const fetchMock = stubJson(failed, false, 400);
    await expect(validateStory(config, "太短。")).rejects.toThrow();
    const raw = JSON.stringify(fetchMock.mock.results[0]?.value);
    expect(raw).not.toContain("fixed_story");
    expect(raw).not.toContain("revised_story");
    expect(raw).not.toContain("patched_story");
  });
});

describe("validationPanelState（§28~§30/§43）", () => {
  it("hidden：没有校验结果且未失败时不渲染面板", () => {
    expect(validationPanelState({ validation: null, validationStatus: "not_started" })).toEqual({
      kind: "hidden",
    });
  });

  it(" validating 中且无结果时不渲染面板（与 review-view 同一套语义，面板只在结果到达后出现）", () => {
    const state = validationPanelState({ validation: null, validationStatus: "validating" });
    expect(state.kind).toBe("hidden");
  });

  it("loading：重新校验优先于已有结果", () => {
    const state = validationPanelState({
      validation: passed,
      validationStatus: "completed",
      revalidating: true,
    });
    expect(state.kind).toBe("loading");
  });
  it("ready：passed + issues 全部可渲染", () => {
    const state = validationPanelState({ validation: passed, validationStatus: "completed" });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.passed).toBe(true);
    expect(state.issues).toEqual([]);
  });

  it("failed 状态：passed=false 且 Issues 提供 Code / Severity / Message", () => {
    const state = validationPanelState({ validation: failed, validationStatus: "completed" });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.passed).toBe(false);
    expect(state.issues).toHaveLength(2);
    expect(state.issues[0]).toEqual({
      code: "TOO_SHORT",
      severity: "error",
      message: "正文长度 12 低于下限 750。",
    });
    expect(state.issues[1]?.severity).toBe("warning");
  });

  it("Validator 自身出错：面板只显示错误，不显示 issues", () => {
    const state = validationPanelState({
      validation: null,
      validationStatus: "failed",
      validationError: "rangeError: rules must not be empty",
    });
    expect(state).toEqual({ kind: "failed", error: "rangeError: rules must not be empty" });
  });

  it("Validator 出错且没有错误信息时给出兜底文案", () => {
    expect(validationPanelState({ validation: null, validationStatus: "failed" })).toEqual({
      kind: "failed",
      error: "Validator 未返回有效校验结果",
    });
  });

  it("§28 重新校验成功后面板回到 ready（覆盖旧的失败态）", () => {
    const state = validationPanelState({
      validation: passed,
      validationStatus: "completed",
      validationError: "上一次失败",
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.passed).toBe(true);
  });
});

describe("§2/§28 Validation 与 Review 严格分离", () => {
  it("校验状态推导不读取任何 Review 字段", () => {
    const withReview = validationPanelState({
      validation: failed,
      validationStatus: "completed",
      review,
      reviewStatus: "completed",
      reviewError: null,
    } as unknown as Parameters<typeof validationPanelState>[0]);
    expect(withReview.kind).toBe("ready");
    if (withReview.kind !== "ready") return;
    expect(withReview.passed).toBe(false);
    expect(withReview).not.toHaveProperty("score");
    expect(withReview).not.toHaveProperty("summary");
  });

  it("Review 的 passed 不存在：校验通过与否来自 validation，不是 score（§2/§59）", () => {
    const highScoreButFailed = validationPanelState({
      validation: failed,
      validationStatus: "completed",
    });
    const lowScoreButPassed = validationPanelState({
      validation: passed,
      validationStatus: "completed",
    });
    expect(highScoreButFailed.kind === "ready" && highScoreButFailed.passed).toBe(false);
    expect(lowScoreButPassed.kind === "ready" && lowScoreButPassed.passed).toBe(true);
  });
});

describe("§30/§44E Validation Failed 后的允许行为", () => {
  it("校验失败时正文与 Review 结果都保持可用（状态推导不丢数据）", () => {
    const validation = validationPanelState({ validation: failed, validationStatus: "completed" });
    const reviewState = {
      story: "陈岚推开派出所的玻璃门。",
      review,
      reviewStatus: "completed",
    };
    // 校验失败只是面板态，正文与审阅结果都不被清空
    expect(validation.kind).toBe("ready");
    expect(reviewState.story).toContain("陈岚");
    expect(reviewState.review.score).toBe(74);
  });

  it("面板状态不含任何自动重试 / 修复语义（§30/§57/§58）", () => {
    const states = [
      validationPanelState({ validation: failed, validationStatus: "completed" }),
      validationPanelState({ validation: null, validationStatus: "failed", validationError: "boom" }),
      validationPanelState({ validation: null, validationStatus: "validating" }),
    ];
    for (const state of states) {
      expect(state).not.toHaveProperty("retry");
      expect(state).not.toHaveProperty("retryable");
      expect(state).not.toHaveProperty("repair");
      expect(state).not.toHaveProperty("fixedStory");
      expect(state).not.toHaveProperty("suggestion");
    }
  });
});
