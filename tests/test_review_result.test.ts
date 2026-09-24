import { describe, expect, it } from "vitest";
import {
  REVIEW_SCORE_MAX,
  REVIEW_SCORE_MIN,
  validateReviewResult,
} from "@/types/review-result";

/**
 * §40 ReviewResult：只查结构，不评价 Review 本身的质量。
 * 只用 Fixture，绝不打真实付费 API。
 */

const valid = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
};

describe("validateReviewResult（§5/§6/§40）", () => {
  it("valid review accepted", () => {
    expect(validateReviewResult(valid)).toEqual(valid);
  });

  it("score 边界 0 与 100 都合法（§51）", () => {
    expect(validateReviewResult({ ...valid, score: REVIEW_SCORE_MIN }).score).toBe(0);
    expect(validateReviewResult({ ...valid, score: REVIEW_SCORE_MAX }).score).toBe(100);
  });

  it("score < 0 rejected（§52）", () => {
    expect(() => validateReviewResult({ ...valid, score: -4 })).toThrow(/score 必须在 0 ~ 100/);
  });

  it("score > 100 rejected（§52）", () => {
    expect(() => validateReviewResult({ ...valid, score: 103 })).toThrow(/score 必须在 0 ~ 100/);
  });

  it("score 非数字 rejected", () => {
    expect(() => validateReviewResult({ ...valid, score: "74" })).toThrow(/score 必须是数字/);
    expect(() => validateReviewResult({ ...valid, score: null })).toThrow(/score 必须是数字/);
    expect(() => validateReviewResult({ ...valid, score: Number.NaN })).toThrow(/score 必须是数字/);
  });

  it("score 缺失 rejected", () => {
    const { score: _score, ...rest } = valid;
    expect(() => validateReviewResult(rest)).toThrow(/score 必须是数字/);
  });

  it("summary empty rejected", () => {
    expect(() => validateReviewResult({ ...valid, summary: "   " })).toThrow(/summary 不能为空/);
    expect(() => validateReviewResult({ ...valid, summary: 42 })).toThrow(/summary 不能为空/);
  });

  it("strengths wrong type rejected", () => {
    expect(() => validateReviewResult({ ...valid, strengths: "开篇抓人" })).toThrow(/strengths 必须是数组/);
    expect(() => validateReviewResult({ ...valid, strengths: { 0: "开篇抓人" } })).toThrow(/strengths 必须是数组/);
    expect(() => validateReviewResult({ ...valid, strengths: [42] })).toThrow(/strengths\[0\] 必须是非空字符串/);
    expect(() => validateReviewResult({ ...valid, strengths: [""] })).toThrow(/strengths\[0\] 必须是非空字符串/);
  });

  it("problems wrong type rejected", () => {
    expect(() => validateReviewResult({ ...valid, problems: "中段重复" })).toThrow(/problems 必须是数组/);
    expect(() => validateReviewResult({ ...valid, problems: null })).toThrow(/problems 必须是数组/);
    expect(() => validateReviewResult({ ...valid, problems: [{}] })).toThrow(/problems\[0\] 必须是非空字符串/);
  });

  it("strengths / problems 允许空数组（没有优点或没有问题都成立）", () => {
    const r = validateReviewResult({ ...valid, strengths: [], problems: [] });
    expect(r.strengths).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it("条目做 trim，首尾空白被清理", () => {
    const r = validateReviewResult({ ...valid, strengths: ["  开篇抓人  "] });
    expect(r.strengths).toEqual(["开篇抓人"]);
  });

  it("§10/§16 旧格式输入不产生任何额外字段（维度可有可无，缺就不造）", () => {
    const r = validateReviewResult(valid) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["problems", "score", "strengths", "summary"]);
    for (const forbidden of ["dimensions", "severity", "evidence", "confidence", "location"]) {
      expect(r).not.toHaveProperty(forbidden);
    }
  });

  it("raw 不是对象时给出明确错误，不抛裸 TypeError", () => {
    expect(() => validateReviewResult(null)).toThrow(/score 必须是数字/);
    expect(() => validateReviewResult("nope")).toThrow(/score 必须是数字/);
  });
});
