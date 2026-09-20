import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configFilename,
  parseStoryConfig,
  serializeStoryConfig,
} from "@/lib/config-io";
import { generateFromPlan, planStory, previewPrompt } from "@/lib/api";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/** v0.2.0 UI 层 StoryConfig 存取覆盖：Save/Load 处理器与生成请求走的是同一批函数。 */

const sample: StoryConfig = validateStoryConfig({
  config_version: STORY_CONFIG_VERSION,
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  setting: "南方多雨的港口城市",
  protagonist: { name: "林砚", identity: "刑警", goal: "保住证人", motivation: "赎罪" },
  conflict: "保护行动内部有人泄密",
  stakes: "证人死亡，线索彻底断掉",
  ending: "证人活下来，但林砚离职",
  target_words: 5000,
  style: "克制冷峻",
  extra_requirements: "不要超自然元素。",
});

/** v0.3.0 起生成请求必须携带 BeatPlan：这里用一份合法骨架做契约样本。 */
const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["林砚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["林砚"] },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Save：表单 → StoryConfig → JSON 文本", () => {
  it("serializeStoryConfig 输出可读 JSON 且 round-trip 后等价", () => {
    const text = serializeStoryConfig(sample);
    expect(text).toContain('"config_version": "1"');
    expect(text).toContain('"title": "消失的目击者"');
    expect(parseStoryConfig(text)).toEqual(sample);
  });

  it("保存文件名 sanitized_title.story.json，且不含路径分隔符", () => {
    expect(configFilename("消失的目击者")).toBe("消失的目击者.story.json");
    const nasty = configFilename('../../etc/passwd"?:*|<>');
    expect(nasty).not.toMatch(/[/\\:*?"<>|]/);
    expect(nasty.endsWith(".story.json")).toBe(true);
    expect(configFilename("   ")).toBe("untitled.story.json");
  });
});

describe("Load：JSON 文本 → StoryConfig（原子，失败即整体拒绝）", () => {
  it("合法文本完整还原", () => {
    expect(parseStoryConfig(serializeStoryConfig(sample))).toEqual(sample);
  });

  it("坏 JSON 抛 ConfigLoadError 且不返回半成品", () => {
    expect(() => parseStoryConfig("{ not json")).toThrow(/JSON 解析失败/);
  });

  it("缺必填字段抛 ConfigValidationError", () => {
    const broken = JSON.parse(serializeStoryConfig(sample)) as Record<string, unknown>;
    delete broken.premise;
    expect(() => parseStoryConfig(JSON.stringify(broken))).toThrow(/premise/);
  });

  it("不支持的 config_version 抛 UnsupportedConfigVersionError", () => {
    const future = JSON.parse(serializeStoryConfig(sample)) as Record<string, unknown>;
    future.config_version = "999";
    expect(() => parseStoryConfig(JSON.stringify(future))).toThrow(/不支持的 config_version/);
  });
});

describe("UI → API 契约：存取后的 StoryConfig 原样进入生成请求", () => {
  it("generateFromPlan 把序列化后的 Config 原样 POST /api/runs/from-plan（运行参数单独传递）", async () => {
    const loaded = parseStoryConfig(serializeStoryConfig(sample));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        run_id: "20260920_101500_ab12cd",
        status: "completed",
        story: "正文",
        beat_plan: plan,
        artifacts: { config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await generateFromPlan(loaded, plan, { model: "m", temperature: 0.5 });
    expect(r.run_id).toBe("20260920_101500_ab12cd");
    expect(r.story).toBe("正文");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/runs/from-plan");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const sent = body.config as Record<string, unknown>;
    expect(sent.title).toBe(loaded.title);
    expect(sent.premise).toBe(loaded.premise);
    expect(sent.target_words).toBe(loaded.target_words);
    expect(body.beat_plan).toEqual(plan);
    expect(body.model).toBe("m");
    expect(body.temperature).toBe(0.5);
  });

  it("planStory 把 StoryConfig 原样 POST /api/plan 并解析出 BeatPlan", async () => {
    const loaded = parseStoryConfig(serializeStoryConfig(sample));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => plan,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await planStory(loaded, { temperature: 0.7 });
    expect(r).toEqual(plan);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.title).toBe(loaded.title);
    expect(body.premise).toBe(loaded.premise);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty("beat_plan");
  });

  it("previewPrompt 发送 Config，失败时抛出可读错误", async () => {
    const loaded = parseStoryConfig(serializeStoryConfig(sample));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "标题不能为空" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(previewPrompt(loaded)).rejects.toThrow("标题不能为空");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/prompt/preview");
  });
});
