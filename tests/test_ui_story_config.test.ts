import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configFilename,
  parseStoryConfig,
  serializeStoryConfig,
} from "@/lib/config-io";
import { generateStory, previewPrompt } from "@/lib/api";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";

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
  it("generateStory 把序列化后的 Config 原样 POST（运行参数单独传递）", async () => {
    const loaded = parseStoryConfig(serializeStoryConfig(sample));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        title: loaded.title,
        content: "正文",
        model: "gpt-4o-mini",
        created_at: "2026-09-19T14:54:00.000Z",
        saved_to: "outputs/x.md",
        config_to: "outputs/x.json",
        metadata_to: "outputs/x.meta.json",
        request: { genre: loaded.genre, target_words: loaded.target_words },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await generateStory(loaded, { model: "m", temperature: 0.5 });
    expect(r.title).toBe("消失的目击者");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/generate");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.title).toBe(loaded.title);
    expect(body.premise).toBe(loaded.premise);
    expect(body.target_words).toBe(loaded.target_words);
    expect(body.model).toBe("m");
    expect(body.temperature).toBe(0.5);
    expect(body).not.toHaveProperty("config_version", undefined);
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
