import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QualityPanel } from "@/components/quality-panel";
import { qualityPanelState, qualityScoreText } from "@/lib/quality-view";
import type { QualityResult } from "@/types/quality";

/**
 * v1.2.0 §31~§35/§53 Quality Summary UI 契约。
 *
 * 覆盖 §53 要求的六种渲染：正常渲染 / 空分数 / 校验失败 / issues / suggestions /
 * 旧 Run（没有 quality）不崩。渲染走 renderToStaticMarkup，不需要浏览器。
 */

const READY: QualityResult = {
  overall_score: 74,
  validation_passed: true,
  accepted: true,
  issues: [
    { id: "validation-1", source: "validation", category: "MISSING_ENDING", message: "故事缺少明确结局。", severity: "error" },
    { id: "review-1", source: "review", category: "review_problem", message: "中段推进重复" },
  ],
  suggestions: [
    { id: "review-suggestion-1", source: "review", message: "压缩重复线索，让中段事件承担新的推进功能。" },
  ],
  summary: "故事整体完整，主线明确，但中段推进略重复。",
};

describe("§53 Quality Summary renders", () => {
  it("总分、校验、采纳、条数、总结、issues、suggestions 全部渲染", () => {
    const html = renderToStaticMarkup(createElement(QualityPanel, { quality: READY }));
    expect(html).toContain("Quality");
    expect(html).toContain("Summary");
    expect(html).toContain("74");
    expect(html).toContain("/ 100");
    expect(html).toContain("Validation");
    expect(html).toContain("通过");
    expect(html).toContain("Status");
    expect(html).toContain("已采纳");
    expect(html).toContain("故事整体完整，主线明确，但中段推进略重复。");
    expect(html).toContain("故事缺少明确结局。");
    expect(html).toContain("中段推进重复");
    expect(html).toContain("validation/MISSING_ENDING");
    expect(html).toContain("review/review_problem");
    expect(html).toContain("压缩重复线索，让中段事件承担新的推进功能。");
  });

  it("数量标签与数组长度一致", () => {
    const html = renderToStaticMarkup(createElement(QualityPanel, { quality: READY }));
    // dl 里 Issues: 2 / Suggestions: 1
    expect(html).toMatch(/Issues<\/dt><dd[^>]*>2<\/dd>/);
    expect(html).toMatch(/Suggestions<\/dt><dd[^>]*>1<\/dd>/);
  });

  it("没有问题 / 没有建议时给出占位文案，不渲染空列表", () => {
    const html = renderToStaticMarkup(createElement(QualityPanel, {
      quality: { ...READY, issues: [], suggestions: [], summary: null },
    }));
    expect(html).toContain("（没有问题）");
    expect(html).toContain("（没有建议）");
    expect(html).not.toContain("中段推进重复");
  });
});

describe("§53 空分数渲染安全", () => {
  it("没有审阅结论 → 显示 —，不是 0、不是 NaN", () => {
    const html = renderToStaticMarkup(createElement(QualityPanel, {
      quality: { ...READY, overall_score: null, summary: null, issues: [], suggestions: [] },
    }));
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
    // 分数位不是 0：空分数要能看到「—」而不是伪造 0 分
    expect(html).toContain('tabular-nums">—</span>');
  });

  it("qualityScoreText：整数不带小数，未知/非有限值是 —", () => {
    expect(qualityScoreText(74)).toBe("74");
    expect(qualityScoreText(0)).toBe("0");
    expect(qualityScoreText(100)).toBe("100");
    expect(qualityScoreText(null)).toBe("—");
    expect(qualityScoreText(Number.NaN)).toBe("—");
    expect(qualityScoreText(74.25)).toBe("74.3");
  });
});

describe("§53 validation failed renders", () => {
  it("未通过时显示未通过，校验没跑时显示未知（与「没过」区分开）", () => {
    const failed = renderToStaticMarkup(createElement(QualityPanel, {
      quality: { ...READY, validation_passed: false, accepted: false },
    }));
    expect(failed).toContain("未通过");
    expect(failed).toContain("未采纳");

    const unknown = renderToStaticMarkup(createElement(QualityPanel, {
      quality: { ...READY, validation_passed: null },
    }));
    expect(unknown).toContain("未知（校验未完成）");
    expect(unknown).not.toContain("未通过");
  });
});

describe("§37 旧 Run 没有 quality 不崩", () => {
  it("quality = null → 整个区域不渲染", () => {
    expect(qualityPanelState({ quality: null })).toEqual({ kind: "hidden" });
    expect(renderToStaticMarkup(createElement(QualityPanel, { quality: null }))).toBe("");
  });
});

describe("§34 不出现 v1.3+ 能力", () => {
  it("面板文本里没有多维、趋势、PASS/FAIL、雷达一类字样", () => {
    const html = renderToStaticMarkup(createElement(QualityPanel, { quality: READY }));
    for (const forbidden of ["Radar", "Coherence", "Narrative", "Character", "Causality", "Dimension", "Trend", "PASS", "FAIL", "Benchmark", "Experiment", "Attribution"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("qualityPanelState 不产出任何额外判断字段", () => {
    const state = qualityPanelState({ quality: READY });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(Object.keys(state).sort()).toEqual([
      "acceptedText", "issues", "kind", "overallScoreText", "suggestions", "summary",
      "validationText", "validationTone",
    ]);
  });
});
