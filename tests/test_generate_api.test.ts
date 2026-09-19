import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleGenerate } from "@/lib/generate-service";
import { LLMError } from "@/lib/llm";
import { StoryGenerator } from "@/lib/story-generator";
import { serializeStoryConfig } from "@/lib/config-io";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
});

const fakeLLM = { generate: async (p: string) => `正文（prompt 长度 ${p.length}）` };
const failLLM = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
const generator = new StoryGenerator(fakeLLM as never);

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

describe("POST /api/generate（v0.3.0 两阶段）", () => {
  it("链路：{config, beat_plan} → 校验 → StoryGenerator → Mock LLM → 200 四文件", async () => {
    const dir = withTmpDir();
    const r = await handleGenerate({ config, beat_plan: plan }, fakeLLM as never, generator);
    expect(r.status).toBe(200);
    const ok = r.json as {
      title: string; content: string; model: string; created_at: string;
      saved_to: string; config_to: string; beats_to: string; metadata_to: string;
      request: { genre: string; target_words: number; beat_count: number };
    };
    expect(ok.title).toBe("消失的目击者");
    expect(ok.request.genre).toBe("悬疑");
    expect(ok.request.target_words).toBe(5000);
    expect(ok.request.beat_count).toBe(2);
    expect(existsSync(ok.saved_to)).toBe(true);
    expect(existsSync(ok.config_to)).toBe(true);
    expect(existsSync(ok.beats_to)).toBe(true);
    expect(existsSync(ok.metadata_to)).toBe(true);
    expect(JSON.parse(readFileSync(ok.config_to, "utf8")).protagonist?.name).toBe("陈岚");
    expect(JSON.parse(readFileSync(ok.beats_to, "utf8")).beats).toHaveLength(2);
    expect(JSON.parse(readFileSync(ok.metadata_to, "utf8")).project_version).toBe("0.3.0");
    expect(dir).toBeTruthy();
  });

  it("§46 Story Prompt 同时包含 StoryConfig 与 BeatPlan，顺序一致", async () => {
    withTmpDir();
    let captured = "";
    const spyLLM = { generate: async (p: string) => { captured = p; return "正文"; } };
    const spyGen = new StoryGenerator(spyLLM as never);
    await handleGenerate({ config, beat_plan: plan }, undefined, spyGen);
    expect(captured).toContain("消失的目击者");
    expect(captured).toContain("Beat 1");
    expect(captured).toContain("Beat 2");
    expect(captured.indexOf("Beat 1")).toBeLessThan(captured.indexOf("Beat 2"));
  });

  it("§29 missing beat_plan → 400 beat_plan is required", async () => {
    const r = await handleGenerate({ config }, fakeLLM as never, generator);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("beat_plan is required");
  });

  it("§47 invalid beat_plan → 400", async () => {
    const r = await handleGenerate(
      { config, beat_plan: { beat_plan_version: "1", beats: [] } },
      fakeLLM as never, generator,
    );
    expect(r.status).toBe(400);
  });

  it("502：LLM 出错（§53 BeatPlan 语义保留）", async () => {
    withTmpDir();
    const r = await handleGenerate({ config, beat_plan: plan }, failLLM as never);
    expect(r.status).toBe(502);
    expect((r.json as { error: string }).error).toContain("401");
  });

  it("§26 legacy {title, prompt} 无 beat_plan → 400（v0.3.0 起两阶段为必须）", async () => {
    const r = await handleGenerate({ title: "旧版请求", prompt: "旧版自由文本需求。" }, fakeLLM as never, generator);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("beat_plan is required");
  });

  it("Config snapshot round-trip 一致", async () => {
    withTmpDir();
    const r = await handleGenerate({ config, beat_plan: plan }, fakeLLM as never, generator);
    if (r.status === 200) {
      const snapshotText = readFileSync((r.json as { config_to: string }).config_to, "utf8");
      expect(JSON.parse(snapshotText)).toEqual(config);
      expect(serializeStoryConfig(config)).toBe(snapshotText);
    }
  });
});
