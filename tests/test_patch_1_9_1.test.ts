import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { ArtifactStore, ArtifactWriteError } from "@/storage/artifact-store";
import { analyzeStoredRun, failureAnalysisInputOf } from "@/lib/failure-analysis-service";
import { getRunFailureAnalysis } from "@/lib/generate-service";
import { FailureAnalyzer } from "@/core/failure-analyzer";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { BeatValidationResult } from "@/types/beat-validation";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { CommercialReviewResult } from "@/types/commercial-review";
import type { RepairRequest, RepairResult } from "@/types/repair";
import type { FailureAnalysisInput } from "@/types/failure-analysis";
import type { RunTelemetry } from "@/types/telemetry";

/**
 * 1.9.1 补丁的回归：1.8.0 / 1.9.0 发布后逐个读代码查出来的真问题。
 *
 * 没有新能力、没有新语义，只有十条修复：
 *   T1 非阻断的失败步骤在 telemetry.json 里被记成 completed（该是 failed + 稳定码）
 *   T2 产物晋升失败时，失败阶段指到上一个已经跑完的步骤，指不到 promotion 自己
 *   T3 产物文件被换成同名目录 / 读不动时，读接口整套 500（该按「没有这份产物」处理）
 *   T4 遥测拿不到时，metadata 里两个转述键照样写上 null（说好的是「不写」）
 *   T5 Run 级 durationMs 没取整，与每条阶段的整数毫秒口径不一致
 *   F1 跑成了的 Run（组件自己崩过）被失败分析判成 detected，摘要还说「未能完成」
 *   F2 修订耗尽没有采纳闸门，且「最后一轮修订」按轮次号取，跨 Attempt 取错那一轮
 *   F3 修订耗尽的文案拿 Run 级合计去比每次 Attempt 的上限，两个口径混成一句话
 *   F4 没有 telemetry.json 时，证据仍然指着这个盘上不存在的文件
 *   F5 证据结构里有 attemptId / repairId，分析器一个都没填过（面板那一列永远是「—」）
 *
 * 全部用 Fake 组件与假磁盘，绝不调用真实付费 API。
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

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
};

const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;
const REPAIRED = `修订后：${STORY}`;

const OK: ValidationResult = { passed: true, issues: [] };
const TOO_SHORT: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度明显短于目标字数。" }],
};

const BEAT_OK: BeatValidationResult = {
  passed: true,
  issues: [],
  summary: "骨架结构完整。",
};

const COMMERCIAL_OK: CommercialReviewResult = {
  score: 76,
  summary: "可读性良好。",
  strengths: ["开场有钩子"],
  problems: [],
  suggestions: [],
  dimensions: {
    hook: { score: 78, summary: "s" },
    pacing: { score: 74, summary: "s" },
    engagement: { score: 76, summary: "s" },
    payoff: { score: 76, summary: "s" },
  },
};

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-patch-1-9-1-"));
  process.chdir(tmp);
  return tmp;
}

interface Components {
  generator: { generate: () => Promise<string> };
  validator: { validate: () => Promise<ValidationResult> };
  reviewer: { review: () => Promise<ReviewResult> };
  beatValidator?: { validate: () => Promise<BeatValidationResult> };
  commercialReviewer?: { review: () => Promise<CommercialReviewResult> };
  repairer?: { repair: (r: RepairRequest) => Promise<RepairResult> };
  store?: ArtifactStore;
  policy?: Partial<RetryPolicy>;
}

function pipelineOf(c: Components): GenerationPipeline {
  return new GenerationPipeline(
    { plan: async () => plan } as never,
    c.generator as never,
    c.validator as never,
    c.reviewer as never,
    c.store ?? new ArtifactStore(),
    { ...DEFAULT_RETRY_POLICY, ...c.policy },
    c.repairer as never,
    undefined,
    undefined,
    undefined,
    c.beatValidator as never,
    c.commercialReviewer as never,
  );
}

function runDirOf(dir: string, runId: string): string {
  return join(dir, "runs", runId);
}

function telemetryOf(dir: string, runId: string): RunTelemetry {
  return JSON.parse(readFileSync(join(runDirOf(dir, runId), "telemetry.json"), "utf8")) as RunTelemetry;
}

function metadataOf(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runDirOf(dir, runId), "metadata.json"), "utf8"),
  ) as Record<string, unknown>;
}

function analysisOf(dir: string, runId: string) {
  return JSON.parse(
    readFileSync(join(runDirOf(dir, runId), "failure-analysis.json"), "utf8"),
  ) as ReturnType<FailureAnalyzer["analyze"]>;
}

function stageOf(telemetry: RunTelemetry, stage: string) {
  return telemetry.stages.find((s) => s.stage === stage);
}

/** 一次跑成功的默认组件组合：Plan → Generate → Validate → Review 全过。 */
function happy(patch: Partial<Components> = {}): Components {
  return {
    generator: { generate: async () => STORY },
    validator: { validate: async () => OK },
    reviewer: { review: async () => review },
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// T1 / T5 阶段收尾与总时长
// ---------------------------------------------------------------------------

describe("T1 非阻断的失败步骤：记 failed 带稳定码，不冒充 completed", () => {
  it("第一次生成失败、第二次成功：两条 generating，第一条 failed，Run 仍是 completed", async () => {
    const dir = withTmpDir();
    let calls = 0;
    const result = await pipelineOf(
      happy({
        generator: {
          generate: async () => {
            calls += 1;
            if (calls === 1) throw new Error("模型这一跳没有回应");
            return STORY;
          },
        },
        policy: { max_attempts: 2 },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const telemetry = telemetryOf(dir, result.run_id);
    expect(telemetry.status).toBe("completed");
    // 跑成了的 Run 没有失败码：failureCode 这个键根本不出现
    expect("failureCode" in telemetry).toBe(false);

    const generating = telemetry.stages.filter((s) => s.stage === "generating");
    expect(generating).toHaveLength(2);
    expect(generating[0].status).toBe("failed");
    expect(generating[0].errorCode).toBeTruthy();
    // 稳定码，不带异常原文
    expect(generating[0].errorCode).not.toContain("模型这一跳没有回应");
    expect(generating[1].status).toBe("completed");
    // 汇总里这一条真的算失败步骤
    expect(telemetry.totals.failedStages).toBe(1);
  });

  it("骨架校验组件崩溃：validating_beat_plan 记 failed，生成照常继续", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        beatValidator: {
          validate: async () => {
            throw new Error("骨架校验这一跳崩了");
          },
        },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const telemetry = telemetryOf(dir, result.run_id);
    const stage = stageOf(telemetry, "validating_beat_plan");
    expect(stage?.status).toBe("failed");
    expect(stage?.errorCode).toBe("BEAT_VALIDATION_COMPONENT_FAILED");
    expect(stage?.errorCode).not.toContain("骨架校验这一跳崩了");
  });

  it("正文校验组件崩溃：validating 记 failed，不拖垮 Run", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        validator: {
          validate: async () => {
            throw new Error("校验器这一跳崩了");
          },
        },
        policy: { max_attempts: 1 },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const telemetry = telemetryOf(dir, result.run_id);
    const stage = stageOf(telemetry, "validating");
    expect(stage?.status).toBe("failed");
    expect(stage?.errorCode).toBe("VALIDATION_COMPONENT_FAILED");
  });

  it("审阅组件崩溃：reviewing 记 failed，Run 仍 completed 且没有失败码", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        reviewer: {
          review: async () => {
            throw new Error("审阅这一跳崩了");
          },
        },
        policy: { max_attempts: 1 },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    expect(result.review_status).toBe("failed");
    const telemetry = telemetryOf(dir, result.run_id);
    const stage = stageOf(telemetry, "reviewing");
    expect(stage?.status).toBe("failed");
    expect(stage?.errorCode).toBe("REVIEW_COMPONENT_FAILED");
    expect("failureCode" in telemetry).toBe(false);
  });

  it("商业审阅组件崩溃：reviewing_commercial 记 failed", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        commercialReviewer: {
          review: async () => {
            throw new Error("商业审阅这一跳崩了");
          },
        },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const telemetry = telemetryOf(dir, result.run_id);
    const stage = stageOf(telemetry, "reviewing_commercial");
    expect(stage?.status).toBe("failed");
    expect(stage?.errorCode).toBe("COMMERCIAL_REVIEW_COMPONENT_FAILED");
  });
});

describe("T5 Run 级 durationMs 与每条阶段同一个取整口径", () => {
  it("durationMs 与 totals.durationMs 都是整数毫秒", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(happy()).run(config);
    const telemetry = telemetryOf(dir, result.run_id);

    expect(Number.isInteger(telemetry.durationMs)).toBe(true);
    expect(Number.isInteger(telemetry.totals.durationMs)).toBe(true);
    expect(telemetry.durationMs).toBeGreaterThanOrEqual(0);
    for (const stage of telemetry.stages) {
      // skipped 的那几步没有起止时间，durationMs 这个键根本不出现
      if (stage.durationMs == null) continue;
      expect(Number.isInteger(stage.durationMs), stage.stage).toBe(true);
    }
  });

  it("骨架校验与商业审阅都注入了的正路：没有一步是 failed，也没有失败码", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        beatValidator: { validate: async () => BEAT_OK },
        commercialReviewer: { review: async () => COMMERCIAL_OK },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const telemetry = telemetryOf(dir, result.run_id);
    expect(telemetry.totals.failedStages).toBe(0);
    expect("failureCode" in telemetry).toBe(false);
    for (const stage of telemetry.stages) {
      expect(["completed", "skipped"], `${stage.stage}=${stage.status}`).toContain(stage.status);
    }

    expect(analysisOf(dir, result.run_id).status).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// T2 产物晋升的失败归属
// ---------------------------------------------------------------------------

describe("T2 产物晋升失败：失败阶段指到 artifact_promotion 自己", () => {
  it("promoteAttempt 抛 ArtifactWriteError：failureStage / current_stage / 失败分类都指到这一步", async () => {
    const dir = withTmpDir();
    class BrokenPromotion extends ArtifactStore {
      override promoteAttempt(): Record<string, string> {
        throw new ArtifactWriteError("story.md", new Error("ENOSPC"));
      }
    }
    const err = await pipelineOf(happy({ store: new BrokenPromotion() }))
      .run(config)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PipelineError);
    const runId = (err as PipelineError).runId;
    expect(runId).not.toBe("");

    const telemetry = telemetryOf(dir, runId);
    expect(telemetry.status).toBe("failed");
    expect(telemetry.failureStage).toBe("artifact_promotion");
    const promo = stageOf(telemetry, "artifact_promotion");
    expect(promo?.status).toBe("failed");
    expect(promo?.errorCode).toBe("ARTIFACT_WRITE_FAILED");

    const meta = metadataOf(dir, runId);
    expect(meta.current_stage).toBe("artifact_promotion");

    const analysis = analysisOf(dir, runId);
    expect(analysis.primaryCategory).toBe("STORAGE");
    expect(analysis.firstFailureStage).toBe("artifact_promotion");
    expect(analysis.summary).toContain("artifact_promotion");
  });
});

// ---------------------------------------------------------------------------
// T4 metadata 的两个转述键
// ---------------------------------------------------------------------------

describe("T4 遥测拿不到时，metadata 的两个转述键整个不出现", () => {
  it("putTelemetry 失败（成功路径）：duration_ms / llm_call_count 都不写，Run 照常 completed", async () => {
    const dir = withTmpDir();
    class NoTelemetry extends ArtifactStore {
      override putTelemetry(): string {
        throw new Error("磁盘只读");
      }
    }
    const result = await pipelineOf(happy({ store: new NoTelemetry() })).run(config);
    expect(result.status).toBe("completed");

    const meta = metadataOf(dir, result.run_id);
    expect("duration_ms" in meta).toBe(false);
    expect("llm_call_count" in meta).toBe(false);
  });

  it("putTelemetry 失败（失败路径）：同样一个键都不多写", async () => {
    const dir = withTmpDir();
    class NoTelemetry extends ArtifactStore {
      override putTelemetry(): string {
        throw new Error("磁盘只读");
      }
    }
    const err = await pipelineOf(
      happy({
        store: new NoTelemetry(),
        generator: {
          generate: async () => {
            throw new Error("模型这一跳没有回应");
          },
        },
        policy: { max_attempts: 1 },
      }),
    )
      .run(config)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);
    const runId = (err as PipelineError).runId;

    const meta = metadataOf(dir, runId);
    expect("duration_ms" in meta).toBe(false);
    expect("llm_call_count" in meta).toBe(false);
  });

  it("遥测正常时两个键都在，而且就是遥测里的那两个数", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(happy()).run(config);
    const meta = metadataOf(dir, result.run_id);
    const telemetry = telemetryOf(dir, result.run_id);

    expect(meta.duration_ms).toBe(telemetry.totals.durationMs);
    expect(meta.llm_call_count).toBe(telemetry.totals.llmCalls);
  });
});

// ---------------------------------------------------------------------------
// T3 读路径兜底
// ---------------------------------------------------------------------------

describe("T3 读不动就当「没有这份产物」，不让接口整套 500", () => {
  it("telemetry / metadata / manifest / 失败分析 / story 被换成同名目录：一律读到 null", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(happy()).run(config);
    const runDir = runDirOf(dir, result.run_id);

    const replaced = [
      "telemetry.json",
      "metadata.json",
      "run-manifest.json",
      "failure-analysis.json",
      "story.md",
    ];
    for (const name of replaced) {
      rmSync(join(runDir, name), { force: true });
      mkdirSync(join(runDir, name));
    }

    const store = new ArtifactStore("runs");
    expect(store.readRunTelemetry(result.run_id)).toBeNull();
    expect(store.readRunMetadata(result.run_id)).toBeNull();
    expect(store.readRunManifest(result.run_id)).toBeNull();
    expect(store.readFailureAnalysis(result.run_id)).toBeNull();
    expect(store.readFinalStory(result.run_id)).toBeNull();
    // 装配失败分析输入时同样不抛：这次读不到事实，就按「没有」算
    const input = failureAnalysisInputOf(result.run_id, store);
    expect(input.telemetry).toBeNull();
    expect(analyzeStoredRun(result.run_id, store).status).toBe("none");
  });

  it("读接口给 200 + null，不是 500", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(happy()).run(config);
    const runDir = runDirOf(dir, result.run_id);
    rmSync(join(runDir, "failure-analysis.json"), { force: true });
    mkdirSync(join(runDir, "failure-analysis.json"));

    const lookup = await getRunFailureAnalysis(result.run_id, new ArtifactStore("runs"));
    expect(lookup.status).toBe(200);
    expect(lookup.json).toEqual({ failureAnalysis: null });
  });
});

// ---------------------------------------------------------------------------
// F1 跑成了的 Run 不许被判成失败
// ---------------------------------------------------------------------------

describe("F1 跑成了的 Run：组件自己崩过也还是 status = none", () => {
  it("唯一一次 Attempt 的审阅组件崩溃、Run 照常收尾：失败分析是 none，不是什么 detected", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        reviewer: {
          review: async () => {
            throw new Error("审阅这一跳崩了");
          },
        },
        policy: { max_attempts: 1 },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const meta = metadataOf(dir, result.run_id);
    expect(meta.review_status).toBe("failed");
    expect(meta.status).toBe("completed");

    const analysis = analysisOf(dir, result.run_id);
    expect(analysis.status).toBe("none");
    expect(analysis.primaryCategory).toBeNull();
    expect(analysis.secondaryCategories).toEqual([]);
    expect(analysis.signals).toEqual([]);
    expect(analysis.summary).toBe("No run-level failure detected.");
    // metadata 的两个摘要字段也跟着说实话
    expect(meta.failure_analysis_status).toBe("none");
    expect("primary_failure_category" in meta).toBe(false);
  });

  it("骨架校验组件崩溃、正文照常跑成：同样是 none", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        beatValidator: {
          validate: async () => {
            throw new Error("骨架校验这一跳崩了");
          },
        },
      }),
    ).run(config);

    expect(result.status).toBe("completed");
    const analysis = analysisOf(dir, result.run_id);
    expect(analysis.status).toBe("none");
    expect(analysis.primaryCategory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F2 修订耗尽：采纳闸门与「最后一轮修订」
// ---------------------------------------------------------------------------

describe("F2 修订耗尽", () => {
  const analyzer = new FailureAnalyzer();

  /** 一个 accepted Run，只是在被采纳之前有一轮没修成的修订。 */
  function acceptedAfterFailedRepair(): FailureAnalysisInput {
    return {
      runId: "20260926_120000_ab12cd",
      status: "completed",
      qualityStatus: "accepted",
      attemptCount: 2,
      selectedAttempt: 2,
      maxAttempts: 2,
      minReviewScore: 70,
      enableRepair: true,
      maxRepairsPerAttempt: 1,
      repairCount: 1,
      telemetry: null,
      beatValidation: null,
      beatValidationStatus: "not_started",
      validation: null,
      validationStatus: "completed",
      review: null,
      reviewStatus: "completed",
      commercialReview: null,
      commercialReviewStatus: "not_started",
      quality: {
        overall_score: 82,
        validation_passed: true,
        accepted: true,
        issues: [],
        suggestions: [],
        summary: "ok",
      },
      attempts: [
        {
          attemptNumber: 1,
          accepted: false,
          retryReason: "validation_failed",
          validationPassed: false,
          repairCount: 1,
          repairs: [{ repairNumber: 1, issueType: "ending", success: false }],
        },
        {
          attemptNumber: 2,
          accepted: true,
          retryReason: null,
          validationPassed: true,
          repairCount: 0,
          repairs: [],
        },
      ],
      errorCodes: [],
      artifactPresence: {
        story: true,
        beatValidation: false,
        validation: true,
        review: true,
        commercialReview: false,
        quality: true,
        manifest: true,
        telemetry: true,
      },
    };
  }

  it("最终被采纳的 Run：修订轮数到了上限也不是修订耗尽", () => {
    const out = analyzer.analyze(acceptedAfterFailedRepair());
    expect(out.status).toBe("none");
    expect(out.signals.map((s) => s.code)).not.toContain("REPAIR_LIMIT_REACHED");
    expect(out.secondaryCategories).not.toContain("REPAIR_EXHAUSTION");
  });

  it("「最后一轮修订」是真正最后发生的那一轮，不是轮次号最大的那一轮", () => {
    const input = acceptedAfterFailedRepair();
    // 都没被采纳，于是只看「最后一轮修订有没有修好」：
    // 第一次尝试修了两轮都没成，第二次尝试那一轮修成了——最后一轮是成功的
    input.qualityStatus = "exhausted";
    input.attempts[1].accepted = false;
    input.attempts[1].retryReason = "validation_failed";
    input.quality = { ...input.quality!, validation_passed: true, accepted: false, overall_score: 82 };
    input.attempts[0].repairs.push({ repairNumber: 2, issueType: "ending", success: false });
    input.attempts[1].repairs.push({ repairNumber: 1, issueType: "ending", success: true });
    input.repairCount = 3;

    const out = analyzer.analyze(input);
    expect(out.signals.map((s) => s.code)).not.toContain("REPAIR_LIMIT_REACHED");
  });

  it("真的修不动：耗尽照旧报得出来（这条不能被上面的闸门一起关掉）", () => {
    const input = acceptedAfterFailedRepair();
    input.qualityStatus = "exhausted";
    input.attempts[1].accepted = false;
    input.attempts[1].retryReason = "validation_failed";
    input.quality = { ...input.quality!, validation_passed: false, accepted: false, overall_score: 60 };
    input.status = "failed";
    input.validation = TOO_SHORT;
    input.validationStatus = "failed";
    input.attempts[1].repairs.push({ repairNumber: 1, issueType: "ending", success: false });

    const out = analyzer.analyze(input);
    expect(out.signals.map((s) => s.code)).toContain("REPAIR_LIMIT_REACHED");
    expect(out.secondaryCategories).toContain("REPAIR_EXHAUSTION");
  });
});

// ---------------------------------------------------------------------------
// F3 修订耗尽的文案口径
// ---------------------------------------------------------------------------

describe("F3 修订耗尽的文案说清两个口径", () => {
  it("Run 级合计与每次 Attempt 的上限分开说，不混成一个数", () => {
    const input: FailureAnalysisInput = {
      runId: "20260926_120000_ab12cd",
      status: "failed",
      qualityStatus: "exhausted",
      attemptCount: 2,
      selectedAttempt: null,
      maxAttempts: 2,
      minReviewScore: 70,
      enableRepair: true,
      maxRepairsPerAttempt: 2,
      repairCount: 3,
      telemetry: null,
      beatValidation: null,
      beatValidationStatus: "not_started",
      validation: TOO_SHORT,
      validationStatus: "failed",
      review: null,
      reviewStatus: "completed",
      commercialReview: null,
      commercialReviewStatus: "not_started",
      quality: {
        overall_score: 60,
        validation_passed: false,
        accepted: false,
        issues: [],
        suggestions: [],
        summary: "no",
      },
      attempts: [
        {
          attemptNumber: 1,
          accepted: false,
          retryReason: "validation_failed",
          validationPassed: false,
          repairCount: 2,
          repairs: [
            { repairNumber: 1, issueType: "ending", success: false },
            { repairNumber: 2, issueType: "ending", success: false },
          ],
        },
        {
          attemptNumber: 2,
          accepted: false,
          retryReason: "validation_failed",
          validationPassed: false,
          repairCount: 1,
          repairs: [{ repairNumber: 1, issueType: "ending", success: false }],
        },
      ],
      errorCodes: [],
      artifactPresence: {
        story: true,
        beatValidation: false,
        validation: true,
        review: true,
        commercialReview: false,
        quality: true,
        manifest: true,
        telemetry: true,
      },
    };

    const out = new FailureAnalyzer().analyze(input);
    const signal = out.signals.find((s) => s.code === "REPAIR_LIMIT_REACHED");
    expect(signal).toBeDefined();
    // 3 是 Run 级合计，2 是每次 Attempt 的上限——两个口径分开说，
    // 读者不会把「3 轮达到上限 2」读成同一件事
    expect(signal!.message).toContain("本次 Run 共 3 轮修订");
    expect(signal!.message).toContain("每次 Attempt 上限 2 轮");
    const evidence = out.evidence.find((e) => e.sourceField === "repair_count");
    expect(evidence?.note).toContain("Run 级合计");
    expect(evidence?.note).toContain("每次 Attempt 上限");
  });
});

// ---------------------------------------------------------------------------
// F4 证据指向盘上真有的文件
// ---------------------------------------------------------------------------

describe("F4 没有那份文件时，证据不指", () => {
  const analyzer = new FailureAnalyzer();

  it("没有 telemetry.json 的 Run：未登记错误码的证据只留码与说明", () => {
    const out = analyzer.analyze({
      runId: "20260926_120000_ab12cd",
      status: "failed",
      qualityStatus: "exhausted",
      attemptCount: 1,
      selectedAttempt: null,
      maxAttempts: 1,
      minReviewScore: 70,
      enableRepair: false,
      maxRepairsPerAttempt: 0,
      repairCount: 0,
      telemetry: null,
      beatValidation: null,
      beatValidationStatus: "not_started",
      validation: null,
      validationStatus: "not_started",
      review: null,
      reviewStatus: "not_started",
      commercialReview: null,
      commercialReviewStatus: "not_started",
      quality: null,
      attempts: [],
      errorCodes: ["SOME_NEW_CODE"],
      artifactPresence: {
        story: true,
        beatValidation: false,
        validation: false,
        review: false,
        commercialReview: false,
        quality: false,
        manifest: false,
        telemetry: false,
      },
    });

    const evidence = out.evidence.find((e) => e.code === "SOME_NEW_CODE");
    expect(evidence).toBeDefined();
    expect(evidence!.sourceArtifact ?? null).toBeNull();
    expect(evidence!.sourceField ?? null).toBeNull();
  });

  it("有 telemetry.json 时，证据照旧指到 telemetry.json 的 failureCode", () => {
    const telemetry: RunTelemetry = {
      schemaVersion: "1",
      runId: "20260926_120000_ab12cd",
      startedAt: "2026-09-26T12:00:00.000Z",
      status: "failed",
      completedAt: "2026-09-26T12:00:05.000Z",
      durationMs: 5000,
      failureStage: "generating",
      failureCode: "SOME_NEW_CODE",
      stages: [],
      llmCalls: [],
      attempts: [],
      repairs: [],
      totals: {
        durationMs: 5000,
        llmCalls: 1,
        inputTokens: null,
        outputTokens: null,
        usageSampleCount: 0,
        retries: 0,
        repairs: 0,
        failedStages: 1,
      },
    };
    const out = analyzer.analyze({
      runId: "20260926_120000_ab12cd",
      status: "failed",
      qualityStatus: "exhausted",
      attemptCount: 1,
      selectedAttempt: null,
      maxAttempts: 1,
      minReviewScore: 70,
      enableRepair: false,
      maxRepairsPerAttempt: 0,
      repairCount: 0,
      telemetry,
      beatValidation: null,
      beatValidationStatus: "not_started",
      validation: null,
      validationStatus: "not_started",
      review: null,
      reviewStatus: "not_started",
      commercialReview: null,
      commercialReviewStatus: "not_started",
      quality: null,
      attempts: [],
      errorCodes: ["SOME_NEW_CODE"],
      artifactPresence: {
        story: true,
        beatValidation: false,
        validation: false,
        review: false,
        commercialReview: false,
        quality: false,
        manifest: false,
        telemetry: true,
      },
    });

    const evidence = out.evidence.find((e) => e.code === "SOME_NEW_CODE");
    expect(evidence?.sourceArtifact).toBe("telemetry.json");
    expect(evidence?.sourceField).toBe("failureCode");
  });
});

// ---------------------------------------------------------------------------
// F5 证据指到具体哪一次 Attempt、哪一轮修订
// ---------------------------------------------------------------------------

describe("F5 修订相关的证据带着 attemptId 与 repairId", () => {
  it("落盘的分析里，修订证据能指到具体那一轮", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      happy({
        validator: { validate: async () => TOO_SHORT },
        policy: { max_attempts: 1, max_repairs_per_attempt: 1 },
        repairer: {
          repair: async (request: RepairRequest): Promise<RepairResult> => ({
            repaired_story: REPAIRED,
            issue_type: request.issue_type,
            // 修订调用本身没跑成：这一轮是失败的
            success: false,
            notes: null,
          }),
        },
      }),
    ).run(config);

    expect(result.quality_status).toBe("exhausted");
    const analysis = analysisOf(dir, result.run_id);
    expect(analysis.signals.map((s) => s.code)).toContain("REPAIR_LIMIT_REACHED");

    const manifestEvidence = analysis.evidence.find(
      (e) => e.sourceArtifact === "run-manifest.json" && e.sourceField === "repairs[].succeeded",
    );
    expect(manifestEvidence).toBeDefined();
    expect(manifestEvidence!.attemptId).toBeTruthy();
    expect(manifestEvidence!.repairId).toBeTruthy();

    // 指的那个 id 在 Manifest 里真的存在，不是拼出来的
    const manifest = JSON.parse(
      readFileSync(join(runDirOf(dir, result.run_id), "run-manifest.json"), "utf8"),
    ) as { attempts?: Array<{ attemptId: string }>; repairs?: Array<{ repairId: string }> };
    expect((manifest.attempts ?? []).map((a) => a.attemptId)).toContain(manifestEvidence!.attemptId);
    expect((manifest.repairs ?? []).map((r) => r.repairId)).toContain(manifestEvidence!.repairId);
  });
});
