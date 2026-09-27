import { describe, expect, it } from "vitest";
import { parseQualityReviewV2Result, ReviewParseError } from "@/engine/review-parser";
import type { QualityReviewV2Result } from "@/domain/quality-review-v2";

/**
 * §41 Quality Reviewer v2 Parser：raw LLM output → 轻量清理 → JSON parse → schema 校验
 * → QualityReviewV2Result。
 * 禁止 LLM JSON Repair Agent（§15）：非法就是非法。
 *
 * v2 起 schema 比 v1.x 严：四个维度必须齐全且各带 strengths / problems，
 * diagnostics 必须过 QualityDiagnostic 校验，整体分一律由系统按四维均分重算。
 */

const validJson = JSON.stringify({
  score: 74,
  dimensions: {
    coherence: {
      score: 76,
      summary: "设定、称呼、时间线前后一致。",
      strengths: ["称呼从头到尾统一"],
      problems: [],
    },
    narrative: {
      score: 78,
      summary: "起承转合完整，中段节奏偏慢。",
      strengths: ["开场冲突建立迅速"],
      problems: ["中段线索重复"],
    },
    character: {
      score: 70,
      summary: "主角目标清晰，高潮处退让动机交代不足。",
      strengths: ["主角目标明确"],
      problems: [],
    },
    causality: {
      score: 72,
      summary: "主线因果成立，配角的反水缺少铺垫。",
      strengths: [],
      problems: ["配角反水缺少铺垫"],
    },
  },
  diagnostics: [
    {
      id: "模型自己编的 id",
      source: "quality-reviewer",
      category: "repetition",
      severity: "warning",
      target: "story",
      message: "中段线索重复",
      suggestion: "压缩重复线索，让中段事件承担新的推进功能。",
    },
  ],
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
});

/** (76+78+70+72)/4 = 74 */
const EXPECTED: QualityReviewV2Result = {
  score: 74,
  dimensions: {
    coherence: {
      score: 76,
      summary: "设定、称呼、时间线前后一致。",
      strengths: ["称呼从头到尾统一"],
      problems: [],
    },
    narrative: {
      score: 78,
      summary: "起承转合完整，中段节奏偏慢。",
      strengths: ["开场冲突建立迅速"],
      problems: ["中段线索重复"],
    },
    character: {
      score: 70,
      summary: "主角目标清晰，高潮处退让动机交代不足。",
      strengths: ["主角目标明确"],
      problems: [],
    },
    causality: {
      score: 72,
      summary: "主线因果成立，配角的反水缺少铺垫。",
      strengths: [],
      problems: ["配角反水缺少铺垫"],
    },
  },
  diagnostics: [
    {
      id: "quality-reviewer-1",
      source: "quality-reviewer",
      category: "repetition",
      severity: "warning",
      target: "story",
      message: "中段线索重复",
      suggestion: "压缩重复线索，让中段事件承担新的推进功能。",
    },
  ],
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
};

describe("parseQualityReviewV2Result（§15/§41）", () => {
  it("valid JSON → QualityReviewV2Result", () => {
    expect(parseQualityReviewV2Result(validJson)).toEqual(EXPECTED);
  });

  it("JSON code fence → 轻量去除后正常解析", () => {
    expect(parseQualityReviewV2Result("```json\n" + validJson + "\n```")).toEqual(EXPECTED);
    expect(parseQualityReviewV2Result("```\n" + validJson + "\n```")).toEqual(EXPECTED);
  });

  it("首尾空白被清理", () => {
    expect(parseQualityReviewV2Result("\n  " + validJson + "  \n")).toEqual(EXPECTED);
  });

  it("invalid JSON → ReviewParseError（不做智能修复）", () => {
    expect(() => parseQualityReviewV2Result("这不是 JSON")).toThrow(ReviewParseError);
    expect(() => parseQualityReviewV2Result("{score: 74,}")).toThrow(/Reviewer 输出不是合法 JSON/);
    expect(() => parseQualityReviewV2Result("")).toThrow(ReviewParseError);
  });

  it("缺一个维度 → 拒绝（不降级成三维结论）", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const partial = { ...(raw.dimensions as Record<string, unknown>) };
    delete partial.character;
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: partial })))
      .toThrow(/dimensions\.character 缺失或不是对象/);
  });

  it("多出未知维度 → 拒绝（模型自己扩到 35 维也进不来）", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const extra = { ...(raw.dimensions as Record<string, unknown>), tension: { score: 90, summary: "x", strengths: [], problems: [] } };
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: extra })))
      .toThrow(/未知维度 tension/);
  });

  it("维度分越界 / 非数字 → 拒绝", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const bad = JSON.parse(JSON.stringify(raw.dimensions)) as Record<string, Record<string, unknown>>;
    bad.coherence.score = 140;
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: bad })))
      .toThrow(/dimensions\.coherence\.score 必须在 0 ~ 100/);

    bad.coherence.score = "76";
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: bad })))
      .toThrow(/dimensions\.coherence\.score 必须是数字/);
  });

  it("维度缺 strengths / problems → 拒绝（§7 每个维度都要能说出好与坏）", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const missingStrengths = JSON.parse(JSON.stringify(raw.dimensions)) as Record<string, Record<string, unknown>>;
    delete missingStrengths.narrative.strengths;
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: missingStrengths })))
      .toThrow(/dimensions\.narrative\.strengths 必须是数组/);

    const missingProblems = JSON.parse(JSON.stringify(raw.dimensions)) as Record<string, Record<string, unknown>>;
    delete missingProblems.causality.problems;
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: missingProblems })))
      .toThrow(/dimensions\.causality\.problems 必须是数组/);
  });

  it("维度 summary 为空 → 拒绝（没有短评的分数不可解释）", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const blank = JSON.parse(JSON.stringify(raw.dimensions)) as Record<string, Record<string, unknown>>;
    blank.character.summary = "   ";
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, dimensions: blank })))
      .toThrow(/dimensions\.character\.summary 不能为空/);
  });

  it("missing summary → 拒绝", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    delete raw.summary;
    expect(() => parseQualityReviewV2Result(JSON.stringify(raw))).toThrow(/summary 不能为空/);
  });

  it("§10 模型自报的整体分不被采信，一律按四维均分确定性重算", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    expect(parseQualityReviewV2Result(JSON.stringify({ ...raw, score: 99 })).score).toBe(74);
    expect(parseQualityReviewV2Result(JSON.stringify({ ...raw, score: 1 })).score).toBe(74);
  });

  it("诊断按统一 schema 校验：类别必须在册、severity / target 必须合法", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const withBadCategory = [
      { ...(raw.diagnostics as unknown[])[0] as Record<string, unknown>, category: "plot_hole" },
    ];
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: withBadCategory })))
      .toThrow(/category 非法：plot_hole/);

    const withBadSeverity = [
      { ...(raw.diagnostics as unknown[])[0] as Record<string, unknown>, severity: "fatal" },
    ];
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: withBadSeverity })))
      .toThrow(/severity 非法：fatal/);

    const withBadTarget = [
      { ...(raw.diagnostics as unknown[])[0] as Record<string, unknown>, target: "somewhere" },
    ];
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: withBadTarget })))
      .toThrow(/target 非法：somewhere/);
  });

  it("诊断缺 message → 拒绝；诊断不是数组 → 拒绝", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const first = (raw.diagnostics as unknown[])[0] as Record<string, unknown>;
    delete first.message;
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: [first] })))
      .toThrow(/message 不能为空/);
    expect(() => parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: { one: first } })))
      .toThrow(/diagnostics 必须是数组/);
  });

  it("诊断 id 由校验方按顺序指派（quality-reviewer-N），模型自报的 id 被覆盖", () => {
    const parsed = parseQualityReviewV2Result(validJson);
    expect(parsed.diagnostics[0].id).toBe("quality-reviewer-1");
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const first = raw.diagnostics as unknown[];
    const second = [{ ...(first[0] as Record<string, unknown>), message: "配角反水缺少铺垫" }];
    expect(parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: [...first, ...second] }))
      .diagnostics.map((d) => d.id)).toEqual(["quality-reviewer-1", "quality-reviewer-2"]);
  });

  it("§5 模型自报的禁用字段被忽略，不会带进结论", () => {
    const raw = JSON.parse(validJson) as Record<string, unknown>;
    const smuggled = [{
      ...(raw.diagnostics as unknown[])[0] as Record<string, unknown>,
      rootCause: "主角动机不纯",
      confidenceProbability: 0.93,
      repairPolicy: "rewrite_climax",
      adaptiveWeight: 1.7,
      causalNodeId: "cn-7",
      evidenceLedgerId: "el-7",
      characterDecisionId: "cd-7",
    }];
    const parsed = parseQualityReviewV2Result(JSON.stringify({ ...raw, diagnostics: smuggled }));
    expect(Object.keys(parsed.diagnostics[0]).sort()).toEqual([
      "category", "id", "message", "severity", "source", "suggestion", "target",
    ]);
  });

  it("数组外层（LLM 把结果包进数组）→ 拒绝，不偷偷取第一个元素", () => {
    expect(() => parseQualityReviewV2Result("[" + validJson + "]")).toThrow(/dimensions 必须是/);
  });
});
