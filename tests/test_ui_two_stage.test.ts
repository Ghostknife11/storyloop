import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFromPlan, planStory, previewPrompt, RunApiError } from "@/lib/api";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/**
 * v0.4.0 UI 两阶段契约（§27~§30/§32/§33）：
 * Step 1 Generate Plan → Step 2 Generate Story（Manual Run），中间 BeatPlan 原样传递。
 * 浏览器逻辑（过期标记、手动编辑、Run 进度）跑在 DOM 里，这里覆盖它依赖的同一批 API 客户端函数。
 */

const config: StoryConfig = validateStoryConfig({
  config_version: STORY_CONFIG_VERSION,
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  setting: "南方多雨的港口城市",
  protagonist: { name: "林砚", identity: "刑警", goal: "保住证人" },
  conflict: "保护行动内部有人泄密",
  target_words: 5000,
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  summary: "从失踪到真相",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["林砚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["林砚", "周衡"] },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Step 1：planStory（Generate Plan）", () => {
  it("成功 → 返回 BeatPlan（供 Step 2 与手动编辑使用）", async () => {
    stubJson(plan);
    await expect(planStory(config, { temperature: 0.7 })).resolves.toEqual(plan);
  });

  it("§13 规划失败（502）→ 抛出可读错误，StoryConfig 侧不自动重试", async () => {
    stubJson({ error: { code: "PLANNER_INVALID_OUTPUT", message: "Plan generation failed. 原因：Planner 输出不是合法 JSON" } }, false, 502);
    await expect(planStory(config, {})).rejects.toThrow(/Planner 输出不是合法 JSON/);
  });
});

describe("Step 2：generateFromPlan（Generate Story → Manual Run）", () => {
  it("§29 beat_plan 必须随请求发送，且原样进入请求体", async () => {
    const fetchMock = stubJson({
      run_id: "20260920_101500_ab12cd",
      status: "completed",
      story: "正文",
      beat_plan: plan,
      artifacts: { config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" },
    });

    const r = await generateFromPlan(config, plan, { model: "m", temperature: 0.8 });
    expect(r.run_id).toBe("20260920_101500_ab12cd");
    expect(r.status).toBe("completed");
    expect(r.story).toBe("正文");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/runs/from-plan");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.beat_plan).toEqual(plan);
    expect(body.config).toMatchObject({ title: config.title, premise: config.premise });
    expect(body.temperature).toBe(0.8);
  });

  it("§29 缺 beat_plan 时服务端 400，错误信息指引先规划", async () => {
    stubJson({ error: { code: "CONFIG_INVALID", message: "beat_plan is required——先生成剧情骨架（Generate Plan），再生成正文" } }, false, 400);
    await expect(
      generateFromPlan(config, plan, {}).catch((e: Error) => { throw e; }),
    ).rejects.toThrow(/beat_plan is required/);
  });

  it("生成失败（502）→ 抛出可读错误，并带上 run_id 与 stage（§28）", async () => {
    stubJson({ error: { code: "LLM_REQUEST_FAILED", message: "Run 20260920_101500_ab12cd failed at generating : LLM API 返回 401", run_id: "20260920_101500_ab12cd", stage: "generating" } }, false, 502);
    const err = await generateFromPlan(config, plan, {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).message).toMatch(/401/);
    expect((err as RunApiError).runId).toBe("20260920_101500_ab12cd");
    expect((err as RunApiError).stage).toBe("generating");
  });
});

describe("Prompt Preview（§30）", () => {
  it("有 BeatPlan → 一并发送，预览含 Beat 顺序", async () => {
    const fetchMock = stubJson({ prompt: "…Beat 1…Beat 2…" });
    await expect(previewPrompt(config, plan)).resolves.toContain("Beat 1");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.beat_plan).toEqual(plan);
  });

  it("无 BeatPlan → 只发送 config（占位提示由服务端补）", async () => {
    const fetchMock = stubJson({ prompt: "…（beat_plan 未生成）…" });
    await previewPrompt(config);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("beat_plan");
    expect(body).toMatchObject({ title: config.title });
  });
});
