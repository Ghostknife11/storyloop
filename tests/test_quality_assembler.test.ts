import { describe, expect, it } from "vitest";
import { QualityAssembler, REVIEW_PROBLEM_CATEGORY } from "@/core/quality-assembler";
import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";

/**
 * v1.2.0 §47 QualityAssembler 测试：以 spec 的 Case A~D 为基线，
 * 再补确定性与「不越界」两条——装配器只汇总已有结论，不新增任何判断。
 *
 * 铁律：装配器不调用 LLM、不读文件系统、不读环境变量（这里是纯函数，天然满足）。
 */

const assembler = new QualityAssembler();

const PASSED: ValidationResult = { passed: true, issues: [] };
const FAILED: ValidationResult = {
  passed: false,
  issues: [
    { code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" },
    { code: "TOO_SHORT", severity: "error", message: "正文长度明显短于目标字数。" },
  ],
};

function review(score: number, problems: string[] = [], suggestions?: string[]): ReviewResult {
  const base: ReviewResult = {
    score,
    summary: "故事整体完整，主线明确。",
    strengths: ["开篇冲突建立迅速"],
    problems,
  };
  return suggestions ? { ...base, suggestions } : base;
}

describe("§47 Case A：校验通过 + 审阅 80 + accepted", () => {
  it("overallScore = 80 / validationPassed = true / accepted = true，issues 为空", () => {
    const result = assembler.assemble({ validation: PASSED, review: review(80), accepted: true });
    expect(result.overall_score).toBe(80);
    expect(result.validation_passed).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toBe("故事整体完整，主线明确。");
  });
});

describe("§47 Case B：校验失败时 ValidationIssue 必须进入 issues", () => {
  it("每条 issue 带 code 作 category、原 message、原 severity，id 按顺序编号", () => {
    const result = assembler.assemble({ validation: FAILED, review: review(60), accepted: false });
    expect(result.validation_passed).toBe(false);
    expect(result.issues).toEqual([
      { id: "validation-1", source: "validation", category: "MISSING_ENDING", message: "故事缺少明确结局。", severity: "error" },
      { id: "validation-2", source: "validation", category: "TOO_SHORT", message: "正文长度明显短于目标字数。", severity: "error" },
    ]);
  });

  it("审阅问题跟在校验问题之后，统一归 review_problem，不带 severity", () => {
    const result = assembler.assemble({
      validation: FAILED,
      review: review(60, ["中段线索重复", "高潮转折略突然"]),
      accepted: false,
    });
    const reviewIssues = result.issues.filter((i) => i.source === "review");
    expect(reviewIssues).toEqual([
      { id: "review-1", source: "review", category: REVIEW_PROBLEM_CATEGORY, message: "中段线索重复" },
      { id: "review-2", source: "review", category: REVIEW_PROBLEM_CATEGORY, message: "高潮转折略突然" },
    ]);
    expect(reviewIssues.every((i) => i.severity === undefined)).toBe(true);
    expect(result.issues).toHaveLength(4);
  });

  it("没有审阅结论时 issues 只包含校验问题", () => {
    const result = assembler.assemble({ validation: FAILED, review: null, accepted: false });
    expect(result.issues.map((i) => i.source)).toEqual(["validation", "validation"]);
  });
});

describe("§47 Case C：Reviewer 失败时 overallScore = null", () => {
  it("review = null → 分数与总结都是 null，但 issues 仍可来自校验", () => {
    const result = assembler.assemble({ validation: FAILED, review: null, accepted: false });
    expect(result.overall_score).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.suggestions).toEqual([]);
    expect(result.issues).toHaveLength(2);
  });

  it("review = null 且校验通过 → 分数 null、issues 空、accepted 由调用方给", () => {
    const result = assembler.assemble({ validation: PASSED, review: null, accepted: true });
    expect(result).toEqual({
      overall_score: null,
      validation_passed: true,
      accepted: true,
      issues: [],
      suggestions: [],
      summary: null,
    });
  });
});

describe("§47 Case D：Validator 自身失败时不得伪造 validationPassed", () => {
  it("validation = null → validation_passed 是 null，不是 false", () => {
    const result = assembler.assemble({ validation: null, review: review(74), accepted: false });
    expect(result.validation_passed).toBeNull();
    expect(result.issues).toEqual([]);
    expect(result.overall_score).toBe(74);
  });

  it("两路都没有结论 → 只有 accepted 一个字段有值", () => {
    const result = assembler.assemble({ validation: null, review: null, accepted: false });
    expect(result).toEqual({
      overall_score: null,
      validation_passed: null,
      accepted: false,
      issues: [],
      suggestions: [],
      summary: null,
    });
  });
});

describe("§14 suggestions 装配", () => {
  it("有 suggestions 时逐条转成 QualitySuggestion，id 按顺序编号", () => {
    const result = assembler.assemble({
      validation: PASSED,
      review: review(82, ["中段线索复用偏多"], ["压缩重复线索。", "让中段事件承担新的推进功能。"]),
      accepted: true,
    });
    expect(result.suggestions).toEqual([
      { id: "review-suggestion-1", source: "review", message: "压缩重复线索。" },
      { id: "review-suggestion-2", source: "review", message: "让中段事件承担新的推进功能。" },
    ]);
  });

  it("旧 ReviewResult 没有 suggestions → 空数组，不是 undefined", () => {
    const result = assembler.assemble({ validation: PASSED, review: review(74), accepted: true });
    expect(result.suggestions).toEqual([]);
  });

  it("suggestions 不是数组（脏数据）时按没有处理，不抛错", () => {
    const dirty = { ...review(74), suggestions: "压缩中段。" } as unknown as ReviewResult;
    const result = assembler.assemble({ validation: PASSED, review: dirty, accepted: true });
    expect(result.suggestions).toEqual([]);
  });
});

describe("§17 确定性与无副作用", () => {
  it("同一输入装配多次，逐字段相等", () => {
    const input = { validation: FAILED, review: review(60, ["高潮缺失"], ["补高潮。"]) as ReviewResult, accepted: false };
    const a = assembler.assemble(input);
    const b = assembler.assemble(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("装配不修改传入的 validation / review", () => {
    const validation = structuredClone(FAILED);
    const r = review(60, ["高潮缺失"], ["补高潮。"]);
    const frozenInput = structuredClone({ validation, review: r, accepted: false });
    assembler.assemble({ validation, review: r, accepted: false });
    expect({ validation, review: r, accepted: false }).toEqual(frozenInput);
  });

  it("分数只有一个：没有任何 dimension / 多维分数字段", () => {
    const result = assembler.assemble({ validation: PASSED, review: review(80), accepted: true });
    expect(Object.keys(result).sort()).toEqual([
      "accepted", "issues", "overall_score", "suggestions", "summary", "validation_passed",
    ]);
    for (const forbidden of ["dimension", "coherence", "narrative", "character", "causality", "confidence"]) {
      for (const key of Object.keys(result)) {
        expect(key.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
