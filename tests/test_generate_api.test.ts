import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateStory, handleGenerate } from "@/lib/generate-service";
import { LLMError } from "@/lib/llm";

const fakeLLM = { generate: async () => "# 消失的目击者\n\n正文……" };
const failLLM = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };

const realCwd = process.cwd();
let tmp: string | null = null;

afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-test-"));
  process.chdir(tmp);
  return tmp;
}

describe("generateStory", () => {
  it("返回 title/content/model/created_at 并保存 Markdown", async () => {
    const dir = withTmpDir();
    const r = await generateStory(
      { title: "消失的目击者", prompt: "写一篇都市悬疑短篇小说。" },
      fakeLLM as never,
    );
    expect(r.title).toBe("消失的目击者");
    expect(r.content).toContain("消失的目击者");
    expect(typeof r.model).toBe("string");
    expect(typeof r.created_at).toBe("string");
    expect(existsSync(r.saved_to)).toBe(true);
    expect(r.saved_to.startsWith(dir)).toBe(true);
    expect(readFileSync(r.saved_to, "utf8")).toContain("# 消失的目击者");
  });
});

describe("handleGenerate（API 适配层）", () => {
  it("200：正常返回字段", async () => {
    withTmpDir();
    const r = await handleGenerate({ title: "标题", prompt: "需求" }, fakeLLM as never);
    expect(r.status).toBe(200);
    const ok = r.json as { title: string; content: string; created_at: string };
    expect(ok.title).toBe("标题");
    expect(ok.content).toBeTruthy();
    expect(ok.created_at).toBeTruthy();
  });

  it("400：空标题", async () => {
    const r = await handleGenerate({ title: "", prompt: "需求" }, fakeLLM as never);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("标题");
  });

  it("400：空 Prompt", async () => {
    const r = await handleGenerate({ title: "标题", prompt: " " }, fakeLLM as never);
    expect(r.status).toBe(400);
  });

  it("502：LLM 出错时返回可读错误", async () => {
    const r = await handleGenerate({ title: "标题", prompt: "需求" }, failLLM as never);
    expect(r.status).toBe(502);
    expect((r.json as { error: string }).error).toContain("401");
  });

  it("400：请求体为 null", async () => {
    const r = await handleGenerate(null, fakeLLM as never);
    expect(r.status).toBe(400);
  });
});
