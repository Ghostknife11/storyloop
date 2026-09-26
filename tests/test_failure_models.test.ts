import { describe, expect, it } from "vitest";
import {
  FAILURE_ANALYSIS_SCHEMA_VERSION,
  FAILURE_CATEGORIES,
  failureAnalysisOf,
  isFailureCategory,
  validateFailureAnalysis,
} from "@/types/failure-analysis";
import type { FailureAnalysisResult } from "@/types/failure-analysis";

function sample(): FailureAnalysisResult {
  return {
    schemaVersion: FAILURE_ANALYSIS_SCHEMA_VERSION,
    runId: "20260926_120000_ab12cd",
    status: "detected",
    primaryCategory: "VALIDATION",
    secondaryCategories: ["QUALITY", "RETRY_EXHAUSTION"],
    summary: "Run 在正文校验阶段被阻止。存在 MISSING_ENDING。",
    signals: [
      {
        code: "MISSING_ENDING",
        source: "story-validation",
        severity: "error",
        message: "正文结尾不像一个完整收束。",
      },
    ],
    evidence: [
      {
        sourceArtifact: "validation.json",
        sourceField: "issues[0].code",
        code: "MISSING_ENDING",
        note: "校验结论里有一条 MISSING_ENDING。",
      },
    ],
    firstFailureStage: "validating",
    terminalState: "failed",
  };
}

describe("v1.9.0 §17/§19 失败分析模型", () => {
  it("§4 FailureCategory 是固定集合，且顺序即 §22 的优先级", () => {
    expect(FAILURE_CATEGORIES).toEqual([
      "SECURITY",
      "CONFIGURATION",
      "STORAGE",
      "PLANNING",
      "GENERATION",
      "VALIDATION",
      "REVIEWER",
      "RETRY_EXHAUSTION",
      "REPAIR_EXHAUSTION",
      "QUALITY",
      "COMMERCIAL",
      "UNKNOWN",
    ]);
    expect(isFailureCategory("VALIDATION")).toBe(true);
    expect(isFailureCategory("ROOT_CAUSE")).toBe(false);
    expect(isFailureCategory(null)).toBe(false);
  });

  it("合法形状原样通过", () => {
    expect(validateFailureAnalysis(sample())).toEqual(sample());
  });

  it("status 只有四个取值", () => {
    for (const status of ["detected", "partial", "unknown"]) {
      expect(validateFailureAnalysis({ ...sample(), status }).status).toBe(status);
    }
    // §28：none 必须配 null 的 primaryCategory，模型层就把这条钉死
    expect(
      validateFailureAnalysis({ ...sample(), status: "none", primaryCategory: null }).status,
    ).toBe("none");
    expect(() => validateFailureAnalysis({ ...sample(), status: "maybe" })).toThrow(
      /status 不合法/,
    );
  });

  it("status = none 时 primaryCategory 必须是 null", () => {
    expect(() =>
      validateFailureAnalysis({ ...sample(), status: "none", primaryCategory: "VALIDATION" }),
    ).toThrow(/none 时 primaryCategory/);
  });

  it("secondaryCategories 不能重复 primary，也不能含非法类别", () => {
    expect(() =>
      validateFailureAnalysis({ ...sample(), secondaryCategories: ["VALIDATION"] }),
    ).toThrow(/不能包含 primaryCategory/);
    expect(() => validateFailureAnalysis({ ...sample(), secondaryCategories: ["NOPE"] })).toThrow(
      /非法值/,
    );
  });

  it("evidence.value 只接受字符串 / 数字 / 布尔", () => {
    expect(
      validateFailureAnalysis({
        ...sample(),
        evidence: [{ note: "n", value: 60 }],
      }).evidence[0].value,
    ).toBe(60);
    expect(() =>
      validateFailureAnalysis({ ...sample(), evidence: [{ note: "n", value: { a: 1 } }] }),
    ).toThrow(/只能是字符串/);
  });

  it("形状不对归一成 null，不抛给调用方（旧 Run / 手改坏的文件照常读）", () => {
    expect(failureAnalysisOf(null)).toBeNull();
    expect(failureAnalysisOf("{}")).toBeNull();
    expect(failureAnalysisOf({ ...sample(), schemaVersion: "99" })).toBeNull();
    expect(failureAnalysisOf({ ...sample(), primaryCategory: "MADE_UP" })).toBeNull();
    expect(failureAnalysisOf({ ...sample(), signals: "nope" })).toBeNull();
    expect(failureAnalysisOf(sample())?.primaryCategory).toBe("VALIDATION");
  });

  it("拿不到的阶段 / 终态写显式 null，绝不补猜测值", () => {
    const raw = {
      schemaVersion: FAILURE_ANALYSIS_SCHEMA_VERSION,
      runId: "r",
      status: "none",
      primaryCategory: null,
      secondaryCategories: [],
      summary: "No run-level failure detected.",
      signals: [],
      evidence: [],
    };
    const out = validateFailureAnalysis(raw);
    expect(out.firstFailureStage).toBeNull();
    expect(out.terminalState).toBeNull();
    expect(out.evidence).toEqual([]);
  });
});
