import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FailureAnalyzer } from "@/analysis/failure-analyzer";
import { failureAnalysisInputOf } from "@/analysis/failure-analysis-service";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import type { FailureAnalysisInput } from "@/domain/failure-analysis";
import type { QualityDiagnostic } from "@/domain/quality-diagnostic";
import { countDiagnosticsBySeverity } from "@/domain/quality-diagnostic";
import { validateQualityStackResult, qualityStackStatusOf, type QualityStackResult } from "@/domain/quality-stack";
import { validateQualityReviewV2Result } from "@/domain/quality-review-v2";
import { validateCommercialReviewV2Result } from "@/domain/commercial-review-v2";
import { validateBeatValidationV2Result } from "@/domain/beat-validation-v2";
import {
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_QUALITY_REVIEW_V2,
} from "./helpers/fixtures";

/**
 * v2.1.0 TASK §29：FailureAnalyzer 把 quality-stack.json 当结构化信号源。
 *
 * 四条硬要求，一条都不松：
 *   1. deterministic——同一输入两次分析，结论逐字相同；
 *   2. 不调 LLM、不碰网络——整个用例没有一个 stub 过的 fetch；
 *   3. 不做根因归因——没有任何一句话解释「为什么」会这样，只念盘上写着的事；
 *   4. 不重新评分——分数与 severity 原样照抄，一个都不改。
 *
 * 还有一条本版本特有的边界：质量组件没接 / 崩过，不升级成 Run 级失败。
 * v1.9.1 定下的规则在 v2.1.0 继续有效——否则一次跑成了的 Run 会因为在
 * v2.0.0 流水线里根本没接质量组件，就被判成 detected。
 */

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
  tmp = mkdtempSync(join(tmpdir(), "storyloop-failure-quality-stack-"));
  process.chdir(tmp);
  return tmp;
}

/** 一次「跑成了、也被采纳」的干净 Run：每个用例在这之上改一项。 */
function clean(): FailureAnalysisInput {
  return {
    runId: "20260927_120000_ab12cd",
    status: "completed",
    qualityStatus: "accepted",
    attemptCount: 1,
    selectedAttempt: 1,
    maxAttempts: 2,
    minReviewScore: 70,
    enableRepair: true,
    maxRepairsPerAttempt: 1,
    repairCount: 0,
    telemetry: null,
    beatValidation: null,
    beatValidationStatus: "not_started",
    validation: null,
    validationStatus: "completed",
    review: null,
    reviewStatus: "completed",
    commercialReview: null,
    commercialReviewStatus: "completed",
    quality: null,
    qualityStack: null,
    attempts: [
      { attemptNumber: 1, accepted: true, retryReason: null, validationPassed: true, repairCount: 0, repairs: [] },
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

function diagnostic(
  source: QualityDiagnostic["source"],
  category: string,
  severity: QualityDiagnostic["severity"],
  message: string,
): QualityDiagnostic {
  return {
    id: `${source}-1`,
    source,
    category,
    severity,
    target: source === "beat-validator" ? "beat-plan" : "story",
    message,
  };
}

/** 用真正的那套校验造一份 stack：形状不合法时用例自己就先炸，不会蒙混过关。 */
function stackOf(modules: {
  beatValidation?: unknown;
  qualityReview?: unknown;
  commercialReview?: unknown;
  diagnostics?: QualityDiagnostic[];
}): QualityStackResult {
  const diagnostics = modules.diagnostics ?? [];
  const present = {
    beatValidation: (modules.beatValidation ?? null) as never,
    qualityReview: (modules.qualityReview ?? null) as never,
    commercialReview: (modules.commercialReview ?? null) as never,
  };
  return validateQualityStackResult({
    schemaVersion: "1",
    status: qualityStackStatusOf(present),
    ...modules,
    diagnostics,
    summary: countDiagnosticsBySeverity(diagnostics),
  });
}

/** 三套结论齐全 + 给定诊断：最常见的 complete 形态。 */
function completeStack(diagnostics: QualityDiagnostic[]): QualityStackResult {
  return stackOf({
    beatValidation: SAMPLE_BEAT_VALIDATION_V2,
    qualityReview: SAMPLE_QUALITY_REVIEW_V2,
    commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
    diagnostics,
  });
}

const analyzer = new FailureAnalyzer();

describe("v2.1.0 TASK §29 quality-stack.json 作为结构化信号源", () => {
  it("旧 Run 没有这份文件：一条 quality-stack 信号都不发，成功的 Run 仍是 none", () => {
    const out = analyzer.analyze(clean());
    expect(out.status).toBe("none");
    expect(out.signals).toEqual([]);
    expect(out.evidence).toEqual([]);
    expect(out.signals.some((s) => s.source === "quality-stack")).toBe(false);
  });

  it("三套齐全且只有 warning 诊断：没有完整度信号，也没有错误级信号", () => {
    const stack = completeStack([
      diagnostic("quality-reviewer", "repetition", "warning", "中段两场戏功能重复。"),
      diagnostic("commercial-reviewer", "repetitive_middle", "info", "中段重复出现同一场戏。"),
    ]);
    const out = analyzer.analyze({ ...clean(), qualityStack: stack });

    expect(out.signals.some((s) => s.source === "quality-stack")).toBe(false);
    // 分析器不把 warning 说成 error：跑成了的 Run 不许被判成失败
    expect(out.status).toBe("none");
  });

  it("跑成了的 Run + 不完整的质量视图：一道信号都不发（§49 成功 Run 干干净净）", () => {
    // 完整度只是观察，与 §42 的产物存在性同一口径：没有失败证据时整份信号表是空的
    const partial = analyzer.analyze({
      ...clean(),
      qualityStack: stackOf({
        beatValidation: SAMPLE_BEAT_VALIDATION_V2,
        qualityReview: SAMPLE_QUALITY_REVIEW_V2,
      }),
    });
    expect(partial.status).toBe("none");
    expect(partial.signals).toEqual([]);

    const empty = analyzer.analyze({ ...clean(), qualityStack: stackOf({}) });
    expect(empty.status).toBe("none");
    expect(empty.signals).toEqual([]);
  });

  it("失败的 Run 少了几套结论：报完整度观察，warning、不定类，不顶掉主要失败类别", () => {
    const stack = stackOf({
      beatValidation: SAMPLE_BEAT_VALIDATION_V2,
      qualityReview: SAMPLE_QUALITY_REVIEW_V2,
    });
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      errorCodes: ["GENERATION_FAILED"],
      qualityStack: stack,
    });

    const signal = out.signals.find((s) => s.code === "QUALITY_STACK_PARTIAL");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("warning");
    expect(signal!.message).toContain("商业可读性审阅");
    // 完整度只是观察：不进任何类别，于是主要失败类别不会被它顶掉
    expect(out.primaryCategory).toBe("GENERATION");
    expect(out.secondaryCategories).toEqual([]);
  });

  it("失败的 Run 一套结论都没有：同样只是完整度观察，不是失败类别", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      errorCodes: ["GENERATION_FAILED"],
      // v2.0.0 的流水线本来就没接这几路组件：stack 是空的不代表这次 Run 失败
      qualityStack: stackOf({}),
    });

    const signal = out.signals.find((s) => s.code === "QUALITY_STACK_EMPTY");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("warning");
    expect(out.primaryCategory).toBe("GENERATION");
    expect(out.secondaryCategories).toEqual([]);
  });

  it("故事质量审阅记了错误级诊断：这是分析器此前看不到的一层事实", () => {
    const stack = completeStack([
      diagnostic("quality-reviewer", "causal_gap", "error", "配角反水没有任何前文支撑。"),
    ]);
    const out = analyzer.analyze({ ...clean(), qualityStack: stack });

    const signal = out.signals.find((s) => s.code === "QUALITY_DIAGNOSTIC_ERROR");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("error");
    expect(signal!.source).toBe("quality-stack");
    expect(signal!.message).toContain("quality-reviewer / causal_gap");
    // 分类口径与「质量分低于阈值」同源：审阅侧自己判定的硬问题归 QUALITY
    expect(out.primaryCategory).toBe("QUALITY");
    // 证据指到合并视图里的那一条 id，读者能顺着找回去
    const evidence = out.evidence.find((e) => e.sourceField === "diagnostics[].id");
    expect(evidence?.sourceArtifact).toBe("quality-stack.json");
    expect(evidence?.code).toBe("quality-reviewer-1");
  });

  it("商业可读性审阅记了错误级诊断：归 COMMERCIAL，与「商业分偏低」同一类", () => {
    const stack = completeStack([
      diagnostic("commercial-reviewer", "weak_payoff", "error", "高潮没有兑现前文许诺的代价。"),
    ]);
    const out = analyzer.analyze({ ...clean(), qualityStack: stack });

    expect(out.primaryCategory).toBe("COMMERCIAL");
    expect(out.signals.find((s) => s.code === "QUALITY_DIAGNOSTIC_ERROR")?.message).toContain(
      "commercial-reviewer / weak_payoff",
    );
  });

  it("骨架层的错误诊断不在这里重复念：§6 已经逐条从 beat-validation.json 取过", () => {
    const stack = completeStack([
      diagnostic("beat-validator", "MISSING_CLIMAX", "error", "第 4 拍直接跳到结局。"),
      diagnostic("quality-reviewer", "causal_gap", "error", "配角反水没有前文支撑。"),
    ]);
    const out = analyzer.analyze({ ...clean(), qualityStack: stack });

    const qualityStackSignals = out.signals.filter((s) => s.source === "quality-stack");
    expect(qualityStackSignals).toHaveLength(1);
    expect(qualityStackSignals[0].message).toContain("quality-reviewer");
    expect(qualityStackSignals[0].message).not.toContain("beat-validator");
  });

  it("确定性：同一输入分析两次，结论逐字相同", () => {
    const stack = completeStack([
      diagnostic("quality-reviewer", "causal_gap", "error", "配角反水没有前文支撑。"),
      diagnostic("commercial-reviewer", "weak_payoff", "error", "高潮没有兑现代价。"),
    ]);
    const input = { ...clean(), qualityStack: stack };
    expect(analyzer.analyze(input)).toEqual(analyzer.analyze(input));
  });

  it("磁盘往返：装配器真把 quality-stack.json 读进来，读不到时是 null", () => {
    const dir = withTmpDir();
    const runId = "20260927_120000_stack01";
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const stack = completeStack([
      diagnostic("quality-reviewer", "causal_gap", "error", "配角反水没有前文支撑。"),
    ]);
    writeFileSync(join(runDir, "quality-stack.json"), JSON.stringify(stack), "utf8");

    const store = new ArtifactStore("runs");
    const input = failureAnalysisInputOf(runId, store);
    expect(input.qualityStack).toEqual(stack);

    const out = analyzer.analyze(input);
    expect(out.signals.find((s) => s.code === "QUALITY_DIAGNOSTIC_ERROR")).toBeDefined();

    rmSync(join(runDir, "quality-stack.json"));
    expect(failureAnalysisInputOf(runId, store).qualityStack).toBeNull();
  });

  it("quality-stack.json 被手改坏：宽容读取给 null，分析器照样出结论", () => {
    const dir = withTmpDir();
    const runId = "20260927_120000_stack02";
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "quality-stack.json"), "{ 这不是 JSON", "utf8");

    const store = new ArtifactStore("runs");
    expect(failureAnalysisInputOf(runId, store).qualityStack).toBeNull();
    expect(analyzer.analyze(failureAnalysisInputOf(runId, store)).status).toBe("none");
  });

  it("三套 v2 结论在 stack 里原样收录：分析器读到的是校验过的那一份，不是转录本", () => {
    const stack = completeStack([]);
    expect(stack.beatValidation).toEqual(
      validateBeatValidationV2Result(SAMPLE_BEAT_VALIDATION_V2),
    );
    expect(stack.qualityReview).toEqual(validateQualityReviewV2Result(SAMPLE_QUALITY_REVIEW_V2));
    expect(stack.commercialReview).toEqual(
      validateCommercialReviewV2Result(SAMPLE_COMMERCIAL_REVIEW_V2),
    );
  });
});
