import { describe, expect, it } from "vitest";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  UnsupportedConfigVersionError,
} from "@/types/story-config";

const valid = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
};

describe("validateStoryConfig", () => {
  it("valid config accepted（缺省 config_version 自动补 1）", () => {
    const c = validateStoryConfig({ ...valid, config_version: undefined });
    expect(c.config_version).toBe(STORY_CONFIG_VERSION);
    expect(c.title).toBe("消失的目击者");
  });

  it("required field missing rejected", () => {
    expect(() => validateStoryConfig({ ...valid, title: "" })).toThrow(/标题/);
    expect(() => validateStoryConfig({ ...valid, genre: "" })).toThrow(/题材/);
    expect(() => validateStoryRequestPremise());
    function validateStoryRequestPremise() {
      expect(() => validateStoryConfig({ ...valid, premise: " " })).toThrow(/premise/);
    }
  });

  it("optional fields accepted", () => {
    const c = validateStoryConfig({
      ...valid,
      setting: "现代一线城市",
      conflict: "证人失踪与嫌疑人有关。",
      stakes: "案件将失败。",
      ending: "证人主动设计的反击。",
      style: "冷峻",
      extra_requirements: "不要超自然元素。",
    });
    expect(c.setting).toBe("现代一线城市");
    expect(c.conflict).toBe("证人失踪与嫌疑人有关。");
    expect(c.stakes).toBe("案件将失败。");
    expect(c.ending).toBe("证人主动设计的反击。");
    expect(c.style).toBe("冷峻");
  });

  it("protagonist accepted", () => {
    const c = validateStoryConfig({
      ...valid,
      protagonist: { name: "陈岚", identity: "刑警", goal: "找到证人", motivation: "履行保护责任" },
    });
    expect(c.protagonist?.name).toBe("陈岚");
    expect(c.protagonist?.identity).toBe("刑警");
  });

  it("invalid protagonist rejected（缺 name）", () => {
    expect(() => validateStoryConfig({ ...valid, protagonist: { identity: "刑警" } })).toThrow(/protagonist\.name/);
    expect(() => validateStoryConfig({ ...valid, protagonist: "陈岚" })).toThrow(/对象/);
  });

  it("invalid target_words rejected", () => {
    expect(() => validateStoryConfig({ ...valid, target_words: -1 })).toThrow(/目标字数/);
    expect(() => validateStoryConfig({ ...valid, target_words: "abc" })).toThrow(/整数/);
    expect(() => validateStoryConfig({ ...valid, target_words: 30001 })).toThrow(/目标字数/);
  });

  it("unknown config_version rejected", () => {
    expect(() => validateStoryConfig({ ...valid, config_version: "99" })).toThrow(UnsupportedConfigVersionError);
  });

  it("title over 120 chars rejected", () => {
    expect(() => validateStoryConfig({ ...valid, title: "长".repeat(121) })).toThrow(/120/);
  });
});
