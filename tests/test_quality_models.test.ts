import { describe, expect, it } from "vitest";
import {
  qualityResultOf,
  type QualityIssue,
  type QualityResult,
  type QualitySuggestion,
} from "@/types/quality";
import type { ReviewResult } from "@/types/review-result";

/**
 * v1.2.0 §46 质量模型测试：QualityResult 的宽容磁盘归一化。
 *
 * 这个函数只回答一件事：磁盘上那份 quality.json 还能不能用。
 * 形状不认识就整体作废（返回 null，让调用方走内存装配），
 * 单条坏数据只丢那一条——宁可按可用的部分渲染，也不让页面白屏。
 */

function qualityJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overall_score: 74,
    validation_passed: true,
    accepted: true,
    issues: [],
    suggestions: [],
    summary: "故事整体完整，主线明确。",
    ...overrides,
  };
}

describe("qualityResultOf — 完整形状（§46）", () => {
  it("valid result：六个字段原样通过", () => {
    const result = qualityResultOf(qualityJson());
    expect(result).toEqual({
      overall_score: 74,
      validation_passed: true,
      accepted: true,
      issues: [],
      suggestions: [],
      summary: "故事整体完整，主线明确。",
    });
  });

  it("score 0 与 score 100 是合法值，不当成缺失", () => {
    expect(qualityResultOf(qualityJson({ overall_score: 0 }))?.overall_score).toBe(0);
    expect(qualityResultOf(qualityJson({ overall_score: 100 }))?.overall_score).toBe(100);
  });

  it("null score：没有审阅结论时是 null，不是 0", () => {
    const result = qualityResultOf(qualityJson({ overall_score: null }));
    expect(result?.overall_score).toBeNull();
  });

  it("accepted false：用尽 Attempt 的 Run 也需要能读出快照", () => {
    const result = qualityResultOf(qualityJson({ accepted: false }));
    expect(result?.accepted).toBe(false);
  });

  it("validation_passed false 与 null 都保留原值", () => {
    expect(qualityResultOf(qualityJson({ validation_passed: false }))?.validation_passed).toBe(false);
    expect(qualityResultOf(qualityJson({ validation_passed: null }))?.validation_passed).toBeNull();
  });

  it("issues / suggestions 数组逐条保留", () => {
    const issues: QualityIssue[] = [
      { id: "validation-1", source: "validation", category: "TOO_SHORT", message: "太短。", severity: "error" },
      { id: "review-1", source: "review", category: "review_problem", message: "高潮缺失。" },
    ];
    const suggestions: QualitySuggestion[] = [
      { id: "review-suggestion-1", source: "review", message: "压缩中段。" },
    ];
    const result = qualityResultOf(qualityJson({ issues, suggestions }));
    expect(result?.issues).toEqual(issues);
    expect(result?.suggestions).toEqual(suggestions);
  });

  it("issues 里缺 severity 也接受（ severity 是可选字段）", () => {
    const result = qualityResultOf(qualityJson({
      issues: [{ id: "review-1", source: "review", category: "review_problem", message: "高潮缺失。" }],
    }));
    expect(result?.issues[0].severity).toBeUndefined();
  });
});

describe("qualityResultOf — 形状不认识就整体作废（§26/§27）", () => {
  it("null / undefined / 字符串 / 数字 / 数组 / 布尔 → null", () => {
    for (const raw of [null, undefined, "74", 74, [], true]) {
      expect(qualityResultOf(raw)).toBeNull();
    }
  });

  it("缺 overall_score / validation_passed / accepted → null（宁可重新装配，也不渲染半个快照）", () => {
    for (const field of ["overall_score", "validation_passed", "accepted"]) {
      const broken = qualityJson();
      delete broken[field];
      expect(qualityResultOf(broken), `缺 ${field} 应整体作废`).toBeNull();
    }
  });

  it("accepted 不是布尔值 → null", () => {
    expect(qualityResultOf(qualityJson({ accepted: "yes" }))).toBeNull();
  });

  it("score 越界（>100 / <0 / 非数字）→ null", () => {
    expect(qualityResultOf(qualityJson({ overall_score: 101 }))).toBeNull();
    expect(qualityResultOf(qualityJson({ overall_score: -1 }))).toBeNull();
    expect(qualityResultOf(qualityJson({ overall_score: "74" }))).toBeNull();
  });
});

describe("qualityResultOf — issues / suggestions / summary 宽容（§46）", () => {
  it("issues / suggestions 缺失时按空数组，整体仍然可用", () => {
    const broken = qualityJson();
    delete broken.issues;
    delete broken.suggestions;
    const result = qualityResultOf(broken);
    expect(result?.issues).toEqual([]);
    expect(result?.suggestions).toEqual([]);
    expect(result?.overall_score).toBe(74);
  });

  it("summary 缺失或不是字符串 → null，快照其余部分照常返回", () => {
    const noSummary = qualityJson();
    delete noSummary.summary;
    expect(qualityResultOf(noSummary)?.summary).toBeNull();
    expect(qualityResultOf(qualityJson({ summary: 74 }))?.summary).toBeNull();
    expect(qualityResultOf(qualityJson({ summary: "   " }))?.summary).toBeNull();
  });
});

describe("qualityResultOf — 单条坏数据只丢那一条（§46）", () => {
  it("issues 不是数组时按空数组处理，其余字段照常返回", () => {
    const result = qualityResultOf(qualityJson({ issues: "高潮缺失" }));
    expect(result?.issues).toEqual([]);
    expect(result?.overall_score).toBe(74);
  });

  it("issues 里的坏条目被跳过，好条目保留", () => {
    const result = qualityResultOf(qualityJson({
      issues: [
        null,
        "高潮缺失",
        42,
        { id: "review-1", source: "review", category: "review_problem", message: "高潮缺失。" },
        { source: "review", category: "review_problem", message: "缺 id" },
        { id: "review-2", source: "review" },
      ],
    }));
    expect(result?.issues).toEqual([
      { id: "review-1", source: "review", category: "review_problem", message: "高潮缺失。" },
      { id: "unknown-2", source: "review", category: "review_problem", message: "缺 id" },
    ]);
  });

  it("id 缺失时补 unknown-N，渲染层仍能拿到稳定 key", () => {
    const result = qualityResultOf(qualityJson({
      suggestions: [{ source: "review", message: "压缩中段。" }],
    }));
    expect(result?.suggestions).toEqual([
      { id: "unknown-1", source: "review", message: "压缩中段。" },
    ]);
  });

  it("source 不在枚举内 → 该条目作废", () => {
    const result = qualityResultOf(qualityJson({
      issues: [{ id: "x-1", source: "benchmark", category: "review_problem", message: "越界来源。" }],
    }));
    expect(result?.issues).toEqual([]);
  });

  it("message 不是字符串 → 该条目作废", () => {
    const result = qualityResultOf(qualityJson({
      issues: [{ id: "review-1", source: "review", category: "review_problem", message: 42 }],
    }));
    expect(result?.issues).toEqual([]);
  });
});

describe("ReviewResult 的 suggestions 是可选的（§48）", () => {
  it("没有 suggestions 字段的旧结构依然完整可用", () => {
    const old: ReviewResult = {
      score: 74,
      summary: "总结。",
      strengths: ["强"],
      problems: ["中段线索重复"],
    };
    expect(old.suggestions).toBeUndefined();
    expect(qualityResultOf(qualityJson({ summary: old.summary }))).not.toBeNull();
  });

  it("带 suggestions 的新结构同样可用", () => {
    const fresh: ReviewResult = {
      score: 74,
      summary: "总结。",
      strengths: ["强"],
      problems: [],
      suggestions: ["压缩中段。"],
    };
    expect(fresh.suggestions).toEqual(["压缩中段。"]);
  });
});

describe("QualityResult 类型形状（§46）", () => {
  it("手工构造的合法快照能被 qualityResultOf 原样读回（可持久化契约自洽）", () => {
    const result: QualityResult = {
      overall_score: 0,
      validation_passed: false,
      accepted: false,
      issues: [
        { id: "validation-1", source: "validation", category: "TOO_SHORT", message: "太短。", severity: "error" },
      ],
      suggestions: [],
      summary: null,
    };
    expect(qualityResultOf(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
});
