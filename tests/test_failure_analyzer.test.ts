import { describe, expect, it } from "vitest";
import { FailureAnalyzer } from "@/core/failure-analyzer";
import { FAILURE_ANALYSIS_SCHEMA_VERSION } from "@/types/failure-analysis";
import type { FailureAnalysisInput } from "@/types/failure-analysis";
import type { BeatValidationResult } from "@/types/beat-validation";
import type { ValidationResult } from "@/types/validation-result";
import type { QualityDimensions } from "@/types/quality-dimensions";
import type { CommercialReviewResult } from "@/types/commercial-review";
import type { RunTelemetry } from "@/types/telemetry";

/** 一次「跑成了、也被采纳」的干净 Run：每个用例在这之上改一项。 */
function clean(): FailureAnalysisInput {
  return {
    runId: "20260926_120000_ab12cd",
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
    quality: {
      overall_score: 82,
      validation_passed: true,
      accepted: true,
      issues: [],
      suggestions: [],
      summary: "ok",
    },
    attempts: [{ attemptNumber: 1, accepted: true, retryReason: null, validationPassed: true, repairCount: 0, repairs: [] }],
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

function beatValidation(codes: string[]): BeatValidationResult {
  return {
    passed: false,
    issues: codes.map((code) => ({ code, severity: "error", message: `${code} hit`, beat_ids: [] })),
    beat_count: 3,
    summary: "structural errors",
  } as BeatValidationResult;
}

function validation(codes: string[]): ValidationResult {
  return {
    passed: false,
    issues: codes.map((code) => ({ code, severity: "error", message: `${code} hit` })),
  } as ValidationResult;
}

function dimensions(scores: Record<string, number>): QualityDimensions {
  const keys = ["coherence", "narrative", "character", "causality"] as const;
  return keys.reduce((acc, key) => {
    acc[key] = { score: scores[key] ?? 80, summary: "s" };
    return acc;
  }, {} as QualityDimensions);
}

function commercial(score: number, dims: Record<string, number>): CommercialReviewResult {
  const keys = ["hook", "pacing", "engagement", "payoff"] as const;
  return {
    score,
    summary: "s",
    strengths: [],
    problems: [],
    suggestions: [],
    dimensions: keys.reduce((acc, key) => {
      acc[key] = { score: dims[key] ?? 70, summary: "s" };
      return acc;
    }, {} as CommercialReviewResult["dimensions"]),
  };
}

function telemetry(failureStage: string, failureCode: string): RunTelemetry {
  return {
    schemaVersion: "1",
    runId: "20260926_120000_ab12cd",
    startedAt: "2026-09-26T12:00:00.000Z",
    status: "failed",
    completedAt: "2026-09-26T12:00:05.000Z",
    durationMs: 5000,
    failureStage,
    failureCode,
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
}

describe("v1.9.0 §23 确定性失败分析 — 类别判定", () => {
  const analyzer = new FailureAnalyzer();

  it("§46 正常 accepted：status = none，primaryCategory = null，没有信号", () => {
    const out = analyzer.analyze(clean());
    expect(out.status).toBe("none");
    expect(out.primaryCategory).toBeNull();
    expect(out.secondaryCategories).toEqual([]);
    expect(out.signals).toEqual([]);
    expect(out.evidence).toEqual([]);
    expect(out.summary).toBe("No run-level failure detected.");
    expect(out.firstFailureStage).toBeNull();
    expect(out.schemaVersion).toBe(FAILURE_ANALYSIS_SCHEMA_VERSION);
  });

  it("§43 CONFIG_INVALID → CONFIGURATION", () => {
    const out = analyzer.analyze({ ...clean(), status: "failed", errorCodes: ["CONFIG_INVALID"] });
    expect(out.status).toBe("detected");
    expect(out.primaryCategory).toBe("CONFIGURATION");
    expect(out.signals.map((s) => s.code)).toContain("CONFIG_INVALID");
  });

  it("§43 MISSING_CLIMAX → PLANNING，且不声称正文生成发生过", () => {
    const input = clean();
    input.beatValidation = beatValidation(["MISSING_CLIMAX"]);
    input.beatValidationStatus = "failed";
    input.status = "failed";
    const out = analyzer.analyze(input);
    expect(out.primaryCategory).toBe("PLANNING");
    const signal = out.signals.find((s) => s.code === "MISSING_CLIMAX");
    expect(signal?.source).toBe("beat-validation");
    expect(signal?.severity).toBe("error");
    expect(out.summary).toContain("PLANNING");
  });

  it("§43 生成超时 → GENERATION，证据指向 telemetry", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      telemetry: telemetry("generating", "LLM_TIMEOUT"),
      errorCodes: ["LLM_TIMEOUT"],
    });
    expect(out.primaryCategory).toBe("GENERATION");
    expect(out.firstFailureStage).toBe("generating");
    const ev = out.evidence.find((e) => e.code === "LLM_TIMEOUT");
    expect(ev?.sourceArtifact).toBe("telemetry.json");
    expect(ev?.stage).toBe("generating");
  });

  it("§43 MISSING_ENDING → VALIDATION", () => {
    const input = clean();
    input.validation = validation(["MISSING_ENDING"]);
    input.validationStatus = "failed";
    input.status = "failed";
    input.quality = { ...input.quality!, validation_passed: false, accepted: false, overall_score: 60 };
    const out = analyzer.analyze(input);
    expect(out.primaryCategory).toBe("VALIDATION");
    expect(out.evidence.some((e) => e.sourceArtifact === "validation.json")).toBe(true);
  });

  it("§43 审阅解析失败 → REVIEWER，且不当成故事质量问题", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      reviewStatus: "failed",
      errorCodes: ["REVIEW_PARSE_ERROR"],
    });
    expect(out.primaryCategory).toBe("REVIEWER");
    expect(out.secondaryCategories).not.toContain("QUALITY");
    expect(out.signals.find((s) => s.code === "REVIEW_PARSE_ERROR")?.message).toContain(
      "不代表故事质量差",
    );
  });

  it("§43 产物写入失败 → STORAGE", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      errorCodes: ["ARTIFACT_WRITE_FAILED"],
    });
    expect(out.primaryCategory).toBe("STORAGE");
  });

  it("§43 URL 守卫拒绝 → SECURITY，且不宣称谁在攻击", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      errorCodes: ["UNSAFE_BASE_URL"],
    });
    expect(out.primaryCategory).toBe("SECURITY");
    const signal = out.signals.find((s) => s.code === "UNSAFE_BASE_URL");
    expect(signal?.source).toBe("security");
    expect(JSON.stringify(out)).not.toMatch(/攻击|恶意|attacker/i);
  });

  it("§47 有失败但错误码未知：不抛异常，原始码留在信号里", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      telemetry: telemetry("generating", "WEIRD_NEW_CODE"),
      errorCodes: ["WEIRD_NEW_CODE"],
    });
    // §41：阶段已知 → 按阶段降级，于是是 partial（不是 unknown，也不是 detected）
    expect(out.status).toBe("partial");
    expect(out.primaryCategory).toBe("GENERATION");
    expect(out.signals.some((s) => s.message.includes("WEIRD_NEW_CODE"))).toBe(true);
    expect(out.evidence.some((e) => e.code === "WEIRD_NEW_CODE")).toBe(true);
  });

  it("§47 连阶段都不知道时：status = unknown，不猜类别", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      telemetry: telemetry("nowhere", "WEIRD_NEW_CODE"),
      errorCodes: ["WEIRD_NEW_CODE"],
    });
    expect(out.status).toBe("unknown");
    expect(out.primaryCategory).toBeNull();
    expect(out.secondaryCategories).toEqual([]);
    expect(out.summary).toContain("不足以归类");
  });

  it("§41 未知码 + 已知阶段：按阶段降级成 partial", () => {
    const out = analyzer.analyze({
      ...clean(),
      status: "failed",
      telemetry: telemetry("validating", "WEIRD_NEW_CODE"),
      errorCodes: ["MISSING_ENDING", "WEIRD_NEW_CODE"],
      validation: validation(["MISSING_ENDING"]),
      validationStatus: "failed",
    });
    expect(out.status).toBe("partial");
    expect(out.primaryCategory).toBe("VALIDATION");
    expect(out.signals.some((s) => s.message.includes("WEIRD_NEW_CODE"))).toBe(true);
  });
});

describe("v1.9.0 §44/§45 Primary 与 Secondary", () => {
  const analyzer = new FailureAnalyzer();

  it("§44 同时有 MISSING_ENDING / overallScore 60 / 重试耗尽时，Primary 稳定为 VALIDATION", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["MISSING_ENDING"]);
    input.validationStatus = "failed";
    input.quality = { ...input.quality!, overall_score: 60, validation_passed: false, accepted: false };
    input.qualityStatus = "exhausted";
    input.attemptCount = 2;
    input.attempts = [
      { attemptNumber: 1, accepted: false, retryReason: "validation_failed", validationPassed: false, repairCount: 1, repairs: [{ repairNumber: 1, issueType: "ending", success: false }] },
      { attemptNumber: 2, accepted: false, retryReason: "validation_failed", validationPassed: false, repairCount: 1, repairs: [{ repairNumber: 2, issueType: "ending", success: false }] },
    ];
    input.repairCount = 2;
    const out = analyzer.analyze(input);
    expect(out.primaryCategory).toBe("VALIDATION");
    expect(out.secondaryCategories).toEqual(["RETRY_EXHAUSTION", "REPAIR_EXHAUSTION", "QUALITY"]);
  });

  it("§45 同一个 Run 可以同时表示 VALIDATION / QUALITY / RETRY_EXHAUSTION", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["MISSING_ENDING"]);
    input.validationStatus = "failed";
    input.quality = { ...input.quality!, overall_score: 60, validation_passed: false, accepted: false };
    input.qualityStatus = "exhausted";
    input.attemptCount = 2;
    input.attempts = [
      { attemptNumber: 1, accepted: false, retryReason: "validation_failed", validationPassed: false, repairCount: 0, repairs: [] },
      { attemptNumber: 2, accepted: false, retryReason: "validation_failed", validationPassed: false, repairCount: 0, repairs: [] },
    ];
    const out = analyzer.analyze(input);
    expect(out.primaryCategory).toBe("VALIDATION");
    expect(out.secondaryCategories).toContain("QUALITY");
    expect(out.secondaryCategories).toContain("RETRY_EXHAUSTION");
  });

  it("同样的输入跑两遍，结论逐字节相同（§23 确定性）", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["TOO_SHORT"]);
    input.validationStatus = "failed";
    expect(JSON.stringify(new FailureAnalyzer().analyze(input))).toBe(
      JSON.stringify(new FailureAnalyzer().analyze(input)),
    );
  });
});

describe("v1.9.0 §36/§37 薄弱维度：只记录观测，不定原因", () => {
  const analyzer = new FailureAnalyzer();

  it("§36 四个维度里最低的那个被记成信号，句子不含「原因」", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["TOO_SHORT"]);
    input.validationStatus = "failed";
    input.quality = {
      ...input.quality!,
      overall_score: 60,
      accepted: false,
      dimensions: dimensions({ coherence: 78, narrative: 70, character: 68, causality: 55 }),
    };
    const out = analyzer.analyze(input);
    const signal = out.signals.find((s) => s.code === "WEAK_CAUSALITY");
    expect(signal?.message).toBe("观测到的最低质量维度是 causality（55）。");
    expect(JSON.stringify(out)).not.toMatch(/原因|根因|root cause/i);
    expect(out.secondaryCategories).toContain("QUALITY");
  });

  it("§37 商业维度偏低只记成 COMMERCIAL，不进技术失败", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["TOO_SHORT"]);
    input.validationStatus = "failed";
    input.commercialReview = commercial(48, { hook: 40, pacing: 55, engagement: 50, payoff: 47 });
    const out = analyzer.analyze(input);
    expect(out.secondaryCategories).toContain("COMMERCIAL");
    expect(out.primaryCategory).toBe("VALIDATION");
    expect(out.signals.find((s) => s.code === "WEAK_HOOK")?.message).toContain("观测到的最低商业可读性维度");
  });

  it("§36 阈值未知时不硬说「偏低」，只报最低维度", () => {
    const input = clean();
    input.status = "failed";
    input.validation = validation(["TOO_SHORT"]);
    input.validationStatus = "failed";
    input.minReviewScore = null;
    input.quality = {
      ...input.quality!,
      overall_score: 60,
      accepted: false,
      dimensions: dimensions({ coherence: 78, narrative: 70, character: 68, causality: 55 }),
    };
    const out = analyzer.analyze(input);
    expect(out.signals.some((s) => s.code === "WEAK_CAUSALITY")).toBe(true);
    expect(out.signals.some((s) => s.code === "QUALITY_BELOW_THRESHOLD")).toBe(false);
  });
});

describe("v1.9.0 §50 分析器不产生任何 LLM 调用", () => {
  it("模块源码里没有任何 llm / fetch / http 依赖", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../src/core/failure-analyzer.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from "@\/lib\/llm"|fetch\(|https?:\/\//);
  });

  it("analyze 是同步方法：同样的输入不需要 await 也能拿到结论", () => {
    const analyzer = new FailureAnalyzer();
    const out = analyzer.analyze(clean());
    expect(out.status).toBe("none");
    expect(out instanceof Promise).toBe(false);
  });
});
