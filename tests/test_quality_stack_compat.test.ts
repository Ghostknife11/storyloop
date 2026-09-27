/**
 * v2.1.0 TASK §43/§44/§45 兼容与回归门禁。
 *
 * 三套质量组件升级到 v2，但「旧客户端读到什么」一个字都不能变（§27/§43），
 * 「重试与修订听谁的」也一个字都不能变（§28/§44）。这一文件用三条证据钉住：
 *
 *   1. §43 一次 v2.1.0 的 Run，旧客户端要的五个字段原样在位：
 *      review.score / review.dimensions / commercial_review.score /
 *      beat_validation.issues / quality.overall_score；qualityStack 是纯追加。
 *      旧 Run（没有 quality-stack.json）照常 200，qualityStack 是 null。
 *   2. §44 RetryPolicy 只看分数：诊断从 1 条涨到 12 条（含 error 级）也不多重试一次；
 *      Repair 之后重新审阅得到的是新正文的 v2 结论，不是修订前那份的转录。
 *   3. §45 受控实验的每条样本走的就是正式生成路径，因此同样拿到 v2 质量栈。
 *
 * 铁律同全仓（§47）：只有假客户端，没有一次请求打到真实模型。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRunRoute } from "@/app/api/runs/[run_id]/route";
import { createStoryLoop } from "@/composition";
import { ExperimentRunner } from "@/analysis/experiment-runner";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { ExperimentStore } from "@/infrastructure/storage/experiment-store";
import { GenerationPipeline } from "@/engine/pipeline";
import { BeatPlanner } from "@/engine/beat-planner";
import { StoryGenerator } from "@/engine/story-generator";
import { StoryValidator } from "@/engine/story-validator";
import { BasicReviewer } from "@/engine/basic-reviewer";
import { StoryRepairer } from "@/engine/story-repairer";
import { RepairStrategy } from "@/engine/repair-strategy";
import { CommercialReviewer } from "@/engine/commercial-reviewer";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/engine/retry-policy";
import { buildPipeline } from "@/application/generate-service";
import { decideRetry } from "@/engine/retry-policy";
import { qualityResultOf } from "@/domain/quality";
import type { QualityStackResult } from "@/domain/quality-stack";
import type { ExperimentDefinition } from "@/domain/experiment";
import type { StoryConfig } from "@/domain/story-config";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_CONFIG,
  SAMPLE_STORY,
  REVIEW_REPLY,
  experimentDeps,
  FakeLLM,
  withTmpDir,
} from "./helpers/fixtures";

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);

/** 一次 Automatic Run 的五次调用：Plan → 骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
const HAPPY_SCRIPT = [
  PLAN_REPLY,
  JSON.stringify({ passed: true, diagnostics: [], summary: "骨架结构完整。" }),
  SAMPLE_STORY,
  REVIEW_REPLY,
  JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2),
];

const BEAT_VALIDATION_REPLY = JSON.stringify({ passed: true, diagnostics: [], summary: "骨架结构完整。" });

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function runDetail(runId: string): Promise<Response> {
  return getRunRoute(new NextRequest("http://localhost/x"), {
    params: Promise.resolve({ run_id: runId }),
  } as never) as unknown as Promise<Response>;
}

// ---------------------------------------------------------------------------
// §43 旧客户端读 v2.1.0 的 Run：五个字段一个不少，qualityStack 只是多出来的那个
// ---------------------------------------------------------------------------

describe("§43 旧客户端要的五个字段在 v2.1.0 的 Run 上原样在位", () => {
  it("review.score / review.dimensions / commercial_review.score / beat_validation.issues / quality.overall_score", async () => {
    withTmpDir();
    const app = createStoryLoop({ llm: new FakeLLM(HAPPY_SCRIPT) as never });
    const created = await app.service.generate({ config: SAMPLE_CONFIG });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const runId = (created.json as { run_id: string }).run_id;

    const res = await runDetail(runId);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;

    // review：v1 DTO 的 score 与 dimensions 都在（REVIEW_REPLY 四维 84/78/80/76 → 均分 79.5）
    const review = detail.review as { score: number; dimensions: Record<string, { score: number }> };
    expect(review.score).toBe(79.5);
    expect(Object.keys(review.dimensions)).toEqual(["coherence", "narrative", "character", "causality"]);
    expect(review.dimensions.coherence.score).toBe(84);

    // commercial_review：v1 DTO 的 score 还在
    const commercial = detail.commercial_review as { score: number };
    expect(commercial.score).toBe(71.5);

    // beat_validation：v1 DTO 的 issues 数组还在（这份样例一条都没有，键仍要在）
    const beatValidation = detail.beat_validation as { passed: boolean; issues: unknown[]; summary: string };
    expect(beatValidation.passed).toBe(true);
    expect(beatValidation.issues).toEqual([]);
    expect(typeof beatValidation.summary).toBe("string");

    // quality：overall_score 与 review.score 同一口径
    const quality = detail.quality as { overall_score: number };
    expect(quality.overall_score).toBe(79.5);

    // 新增的那一个只是多出来：旧字段一个都没被替换掉
    const stack = detail.qualityStack as { status: string; diagnostics: unknown[]; summary: unknown };
    expect(stack.status).toBe("complete");
    expect(Array.isArray(stack.diagnostics)).toBe(true);
  });

  it("§24 三套结论的本体仍由各自的字段给，qualityStack 不是第二处事实来源", async () => {
    withTmpDir();
    const app = createStoryLoop({ llm: new FakeLLM(HAPPY_SCRIPT) as never });
    const created = await app.service.generate({ config: SAMPLE_CONFIG });
    const runId = (created.json as { run_id: string }).run_id;
    const res = await runDetail(runId);
    const detail = (await res.json()) as Record<string, unknown>;
    const stack = detail.qualityStack as Record<string, unknown>;

    // 投影里没有三套结论的本体：那三个键一个都不出现
    expect(Object.keys(stack).sort()).toEqual(["diagnostics", "status", "summary"]);
  });

  it("旧 Run 没有 quality-stack.json：仍然 200，五个旧字段照常，qualityStack 是 null", async () => {
    const dir = withTmpDir();
    const runId = "20260101_120000_legacy1";
    const runDir = join(dir, "runs", runId);
    mkdirSync(join(runDir, "attempts", "01"), { recursive: true });

    const oldReview = {
      score: 78,
      summary: "节奏紧凑。",
      strengths: ["开场干净"],
      problems: ["中段略拖"],
      dimensions: {
        coherence: { score: 80, summary: "一致。" },
        narrative: { score: 76, summary: "完整。" },
        character: { score: 78, summary: "清楚。" },
        causality: { score: 78, summary: "成立。" },
      },
    };
    const oldCommercial = {
      score: 71.5,
      summary: "开篇即冲突。",
      strengths: [],
      problems: [],
      suggestions: [],
      dimensions: {
        hook: { score: 82, summary: "开场即冲突。" },
        pacing: { score: 68, summary: "中段略拖。" },
        engagement: { score: 74, summary: "动力持续。" },
        payoff: { score: 62, summary: "收得干脆。" },
      },
    };
    writeFileSync(join(runDir, "config.json"), JSON.stringify({ title: "消失的目击者" }));
    writeFileSync(join(runDir, "story.md"), "# 消失的目击者\n\n陈岚推开派出所的玻璃门。\n");
    writeFileSync(join(runDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
    writeFileSync(join(runDir, "review.json"), JSON.stringify(oldReview));
    writeFileSync(join(runDir, "commercial-review.json"), JSON.stringify(oldCommercial));
    writeFileSync(join(runDir, "beat-validation.json"), JSON.stringify({ passed: true, issues: [], summary: "骨架完整。" }));
    writeFileSync(
      join(runDir, "metadata.json"),
      JSON.stringify({
        run_id: runId,
        project_version: "2.0.0",
        status: "completed",
        quality_status: "accepted",
        attempt_count: 1,
        selected_attempt: 1,
        validation_status: "completed",
        review_status: "completed",
        commercial_review_status: "completed",
        review_score: 78,
      }),
    );
    // attempt 级那份也按 v2.0.0 的形状写全：读接口的兜底装配从这儿取结论
    const attemptDir = join(runDir, "attempts", "01");
    writeFileSync(join(attemptDir, "story.md"), "# 消失的目击者\n\n陈岚推开派出所的玻璃门。\n");
    writeFileSync(join(attemptDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
    writeFileSync(join(attemptDir, "review.json"), JSON.stringify(oldReview));
    writeFileSync(
      join(attemptDir, "metadata.json"),
      JSON.stringify({
        attempt_number: 1,
        accepted: true,
        retry_reason: null,
        review_score: 78,
        validation_passed: true,
        repair_count: 0,
        repairs: [],
        error: null,
      }),
    );

    const res = await runDetail(runId);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;

    expect((detail.review as { score: number }).score).toBe(78);
    expect(Object.keys((detail.review as { dimensions: object }).dimensions)).toHaveLength(4);
    expect((detail.commercial_review as { score: number }).score).toBe(71.5);
    expect((detail.beat_validation as { issues: unknown[] }).issues).toEqual([]);
    expect((detail.quality as { overall_score: number }).overall_score).toBe(78);
    // v2.1.0 之前没有这份文件：是 null，不是空壳、不是 0 条诊断
    expect(detail.qualityStack).toBeNull();

    // 读旧 Run 不会在磁盘上补写任何文件
    expect(() => readFileSync(join(runDir, "quality-stack.json"), "utf8")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §44 RetryPolicy / Repair 不因 diagnostics 数量而改变
// ---------------------------------------------------------------------------

/** 均分 60 的四维（低于默认门槛 70）。 */
const LOW_DIMENSIONS = {
  coherence: { score: 62, summary: "后段称呼前后不一致。", strengths: [], problems: ["称呼不一致"] },
  narrative: { score: 59, summary: "起承转合缺高潮。", strengths: [], problems: ["高潮缺失"] },
  character: { score: 63, summary: "主角中途换了目标。", strengths: [], problems: [] },
  causality: { score: 56, summary: "配角的反水没有铺垫。", strengths: [], problems: [] },
};

/** 均分 82 的四维（过门槛）。 */
const HIGH_DIMENSIONS = {
  coherence: { score: 84, summary: "设定与称呼前后一致。", strengths: ["称呼统一"], problems: [] },
  narrative: { score: 80, summary: "结构完整，中段略慢。", strengths: ["起承转合完整"], problems: [] },
  character: { score: 81, summary: "主角目标清楚。", strengths: ["主角目标清楚"], problems: [] },
  causality: { score: 83, summary: "事件推进都有前因。", strengths: ["主线因果成立"], problems: [] },
};

function reviewReply(dimensions: Record<string, unknown>, diagnostics: unknown[]): string {
  return JSON.stringify({ dimensions, diagnostics, summary: "一句话总结。" });
}

/** 一条诊断。 */
const ONE_DIAGNOSTIC = [
  { category: "weak_climax", severity: "error", target: "ending", message: "高潮冲突没有展开" },
];

/** 十二条诊断：三档 severity 都有，类别铺开，故意比「一条」多得多。 */
const TWELVE_DIAGNOSTICS = [
  { category: "continuity_break", severity: "error", target: "story", message: "第三场戏的称呼变了。" },
  { category: "setting_conflict", severity: "warning", target: "global", message: "时间线与设定冲突。" },
  { category: "character_state_conflict", severity: "error", target: "character", message: "主角状态前后不一。" },
  { category: "goal_unclear", severity: "warning", target: "character", message: "中段目标含糊。" },
  { category: "motivation_weak", severity: "info", target: "character", message: "动机交代不足。" },
  { category: "character_inconsistency", severity: "warning", target: "character", message: "配角立场漂移。" },
  { category: "narrative_stall", severity: "info", target: "middle", message: "中段停滞。" },
  { category: "repetition", severity: "warning", target: "middle", message: "两场戏功能重复。" },
  { category: "unsupported_turn", severity: "error", target: "story", message: "转折缺少铺垫。" },
  { category: "causal_gap", severity: "error", target: "story", message: "因果断裂。" },
  { category: "weak_climax", severity: "warning", target: "ending", message: "高潮不够顶。" },
  { category: "weak_resolution", severity: "info", target: "ending", message: "收束略赶。" },
];

function pipelineWith(llm: FakeLLM, store: ArtifactStore, policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator(),
    new BasicReviewer(client),
    store,
    policy,
    new StoryRepairer(client),
    new RepairStrategy(),
  );
}

function stackAt(path: string): QualityStackResult {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as QualityStackResult;
  expect(parsed.status, `${path} 应有 status`).toBeDefined();
  return parsed;
}

describe("§44 诊断数量不参与重试判定", () => {
  it("decideRetry：同一份低分，1 条诊断与 12 条诊断给出同一个决定", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, enable_repair: false };
    const base = {
      policy,
      attempt_number: 1,
      generation_error: null,
      validator_error: false,
      reviewer_error: false,
      validation: { passed: true, issues: [] },
    };
    const one = decideRetry({ ...base, review: { score: 60, summary: "s", strengths: [], problems: [], diagnostics: ONE_DIAGNOSTIC } as never });
    const twelve = decideRetry({ ...base, review: { score: 60, summary: "s", strengths: [], problems: [], diagnostics: TWELVE_DIAGNOSTICS } as never });
    expect(one).toEqual(twelve);
    expect(one).toEqual({ should_retry: true, reason: "review_score_below_threshold" });
  });

  it("真实管道：诊断从 1 条变成 12 条，重试次数一次不多", async () => {
    const outcomes: Array<{ attempts: number; reason: string | null; diagnostics: number }> = [];
    for (const diagnostics of [ONE_DIAGNOSTIC, TWELVE_DIAGNOSTICS]) {
      withTmpDir();
      const llm = new FakeLLM([
        PLAN_REPLY,
        SAMPLE_STORY,
        reviewReply(LOW_DIMENSIONS, diagnostics),
        SAMPLE_STORY,
        reviewReply(HIGH_DIMENSIONS, diagnostics),
      ]);
      const result = await pipelineWith(llm, new ArtifactStore(), {
        ...DEFAULT_RETRY_POLICY,
        enable_repair: false,
      }).run(SAMPLE_CONFIG);

      expect(result.quality_status).toBe("accepted");
      expect(result.selected_attempt).toBe(2);
      expect(result.attempts).toHaveLength(2);
      outcomes.push({
        attempts: result.attempts.length,
        reason: result.attempts[0].retry_reason,
        diagnostics: stackAt(join("runs", result.run_id, "quality-stack.json")).diagnostics.length,
      });
    }
    // 两次跑出来的行为一模一样：Attempt 数、重试理由都相同
    expect(outcomes[0]).toEqual({ attempts: 2, reason: "review_score_below_threshold", diagnostics: 1 });
    expect(outcomes[1]).toEqual({ attempts: 2, reason: "review_score_below_threshold", diagnostics: 12 });
  });

  it("Repair 之后：重新审阅得到新正文的 v2 结论，质量栈收的是修订后那一份", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY,
      SAMPLE_STORY,
      reviewReply(LOW_DIMENSIONS, ONE_DIAGNOSTIC),
      `修订后的正文，补上了高潮。${SAMPLE_STORY}`,
      reviewReply(HIGH_DIMENSIONS, ONE_DIAGNOSTIC),
    ]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("accepted");
    expect(result.attempts[0].repairs).toHaveLength(1);

    // 首次结论是修订前那份（低分），修订后那份在 repairs/01/
    expect(readJson(join(runDir, "attempts", "01", "review.json")).score).toBe(60);
    const repaired = readJson(join(runDir, "attempts", "01", "repairs", "01", "review.json"));
    expect(repaired.score).toBe(82);
    expect(Object.keys(repaired.dimensions as object)).toEqual([
      "coherence",
      "narrative",
      "character",
      "causality",
    ]);

    // 质量栈里的 qualityReview 是修订后那一份：分数与四维都对得上。
    // 这一版 fixture 管道只挂了结构审阅者，所以栈是 partial——缺的两路如实缺，
    // 正好也是 §36「保留具体模块状态」的样子。
    const stack = stackAt(join(runDir, "quality-stack.json"));
    expect(stack.status).toBe("partial");
    expect(stack.beatValidation).toBeUndefined();
    expect(stack.commercialReview).toBeUndefined();
    expect(stack.qualityReview?.score).toBe(82);
    expect(stack.qualityReview?.dimensions.narrative.score).toBe(80);
    // 快照与 quality.json 同源：旧客户端读 overall_score 也读到 82
    const quality = qualityResultOf(readJson(join(runDir, "quality.json")));
    expect(quality?.overall_score).toBe(82);
  });
});

// ---------------------------------------------------------------------------
// §36 组件自身失败：栈落在 partial，跑成的照常在，具体模块状态留在 metadata
// ---------------------------------------------------------------------------

describe("§36 商业审阅这一路自己崩了：栈是 partial，不是失败", () => {
  it("故事质量审阅跑成、商业审阅抛异常：Run 仍 completed，栈里缺的那一路如实缺", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY,
      SAMPLE_STORY,
      reviewReply(HIGH_DIMENSIONS, ONE_DIAGNOSTIC),
      JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2),
    ]);
    const exploding = new CommercialReviewer({
      generate: async () => {
        throw new Error("commercial reviewer exploded");
      },
    } as never);
    const client = llm as never;
    const result = await new GenerationPipeline(
      new BeatPlanner(client),
      new StoryGenerator(client),
      new StoryValidator(),
      new BasicReviewer(client),
      new ArtifactStore(),
      DEFAULT_RETRY_POLICY,
      new StoryRepairer(client),
      new RepairStrategy(),
      undefined,
      undefined,
      undefined,
      exploding,
    ).run(SAMPLE_CONFIG);

    // 评价器崩了不等于故事坏了：Run 照常 completed
    expect(result.status).toBe("completed");
    expect(result.quality_status).toBe("accepted");

    const stack = stackAt(join(dir, "runs", result.run_id, "quality-stack.json"));
    expect(stack.status).toBe("partial");
    expect(stack.qualityReview?.score).toBe(82);
    expect(stack.commercialReview).toBeUndefined();
    // 诊断只来自跑成的那一家，不替崩掉的那家编几条
    expect(stack.diagnostics).toHaveLength(1);
    expect(stack.summary).toEqual({ totalDiagnostics: 1, errors: 1, warnings: 0, info: 0 });

    // §36：具体模块状态留在 metadata 里，与栈的说法一致
    const meta = readJson(join(dir, "runs", result.run_id, "metadata.json"));
    expect(meta.commercial_review_status).toBe("failed");
    expect(meta.review_status).toBe("completed");
    // 崩掉那一路的旧产物仍然不在（§24：不写空结论占位）
    expect(() => readFileSync(join(dir, "runs", result.run_id, "commercial-review.json"), "utf8")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §45 受控实验的样本走正式生成路径，同样拿到 v2 质量栈
// ---------------------------------------------------------------------------

describe("§45 实验样本使用 production v2 Quality Stack", () => {
  const CONFIG: StoryConfig = {
    config_version: "1",
    title: "消失的目击者",
    genre: "悬疑",
    premise: "唯一证人在出庭前一天突然消失。",
    target_words: 5000,
    protagonist: { name: "陈岚" },
  };
  const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

  function scriptedLLM(script: Array<string | Error>) {
    let index = 0;
    return {
      // 只按调用顺序回话：提示词内容与温度这一版用不上
      async generate(): Promise<string> {
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step instanceof Error) throw step;
        return step;
      },
    };
  }

  /** 一个样本的完整剧本：骨架校验 → 正文 → 结构审阅 → 商业审阅（fixed 骨架，不调 Planner）。 */
  function sampleScript(): string[] {
    return [
      BEAT_VALIDATION_REPLY,
      STORY,
      reviewReply(HIGH_DIMENSIONS, ONE_DIAGNOSTIC),
      JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2),
    ];
  }

  it("每条样本的 Run 目录里都有 quality-stack.json，且三套结论齐全", async () => {
    const dir = withTmpDir();
    const experimentId = "exp-qs";
    const store = new ExperimentStore("runs");
    const definition = {
      schemaVersion: "1",
      name: "模型对比",
      experimentId,
      base: { storyConfig: CONFIG, beatPlanMode: "fixed", beatPlan: SAMPLE_BEAT_PLAN },
      variants: [{ id: "model-a", name: "模型 A" }],
      repetitions: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
    };
    store.createExperimentDirectory(experimentId);
    store.putDefinition(experimentId, definition as unknown as ExperimentDefinition);

    const llm = scriptedLLM(sampleScript());
    const runner = new ExperimentRunner({
      llm: llm as never,
      generate: buildPipeline,
      ...experimentDeps(),
    });
    const result = await runner.run(store.readDefinition(experimentId) as ExperimentDefinition);
    expect(result.status).toBe("completed");
    expect(result.runs).toHaveLength(1);

    const artifacts = new ArtifactStore("runs");
    for (const ref of result.runs) {
      const stack = artifacts.readQualityStack(ref.runId);
      expect(stack, `${ref.runId} 应有 quality-stack.json`).not.toBeNull();
      expect(stack?.status).toBe("complete");
      expect(stack?.beatValidation?.summary).toContain("骨架");
      expect(stack?.qualityReview?.score).toBe(82);
      expect(stack?.commercialReview?.score).toBe(71.5);
      // 合并诊断里三家一条不少：骨架 0 + 故事 1 + 商业 1
      expect(stack?.diagnostics).toHaveLength(2);
      expect(stack?.summary.totalDiagnostics).toBe(2);
    }
    // 实验自己的三个文件也都在
    for (const file of ["definition.json", "runs.json", "results.json"]) {
      expect(() => readFileSync(join(dir, "experiments", experimentId, file), "utf8")).not.toThrow();
    }
  });
});
