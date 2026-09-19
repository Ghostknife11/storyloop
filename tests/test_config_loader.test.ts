import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configFilename,
  parseStoryConfig,
  serializeStoryConfig,
  ConfigLoadError,
} from "@/lib/config-io";
import { UnsupportedConfigVersionError } from "@/types/story-config";

const config = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  setting: "现代中国一线城市，商业贿赂案件进入庭审前夜。",
  protagonist: { name: "陈岚", identity: "刑警", goal: "在开庭前找到证人", motivation: "她负责证人的保护工作" },
  conflict: "证人的失踪可能与案件核心嫌疑人有关。",
  stakes: "证人缺席可能导致案件失败。",
  ending: "失踪是证人主动设计的反击。",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要超自然元素。",
};

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

describe("config serialize / parse（§18 Round-trip）", () => {
  it("save → load → 关键字段一致（§78 round-trip）", () => {
    const text = serializeStoryConfig(config as never);
    const loaded = parseStoryConfig(text);
    expect(loaded).toEqual(config);
  });

  it("§83 中文 UTF-8 round-trip 无乱码", () => {
    const text = serializeStoryConfig(config as never);
    expect(text).toContain("消失的目击者");
    expect(text).toContain("陈岚");
    expect(text).toContain("庭审前夜");
    const loaded = parseStoryConfig(text);
    expect(loaded.protagonist?.name).toBe("陈岚");
    expect(loaded.premise).toContain("突然消失");
  });

  it("§47 保存文件名：sanitized_title.story.json", () => {
    expect(configFilename("消失的目击者")).toBe("消失的目击者.story.json");
    expect(configFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j.story.json");
  });
});

describe("parseStoryConfig 错误处理（§27/§62）", () => {
  it("invalid JSON → ConfigLoadError", () => {
    expect(() => parseStoryConfig("{ not json")).toThrow(ConfigLoadError);
  });

  it("§87 target_words 类型错误 → ConfigValidationError，不部分加载", () => {
    expect(() => parseStoryConfig(JSON.stringify({ ...config, target_words: "abc" }))).toThrow(/整数/);
  });

  it("unsupported version → UnsupportedConfigVersionError", () => {
    expect(() => parseStoryConfig(JSON.stringify({ ...config, config_version: "99" }))).toThrow(UnsupportedConfigVersionError);
  });

  it("missing file 由调用方读取时抛错（CLI 路径）", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-cfg-"));
    const missing = join(tmp, "missing.story.json");
    expect(() => readFileSync(missing, "utf8")).toThrow();
  });

  it("example_story.json 是真实可运行的完整配置（§22）", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-cfg-"));
    void tmp;
    const example = parseStoryConfig(
      // 直接读取仓库内的 example（相对测试运行目录 repo/）
      // vitest cwd = repo/
      // eslint-disable-next-line
      readFileSync("configs/example_story.json", "utf8"),
    );
    expect(example.title).toBe("消失的目击者");
    expect(example.protagonist?.name).toBe("陈岚");
    expect(example.target_words).toBe(5000);
  });
});
