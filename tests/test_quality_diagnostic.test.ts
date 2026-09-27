/**
 * v2.1.0 TASK §38 QualityDiagnostic schema。
 *
 * 三套质量组件（Beat Validator v2 / Quality Reviewer v2 / Commercial Reviewer v2）
 * 共用这一个诊断模型，所以它的校验必须一次到位：
 *   - 合法的一条原样通过，可选字段给了就不能是空壳；
 *   - source / category / severity / target / message 五样缺一样或不在册都拒；
 *   - category 按来源各认各的白名单——两套评价体系不做换算；
 *   - §5 禁用的字段（rootCause / confidenceProbability / repairPolicy / adaptiveWeight /
 *     causalNodeId / evidenceLedgerId / characterDecisionId）一个都不进结论。
 *
 * 全部是纯函数，没有 LLM、没有磁盘、没有网络。
 */

import { describe, expect, it } from "vitest";
import {
  BEAT_DIAGNOSTIC_CATEGORIES,
  COMMERCIAL_DIAGNOSTIC_CATEGORIES,
  QUALITY_DIAGNOSTIC_CATEGORIES,
  QUALITY_DIAGNOSTIC_SEVERITIES,
  QUALITY_DIAGNOSTIC_SOURCES,
  QUALITY_DIAGNOSTIC_TARGETS,
  QualityDiagnosticValidationError,
  countDiagnosticsBySeverity,
  dedupeQualityDiagnostics,
  diagnosticCategoriesOf,
  diagnosticDedupKey,
  isQualityDiagnosticSeverity,
  isQualityDiagnosticSource,
  isQualityDiagnosticTarget,
  qualityDiagnosticsOf,
  validateQualityDiagnostic,
  validateQualityDiagnostics,
  type QualityDiagnostic,
  type QualityDiagnosticSource,
} from "@/domain/quality-diagnostic";

const BEAT: QualityDiagnosticSource = "beat-validator";
const STORY: QualityDiagnosticSource = "quality-reviewer";
const COMMERCIAL: QualityDiagnosticSource = "commercial-reviewer";

function beatDiagnostic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "beat-validator-1",
    category: "MISSING_CLIMAX",
    severity: "error",
    target: "beat-plan",
    message: "第 4 拍直接跳到结局。",
    relatedBeatIds: [4],
    ...overrides,
  };
}

describe("§38 合法诊断原样通过", () => {
  it("valid diagnostic：六个字段一个不少，可选字段也在", () => {
    expect(validateQualityDiagnostic(beatDiagnostic(), BEAT)).toEqual({
      id: "beat-validator-1",
      source: BEAT,
      category: "MISSING_CLIMAX",
      severity: "error",
      target: "beat-plan",
      message: "第 4 拍直接跳到结局。",
      relatedBeatIds: [4],
    });
  });

  it("只有五个必填字段也合法：suggestion 与 relatedBeatIds 整个键不出现", () => {
    const out = validateQualityDiagnostic(
      {
        id: "quality-reviewer-1",
        category: "repetition",
        severity: "warning",
        target: "middle",
        message: "中段两场戏功能重复。",
      },
      STORY,
    );
    expect(out).toEqual({
      id: "quality-reviewer-1",
      source: STORY,
      category: "repetition",
      severity: "warning",
      target: "middle",
      message: "中段两场戏功能重复。",
    });
    expect("suggestion" in out).toBe(false);
    expect("relatedBeatIds" in out).toBe(false);
  });

  it("suggestion 给了就保留原文", () => {
    const out = validateQualityDiagnostic(
      {
        id: "commercial-reviewer-1",
        category: "weak_payoff",
        severity: "warning",
        target: "ending",
        message: "回报不足。",
        suggestion: "把最后一次反转的代价写实。",
      },
      COMMERCIAL,
    );
    expect(out.suggestion).toBe("把最后一次反转的代价写实。");
  });

  it("三档 severity 与七个 target 的每一种取值都过得去", () => {
    for (const severity of QUALITY_DIAGNOSTIC_SEVERITIES) {
      for (const target of QUALITY_DIAGNOSTIC_TARGETS) {
        const out = validateQualityDiagnostic(
          {
            id: "quality-reviewer-1",
            category: "causal_gap",
            severity,
            target,
            message: "一句话。",
          },
          STORY,
        );
        expect(out.severity).toBe(severity);
        expect(out.target).toBe(target);
      }
    }
  });

  it("首尾空白被清理，中间的内容不动", () => {
    const out = validateQualityDiagnostic(
      {
        id: "  quality-reviewer-1  ",
        category: " repetition ",
        severity: " warning ",
        target: " middle ",
        message: "  中段重复。  ",
        suggestion: "  压缩线索。  ",
      },
      STORY,
    );
    expect(out).toEqual({
      id: "quality-reviewer-1",
      source: STORY,
      category: "repetition",
      severity: "warning",
      target: "middle",
      message: "中段重复。",
      suggestion: "压缩线索。",
    });
  });
});

describe("§38 非法诊断一律拒", () => {
  it("invalid source：调用方给的来源不在那三个里", () => {
    expect(isQualityDiagnosticSource("story-validator")).toBe(false);
    expect(() => validateQualityDiagnostic(beatDiagnostic(), "story-validator" as never)).toThrow(
      QualityDiagnosticValidationError,
    );
    // 三个合法来源各认各的
    expect(isQualityDiagnosticSource(BEAT)).toBe(true);
    expect(isQualityDiagnosticSource(STORY)).toBe(true);
    expect(isQualityDiagnosticSource(COMMERCIAL)).toBe(true);
    expect(QUALITY_DIAGNOSTIC_SOURCES).toEqual([BEAT, STORY, COMMERCIAL]);
  });

  it("invalid category：故事质量的类别写进别家的白名单就拒（两套评价不做换算）", () => {
    expect(() =>
      validateQualityDiagnostic(beatDiagnostic({ category: "repetition" }), BEAT),
    ).toThrow(/category 非法/);
    expect(() =>
      validateQualityDiagnostic(
        { id: "quality-reviewer-1", category: "MISSING_CLIMAX", severity: "error", target: "story", message: "x" },
        STORY,
      ),
    ).toThrow(/category 非法/);
    expect(() =>
      validateQualityDiagnostic(
        { id: "commercial-reviewer-1", category: "slow_pacing", severity: "warning", target: "middle", message: "x" },
        STORY,
      ),
    ).toThrow(/category 非法/);
  });

  it("每个来源只认自己那一份类别清单", () => {
    expect(diagnosticCategoriesOf(BEAT)).toBe(BEAT_DIAGNOSTIC_CATEGORIES);
    expect(diagnosticCategoriesOf(STORY)).toBe(QUALITY_DIAGNOSTIC_CATEGORIES);
    expect(diagnosticCategoriesOf(COMMERCIAL)).toBe(COMMERCIAL_DIAGNOSTIC_CATEGORIES);
    expect([...BEAT_DIAGNOSTIC_CATEGORIES]).toContain("MISSING_CLIMAX");
    expect([...QUALITY_DIAGNOSTIC_CATEGORIES]).toContain("causal_gap");
    expect([...COMMERCIAL_DIAGNOSTIC_CATEGORIES]).toContain("weak_payoff");
  });

  it("invalid severity：空 / 大小写不对 / 白名单外都拒", () => {
    for (const severity of ["", "  ", "critical", "ERROR", "warn"]) {
      expect(() => validateQualityDiagnostic(beatDiagnostic({ severity }), BEAT)).toThrow(
        /severity 非法/,
      );
    }
    expect(isQualityDiagnosticSeverity("error")).toBe(true);
    expect(isQualityDiagnosticSeverity("fatal")).toBe(false);
  });

  it("invalid target：白名单外的指向拒，七个合法值都认", () => {
    for (const target of ["", "beat", "plot", "whole-story"]) {
      expect(() => validateQualityDiagnostic(beatDiagnostic({ target }), BEAT)).toThrow(/target 非法/);
    }
    expect(isQualityDiagnosticTarget("beat-plan")).toBe(true);
    expect(isQualityDiagnosticTarget("global")).toBe(true);
    expect(isQualityDiagnosticTarget("world")).toBe(false);
    expect(QUALITY_DIAGNOSTIC_TARGETS).toHaveLength(7);
  });

  it("empty message：空串与纯空白都拒（说不出话的诊断等于没有）", () => {
    for (const message of ["", "   ", "\t\n"]) {
      expect(() => validateQualityDiagnostic(beatDiagnostic({ message }), BEAT)).toThrow(/message/);
    }
    expect(() => validateQualityDiagnostic(beatDiagnostic({ message: 42 }), BEAT)).toThrow(/message/);
  });

  it("id 必填：缺失或空白都拒", () => {
    expect(() => validateQualityDiagnostic(beatDiagnostic({ id: "" }), BEAT)).toThrow(/id 必填/);
    expect(() => validateQualityDiagnostic(beatDiagnostic({ id: "   " }), BEAT)).toThrow(/id 必填/);
    // 整个键不在：同样拒（不能拿一个没有 id 的诊断混过去）
    const withoutId: Record<string, unknown> = {
      category: "MISSING_CLIMAX",
      severity: "error",
      target: "beat-plan",
      message: "第 4 拍直接跳到结局。",
    };
    expect(() => validateQualityDiagnostic(withoutId, BEAT)).toThrow(/id 必填/);
  });

  it("invalid relatedBeatIds：不是数组就拒；非正整数被滤掉；滤空了键不出现", () => {
    expect(() => validateQualityDiagnostic(beatDiagnostic({ relatedBeatIds: "4" }), BEAT)).toThrow(
      /relatedBeatIds 必须是数组/,
    );
    expect(() => validateQualityDiagnostic(beatDiagnostic({ relatedBeatIds: {} }), BEAT)).toThrow(
      /relatedBeatIds 必须是数组/,
    );
    const filtered = validateQualityDiagnostic(
      beatDiagnostic({ relatedBeatIds: [4, 0, -1, 2.5, "3", null, 7] }),
      BEAT,
    );
    expect(filtered.relatedBeatIds).toEqual([4, 7]);
    const emptied = validateQualityDiagnostic(beatDiagnostic({ relatedBeatIds: [0, -1] }), BEAT);
    expect("relatedBeatIds" in emptied).toBe(false);
    const nulled = validateQualityDiagnostic(beatDiagnostic({ relatedBeatIds: null }), BEAT);
    expect("relatedBeatIds" in nulled).toBe(false);
  });

  it("suggestion 给了却不能是空壳", () => {
    expect(() => validateQualityDiagnostic(beatDiagnostic({ suggestion: "" }), BEAT)).toThrow(
      /suggestion 必须是非空字符串/,
    );
    expect(() => validateQualityDiagnostic(beatDiagnostic({ suggestion: "   " }), BEAT)).toThrow(
      /suggestion 必须是非空字符串/,
    );
    expect(() => validateQualityDiagnostic(beatDiagnostic({ suggestion: 7 }), BEAT)).toThrow(
      /suggestion 必须是非空字符串/,
    );
  });

  it("§5 禁用的字段被忽略，不会跟着结论走", () => {
    const out = validateQualityDiagnostic(
      beatDiagnostic({
        rootCause: "主角动机不足",
        confidenceProbability: 0.92,
        repairPolicy: "rewrite-ending",
        adaptiveWeight: 1.7,
        causalNodeId: "node-9",
        evidenceLedgerId: "ledger-3",
        characterDecisionId: "decision-5",
      }),
      BEAT,
    );
    expect(Object.keys(out).sort()).toEqual(
      ["category", "id", "message", "relatedBeatIds", "severity", "source", "target"].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("0.92");
  });
});

describe("§38 诊断数组：id 由校验方按顺序指派", () => {
  it("模型自报的 id 被覆盖，顺序连续", () => {
    const out = validateQualityDiagnostics(
      [
        { id: "model-made-this-up", category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮。" },
        { category: "BROKEN_SEQUENCE", severity: "error", target: "beat-plan", message: "顺序断了。" },
      ],
      BEAT,
    );
    expect(out.map((d) => d.id)).toEqual(["beat-validator-1", "beat-validator-2"]);
  });

  it("不是数组就拒，不拿空数组糊弄", () => {
    expect(() => validateQualityDiagnostics(undefined, BEAT)).toThrow(/必须是数组/);
    expect(() => validateQualityDiagnostics({}, BEAT)).toThrow(/必须是数组/);
  });

  it("空数组是合法的：没有诊断不等于输出非法", () => {
    expect(validateQualityDiagnostics([], BEAT)).toEqual([]);
  });

  it("数组里混进一条坏的：整批拒，不挑好的先留着", () => {
    expect(() =>
      validateQualityDiagnostics(
        [
          { category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮。" },
          { category: "NOT_A_CODE", severity: "error", target: "beat-plan", message: "坏的一条。" },
        ],
        BEAT,
      ),
    ).toThrow(/category 非法/);
  });

  it("读盘宽容版：认不出来只给 null", () => {
    expect(qualityDiagnosticsOf([{ category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮。" }], BEAT)).toEqual([
      { id: "beat-validator-1", source: BEAT, category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮。" },
    ]);
    expect(qualityDiagnosticsOf("nope", BEAT)).toBeNull();
    expect(qualityDiagnosticsOf([{ category: "NOT_A_CODE", severity: "error", target: "beat-plan", message: "x" }], BEAT)).toBeNull();
  });
});

describe("§38 severity 计数与轻量去重", () => {
  const diagnostics: QualityDiagnostic[] = [
    { id: "beat-validator-1", source: BEAT, category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮。" },
    { id: "quality-reviewer-1", source: STORY, category: "repetition", severity: "warning", target: "middle", message: "中段重复。" },
    { id: "quality-reviewer-2", source: STORY, category: "causal_gap", severity: "error", target: "story", message: "因果断裂。" },
    { id: "commercial-reviewer-1", source: COMMERCIAL, category: "weak_payoff", severity: "info", target: "ending", message: "回报略赶。" },
  ];

  it("countDiagnosticsBySeverity：总数等于长度，三档各计各的", () => {
    expect(countDiagnosticsBySeverity(diagnostics)).toEqual({
      totalDiagnostics: 4,
      errors: 2,
      warnings: 1,
      info: 1,
    });
    expect(countDiagnosticsBySeverity([])).toEqual({
      totalDiagnostics: 0,
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it("dedupeQualityDiagnostics：同一来源对同一处说的同一句话只留第一条", () => {
    const repeated = [...diagnostics, { ...diagnostics[1], id: "quality-reviewer-9" }];
    expect(dedupeQualityDiagnostics(repeated)).toEqual(diagnostics);
  });

  it("去重键只含 source + category + target + message：severity 与 id 不同也算同一句", () => {
    const key = diagnosticDedupKey(diagnostics[1]);
    expect(key).toBe(`${STORY}|repetition|middle|中段重复。`);
    const sameWords = { ...diagnostics[1], id: "other", severity: "error" as const };
    expect(dedupeQualityDiagnostics([diagnostics[1], sameWords])).toEqual([diagnostics[1]]);
  });

  it("换来源、换指向、换说法都不合并：没有语义合并", () => {
    const sameWordsOtherSource = { ...diagnostics[1], source: COMMERCIAL, category: "repetitive_middle" };
    expect(dedupeQualityDiagnostics([diagnostics[1], sameWordsOtherSource])).toHaveLength(2);

    const otherTarget = { ...diagnostics[1], target: "story" as const };
    expect(dedupeQualityDiagnostics([diagnostics[1], otherTarget])).toHaveLength(2);

    const nearMiss = { ...diagnostics[1], message: "中段两场戏功能重复。" };
    expect(dedupeQualityDiagnostics([diagnostics[1], nearMiss])).toHaveLength(2);
  });

  it("去重不改传入的数组，也不改里面的对象", () => {
    const input = [diagnostics[1], { ...diagnostics[1], id: "dup" }];
    const before = JSON.stringify(input);
    dedupeQualityDiagnostics(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
