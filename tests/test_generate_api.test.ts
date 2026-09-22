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
import { apiErrorOf, repoVersion } from "./helpers/fixtures";

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

describe("POST /api/runs（v0.6.0 Automatic Run）", () => {
  it("链路：config → Planning → Generation → Save → Validate → Review；Review 失败不拖垮 Run", async () => {
    const dir = withTmpDir();
    const calls: Array<{ temperature: number }> = [];
    const r = await startRun({ config }, { llm: fakeLLM as never, planner: fakePlanner(plan, calls) as never });
    expect(r.status).toBe(200);
    const ok = r.json as {
      run_id: string; status: string; story: string; beat_plan: BeatPlan;
      validation: { passed: boolean; issues: Array<{ code: string }> }; validation_status: string;
      review: unknown; review_status: string; artifacts: Record<string, string>;
      attempt_count: number; selected_attempt: number; quality_status: string;
    };
    expect(ok.run_id).toMatch(RUN_ID);
    expect(ok.status).toBe("completed");
    expect(ok.story).toContain("正文");
    expect(ok.beat_plan.beats).toHaveLength(2);
    // §17/§18：Validate 在 Review 之前，Story 已落盘后才校验
    expect(ok.validation_status).toBe("completed");
    // fakeLLM 的正文极短且不含主角 → Validation 失败，但 Run 仍 completed（§18）
    expect(ok.validation.passed).toBe(false);
    expect(ok.validation.issues.map((i) => i.code)).toContain("TOO_SHORT");
    // fakeLLM 只回正文文本，Reviewer 拿不到合法 JSON → Review 失败，但 Story 仍成功（§28/§46）
    expect(ok.review).toBeNull();
    expect(ok.review_status).toBe("failed");
    expect(ok.artifacts).toEqual({
      config: "config.json",
      beat_plan: "beats.json",
      story: "story.md",
      validation: "validation.json",
      metadata: "metadata.json",
    });
    expect(calls).toHaveLength(1);

    const runDir = runDirOf(dir, ok.run_id);
    // §14/§15：两次校验都不合格 → 默认策略自动重试一次后 exhausted，attempts/ 归档两次正文
    expect(ok.attempt_count).toBe(2);
    expect(ok.quality_status).toBe("exhausted");
    expect(ok.selected_attempt).toBe(2);
    // §8：planner 只规划一次，重试复用 BeatPlan
    expect(calls).toHaveLength(1);
    expect(readdirSync(runDir).sort()).toEqual([
      "attempts", "beats.json", "config.json", "metadata.json", "story.md", "validation.json",
    ]);
    expect(JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")).protagonist?.name).toBe("陈岚");
    expect(JSON.parse(readFileSync(join(runDir, "beats.json"), "utf8")).beats).toHaveLength(2);
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");
    // §16/§17：metadata 的 run_id 与响应 run_id 一致，状态 completed
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(ok.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.current_stage).toBe("completed");
    expect(meta.project_version).toBe(repoVersion());
    // §25：metadata 记录当时生效的策略与 Attempt 结论
    expect(meta.max_attempts).toBe(2);
    expect(meta.min_review_score).toBe(70);
    // §18：Repair 策略同样落 metadata
    expect(meta.enable_repair).toBe(true);
    expect(meta.max_repairs_per_attempt).toBe(1);
    expect(meta.attempt_count).toBe(2);
    expect(meta.selected_attempt).toBe(2);
    expect(meta.quality_status).toBe("exhausted");
    // §24：Validation 失败只记录，不改变 Run 状态
    expect(meta.validation_status).toBe("completed");
    expect(meta.validation_passed).toBe(false);
    expect(meta.validation_issue_count).toBeGreaterThan(0);
    expect(meta.review_status).toBe("failed");
    expect(meta.review_score).toBeUndefined();
    expect(meta.review_error).toBeTruthy();
    expect(meta.finished_at).toBeTruthy();
    // §25：落盘的 validation.json 与响应一致
    expect(JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8")).passed).toBe(false);
  });

  it("§7 固定顺序：Planning 在 Generation 之前，temperature 分别默认 0.7 / 0.8", async () => {
    withTmpDir();
    const order: string[] = [];
    const planSpy = { plan: async () => { order.push("plan"); return plan; } };
    const genSpy = new StoryGenerator({ generate: async () => { order.push("generate"); return "正文"; } } as never);
    await startRun({ config }, { llm: fakeLLM as never, planner: planSpy as never, generator: genSpy });
    // §8：Retry 不重新规划——plan 只出现一次；每次 Attempt 都以 generate 开头
    expect(order).toEqual(["plan", "generate", "generate"]);
  });

  it("§26 legacy {title, prompt} 仍可跑 Automatic Run", async () => {
    withTmpDir();
    const r = await startRun(
      { title: "旧版请求", prompt: "旧版自由文本需求。" },
      { llm: fakeLLM as never, planner: fakePlanner(plan) as never, generator },
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
    const err = apiErrorOf(r.json);
    expect(err.code).toBe("PLANNER_INVALID_OUTPUT");
    expect(err.stage).toBe("planning");
    // 阶段信息由 stage 字段承载，不靠人类可读消息里恰好出现 "planning" 这个词：
    // v0.9.0 因为 toApiError 的分支顺序，这里拿到的是 PipelineError 的阶段壳消息，
    // BeatParseError 的专属前缀（Plan generation failed. 原因：...）反而被吃掉了。
    expect(err.message).toContain("Plan generation failed");
    expect(err.message).toContain("Planner 输出不是合法 JSON");
    expect(err.run_id).toMatch(RUN_ID);
    const runDir = runDirOf(dir, err.run_id as string);
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
    const err = apiErrorOf(r.json);
    // §11：LLM 层失败保留专属错误码，不退化成 GENERATION_FAILED
    expect(err.code).toBe("LLM_REQUEST_FAILED");
    expect(err.stage).toBe("generating");
    expect(err.message).toContain("401");
    expect(err.run_id).toMatch(RUN_ID);
    const runId = err.run_id as string;
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

describe("POST /api/runs/from-plan（v0.6.0 Manual Run）", () => {
  it("链路：不再调用 Planner，直接生成，Validate 仍执行，run_id 与 metadata 一致", async () => {
    const dir = withTmpDir();
    const r = await startRunFromPlan({ config, beat_plan: plan }, { llm: fakeLLM as never, generator });
    expect(r.status).toBe(200);
    const ok = r.json as {
      run_id: string; story: string; beat_plan: BeatPlan;
      validation: { passed: boolean }; validation_status: string;
    };
    expect(ok.run_id).toMatch(RUN_ID);
    expect(ok.story).toContain("正文");
    expect(ok.beat_plan.beats).toHaveLength(2);
    // §17：Manual Run 同样在 Save Story 之后 Validate
    expect(ok.validation_status).toBe("completed");
    expect(ok.validation.passed).toBe(false);
    const meta = JSON.parse(readFileSync(join(runDirOf(dir, ok.run_id), "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(ok.run_id);
    expect(meta.status).toBe("completed");
    expect(existsSync(join(runDirOf(dir, ok.run_id), "validation.json"))).toBe(true);
  });

  it("§29 Manual Run 不触发 Planner（plan 被调用即失败）", async () => {
    withTmpDir();
    const r = await startRunFromPlan(
      { config, beat_plan: plan },
      { llm: fakeLLM as never, planner: { plan: async () => { throw new Error("Manual Run 不得调用 Planner"); } } as never, generator },
    );
    expect(r.status).toBe(200);
  });

  it("§29 missing beat_plan → 400 beat_plan is required", async () => {
    const r = await startRunFromPlan({ config }, { generator });
    expect(r.status).toBe(400);
    expect(apiErrorOf(r.json).message).toContain("beat_plan is required");
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
    expect(apiErrorOf(r.json).message).toContain("beat_plan is required");
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
