import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  STORY_CONFIG_VERSION,
  SUPPORTED_CONFIG_VERSIONS,
  TARGET_WORDS_DEFAULT,
  TARGET_WORDS_MAX,
  TARGET_WORDS_MIN,
  TITLE_MAX,
  UnsupportedConfigVersionError,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.0.0 合同测试：StoryConfig v1 schema 冻结（TASK §4/§5/§22/§49）。
 *
 * 与 test_story_config.test.ts 的分工：那份测「校验规则怎么判」，
 * 这份测「schema 本身不许变」。字段集、必填性、默认值、版本号、示例配置
 * 都在这里钉死——1.x 若要删字段、改语义、改名，必须先看到这里红。
 */

/** v1.0.0 冻结的 StoryConfig 字段全集，含必填性。 */
const FROZEN_FIELDS = {
  required: ["config_version", "title", "genre", "premise", "target_words"],
  optional: ["setting", "protagonist", "conflict", "stakes", "ending", "style", "extra_requirements"],
} as const;

/** protagonist 子字段：只允许这四个，name 必填。 */
const FROZEN_PROTAGONIST = {
  required: ["name"],
  optional: ["identity", "goal", "motivation"],
} as const;

/** 一个填满所有可选字段的合法配置，用于字段集断言。 */
function fullConfig() {
  return validateStoryConfig({
    config_version: "1",
    title: "消失的目击者",
    genre: "悬疑",
    premise: "唯一证人在出庭前一天突然消失。",
    setting: "现代中国一线城市。",
    protagonist: { name: "陈岚", identity: "刑警", goal: "找到证人", motivation: "她负责保护工作" },
    conflict: "失踪与核心嫌疑人有关。",
    stakes: "证人无法出庭则案件失败。",
    ending: "失踪是证人主动设计的反击。",
    target_words: 5000,
    style: "冷峻、节奏紧凑",
    extra_requirements: "不要超自然元素。",
  });
}

describe("v1.0.0 StoryConfig v1 freeze — 版本与字段集", () => {
  it("config_version 冻结为 1，且只有这一个受支持版本", () => {
    expect(STORY_CONFIG_VERSION).toBe("1");
    expect(SUPPORTED_CONFIG_VERSIONS).toEqual(["1"]);
  });

  it("填满可选字段的对象，键集恰好是冻结的全集（不多不少）", () => {
    const config = fullConfig();
    const keys = Object.keys(config).sort();
    expect(keys).toEqual([...FROZEN_FIELDS.required, ...FROZEN_FIELDS.optional].sort());
  });

  it("protagonist 键集同样被冻结：name 必填，另三个可选", () => {
    const config = fullConfig();
    expect(config.protagonist).toBeDefined();
    expect(Object.keys(config.protagonist as object).sort()).toEqual(
      [...FROZEN_PROTAGONIST.required, ...FROZEN_PROTAGONIST.optional].sort(),
    );
  });

  it("省略全部可选字段时只保留必填字段，不会有 undefined 占位键", () => {
    const config = validateStoryConfig({
      title: "标题",
      genre: "悬疑",
      premise: "一句话核心设定。",
      target_words: 3000,
    });
    expect(Object.keys(config).sort()).toEqual(["config_version", "genre", "premise", "target_words", "title"]);
    // config_version 缺省即当前版本，不要求调用方显式提供
    expect(config.config_version).toBe("1");
  });

  it("输入里的未知字段不会存活到输出（schema 是封闭的）", () => {
    const config = validateStoryConfig({
      title: "标题",
      genre: "悬疑",
      premise: "一句话核心设定。",
      target_words: 3000,
      future_dimension: "多维评分",
      causal_graph: { nodes: [] },
    }) as unknown as Record<string, unknown>;
    expect(config.future_dimension).toBeUndefined();
    expect(config.causal_graph).toBeUndefined();
  });
});

describe("v1.0.0 StoryConfig v1 freeze — 默认值与边界", () => {
  it("target_words 缺省建议值 5000，边界 500 ~ 30000，标题上限 120", () => {
    expect(TARGET_WORDS_DEFAULT).toBe(5000);
    expect(TARGET_WORDS_MIN).toBe(500);
    expect(TARGET_WORDS_MAX).toBe(30000);
    expect(TITLE_MAX).toBe(120);
  });

  it("边界值合法：500 与 30000 都收", () => {
    expect(validateStoryConfig({ title: "t", genre: "g", premise: "p", target_words: 500 }).target_words).toBe(500);
    expect(validateStoryConfig({ title: "t", genre: "g", premise: "p", target_words: 30000 }).target_words).toBe(30000);
  });

  it("config_version 不是受支持版本 → UnsupportedConfigVersionError（不是普通 CONFIG_INVALID）", () => {
    expect(() => validateStoryConfig({ config_version: "2", title: "t", genre: "g", premise: "p", target_words: 5000 }))
      .toThrow(UnsupportedConfigVersionError);
    expect(() => validateStoryConfig({ config_version: "2", title: "t", genre: "g", premise: "p", target_words: 5000 }))
      .not.toThrow(ConfigValidationError);
  });

  it("校验是幂等的：对同一份校验结果再跑一遍，输出逐字节稳定", () => {
    const once = fullConfig();
    const twice = validateStoryConfig(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe("v1.0.0 官方示例配置", () => {
  const raw = JSON.parse(
    readFileSync(join(repoRoot(), "configs", "example_story.json"), "utf8"),
  ) as unknown;

  it("configs/example_story.json 存在且能通过 StoryConfig v1 校验", () => {
    expect(() => validateStoryConfig(raw)).not.toThrow();
  });

  it("示例覆盖全部可选字段（读者照抄即可得到完整配置）", () => {
    const config = validateStoryConfig(raw);
    for (const field of FROZEN_FIELDS.optional) {
      expect(config[field as keyof StoryConfig], `示例缺少可选字段 ${field}`).toBeDefined();
    }
  });

  it("示例自带 config_version=1 与建议缺省字数 5000", () => {
    const config = validateStoryConfig(raw);
    expect(config.config_version).toBe("1");
    expect(config.target_words).toBe(TARGET_WORDS_DEFAULT);
  });
});
