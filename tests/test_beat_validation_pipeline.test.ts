import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError, type GenerationResult } from "@/core/pipeline";
import { QualityAssembler } from "@/core/quality-assembler";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { BeatValidator } from "@/lib/beat-validator";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import type { BeatValidationResult } from "@/types/beat-validation";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_BEAT_VALIDATION_FAILED,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  FakeLLM,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.4.0 BeatPlan 结构校验在真实管道里的落点（TASK §7/§10/§12）。
 *
 * 只有 LLM 与 BeatValidator 是假的，Pipeline / ArtifactStore / Validator / Reviewer
 * 全是真组件，落盘结构与生产一致。四件事：
 *   1. 骨架带 error 级问题 → 整个 Run 在生成前失败，一个 Attempt 都不跑（§7）
 *   2. 只有 warning 或干脆没问题 → 照常生成，结论落 beat-validation.json（§7）
 *   3. BeatValidator 自身抛异常 → beat_validation_status=failed，生成照常继续（§12）
 *   4. 没注入 BeatValidator → 这条路等于不存在，metadata 里一个字段都不多（§5）
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify(SAMPLE_REVIEW);

function pipelineWith(
  llm: FakeLLM,
  store: ArtifactStore,
  beatValidator: unknown,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator(),
    new BasicReviewer(client),
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
    new QualityAssembler(),
    undefined,
    beatValidator as never,
  );
}

/** 注入一个会返回固定结论的真 BeatValidator（自带假 LLM，不吃主回复序列）。 */
function beatValidatorOf(beatValidation: BeatValidationResult): BeatValidator {
  return new BeatValidator(new FakeLLM([JSON.stringify(beatValidation)]) as never);
}

function metaOf(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8")) as Record<string, unknown>;
}

describe("v1.4.0 结构校验未通过：整个 Run 在生成前就结束（§7）", () => {
  it("error 级命中项 → 抛 PipelineError，attempts/ 与 story.md 一个都没有", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    let caught: unknown;
    try {
      await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(SAMPLE_BEAT_VALIDATION_FAILED)).run(SAMPLE_CONFIG);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    const err = caught as PipelineError & { runId: string; stage: string };
    expect(err.runId).toMatch(/^\d{8}_\d{6}_/);
    expect(err.stage).toBe("validating_beat_plan");
    expect(err.message).toContain("结构校验未通过");
    expect(err.message).toContain("MISSING_CLIMAX");

    const runDir = join(dir, "runs", err.runId);
    // 失败也要能复盘：beat_plan 与 beat-validation.json 都在
    expect(existsSync(join(runDir, "beats.json"))).toBe(true);
    const stored = JSON.parse(readFileSync(join(runDir, "beat-validation.json"), "utf8")) as BeatValidationResult;
    expect(stored).toEqual(SAMPLE_BEAT_VALIDATION_FAILED);
    // 正文与 attempt 产物一个都没有：骨架都站不住时不花生成额度（§7）
    expect(existsSync(join(runDir, "story.md"))).toBe(false);
    expect(existsSync(join(runDir, "attempts"))).toBe(false);

    const meta = metaOf(dir, err.runId);
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("validating_beat_plan");
    expect(meta.beat_validation_status).toBe("completed");
    expect(meta.beat_validation_passed).toBe(false);
    expect(meta.beat_validation_issue_count).toBe(1);
    expect(meta.error).toContain("结构校验未通过");
    // §12：骨架不达标不是校验器自身的失败，beat_validation_error 不出现
    expect(meta.beat_validation_error).toBeUndefined();
  });

  it("手动模式（runWithPlan）同样先校验：用户改过的骨架也会被挡住", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([SAMPLE_STORY, GOOD_REVIEW]);
    let caught: unknown;
    try {
      await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(SAMPLE_BEAT_VALIDATION_FAILED)).runWithPlan(
        SAMPLE_CONFIG,
        SAMPLE_BEAT_PLAN,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    // 一次 LLM 都没调用：Planner 被跳过（传了 plan），Generator 根本没轮到
    expect(llm.prompts).toHaveLength(0);
  });
});

describe("v1.4.0 结构校验通过：照常生成（§7）", () => {
  it("passed → 进 Attempt 循环，beat-validation.json 与 metadata 字段齐全", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(SAMPLE_BEAT_VALIDATION)).run(
      SAMPLE_CONFIG,
    );

    expect(result.status).toBe("completed");
    expect(result.beat_validation_status).toBe("completed");
    expect(result.beat_validation).toEqual(SAMPLE_BEAT_VALIDATION);

    const runDir = join(dir, "runs", result.run_id);
    expect(readFileSync(join(runDir, "beat-validation.json"), "utf8")).toBe(
      JSON.stringify(SAMPLE_BEAT_VALIDATION, null, 2),
    );
    expect(existsSync(join(runDir, "attempts", "01", "story.md"))).toBe(true);

    const meta = metaOf(dir, result.run_id);
    expect(meta.beat_validation_status).toBe("completed");
    expect(meta.beat_validation_passed).toBe(true);
    expect(meta.beat_validation_issue_count).toBe(0);
    expect(meta.beat_validation_error).toBeUndefined();
  });

  it("只有 warning 也算通过：不阻断，照常生成正文", async () => {
    const dir = withTmpDir();
    const warned: BeatValidationResult = {
      passed: true,
      issues: [
        {
          code: "ENDING_NOT_PREPARED",
          severity: "warning",
          message: "结局所需条件没有铺垫。",
          beat_ids: [1, 2],
        },
      ],
      summary: "骨架撑得起一个短篇，只差一笔铺垫。",
    };
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(warned)).run(SAMPLE_CONFIG);

    expect(result.status).toBe("completed");
    expect(result.beat_validation?.passed).toBe(true);
    const meta = metaOf(dir, result.run_id);
    expect(meta.beat_validation_passed).toBe(true);
    expect(meta.beat_validation_issue_count).toBe(1);
  });

  it("校验只跑一次：重试时 BeatValidator 不会跟着再来一遍", async () => {
    const dir = withTmpDir();
    const short = "陈岚走进派出所，然后又走了。";
    const llm = new FakeLLM([PLAN_REPLY, short, GOOD_REVIEW, SAMPLE_STORY, GOOD_REVIEW]);
    const beatLlm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_VALIDATION)]);
    const result = await pipelineWith(llm, new ArtifactStore(), new BeatValidator(beatLlm as never), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);

    expect(result.attempt_count).toBe(2);
    expect(beatLlm.prompts).toHaveLength(1);
  });

  it("骨架不被校验改写：beats.json 仍是合法 BeatPlan", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(SAMPLE_BEAT_VALIDATION)).run(
      SAMPLE_CONFIG,
    );
    const stored = JSON.parse(
      readFileSync(join(dir, "runs", result.run_id, "beats.json"), "utf8"),
    ) as unknown;
    expect(() => validateBeatPlan(stored)).not.toThrow();
    expect((stored as BeatPlan).beats).toHaveLength(4);
  });
});

describe("v1.4.0 BeatValidator 自身异常：只记 failed，Run 照常（§12）", () => {
  it("校验器抛异常 → beat_validation_status=failed，正文照样生成", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      validate: () => {
        throw new Error("结构校验模型超时");
      },
    }).run(SAMPLE_CONFIG);

    expect(result.status).toBe("completed");
    expect(result.beat_validation_status).toBe("failed");
    expect(result.beat_validation).toBeNull();
    expect(existsSync(join(dir, "runs", result.run_id, "story.md"))).toBe(true);

    const meta = metaOf(dir, result.run_id);
    expect(meta.beat_validation_status).toBe("failed");
    expect(meta.beat_validation_error).toContain("结构校验模型超时");
    // §12：没有有效结论时 beat_validation_passed / issue_count 都不出现
    expect(meta.beat_validation_passed).toBeUndefined();
    expect(meta.beat_validation_issue_count).toBeUndefined();
    // 没有结论就不写文件——读的人不会拿到半份
    expect(existsSync(join(dir, "runs", result.run_id, "beat-validation.json"))).toBe(false);
    // 骨架本身还在，用户改完还能再来一次
    expect(existsSync(join(dir, "runs", result.run_id, "beats.json"))).toBe(true);
  });

  it("组件异常不会把 Run 判失败：status / quality_status 照旧走完", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      validate: () => {
        throw new Error("模型返回了非 JSON");
      },
    }).run(SAMPLE_CONFIG);
    expect(result.quality_status).toBe("accepted");
    expect(metaOf(dir, result.run_id).status).toBe("completed");
  });
});

describe("v1.4.0 没注入 BeatValidator：这一路等于不存在（§5）", () => {
  it("metadata 里一个 beat_validation 结论字段都不多，也没有 beat-validation.json", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), undefined).run(SAMPLE_CONFIG);

    expect(result.status).toBe("completed");
    expect(result.beat_validation_status).toBe("not_started");
    expect(result.beat_validation).toBeNull();

    const meta = metaOf(dir, result.run_id);
    expect(meta.beat_validation_status).toBe("not_started");
    expect(meta.beat_validation_passed).toBeUndefined();
    expect(meta.beat_validation_issue_count).toBeUndefined();
    expect(meta.beat_validation_error).toBeUndefined();
    expect((meta.artifacts as Record<string, string>).beat_validation).toBeUndefined();
    expect(existsSync(join(dir, "runs", result.run_id, "beat-validation.json"))).toBe(false);
  });

  it("显式注入 null 与不注入行为一致（调用方可以传 undefined/null）", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), null).run(SAMPLE_CONFIG);
    expect(result.beat_validation_status).toBe("not_started");
    expect(existsSync(join(dir, "runs", result.run_id, "beat-validation.json"))).toBe(false);
  });
});

describe("v1.4.0 GenerationResult 形状", () => {
  it("beat_validation / beat_validation_status 是返回值的一部分", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result: GenerationResult = await pipelineWith(llm, new ArtifactStore(), beatValidatorOf(SAMPLE_BEAT_VALIDATION)).run(
      SAMPLE_CONFIG,
    );
    const keys = Object.keys(result).sort();
    expect(keys).toContain("beat_validation");
    expect(keys).toContain("beat_validation_status");
  });
});
