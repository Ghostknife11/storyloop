import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentRunner } from "@/core/experiment-runner";
import { ArtifactStore } from "@/storage/artifact-store";
import { ExperimentStore } from "@/storage/experiment-store";
import { ExperimentValidationError, type ExperimentDefinition } from "@/types/experiment";
import { LLMError } from "@/lib/llm";
import {
  withTmpDir,
  SAMPLE_BEAT_PLAN,
} from "./helpers/fixtures";
import type { StoryConfig } from "@/types/story-config";

/**
 * v1.7.0 ExperimentRunner：把一份定义跑成一组 Run，再落成实验结果。
 *
 * 铁律（TASK §47）：只注入假 LLM，绝不调用真实付费端点。每个样本都是一次
 * 完完整整的普通 Run，区别只在 run-manifest.json 上多一个 experiment 块。
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

/** 商业可读性：四个维度同分，score 由其聚合覆盖（70 > min_review_score，不触发重试）。 */
function commercial(score: number): string {
  return JSON.stringify({
    score: 99,
    summary: "开篇即冲突，结尾收得住。",
    strengths: ["第一段就抛出失踪悬念"],
    problems: ["中段推理过程重复"],
    suggestions: ["把中段两次排查合并成一次带新信息的排查"],
    dimensions: {
      hook: { score, summary: "开场即冲突。" },
      pacing: { score, summary: "中段排查略拖。" },
      engagement: { score, summary: "动力持续住。" },
      payoff: { score, summary: "结局收得干脆。" },
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

interface Raw {
  name: string;
  experimentId: string;
  base: {
    storyConfig: StoryConfig;
    beatPlanMode: "fixed";
    beatPlan: typeof SAMPLE_BEAT_PLAN;
  };
  variants: Array<{ id: string; name: string }>;
  repetitions: number;
}

function definitionRaw(id: string, repetitions = 1): Raw {
  return {
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
    repetitions,
  };
}

/** 建一个实验目录并返回磁盘上的定义（schemaVersion 缺省会读不回来）。 */
function seed(dir: string, id: string, repetitions: number): ExperimentDefinition {
  const store = new ExperimentStore("runs");
  const definition = {
    schemaVersion: "1",
    ...definitionRaw(id, repetitions),
    createdAt: "2026-09-26T00:00:00.000Z",
  };
  store.createExperimentDirectory(id);
  store.putDefinition(id, definition as unknown as ExperimentDefinition);
  expect(existsSync(join(dir, "experiments", id, "definition.json"))).toBe(true);
  return store.readDefinition(id) as ExperimentDefinition;
}

function readJson(dir: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, unknown>;
}

describe("ExperimentRunner — 完整跑完", () => {
  it("两个变体 × 1 次 = 两条 Run，status=completed", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([...variantScript(STORY, 90), ...variantScript(STORY, 82)]);
    const definition = seed(dir, "exp-full", 1);
    const runner = new ExperimentRunner({ llm: llm as never });

    const result = await runner.run(definition);
    expect(result.status).toBe("completed");
    expect(result.runs).toHaveLength(2);
    expect(result.summary.runCount).toBe(2);
    expect(result.summary.successCount).toBe(2);
    expect(result.summary.failureCount).toBe(0);
    // 三个文件都在
    for (const file of ["definition.json", "runs.json", "results.json"]) {
      expect(existsSync(join(dir, "experiments", "exp-full", file))).toBe(true);
    }
    // 每个样本四次请求，共八次；fixed 模式下两条样本共用同一份骨架
    expect(llm.seen).toHaveLength(8);
  });

  it("每条样本自带 experiment 出身，写进 run-manifest.json", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([...variantScript(STORY, 90), ...variantScript(STORY, 82)]);
    const definition = seed(dir, "exp-manifest", 1);
    const result = await new ExperimentRunner({ llm: llm as never }).run(definition);

    const artifacts = new ArtifactStore("runs");
    const provenances = result.runs.map((ref) => {
      const manifest = artifacts.readRunManifest(ref.runId);
      expect(manifest).not.toBeNull();
      return manifest?.experiment ?? null;
    });
    expect(provenances).toEqual([
      { experimentId: "exp-manifest", variantId: "model-a", repetition: 1 },
      { experimentId: "exp-manifest", variantId: "model-b", repetition: 1 },
    ]);
    // 两条 runId 不重复：每个样本是独立 Run
    expect(new Set(result.runs.map((r) => r.runId)).size).toBe(2);
    expect(existsSync(join(dir, "experiments", "exp-manifest", "results.json"))).toBe(true);
  });

  it("每条样本引用带上自己的两个分数（v1.7.1：v1.7.0 漏了这两个字段）", async () => {
    const dir = withTmpDir();
    // 结构审阅四维 90 / 90 / 90 / 90 → 整体 90；商业四维 82 → 82
    const llm = scriptedLLM([...variantScript(STORY, 90), ...variantScript(STORY, 82)]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-scores", 1));

    expect(result.runs.map((r) => r.overallScore)).toEqual([90, 82]);
    expect(result.runs.map((r) => r.commercialScore)).toEqual([90, 82]);
    // 分数与均值同源：都是从这条 Run 自己的产物里读的
    expect(result.summary.variants.map((v) => v.meanOverallScore)).toEqual([90, 82]);

    // 磁盘上也要有：界面是从 results.json 拿这两个数字的
    const results = readJson(dir, "experiments/exp-scores/results.json");
    expect((results.runs as Array<Record<string, unknown>>).map((r) => r.overallScore)).toEqual([90, 82]);
  });
});

describe("ExperimentRunner — 部分失败", () => {
  it("第二条样本的生成一直失败：status=partial，另一条仍 completed", async () => {
    const dir = withTmpDir();
    // 脚本最后一格是错误，脚本用完后每次调用都抛——这个样本的每一次生成都失败
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMError("上游 502"),
    ]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-partial", 1));

    expect(result.status).toBe("partial");
    // 两条样本都建出了 Run：一条完成，一条死在生成阶段
    expect(result.summary.runCount).toBe(2);
    expect(result.summary.successCount).toBe(1);
    expect(result.summary.failureCount).toBe(1);
    expect(result.runs.map((r) => r.status)).toEqual(["completed", "failed"]);

    // runs.json 记下失败阶段与一句话摘要，顺序与执行顺序一致
    const entries = readJson(dir, "experiments/exp-partial/runs.json").entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe("completed");
    expect(entries[1].status).toBe("failed");
    expect(typeof entries[1].runId).toBe("string");
    expect(String(entries[1].failure)).toContain("generating");
    // results.json 与 runs.json 同一批格子，没有偷偷丢弃失败样本
    const results = readJson(dir, "experiments/exp-partial/results.json");
    expect(results.status).toBe("partial");
    expect((results.runs as unknown[]).length).toBe(2);
    // 失败的样本：分数是 null 而不是 0，也没有被从引用里抹掉
    const refs = results.runs as Array<Record<string, unknown>>;
    expect(refs.map((r) => r.overallScore)).toEqual([90, null]);
    expect(refs.map((r) => r.commercialScore)).toEqual([90, null]);
  });

  it("均值只对有分数的样本求：跑不出来的一条不补 0", async () => {
    const dir = withTmpDir();
    const llm = scriptedLLM([
      ...variantScript(STORY, 90),
      BEAT_VALIDATION,
      new LLMError("上游 502"),
    ]);
    const result = await new ExperimentRunner({ llm: llm as never }).run(seed(dir, "exp-mean", 1));

    const [a, b] = result.summary.variants;
    expect(a.meanOverallScore).toBe(90);
    // 没有正文就没有分数：null，而不是 0（补 0 等于凭空制造一个差评）
    expect(b.meanOverallScore).toBeNull();
    expect(b.meanCommercialScore).toBeNull();
    expect(b.successCount).toBe(0);
    expect(b.failureCount).toBe(1);
    // 没有赢家字段：键集合里只有计数、均值与 id
    expect(Object.keys(a).sort()).toEqual([
      "failureCount",
      "meanCausality",
      "meanCharacter",
      "meanCoherence",
      "meanCommercialScore",
      "meanEngagement",
      "meanHook",
      "meanNarrative",
      "meanOverallScore",
      "meanPacing",
      "meanPayoff",
      "runCount",
      "successCount",
      "variantId",
    ]);
    // 顺序就是定义里的声明顺序，不按分数重排
    expect(result.summary.variants.map((v) => v.variantId)).toEqual(["model-a", "model-b"]);
  });
});

describe("ExperimentRunner — 定义校验", () => {
  it("磁盘上被手改坏的定义拒绝执行", async () => {
    const dir = withTmpDir();
    const definition = seed(dir, "exp-broken", 1);
    (definition as { repetitions: number }).repetitions = 9;
    const llm = scriptedLLM([]);
    await expect(new ExperimentRunner({ llm: llm as never }).run(definition)).rejects.toThrow(
      ExperimentValidationError,
    );
    // 一个请求都没发出去
    expect(llm.seen).toHaveLength(0);
  });
});
