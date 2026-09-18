import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleGenerate } from "@/lib/generate-service";
import { LLMError } from "@/lib/llm";
import { PromptBuilder } from "@/lib/prompt-builder";
import { buildRequestPayload } from "@/types/story-request";

const fakeLLM = { generate: async (prompt: string) => `收到 Prompt（长度 ${prompt.length}）。# 故事正文` };
const failLLM = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
const builder = new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));

const structuredRequest = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要超自然元素。",
};

let tmp: string | null = null;
afterEach(() => {
  process.chdir(process.env.INIT_CWD ?? "D:/test/zhihu/repo");
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

describe("POST /api/generate（结构化请求）", () => {
  it("structured request → PromptBuilder → Mock LLM → 200", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-api-"));
    process.chdir(tmp);
    const r = await handleGenerate(structuredRequest, fakeLLM as never, builder);
    expect(r.status).toBe(200);
    const ok = r.json as { title: string; content: string; model: string; created_at: string; request: { genre: string; target_words: number } };
    expect(ok.title).toBe("消失的目击者");
    expect(ok.content).toBeTruthy();
    expect(ok.request.genre).toBe("悬疑");
    expect(ok.request.target_words).toBe(5000);
  });

  it("§57 API 不再自己拼 Prompt，必须经过 PromptBuilder（校验走的是 builder 的输出）", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-api-"));
    process.chdir(tmp);
    let captured = "";
    const spyLLM = { generate: async (p: string) => { captured = p; return "正文"; } };
    await handleGenerate(structuredRequest, spyLLM as never, builder);
    // 若 API 直接拼 JSON，captured 不会包含模板的【题材】段落
    expect(captured).toContain("【题材】");
    expect(captured).toContain("【核心设定】");
  });

  it("§26 legacy {title, prompt} 兼容：prompt 映射为 premise", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-api-"));
    process.chdir(tmp);
    const r = await handleGenerate({ title: "旧版请求", prompt: "旧版自由文本需求。" }, fakeLLM as never, builder);
    expect(r.status).toBe(200);
    expect((r.json as { request: { genre: string } }).request.genre).toBe("其他");
  });

  it("400：invalid target_words（Case D 后端侧）", async () => {
    const r = await handleGenerate({ ...structuredRequest, target_words: -1 }, fakeLLM as never, builder);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("目标字数");
  });

  it("502：LLM 出错", async () => {
    const r = await handleGenerate(structuredRequest, failLLM as never, builder);
    expect(r.status).toBe(502);
  });
});

describe("§59 buildRequestPayload（前端提交 JSON 纯函数）", () => {
  it("完整表单 → 正确 JSON", () => {
    const r = buildRequestPayload({
      title: "消失的目击者", genre: "悬疑", customGenre: "",
      premise: "唯一证人在出庭前一天突然失踪。", targetWords: 5000,
      style: "冷峻", extraRequirements: "无超自然元素",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        title: "消失的目击者",
        genre: "悬疑",
        premise: "唯一证人在出庭前一天突然失踪。",
        target_words: 5000,
        style: "冷峻",
        extra_requirements: "无超自然元素",
      });
    }
  });

  it("Case C：其他题材 → customGenre 生效", () => {
    const r = buildRequestPayload({
      title: "t", genre: "其他", customGenre: "黑色幽默荒诞职场",
      premise: "p", targetWords: 5000, style: "", extraRequirements: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.genre).toBe("黑色幽默荒诞职场");
  });

  it("Case D：targetWords = -1 被前端拦截", () => {
    const r = buildRequestPayload({
      title: "t", genre: "悬疑", customGenre: "", premise: "p",
      targetWords: -1, style: "", extraRequirements: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("目标字数");
  });

  it("Case E：空可选字段不出现在 payload", () => {
    const r = buildRequestPayload({
      title: "t", genre: "悬疑", customGenre: "", premise: "p",
      targetWords: 5000, style: "", extraRequirements: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("style" in r.payload).toBe(false);
      expect("extra_requirements" in r.payload).toBe(false);
      expect(JSON.stringify(r.payload)).not.toMatch(/undefined|null/i);
    }
  });

  it("保存的 Markdown 包含 metadata blockquote（§42）", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-api-"));
    process.chdir(tmp);
    const r = await handleGenerate(structuredRequest, fakeLLM as never, builder);
    if (r.status === 200) {
      const md = readFileSync((r.json as { saved_to: string }).saved_to, "utf8");
      expect(md).toContain("> Genre: 悬疑");
      expect(md).toContain("> Target Words: 5000");
    }
    const json = readFileSync((r.json as { metadata_to: string }).metadata_to, "utf8");
    const meta = JSON.parse(json);
    expect(meta.model).toBeTruthy();
    expect(meta.target_words).toBe(5000);
  });
});
