import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentRunner } from "@/core/experiment-runner";
import { ArtifactStore } from "@/storage/artifact-store";
import { ExperimentStore } from "@/storage/experiment-store";
import type { ExperimentDefinition } from "@/types/experiment";
import { LLMError, LLMRequestError } from "@/lib/llm";
import { summarizeExperiment } from "@/lib/experiment-summary";
import { failureDistributionText, resultRowsOf } from "@/lib/experiment-view";
import type { ExperimentDetailApi } from "@/lib/api";
import { SAMPLE_BEAT_PLAN, withTmpDir } from "./helpers/fixtures";
import type { StoryConfig } from "@/types/story-config";

/**
 * v1.9.0 §52 实验级失败类别分布。
 *
 * 与分数均值同一套边界：只数事实、不排名、不给结论。这里数的是每个样本自己的
 * failure-analysis.json 里的**主要**类别——没有这份文件的样本（1.9.0 之前跑的）
 * 不进任何计数，也不被当成「没有失败」（那正是这个版本要避免的误读）。
 *
 * 铁律不变：只注入假 LLM，绝不触碰真实付费端点。
 */

const CONFIG: StoryConfig = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

/** 远超长度下限、含主角名、以句号结尾，可通过全部硬规则。 */
const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

const BEAT_VALIDATION = JSON.stringify({
  passed: true,
  issues: [],
  summary: "骨架结构完整：开场、高潮都有。",
});

/** 结构审阅：总分即维度分，四维 90/90/90/90 → overall 90。 */
function review(score: number): string {
  return JSON.stringify({
    score,
    summary: "总结。",
    strengths: ["强"],
    problems: ["弱"],
    dimensions: {
      coherence: { score, summary: "连贯。" },
      narrative: { score, summary: "叙事。" },
      character: { score, summary: "人物。" },
      causality: { score, summary: "因果。" },
    },
  });
}

function commercial(score: number): string {
  return JSON.stringify({
    score,
    summary: "开篇即冲突，结尾收得住。",
    strengths: ["第一段就抛出失踪悬念"],
    problems: ["中段推理过程重复"],
    suggestions: ["把中段两次排查合并成一次带新信息的排查"],
    dimensions: {
      hook: { score: 82, summary: "开场即冲突。" },
      pacing: { score: 68, summary: "中段排查略拖。" },
      engagement: { score: 74, summary: "动力持续住。" },
      payoff: { score: 62, summary: "结局收得干脆。" },
    },
  });
}

/** 按调用顺序依次返回：字符串回内容，Error 直接抛；脚本用完重复最后一格。 */
function scriptedLLM(script: Array<string | Error>) {
  const seen: Array<{ prompt: string; temperature: number }> = [];
  let index = 0;
  return {
    seen,
    async generate(prompt: string, temperature = 0.8): Promise<string> {
      seen.push({ prompt, temperature });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

/** 一个 variant 的完整剧本：骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
function variantScript(story: string, score: number): Array<string | Error> {
  return [BEAT_VALIDATION, story, review(score), commercial(score)];
}

function seed(dir: string, id: string): ExperimentDefinition {
  const store = new ExperimentStore("runs");
  const definition = {
    schemaVersion: "1",
    name: "模型对比",
    experimentId: id,
    base: {
      storyConfig: CONFIG,
      beatPlanMode: "fixed",
      beatPlan: SAMPLE_BEAT_PLAN,
    },
    variants: [
      { id: "model-a", name: "模型 A" },
      { id: "model-b", name: "模型 B" },
    ],
    repetitions: 1,
    createdAt: "2026-09-26T00:00:00.000Z",
  };
  store.createExperimentDirectory(id);
  store.putDefinition(id, definition as unknown as ExperimentDefinition);
  expect(existsSync(join(dir, "experiments", id, "definition.json"))).toBe(true);
  return store.readDefinition(id) as ExperimentDefinition;
}

function runIdOf(runs: Array<{ variantId: string; runId: string }>, variantId: string): string {
  const found = runs.find((r) => r.variantId === variantId);
  if (!found) throw new Error(`没有 ${variantId} 的样本`);
  return found.runId;
}

describe("v1.9.0 实验级失败类别分布", () => {
  it("成功的样本分出 0 类，失败的样本按主要类别计数", async () => {
    const dir = withTmpDir();
    // A 组跑完；B 组死在正文生成（LLM 请求失败 → 主要类别 GENERATION）
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMRequestError("上游 502", 502),
    ]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-dist"));

    const [a, b] = result.summary.variants;
    expect(result.status).toBe("partial");
    expect(a.runCount).toBe(1);
    expect(b.runCount).toBe(1);

    // A：这次 Run 成功 → 有分析，但没有主要类别
    expect(a.failures.analyzedCount).toBe(1);
    expect(a.failures.classifiedCount).toBe(0);
    expect(a.failures.counts).toEqual({});
    // B：这次 Run 失败 → 数进「正文生成问题」
    expect(b.failures.analyzedCount).toBe(1);
    expect(b.failures.classifiedCount).toBe(1);
    expect(b.failures.counts).toEqual({ GENERATION: 1 });
    // 没有出现过的类别整个键不出现，不写 0
    expect("UNKNOWN" in b.failures.counts).toBe(false);

    // 分母与失败数是两回事：有分析 ≠ 有失败，有失败 ≠ 分出了类别
    const store = new ArtifactStore("runs");
    expect(store.readFailureAnalysis(runIdOf(result.runs, "model-a"))?.status).toBe("none");
    expect(store.readFailureAnalysis(runIdOf(result.runs, "model-b"))?.primaryCategory).toBe(
      "GENERATION",
    );
  });

  it("没登记过的错误码按已知阶段降级归类，同样进分布（§41 不丢事实）", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMError("上游 502"), // 未知错误名：码留下来，按已知阶段降级
    ]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-unknown"));

    const [, b] = result.summary.variants;
    const analysis = new ArtifactStore("runs").readFailureAnalysis(
      runIdOf(result.runs, "model-b"),
    );
    // 状态是 partial：有信号，但那条信号来自未登记的码
    expect(analysis?.status).toBe("partial");
    expect(analysis?.primaryCategory).toBe("GENERATION");
    // 分布数的是主要类别，不因为 partial 少计一次
    expect(b.failures.classifiedCount).toBe(1);
    expect(b.failures.counts).toEqual({ GENERATION: 1 });
  });

  it("results.json 落盘的就是这份分布（界面与磁盘同源）", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([...variantScript(STORY, 90), ...variantScript(STORY, 82)]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-persist"));

    const stored = JSON.parse(
      readFileSync(join(dir, "experiments", "exp-persist", "results.json"), "utf8"),
    ) as { summary: { variants: Array<{ variantId: string; failures: unknown }> } };
    const [a, b] = stored.summary.variants;
    expect(a.failures).toEqual(result.summary.variants[0].failures);
    expect(b.failures).toEqual(result.summary.variants[1].failures);
    // 两条都成功：有分析、没有类别
    expect(a.failures).toEqual({ analyzedCount: 1, classifiedCount: 0, counts: {} });
  });

  it("读不到失败分析的样本不进分母（1.9.0 之前跑的 Run）", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMRequestError("上游 502", 502),
    ]);
    const definition = seed(dir, "exp-legacy");
    const result = await new ExperimentRunner({ llm: llm as never }).run(definition);

    // 把 A 组那条样本的分析文件删掉：模拟 1.9.0 之前跑出来的 Run
    const store = new ArtifactStore("runs");
    const aRunId = runIdOf(result.runs, "model-a");
    const file = join(dir, "runs", aRunId, "failure-analysis.json");
    expect(existsSync(file)).toBe(true);
    rmSync(file);

    const index = new ExperimentStore("runs").readRuns("exp-legacy");
    expect(index).not.toBeNull();
    const recomputed = summarizeExperiment(definition, index?.entries ?? [], store);
    const [a, b] = recomputed;
    // A 组没有分析：不进分母，也不被读成「没有失败」
    expect(a.failures).toEqual({ analyzedCount: 0, classifiedCount: 0, counts: {} });
    // B 组照旧
    expect(b.failures).toEqual({ analyzedCount: 1, classifiedCount: 1, counts: { GENERATION: 1 } });
  });
});

describe("failureDistributionText（界面一行文案）", () => {
  it("一条类别都没有时是 —，不显示「全部没有失败」", () => {
    expect(failureDistributionText(null)).toBe("—");
    expect(failureDistributionText({ analyzedCount: 2, classifiedCount: 0, items: [] })).toBe("—");
  });

  it("按类别优先级顺序，不按条数重排（重排就是排名）", () => {
    expect(
      failureDistributionText({
        analyzedCount: 3,
        classifiedCount: 3,
        items: [
          { category: "GENERATION", label: "正文生成问题", count: 1 },
          { category: "RETRY_EXHAUSTION", label: "重试次数用尽", count: 2 },
        ],
      }),
    ).toBe("正文生成问题 ×1 · 重试次数用尽 ×2");
  });
});

describe("resultRowsOf 的失败分布兜底", () => {
  it("v1.9.0 之前的结果没有 failures 块：行上是 null，界面整段隐藏", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([...variantScript(STORY, 90), ...variantScript(STORY, 82)]);
    const definition = seed(dir, "exp-old");
    const result = await new ExperimentRunner({ llm: llm as never }).run(definition);

    // 手工抹掉 results.json 里的 failures 块：复现 1.9.0 之前落盘的结果
    const path = join(dir, "experiments", "exp-old", "results.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      summary: { variants: Array<Record<string, unknown>> };
    };
    for (const variant of stored.summary.variants) delete variant.failures;

    const detail = {
      definition,
      runs: new ExperimentStore("runs").readRuns("exp-old"),
      result: stored,
    } as unknown as ExperimentDetailApi;
    const rows = resultRowsOf(detail);
    expect(rows).not.toBeNull();
    expect(rows?.[0].failures).toBeNull();
    expect(rows?.[1].failures).toBeNull();
    expect(result.status).toBe("completed");
  });

  it("有 failures 块时就照原样搬进行里（顺序按类别优先级）", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMRequestError("上游 502", 502),
    ]);
    const definition = seed(dir, "exp-new");
    await new ExperimentRunner({ llm: llm as never }).run(definition);

    const detail = {
      definition,
      runs: new ExperimentStore("runs").readRuns("exp-new"),
      result: new ExperimentStore("runs").readResults("exp-new"),
    } as unknown as ExperimentDetailApi;
    const rows = resultRowsOf(detail);
    expect(rows?.[0].failures).toEqual({
      analyzedCount: 1,
      classifiedCount: 0,
      items: [],
    });
    expect(rows?.[1].failures).toEqual({
      analyzedCount: 1,
      classifiedCount: 1,
      items: [{ category: "GENERATION", label: "正文生成问题", count: 1 }],
    });
  });
});
