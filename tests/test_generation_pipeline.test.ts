import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/**
 * §3/§5~§7/§16~§30/§59~§62 GenerationPipeline。
 * 只用 Mock / Fake / Fixture，绝不打真实付费 API。
 */

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

interface PlanCall { config: StoryConfig; temperature: number }
interface GenCall { config: StoryConfig; plan: BeatPlan; temperature: number }

function fakePlanner(out: BeatPlan, calls: PlanCall[] = []) {
  return {
    plan: async (c: StoryConfig, temperature = 0.7) => {
      calls.push({ config: c, temperature });
      return out;
    },
  };
}

function fakeGenerator(story: string, calls: GenCall[] = []) {
  return {
    generate: async (c: StoryConfig, p: BeatPlan, temperature = 0.8) => {
      calls.push({ config: c, plan: p, temperature });
      return story;
    },
  };
}

/** 落盘阶段注入失败：模拟磁盘错误，且不让内部路径泄漏给用户。 */
class FailingStore extends ArtifactStore {
  override putStory(runId: string, title: string, story: string): string {
    throw new Error(`EACCES: permission denied, open '${join("D:", "secret", "runs", runId, "story.md")}'`);
  }
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-pipeline-"));
  process.chdir(tmp);
  return tmp;
}

function readMeta(dir: string, runId: string) {
  return JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8"));
}

describe("GenerationPipeline — successful full run（§59）", () => {
  it("planner called before generator，四件产物齐全，metadata status completed", async () => {
    const dir = withTmpDir();
    const order: string[] = [];
    const pipeline = new GenerationPipeline(
      { plan: async () => { order.push("plan"); return plan; } } as never,
      { generate: async () => { order.push("generate"); return "正文内容"; } } as never,
      new ArtifactStore(),
    );

    const result = await pipeline.run(config);
    expect(order).toEqual(["plan", "generate"]);
    expect(result.run_id).toMatch(RUN_ID);
    expect(result.status).toBe("completed");
    expect(result.story).toBe("正文内容");
    expect(result.beat_plan).toEqual(plan);
    expect(result.config).toEqual(config);
    expect(result.artifacts).toEqual({
      config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json",
    });

    const runDir = join(dir, "runs", result.run_id);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");

    const meta = readMeta(dir, result.run_id);
    expect(meta.run_id).toBe(result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.current_stage).toBe("completed");
    expect(meta.project_version).toBe("0.4.0");
    expect(meta.finished_at).toBeTruthy();
  });

  it("§30 GenerationResult 不含未来能力字段", async () => {
    withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config);
    expect(Object.keys(result).sort()).toEqual([
      "artifacts", "beat_plan", "config", "finished_at", "run_id", "started_at", "status", "story",
    ]);
  });

  it("§30 只暴露 run() / runWithPlan()，没有未来能力入口", () => {
    const names = Object.getOwnPropertyNames(GenerationPipeline.prototype);
    expect(names).toContain("run");
    expect(names).toContain("runWithPlan");
    for (const name of names) {
      for (const forbidden of ["review", "validate", "repair", "retry", "experiment", "benchmark", "score", "observe"]) {
        expect(name.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("temperature 缺省 0.7 / 0.8，运行时覆盖生效", async () => {
    withTmpDir();
    const planCalls: PlanCall[] = [];
    const genCalls: GenCall[] = [];
    const pipeline = new GenerationPipeline(
      fakePlanner(plan, planCalls) as never, fakeGenerator("正文", genCalls) as never, new ArtifactStore(),
    );
    await pipeline.run(config);
    expect(planCalls[0].temperature).toBe(0.7);
    expect(genCalls[0].temperature).toBe(0.8);

    planCalls.length = 0;
    genCalls.length = 0;
    await pipeline.run(config, { temperature: 0.25, model: "m" });
    expect(planCalls[0].temperature).toBe(0.25);
    expect(genCalls[0].temperature).toBe(0.25);
  });

  it("metadata 记录运行时 model", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, new ArtifactStore(),
    );
    const result = await pipeline.run(config, { model: "gpt-4o-mini" });
    expect(readMeta(dir, result.run_id).model).toBe("gpt-4o-mini");
  });
});

describe("GenerationPipeline — runWithPlan（§29 Manual Run）", () => {
  it("supplied BeatPlan 直接进入生成，Planner 不被调用", async () => {
    const dir = withTmpDir();
    const genCalls: GenCall[] = [];
    const planner = {
      plan: async () => {
        throw new Error("Manual Run 不得调用 Planner");
      },
    };
    const pipeline = new GenerationPipeline(planner as never, fakeGenerator("正文", genCalls) as never, new ArtifactStore());

    const result = await pipeline.runWithPlan(config, plan);
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0].plan).toEqual(plan);
    expect(result.run_id).toMatch(RUN_ID);
    // run_id 一致性：响应 / beats.json / metadata.json 三处同一个值
    expect(JSON.parse(readFileSync(join(dir, "runs", result.run_id, "beats.json"), "utf8")).beats).toHaveLength(2);
    expect(readMeta(dir, result.run_id).run_id).toBe(result.run_id);
  });

  it("手动模式下 Planning 阶段不写 beats.json 之外的额外产物", async () => {
    withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, new ArtifactStore(),
    );
    const result = await pipeline.runWithPlan(config, plan);
    expect(result.artifacts.story).toBe("story.md");
  });
});

describe("GenerationPipeline — planning failure（§18/§60）", () => {
  it("status=failed，current_stage=planning，config+metadata 保留，beats/story 缺失", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      { plan: async () => { throw new Error("Planner 输出不是合法 JSON"); } } as never,
      fakeGenerator("正文") as never,
      new ArtifactStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.name).toBe("PipelineError");
    expect(pe.stage).toBe("planning");
    expect(pe.runId).toMatch(RUN_ID);
    expect(pe.message).toContain("failed at planning");

    const runDir = join(dir, "runs", pe.runId);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(false);
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    const meta = readMeta(dir, pe.runId);
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("planning");
    expect(meta.error).toContain("Planner 输出不是合法 JSON");
  });
});

describe("GenerationPipeline — generation failure（§19/§61）", () => {
  it("status=failed，current_stage=generating，config+beats+metadata 保留，story 缺失", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never,
      { generate: async () => { throw new Error("LLM API 返回 500"); } } as never,
      new ArtifactStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.stage).toBe("generating");

    const runDir = join(dir, "runs", pe.runId);
    expect(existsSync(join(runDir, "config.json"))).toBe(true);
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    const meta = readMeta(dir, pe.runId);
    expect(meta.status).toBe("failed");
    expect(meta.error).toContain("500");
  });
});

describe("GenerationPipeline — persistence failure（§20/§62）", () => {
  it("save 失败：status=failed，current_stage=saving，错误信息不含内部路径", async () => {
    const dir = withTmpDir();
    const pipeline = new GenerationPipeline(
      fakePlanner(plan) as never, fakeGenerator("正文") as never, new FailingStore(),
    );

    const err = await pipeline.run(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const pe = err as PipelineError;
    expect(pe.stage).toBe("saving");
    // §28：只回安全错误，不透出服务器绝对路径
    expect(pe.message).not.toContain("secret");
    expect(pe.message).not.toMatch(/[A-Za-z]:\\/);
    expect(readMeta(dir, pe.runId).status).toBe("failed");
  });
});
