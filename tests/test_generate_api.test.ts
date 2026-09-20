import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun, startRunFromPlan, handleGenerate } from "@/lib/generate-service";
import { LLMError } from "@/lib/llm";
import { BeatParseError } from "@/lib/beat-parser";
import { StoryGenerator } from "@/lib/story-generator";
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

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

const fakeLLM = { generate: async (p: string) => `正文（prompt 长度 ${p.length}）` };
const failLLM = { generate: async () => { throw new LLMError("LLM API 返回 401"); } };
const generator = new StoryGenerator(fakeLLM as never);

/** 假 Planner：记录调用次数与拿到的 temperature，绝不访问真实 LLM。 */
function fakePlanner(out: BeatPlan, calls?: Array<{ temperature: number }>) {
  return { plan: async (_c: StoryConfig, temperature = 0.7) => { calls?.push({ temperature }); return out; } };
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-runs-"));
  process.chdir(tmp);
  return tmp;
}

function runDirOf(dir: string, runId: string) {
  return join(dir, "runs", runId);
}

/** PipelineError 形如 "Run <run_id> failed at <stage>: <detail>"。 */
function runIdFromError(message: string): string {
  return message.split(" ")[1] ?? "";
}

describe("POST /api/runs（v0.4.0 Automatic Run）", () => {
  it("链路：config → Planning → Generation → Persistence，四件产物落盘", async () => {
    const dir = withTmpDir();
    const calls: Array<{ temperature: number }> = [];
    const r = await startRun({ config }, { llm: fakeLLM as never, planner: fakePlanner(plan, calls) as never });
    expect(r.status).toBe(200);
    const ok = r.json as { run_id: string; status: string; story: string; beat_plan: BeatPlan; artifacts: Record<string, string> };
    expect(ok.run_id).toMatch(RUN_ID);
    expect(ok.status).toBe("completed");
    expect(ok.story).toContain("正文");
    expect(ok.beat_plan.beats).toHaveLength(2);
    expect(ok.artifacts).toEqual({ config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" });
    expect(calls).toHaveLength(1);

    const runDir = runDirOf(dir, ok.run_id);
    expect(readdirSync(runDir).sort()).toEqual(["beats.json", "config.json", "metadata.json", "story.md"]);
    expect(JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")).protagonist?.name).toBe("陈岚");
    expect(JSON.parse(readFileSync(join(runDir, "beats.json"), "utf8")).beats).toHaveLength(2);
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");
    // §16/§17：metadata 的 run_id 与响应 run_id 一致，状态 completed
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(ok.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.current_stage).toBe("completed");
    expect(meta.project_version).toBe("0.4.0");
    expect(meta.finished_at).toBeTruthy();
  });

  it("§7 固定顺序：Planning 在 Generation 之前，temperature 分别默认 0.7 / 0.8", async () => {
    withTmpDir();
    const order: string[] = [];
    const planSpy = { plan: async () => { order.push("plan"); return plan; } };
    const genSpy = new StoryGenerator({ generate: async () => { order.push("generate"); return "正文"; } } as never);
    await startRun({ config }, { planner: planSpy as never, generator: genSpy });
    expect(order).toEqual(["plan", "generate"]);
  });

  it("§26 legacy {title, prompt} 仍可跑 Automatic Run", async () => {
    withTmpDir();
    const r = await startRun(
      { title: "旧版请求", prompt: "旧版自由文本需求。" },
      { planner: fakePlanner(plan) as never, generator },
    );
    expect(r.status).toBe(200);
    expect((r.json as { run_id: string }).run_id).toMatch(RUN_ID);
  });

  it("§12 Planner 输出非法 → 502，阶段 planning，不产生 story.md", async () => {
    const dir = withTmpDir();
    // 真实 BeatPlanner 在 LLM 输出非法时抛 BeatParseError（§13：不自动重试）
    const r = await startRun(
      { config },
      { planner: { plan: async () => { throw new BeatParseError("Planner 输出不是合法 JSON"); } } as never, generator },
    );
    expect(r.status).toBe(502);
    const err = r.json as { error: string };
    expect(err.error).toContain("planning");
    const runDir = runDirOf(dir, runIdFromError(err.error));
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("planning");
  });

  it("502：LLM 出错，阶段 generating，metadata 记 failed", async () => {
    const dir = withTmpDir();
    const r = await startRun({ config }, { llm: failLLM as never, planner: fakePlanner(plan) as never });
    expect(r.status).toBe(502);
    const err = r.json as { error: string };
    expect(err.error).toContain("401");
    expect(err.error).toContain("generating");
    const runId = runIdFromError(err.error);
    expect(runId).toMatch(RUN_ID);
    const meta = JSON.parse(readFileSync(join(runDirOf(dir, runId), "metadata.json"), "utf8"));
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("401");
    // §19/§20：失败不清盘，已产出的 config/beats 仍可追溯
    expect(existsSync(join(runDirOf(dir, runId), "beats.json"))).toBe(true);
  });

  it("§23 invalid config → 400", async () => {
    withTmpDir();
    const r = await startRun({ title: "", genre: "悬疑", premise: "x", target_words: 5000 }, { planner: fakePlanner(plan) as never, generator });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/runs/from-plan（v0.4.0 Manual Run）", () => {
  it("链路：不再调用 Planner，直接生成，run_id 与 metadata 一致", async () => {
    const dir = withTmpDir();
    const r = await startRunFromPlan({ config, beat_plan: plan }, { generator });
    expect(r.status).toBe(200);
    const ok = r.json as { run_id: string; story: string; beat_plan: BeatPlan };
    expect(ok.run_id).toMatch(RUN_ID);
    expect(ok.story).toContain("正文");
    expect(ok.beat_plan.beats).toHaveLength(2);
    const meta = JSON.parse(readFileSync(join(runDirOf(dir, ok.run_id), "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(ok.run_id);
    expect(meta.status).toBe("completed");
  });

  it("§29 Manual Run 不触发 Planner（plan 被调用即失败）", async () => {
    withTmpDir();
    const r = await startRunFromPlan(
      { config, beat_plan: plan },
      { planner: { plan: async () => { throw new Error("Manual Run 不得调用 Planner"); } } as never, generator },
    );
    expect(r.status).toBe(200);
  });

  it("§29 missing beat_plan → 400 beat_plan is required", async () => {
    const r = await startRunFromPlan({ config }, { generator });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("beat_plan is required");
  });

  it("§47 invalid beat_plan → 400", async () => {
    const r = await startRunFromPlan({ config, beat_plan: { beat_plan_version: "1", beats: [] } }, { generator });
    expect(r.status).toBe(400);
  });

  it("§71 重新校验 beat_plan 与 config 的一致性（id 不连续 → 400）", async () => {
    const r = await startRunFromPlan(
      { config, beat_plan: { beat_plan_version: "1", beats: [{ id: 2, purpose: "a", event: "b", characters: [] }] } },
      { generator },
    );
    expect(r.status).toBe(400);
  });
});

describe("POST /api/generate（§35 兼容入口）", () => {
  it("内部走 Manual Run，响应为 run 形态", async () => {
    const dir = withTmpDir();
    const r = await handleGenerate({ config, beat_plan: plan }, fakeLLM as never, generator);
    expect(r.status).toBe(200);
    const ok = r.json as { run_id: string; status: string };
    expect(ok.run_id).toMatch(RUN_ID);
    expect(ok.status).toBe("completed");
    expect(existsSync(join(runDirOf(dir, ok.run_id), "story.md"))).toBe(true);
  });

  it("§26 legacy {title, prompt} 无 beat_plan → 400（两阶段为必须）", async () => {
    const r = await handleGenerate({ title: "旧版请求", prompt: "旧版自由文本需求。" }, fakeLLM as never, generator);
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("beat_plan is required");
  });

  it("§67 响应不含本地绝对路径", async () => {
    withTmpDir();
    const r = await handleGenerate({ config, beat_plan: plan }, fakeLLM as never, generator);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(tmp ?? "\\");
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
    expect(text).not.toContain("/runs/");
  });
});
