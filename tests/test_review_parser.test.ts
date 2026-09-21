import { describe, expect, it } from "vitest";
import { parseReviewResult, ReviewParseError } from "@/lib/review-parser";

/**
 * §41 Review Parser：raw LLM output → 轻量清理 → JSON parse → schema 校验 → ReviewResult。
 * 禁止 LLM JSON Repair Agent（§15）：非法就是非法。
 */

const validJson = JSON.stringify({
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
});

describe("parseReviewResult（§15/§41）", () => {
  it("valid JSON → ReviewResult", () => {
    expect(parseReviewResult(validJson)).toEqual({
      score: 74,
      summary: "故事整体完整，主线清楚，但中段推进略重复。",
      strengths: ["开篇冲突建立迅速", "主角目标明确"],
      problems: ["中段线索重复", "高潮转折略突然"],
    });
  });

  it("JSON code fence → 轻量去除后正常解析", () => {
    expect(parseReviewResult("```json\n" + validJson + "\n```")).toEqual(parseReviewResult(validJson));
    expect(parseReviewResult("```\n" + validJson + "\n```")).toEqual(parseReviewResult(validJson));
  });

  it("首尾空白被清理", () => {
    expect(parseReviewResult("\n  " + validJson + "  \n")).toEqual(parseReviewResult(validJson));
  });

  it("invalid JSON → ReviewParseError（不做智能修复）", () => {
    expect(() => parseReviewResult("这不是 JSON")).toThrow(ReviewParseError);
    expect(() => parseReviewResult("{score: 74,}")).toThrow(/Reviewer 输出不是合法 JSON/);
    expect(() => parseReviewResult("")).toThrow(ReviewParseError);
  });

  it("missing score → 拒绝", () => {
    const raw = JSON.stringify({ summary: "整体完整。", strengths: [], problems: [] });
    expect(() => parseReviewResult(raw)).toThrow(/score 必须是数字/);
  });

  it("score string → 拒绝", () => {
    const raw = JSON.stringify({ ...JSON.parse(validJson), score: "74" });
    expect(() => parseReviewResult(raw)).toThrow(/score 必须是数字/);
  });

  it("score > 100 → 拒绝（§52）", () => {
    const raw = JSON.stringify({ ...JSON.parse(validJson), score: 101 });
    expect(() => parseReviewResult(raw)).toThrow(/score 必须在 0 ~ 100/);
  });

  it("missing summary → 拒绝", () => {
    const raw = JSON.stringify({ score: 74, strengths: [], problems: [] });
    expect(() => parseReviewResult(raw)).toThrow(/summary 不能为空/);
  });

  it("strengths wrong type → 拒绝", () => {
    const raw = JSON.stringify({ ...JSON.parse(validJson), strengths: "开篇抓人" });
    expect(() => parseReviewResult(raw)).toThrow(/strengths 必须是数组/);
  });

  it("problems wrong type → 拒绝", () => {
    const raw = JSON.stringify({ ...JSON.parse(validJson), problems: 3 });
    expect(() => parseReviewResult(raw)).toThrow(/problems 必须是数组/);
  });

  it("数组外层（LLM 把结果包进数组）→ 拒绝，不偷偷取第一个元素", () => {
    expect(() => parseReviewResult("[" + validJson + "]")).toThrow(/score 必须是数字/);
  });
});
