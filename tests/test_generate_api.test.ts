import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleGenerate } from "@/lib/generate-service";
import { LLMError } from "@/lib/llm";
import { PromptBuilder } from "@/lib/prompt-builder";
import { serializeStoryConfig } from "@/lib/config-io";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";

const fullConfig: StoryConfig = validateStoryConfig({
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  setting: "现代一线城市，庭审前夜。",
  protagonist: { name: "陈岚", identity: "刑警", goal: "找到证人", motivation: "履行保护责任" },
  conflict: "证人失踪与嫌疑人有关。",
  stakes: "证人缺席将导致案件失败。",
  ending: "证人主动设计了失踪。",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要超自然元素。",
});

const fakeLLM = { generate: async (p: string) => `收到 Prompt（长度 ${p.length}）。# 故事正文` };
const failLLM = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
const builder = new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-api-"));
  process.chdir(tmp);
  return tmp;
}

describe("POST /api/generate（StoryConfig 输入）", () => {
  it("§80 链路：API → StoryConfig validation → PromptBuilder → Mock LLM → 200", async () => {
    const dir = withTmpDir();
    const r = await handleGenerate(fullConfig, fakeLLM as never, builder);
    expect(r.status).toBe(200);
    const ok = r.json as {
      title: string; content: string; model: string; created_at: string;
      saved_to: string; config_to: string; metadata_to: string;
      request: { genre: string; target_words: number };
    };
    expect(ok.title).toBe("消失的目击者");
    expect(ok.request.genre).toBe("悬疑");
    expect(ok.request.target_words).toBe(5000);
    expect(existsSync(ok.saved_to)).toBe(true);
    expect(existsSync(ok.config_to)).toBe(true);
    expect(existsSync(ok.metadata_to)).toBe(true);
    expect(JSON.parse(readFileSync(ok.config_to, "utf8")).protagonist?.name).toBe("陈岚");
    expect(JSON.parse(readFileSync(ok.metadata_to, "utf8")).project_version).toBe("0.2.0");
    expect(dir).toBeTruthy();
  });

  it("§71 Generate 前重新校验：无效 config 被拒绝", async () => {
    const r = await handleGenerate({ ...fullConfig, target_words: -1 }, fakeLLM as never, builder);
    expect(r.status).toBe(400);
  });

  it("§24/§77 unknown config_version 被拒绝", async () => {
    const r = await handleGenerate({ ...fullConfig, config_version: "99" }, fakeLLM as never, builder);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("config_version");
  });

  it("502：LLM 出错", async () => {
    const r = await handleGenerate(fullConfig, failLLM as never, builder);
    expect(r.status).toBe(502);
  });

  it("§26 legacy {title, prompt} 仍兼容", async () => {
    const dir = withTmpDir();
    void dir;
    const r = await handleGenerate({ title: "旧版请求", prompt: "旧版自由文本需求。" }, fakeLLM as never, builder);
    expect(r.status).toBe(200);
    expect((r.json as { request: { genre: string } }).request.genre).toBe("其他");
  });

  it("§26 v0.1.0 请求（无 config_version、无新字段）兼容", async () => {
    const dir = withTmpDir();
    void dir;
    const r = await handleGenerate({
      title: "v0.1 请求", genre: "悬疑", premise: "premise。",
      target_words: 5000, style: "冷峻",
    }, fakeLLM as never, builder);
    expect(r.status).toBe(200);
  });

  it("Config snapshot 与原始 config round-trip 一致（§56/§78）", async () => {
    const dir = withTmpDir();
    void dir;
    const r = await handleGenerate(fullConfig, fakeLLM as never, builder);
    if (r.status === 200) {
      const snapshotText = readFileSync((r.json as { config_to: string }).config_to, "utf8");
      expect(JSON.parse(snapshotText)).toEqual(fullConfig);
      // 序列化层自检
      expect(serializeStoryConfig(fullConfig)).toBe(snapshotText);
    }
  });
});
