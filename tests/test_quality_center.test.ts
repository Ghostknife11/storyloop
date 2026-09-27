import { describe, expect, it } from "vitest";
import { FailureAnalyzer } from "@/analysis/failure-analyzer";
import { QualityStackCoordinator } from "@/engine/quality-stack-coordinator";
import { validateQualityReviewV2Result } from "@/domain/quality-review-v2";
import { qualityStackViewOf } from "@/domain/quality-stack";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/runs/[run_id]/quality-stack/route";
import {
  QUALITY_CENTER_FILTERS_ALL,
  filterDiagnostics,
  qualityCenterState,
  severityTone,
} from "@/interface/quality-center-view";
import type { QualityStackResult, QualityStackView } from "@/domain/quality-stack";
import type { BeatValidationResult } from "@/domain/beat-validation";
import type { CommercialReviewResult } from "@/domain/commercial-review";
import type { ReviewResult } from "@/domain/review-result";
import {
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_BEAT_VALIDATION_FAILED,
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_COMMERCIAL_REVIEW,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_QUALITY_REVIEW_V2,
  SAMPLE_REVIEW,
} from "./helpers/fixtures";
import { legacyReviewOf } from "@/domain/quality-review-v2";

/**
 * v2.1.0 TASK §33/§34/§35 Quality Center。
 *
 * 这里只测「怎么显示、筛出哪些」——全部是纯函数，不启动浏览器。
 * §35 的三条边界逐条对拍：没有 Beat Score、没有 confidence、诊断原样呈现。
 */

function diagnostic(
  id: string,
  source: "beat-validator" | "quality-reviewer" | "commercial-reviewer",
  category: string,
  severity: "info" | "warning" | "error",
  target: "beat-plan" | "story" | "opening" | "middle" | "ending" | "character" | "global",
  message: string,
  suggestion?: string) {
  return { id, source, category, severity, target, message, ...(suggestion ? { suggestion } : {}) };
}

function stackOf(diagnostics: QualityStackView["diagnostics"], status: QualityStackView["status"] = "complete"): QualityStackView {
  return {
    status,
    diagnostics,
    summary: {
      totalDiagnostics: diagnostics.length,
      errors: diagnostics.filter((d) => d.severity === "error").length,
      warnings: diagnostics.filter((d) => d.severity === "warning").length,
      info: diagnostics.filter((d) => d.severity === "info").length,
    },
  };
}

/**
 * 落盘那一份：用真协调器把三套样例结论装成一栈，形状与 Pipeline 写出来的一致。
 * 走这一路而不是手写 JSON——手写的那份只要少一个模块键，status 就与在位模块对不上，
 * 会被读盘的严格校验整份作废（§37）。
 */
function realStack(): QualityStackResult {
  return new QualityStackCoordinator().coordinate({
    beatValidation: SAMPLE_BEAT_VALIDATION_V2,
    qualityReview: SAMPLE_QUALITY_REVIEW_V2,
    commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
  });
}

/** 只有故事质量一套在位、且带着一条 error 诊断的栈。 */
function stackWithError(): QualityStackResult {
  return new QualityStackCoordinator().coordinate({
    beatValidation: null,
    qualityReview: validateQualityReviewV2Result({
      ...SAMPLE_QUALITY_REVIEW_V2,
      diagnostics: [
        {
          category: "causal_gap",
          severity: "error",
          target: "story",
          message: "配角反水没有前文支撑。",
          suggestion: "在中段给一次反水的动机铺垫。",
        },
      ],
    }),
    commercialReview: null,
  });
}

const review: ReviewResult = SAMPLE_REVIEW;
const commercial: CommercialReviewResult = SAMPLE_COMMERCIAL_REVIEW;
const beatValidation: BeatValidationResult = SAMPLE_BEAT_VALIDATION;

function stateOf(
  diagnostics: QualityStackView["diagnostics"],
  overrides: {
    stack?: QualityStackView | null;
    review?: ReviewResult | null;
    commercial?: CommercialReviewResult | null;
    beatValidation?: BeatValidationResult | null;
  } = {},
) {
  return qualityCenterState({
    stack: overrides.stack === undefined ? stackOf(diagnostics) : overrides.stack,
    review: overrides.review === undefined ? review : overrides.review,
    commercialReview: overrides.commercial === undefined ? commercial : overrides.commercial,
    beatValidation: overrides.beatValidation === undefined ? beatValidation : overrides.beatValidation,
  });
}

describe("Quality Center — §33 结构与边界", () => {
  it("没有 quality-stack.json：整个区域隐藏，不占位也不编 0 条诊断", () => {
    expect(stateOf([], { stack: null })).toEqual({ kind: "hidden" });
  });

  it("Overview 三行齐全：Planning / Story Quality / Commercial", () => {
    const state = stateOf([]);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.overview.map((r) => r.key)).toEqual(["planning", "story", "commercial"]);
    expect(state.overview.map((r) => r.label)).toEqual(["Planning", "Story Quality", "Commercial"]);
    expect(state.statusText).toBe("三套结论齐全");
  });

  it("§35 Beat Planning 只有 passed 与诊断条数：没有分数，也不编一个", () => {
    // 骨架没过，且诊断里确实躺着那条 error——两件事必须同时为真，行上才显示「未通过」
    const state = stateOf(
      [
        diagnostic("beat-validator-1", "beat-validator", "MISSING_CLIMAX", "error", "beat-plan", "第 4 拍直接跳到结局。"),
      ],
      { beatValidation: SAMPLE_BEAT_VALIDATION_FAILED },
    );
    if (state.kind !== "ready") throw new Error("应当 ready");
    const planning = state.overview.find((r) => r.key === "planning")!;
    expect(planning.scoreText).toBeNull();
    expect(planning.statusText).toBe("未通过");
    expect(planning.tone).toBe("bad");
    expect(planning.detailText).toBe("1 条诊断");
  });

  it("§35 骨架校验没跑过与没过是两件事：文案能区分", () => {
    const state = stateOf([], { beatValidation: null });
    if (state.kind !== "ready") throw new Error("应当 ready");
    const planning = state.overview.find((r) => r.key === "planning")!;
    expect(planning.statusText).toBe("未运行");
    expect(planning.tone).toBe("unknown");
    expect(planning.scoreText).toBeNull();
  });

  it("§35 全篇没有 confidence / 概率一类的字段", () => {
    const state = stateOf([
      diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段两场戏功能重复。"),
    ]);
    if (state.kind !== "ready") throw new Error("应当 ready");
    const text = JSON.stringify(state);
    expect(text).not.toContain("confidence");
    expect(text).not.toContain("概率");
    expect(text).not.toContain("置信");
  });

  it("§35 诊断原样呈现：message 与 suggestion 一个字符都不改", () => {
    const state = stateOf([
      diagnostic(
        "quality-reviewer-1",
        "quality-reviewer",
        "repetition",
        "warning",
        "middle",
        "中段两场戏功能重复。",
        "压缩重复线索，让中段事件承担新的推进功能。",
      ),
    ]);
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0].message).toBe("中段两场戏功能重复。");
    expect(state.warnings[0].suggestion).toBe("压缩重复线索，让中段事件承担新的推进功能。");
    expect(state.warnings[0].id).toBe("quality-reviewer-1");
  });

  it("Diagnostics 按 severity 分三栏：Errors / Warnings / Info", () => {
    const state = stateOf([
      diagnostic("quality-reviewer-1", "quality-reviewer", "causal_gap", "error", "story", "因果断裂。"),
      diagnostic("commercial-reviewer-1", "commercial-reviewer", "weak_payoff", "warning", "ending", "回报不足。"),
      diagnostic("quality-reviewer-2", "quality-reviewer", "repetition", "info", "middle", "有点重复。"),
    ]);
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.errors.map((r) => r.id)).toEqual(["quality-reviewer-1"]);
    expect(state.warnings.map((r) => r.id)).toEqual(["commercial-reviewer-1"]);
    expect(state.info.map((r) => r.id)).toEqual(["quality-reviewer-2"]);
    expect(state.summary).toEqual({ totalDiagnostics: 3, errors: 1, warnings: 1, info: 1 });
  });

  it("Detailed Scores：Co / N / C / Ca 与 H / P / E / Pf 两组齐全", () => {
    const state = stateOf([]);
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.qualityScores.map((r) => r.short)).toEqual(["Co", "N", "C", "Ca"]);
    expect(state.qualityScores.map((r) => r.label)).toEqual(["连贯性", "叙事", "人物", "因果"]);
    expect(state.commercialScores.map((r) => r.short)).toEqual(["H", "P", "E", "Pf"]);
    expect(state.commercialScores.map((r) => r.label)).toEqual(["Hook", "Pacing", "Engagement", "Payoff"]);
    // 分数来自 review / commercial_review，一处事实来源
    expect(state.qualityScores[0].scoreText).toBe("84");
    expect(state.commercialScores[0].scoreText).toBe("82");
  });

  it("旧 Run 没有维度时 Detailed Scores 整组不出现，不补 0", () => {
    const noDimensions = legacyReviewOf(SAMPLE_QUALITY_REVIEW_V2);
    const bare: ReviewResult = { ...noDimensions, dimensions: undefined } as ReviewResult;
    const state = stateOf([], { review: bare });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.qualityScores).toEqual([]);
  });

  it("partial：缺结论的那一行说「无结论」，不假装有分", () => {
    const state = stateOf([], {
      stack: stackOf([], "partial"),
      commercial: null,
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.status).toBe("partial");
    expect(state.statusText).toBe("部分结论缺失");
    const row = state.overview.find((r) => r.key === "commercial")!;
    expect(row.statusText).toBe("无结论");
    expect(row.scoreText).toBeNull();
    expect(row.tone).toBe("partial");
  });
});

describe("Quality Center — §34 筛选", () => {
  const rows = () =>
    stateOf([
      diagnostic("beat-validator-1", "beat-validator", "MISSING_CLIMAX", "error", "beat-plan", "缺高潮。"),
      diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
      diagnostic("quality-reviewer-2", "quality-reviewer", "causal_gap", "error", "story", "因果断裂。"),
      diagnostic("commercial-reviewer-1", "commercial-reviewer", "repetitive_middle", "warning", "middle", "中段重复。"),
    ]);

  it("默认不筛：filtered 与 all 逐字相同", () => {
    const state = rows();
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered).toEqual(state.all);
  });

  it("按 source 筛", () => {
    const state = qualityCenterState({
      stack: stackOf([
        diagnostic("beat-validator-1", "beat-validator", "MISSING_CLIMAX", "error", "beat-plan", "缺高潮。"),
        diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
      ]),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { ...QUALITY_CENTER_FILTERS_ALL, source: "quality-reviewer" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered.map((r) => r.id)).toEqual(["quality-reviewer-1"]);
  });

  it("按 severity 筛", () => {
    const state = qualityCenterState({
      stack: stackOf([
        diagnostic("beat-validator-1", "beat-validator", "MISSING_CLIMAX", "error", "beat-plan", "缺高潮。"),
        diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
      ]),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { ...QUALITY_CENTER_FILTERS_ALL, severity: "error" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered.map((r) => r.id)).toEqual(["beat-validator-1"]);
  });

  it("按 target 筛", () => {
    const state = qualityCenterState({
      stack: stackOf([
        diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
        diagnostic("quality-reviewer-2", "quality-reviewer", "causal_gap", "error", "story", "因果断裂。"),
      ]),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { ...QUALITY_CENTER_FILTERS_ALL, target: "middle" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered.map((r) => r.id)).toEqual(["quality-reviewer-1"]);
  });

  it("按 category 筛：跨来源同名的 category 一起出来", () => {
    const state = qualityCenterState({
      stack: stackOf([
        diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
        diagnostic("commercial-reviewer-1", "commercial-reviewer", "repetitive_middle", "warning", "middle", "中段重复。"),
      ]),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { ...QUALITY_CENTER_FILTERS_ALL, category: "repetitive_middle" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered.map((r) => r.id)).toEqual(["commercial-reviewer-1"]);
  });

  it("四类条件同时生效（AND），不是或", () => {
    const diagnostics = [
      diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
      diagnostic("quality-reviewer-2", "quality-reviewer", "repetition", "error", "middle", "中段重复到断裂。"),
    ];
    const state = qualityCenterState({
      stack: stackOf(diagnostics),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { source: "quality-reviewer", severity: "warning", target: "middle", category: "repetition" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered.map((r) => r.id)).toEqual(["quality-reviewer-1"]);
  });

  it("筛不出来时是空列表，不是把全部行都返回", () => {
    const state = qualityCenterState({
      stack: stackOf([
        diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
      ]),
      review,
      commercialReview: commercial,
      beatValidation,
      filters: { ...QUALITY_CENTER_FILTERS_ALL, severity: "error" },
    });
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filtered).toEqual([]);
    expect(state.all).toHaveLength(1);
  });

  it("可选项只列这次真的出现过的值，顺序稳定不跟诊断顺序漂移", () => {
    const state = rows();
    if (state.kind !== "ready") throw new Error("应当 ready");
    expect(state.filterOptions.sources).toEqual(["beat-validator", "quality-reviewer", "commercial-reviewer"]);
    expect(state.filterOptions.severities).toEqual(["error", "warning"]);
    expect(state.filterOptions.targets).toEqual(["beat-plan", "middle", "story"]);
    expect(state.filterOptions.categories).toEqual([
      "causal_gap", "MISSING_CLIMAX", "repetition", "repetitive_middle",
    ]);
  });

  it("severity → 圆点颜色：三档各一个稳定值", () => {
    expect(severityTone("error")).toBe("bg-red-500");
    expect(severityTone("warning")).toBe("bg-amber-500");
    expect(severityTone("info")).toBe("bg-sky-500");
  });

  it("filterDiagnostics 不改传入的数组", () => {
    const diagnostics = [
      diagnostic("quality-reviewer-1", "quality-reviewer", "repetition", "warning", "middle", "中段重复。"),
    ];
    const rowsIn = diagnostics.map((d) => ({ ...d, sourceLabel: "故事质量", suggestion: null }));
    const before = JSON.stringify(rowsIn);
    filterDiagnostics(rowsIn, { ...QUALITY_CENTER_FILTERS_ALL, severity: "error" });
    expect(JSON.stringify(rowsIn)).toBe(before);
  });
});

describe("GET /api/runs/<id>/quality-stack（TASK §33）", () => {
  const realCwd = process.cwd();
  let tmp: string | null = null;

  function withTmpDir(): string {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-quality-stack-route-"));
    process.chdir(tmp);
    return tmp;
  }

  function cleanup() {
    process.chdir(realCwd);
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  }

  function call(runId: string): Promise<Response> {
    return GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ run_id: runId }),
    } as never) as unknown as Promise<Response>;
  }

  it("有这份文件：200 + qualityStack 是盘上那一份的投影", async () => {
    const dir = withTmpDir();
    try {
      const runId = "20260927_120000_qs0001";
      mkdirSync(join(dir, "runs", runId), { recursive: true });
      const stack = realStack();
      writeFileSync(join(dir, "runs", runId, "quality-stack.json"), JSON.stringify(stack), "utf8");

      const res = await call(runId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ qualityStack: qualityStackViewOf(stack) });
    } finally {
      cleanup();
    }
  });

  it("旧 Run 没有这份文件：仍然 200，qualityStack 是 null", async () => {
    const dir = withTmpDir();
    try {
      const runId = "20260927_120000_qs0002";
      mkdirSync(join(dir, "runs", runId), { recursive: true });

      const res = await call(runId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ qualityStack: null });
    } finally {
      cleanup();
    }
  });

  it("文件被手改坏：200 + null，坏数据不进响应", async () => {
    const dir = withTmpDir();
    try {
      const runId = "20260927_120000_qs0003";
      mkdirSync(join(dir, "runs", runId), { recursive: true });
      writeFileSync(join(dir, "runs", runId, "quality-stack.json"), "{ 这不是 JSON", "utf8");

      const res = await call(runId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ qualityStack: null });
    } finally {
      cleanup();
    }
  });

  it("run_id 非法：400 CONFIG_INVALID；不存在：404 RUN_NOT_FOUND", async () => {
    withTmpDir();
    try {
      const bad = await call("../../etc");
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");

      const missing = await call("20200101_000000_zzzzzz");
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
    } finally {
      cleanup();
    }
  });

  it("响应体不夹带任何凭据（§46）", async () => {
    const dir = withTmpDir();
    try {
      const runId = "20260927_120000_qs0004";
      mkdirSync(join(dir, "runs", runId), { recursive: true });
      writeFileSync(
        join(dir, "runs", runId, "quality-stack.json"),
        JSON.stringify(realStack()),
        "utf8",
      );

      const res = await call(runId);
      const text = await res.text();
      expect(text).not.toContain("api_key");
      expect(text).not.toContain("Authorization");
      expect(text).not.toContain("Cookie");
      expect(text).not.toContain("sk-");
    } finally {
      cleanup();
    }
  });
});

describe("FailureAnalyzer 与 Quality Center 用的是同一份盘上事实", () => {
  it("同一份 quality-stack.json：两边读到的诊断逐字相同", () => {
    const stack = stackWithError();
    const center = qualityCenterState({
      stack: qualityStackViewOf(stack),
      review,
      commercialReview: commercial,
      beatValidation,
    });
    if (center.kind !== "ready") throw new Error("应当 ready");
    // 分析器那边：error 级诊断成为一条信号
    const analysis = new FailureAnalyzer().analyze({
      runId: "20260927_120000_ab12cd",
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
      validationStatus: "completed",
      review: null,
      reviewStatus: "completed",
      commercialReview: null,
      commercialReviewStatus: "completed",
      quality: null,
      qualityStack: stack,
      attempts: [],
      errorCodes: ["GENERATION_FAILED"],
      artifactPresence: {
        story: true, beatValidation: false, validation: true, review: true,
        commercialReview: false, quality: true, manifest: true, telemetry: true,
      },
    });
    const signal = analysis.signals.find((s) => s.code === "QUALITY_DIAGNOSTIC_ERROR");
    expect(signal?.message).toContain("配角反水没有前文支撑。");
    expect(center.errors[0].message).toBe("配角反水没有前文支撑。");
  });
});
