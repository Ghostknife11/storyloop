import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  BEAT_VALIDATION_ISSUE_CODES,
  BEAT_VALIDATION_SEVERITIES,
  BeatValidationValidationError,
  beatValidationPassed,
  validateBeatValidationResult,
  type BeatValidationIssue,
} from "@/domain/beat-validation";
import {
  BeatValidationV2ValidationError,
  beatValidationV2Passed,
  legacyBeatValidationOf,
  diagnosticsOfIssues,
  validateBeatValidationV2Result,
} from "@/domain/beat-validation-v2";
import {
  BeatValidationParseError,
  parseBeatValidationV2Result,
} from "@/engine/beat-validation-parser";
import {
  BEAT_VALIDATION_TEMPERATURE,
  BeatValidator,
  checkBeatPlanDeterministic,
} from "@/engine/beat-validator";
import { validateBeatPlan, type BeatPlan } from "@/domain/beat-plan";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_BEAT_VALIDATION_FAILED,
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_BEAT_VALIDATION_V2_FAILED,
  SAMPLE_CONFIG,
  FakeLLM,
  repoRoot,
} from "./helpers/fixtures";

/**
 * v2.1.0 Beat 校验模型 / parser / 规则层 / BeatValidator 测试（TASK §13~§16）。
 * v1.4.0 的 BeatValidationResult 仍然在（beat-validation.json 与接口的形状没变），
 * 这里同时把守两侧：v2 的统一 diagnostics 与 v1 DTO 兼容层。
 * 全部用假 LLM 与合成 BeatPlan，绝不调用真实付费 API（§47）。
 */

function planOf(beats: BeatPlan["beats"]): BeatPlan {
  return validateBeatPlan({ beat_plan_version: "1", beats });
}

/**
 * 直接搭一个 BeatPlan 对象、绕过 validateBeatPlan。
 * 规则层防的正是这种形状：空骨架 / 编号重复 / 编号不连续根本过不了 BeatPlan schema
 * （src/domain/beat-plan.ts 会先抛 BeatPlanValidationError），所以走 schema 进来的
 * BeatPlan 永远碰不到这几条规则。规则层是第二道防线，这里必须能单独验到。
 */
function rawPlan(beats: BeatPlan["beats"]): BeatPlan {
  return { beat_plan_version: "1", beats } as BeatPlan;
}

function beat(id: number, purpose: string, event: string, characters: string[] = ["陈岚"]) {
  return { id, purpose, event, characters };
}

describe("v1.4.0 BeatValidationResult schema（§4/§6/§33）", () => {
  it("白名册：11 个 code、2 个 severity，没有第三套体系", () => {
    expect(BEAT_VALIDATION_ISSUE_CODES).toHaveLength(11);
    expect(BEAT_VALIDATION_ISSUE_CODES).toEqual([
      "EMPTY_PLAN",
      "TOO_FEW_BEATS",
      "MISSING_OPENING",
      "MISSING_ESCALATION",
      "MISSING_CLIMAX",
      "MISSING_RESOLUTION",
      "BROKEN_SEQUENCE",
      "DUPLICATE_BEAT",
      "CHARACTER_STATE_CONFLICT",
      "UNSUPPORTED_TURN",
      "ENDING_NOT_PREPARED",
    ]);
    expect(BEAT_VALIDATION_SEVERITIES).toEqual(["warning", "error"]);
    // 与 StoryValidator 同一套 severity 口径：没有 info / fatal 之类的新等级
    expect(BEAT_VALIDATION_SEVERITIES).not.toContain("info");
  });

  it("passed 一律由 issues 重新推导：有 error 才 false", () => {
    expect(beatValidationPassed([])).toBe(true);
    expect(beatValidationPassed([{ code: "TOO_FEW_BEATS", severity: "warning", message: "x" }])).toBe(true);
    expect(
      beatValidationPassed([
        { code: "TOO_FEW_BEATS", severity: "warning", message: "x" },
        { code: "MISSING_CLIMAX", severity: "error", message: "y" },
      ]),
    ).toBe(false);
  });

  it("合法结果原样通过，缺 passed 时按 issues 推导", () => {
    expect(validateBeatValidationResult(SAMPLE_BEAT_VALIDATION)).toEqual(SAMPLE_BEAT_VALIDATION);
    expect(validateBeatValidationResult(SAMPLE_BEAT_VALIDATION_FAILED)).toEqual(SAMPLE_BEAT_VALIDATION_FAILED);

    const noPassed = validateBeatValidationResult({
      issues: [{ code: "MISSING_CLIMAX", severity: "error", message: "缺高潮" }],
      summary: "缺高潮。",
    });
    expect(noPassed.passed).toBe(false);
  });

  it("非法 code / severity / 空 message / 空 summary 一律抛 BeatValidationValidationError", () => {
    expect(() =>
      validateBeatValidationResult({ passed: true, issues: [{ code: "TONE_OFF", severity: "error", message: "x" }], summary: "s" }),
    ).toThrow(BeatValidationValidationError);
    expect(() =>
      validateBeatValidationResult({ passed: true, issues: [{ code: "MISSING_CLIMAX", severity: "fatal", message: "x" }], summary: "s" }),
    ).toThrow(BeatValidationValidationError);
    expect(() =>
      validateBeatValidationResult({ passed: true, issues: [{ code: "MISSING_CLIMAX", severity: "error", message: "  " }], summary: "s" }),
    ).toThrow(/message/);
    expect(() => validateBeatValidationResult({ passed: true, issues: [] })).toThrow(/summary/);
    expect(() => validateBeatValidationResult({ passed: true, summary: "s" })).toThrow(/issues/);
  });

  it("beat_ids 只留正整数，空数组等于没填", () => {
    const cleaned = validateBeatValidationResult({
      passed: false,
      issues: [{ code: "BROKEN_SEQUENCE", severity: "error", message: "顺序倒置", beat_ids: [1, 0, -2, 3.5, 7] }],
      summary: "顺序倒置。",
    });
    expect(cleaned.issues[0].beat_ids).toEqual([1, 7]);

    const none = validateBeatValidationResult({
      passed: false,
      issues: [{ code: "EMPTY_PLAN", severity: "error", message: "空骨架", beat_ids: [] }],
      summary: "空骨架。",
    });
    expect(none.issues[0].beat_ids).toBeUndefined();
  });

  it("schema 本身不带修复能力字段（§10：只报告，不修复）", () => {
    const keys = Object.keys(validateBeatValidationResult(SAMPLE_BEAT_VALIDATION)).sort();
    expect(keys).toEqual(["issues", "passed", "summary"]);
    const issueKeys = Object.keys(validateBeatValidationResult(SAMPLE_BEAT_VALIDATION_FAILED).issues[0]).sort();
    expect(issueKeys).toEqual(["beat_ids", "code", "message", "severity"]);
  });
});

describe("v1.4.0 parseBeatValidationResult（§3 JSON 边界）", () => {
  it("干净 JSON / 带围栏 / 带首尾空白都能解析，混在散文里则不行（§15 不修 JSON）", () => {
    const raw = JSON.stringify(SAMPLE_BEAT_VALIDATION_V2);
    expect(parseBeatValidationV2Result(raw)).toEqual(SAMPLE_BEAT_VALIDATION_V2);
    expect(parseBeatValidationV2Result(`\`\`\`json\n${raw}\n\`\`\``)).toEqual(SAMPLE_BEAT_VALIDATION_V2);
    expect(parseBeatValidationV2Result(`\n  ${raw}  \n`)).toEqual(SAMPLE_BEAT_VALIDATION_V2);
    // 与 review-parser 同一套口径：只做 trim + 去围栏，不围捕正文里的 JSON
    expect(() => parseBeatValidationV2Result(`好的，结论如下：\n${raw}\n以上。`)).toThrow(BeatValidationParseError);
  });

  it("解析不出 JSON 时抛 BeatValidationParseError，不静默返回 passed", () => {
    expect(() => parseBeatValidationV2Result("这份骨架我觉得还行")).toThrow(BeatValidationParseError);
    expect(() => parseBeatValidationV2Result("")).toThrow(BeatValidationParseError);
    expect(() => parseBeatValidationV2Result("{score: 1,}")).toThrow(/不是合法 JSON/);
  });

  it("JSON 合法但结构不对时：解析不出问题照样抛错，不会静默当成通过", () => {
    expect(() => parseBeatValidationV2Result('{"passed":true}')).toThrow(BeatValidationParseError);
    expect(() => parseBeatValidationV2Result('{"passed":true}')).toThrow(/diagnostics 必须是数组/);
    expect(() =>
      parseBeatValidationV2Result('{"passed":true,"diagnostics":[],"summary":"行。","extra":1}'),
    ).not.toThrow();
  });

  it("诊断用统一 schema：未知 category / 非法 severity / 非法 target / 空 message / 空 summary 一律拒绝", () => {
    expect(() =>
      parseBeatValidationV2Result('{"diagnostics":[{"category":"TONE_OFF","severity":"error","target":"beat-plan","message":"x"}],"summary":"s"}'),
    ).toThrow(/category 非法：TONE_OFF/);
    expect(() =>
      parseBeatValidationV2Result('{"diagnostics":[{"category":"MISSING_CLIMAX","severity":"fatal","target":"beat-plan","message":"x"}],"summary":"s"}'),
    ).toThrow(/severity 非法：fatal/);
    expect(() =>
      parseBeatValidationV2Result('{"diagnostics":[{"category":"MISSING_CLIMAX","severity":"error","target":"plot","message":"x"}],"summary":"s"}'),
    ).toThrow(/target 非法：plot/);
    expect(() =>
      parseBeatValidationV2Result('{"diagnostics":[{"category":"MISSING_CLIMAX","severity":"error","target":"beat-plan","message":"  "}],"summary":"s"}'),
    ).toThrow(/message 不能为空/);
    expect(() => parseBeatValidationV2Result('{"diagnostics":[],"summary":"  "}')).toThrow(/summary 不能为空/);
    expect(() => parseBeatValidationV2Result('{"summary":"s"}')).toThrow(/diagnostics 必须是数组/);
  });

  it("模型自报的 passed 不被采信：一律由诊断里的 severity 推导", () => {
    const lying = {
      passed: true,
      diagnostics: [{ category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮" }],
      summary: "缺高潮。",
    };
    expect(parseBeatValidationV2Result(JSON.stringify(lying)).passed).toBe(false);

    const cautious = {
      passed: false,
      diagnostics: [{ category: "ENDING_NOT_PREPARED", severity: "warning", target: "beat-plan", message: "结局没铺垫" }],
      summary: "结局缺铺垫。",
    };
    expect(parseBeatValidationV2Result(JSON.stringify(cautious)).passed).toBe(true);
  });

  it("诊断 id 由校验方按顺序指派，模型自报的 id 被覆盖", () => {
    const parsed = parseBeatValidationV2Result(JSON.stringify({
      diagnostics: [
        { id: "模型编的", category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "缺高潮" },
        { id: "另一个", category: "UNSUPPORTED_TURN", severity: "error", target: "beat-plan", message: "转折没铺垫" },
      ],
      summary: "两处问题。",
    }));
    expect(parsed.diagnostics.map((d) => d.id)).toEqual(["beat-validator-1", "beat-validator-2"]);
    expect(parsed.passed).toBe(false);
  });

  it("relatedBeatIds 只留正整数，空数组等于没填", () => {
    const parsed = parseBeatValidationV2Result(JSON.stringify({
      diagnostics: [
        {
          category: "BROKEN_SEQUENCE",
          severity: "error",
          target: "beat-plan",
          message: "顺序倒置",
          relatedBeatIds: [1, 0, -2, 3.5, 7],
        },
      ],
      summary: "顺序倒置。",
    }));
    expect(parsed.diagnostics[0].relatedBeatIds).toEqual([1, 7]);

    const none = parseBeatValidationV2Result(JSON.stringify({
      diagnostics: [
        { category: "EMPTY_PLAN", severity: "error", target: "beat-plan", message: "空骨架", relatedBeatIds: [] },
      ],
      summary: "空骨架。",
    }));
    expect(none.diagnostics[0].relatedBeatIds).toBeUndefined();
  });
});

describe("v2.1.0 BeatValidationV2Result schema（§14/§37）", () => {
  it("合法结果原样通过", () => {
    expect(validateBeatValidationV2Result(SAMPLE_BEAT_VALIDATION_V2)).toEqual(SAMPLE_BEAT_VALIDATION_V2);
    expect(validateBeatValidationV2Result(SAMPLE_BEAT_VALIDATION_V2_FAILED))
      .toEqual(SAMPLE_BEAT_VALIDATION_V2_FAILED);
  });

  it("§37 缺字段一律抛错：不拿空数组糊弄过去，也不静默当成通过", () => {
    expect(() => validateBeatValidationV2Result({ passed: true, summary: "s" })).toThrow(
      /diagnostics 必须是数组/,
    );
    expect(() => validateBeatValidationV2Result({ diagnostics: [], summary: "  " })).toThrow(
      BeatValidationV2ValidationError,
    );
    expect(() => validateBeatValidationV2Result({ diagnostics: "没有", summary: "s" })).toThrow(
      /diagnostics 必须是数组/,
    );
  });

  it("passed 一律由诊断重新推导：有 error 才 false", () => {
    expect(beatValidationV2Passed([])).toBe(true);
    expect(beatValidationV2Passed([
      { id: "beat-validator-1", source: "beat-validator", category: "TOO_FEW_BEATS", severity: "warning", target: "beat-plan", message: "x" },
    ])).toBe(true);
    expect(beatValidationV2Passed([
      { id: "beat-validator-1", source: "beat-validator", category: "TOO_FEW_BEATS", severity: "warning", target: "beat-plan", message: "x" },
      { id: "beat-validator-2", source: "beat-validator", category: "MISSING_CLIMAX", severity: "error", target: "beat-plan", message: "y" },
    ])).toBe(false);
  });

  it("§14 DTO 兼容层：v2 结论摊平回 v1.4.0 的 {passed, issues, summary}", () => {
    expect(legacyBeatValidationOf(SAMPLE_BEAT_VALIDATION_V2)).toEqual(SAMPLE_BEAT_VALIDATION);
    expect(legacyBeatValidationOf(SAMPLE_BEAT_VALIDATION_V2_FAILED)).toEqual({
      passed: false,
      issues: [
        {
          code: "MISSING_CLIMAX",
          severity: "error",
          message: "第 4 拍直接跳到结局，没有任何高潮或决定性对抗。",
          beat_ids: [4],
        },
      ],
      summary: "缺少高潮：从升级直接跳到收束，故事没有顶点。",
    });
  });

  it("§14 反向映射：v1 命中项 → 统一诊断，target 统一是 beat-plan", () => {
    const diagnostics = diagnosticsOfIssues([
      { code: "MISSING_CLIMAX", severity: "error", message: "缺高潮", beat_ids: [3, 4] },
      { code: "TOO_FEW_BEATS", severity: "warning", message: "拍数太少" },
    ]);
    expect(diagnostics).toEqual([
      {
        id: "beat-validator-1",
        source: "beat-validator",
        category: "MISSING_CLIMAX",
        severity: "error",
        target: "beat-plan",
        message: "缺高潮",
        relatedBeatIds: [3, 4],
      },
      {
        id: "beat-validator-2",
        source: "beat-validator",
        category: "TOO_FEW_BEATS",
        severity: "warning",
        target: "beat-plan",
        message: "拍数太少",
      },
    ]);
    // 两个方向互为逆运算：issues → diagnostics → issues 逐字一致
    expect(legacyBeatValidationOf({
      passed: false,
      diagnostics,
      summary: "s",
    }).issues).toEqual([
      { code: "MISSING_CLIMAX", severity: "error", message: "缺高潮", beat_ids: [3, 4] },
      { code: "TOO_FEW_BEATS", severity: "warning", message: "拍数太少" },
    ]);
  });

  it("info 档诊断落进旧 DTO 时按 warning 记：旧结构里没有第三档，不静默丢档", () => {
    const legacy = legacyBeatValidationOf({
      passed: true,
      diagnostics: [
        {
          id: "beat-validator-1",
          source: "beat-validator",
          category: "ENDING_NOT_PREPARED",
          severity: "info",
          target: "beat-plan",
          message: "结局铺垫偏薄",
        },
      ],
      summary: "结局铺垫偏薄。",
    });
    expect(legacy.issues[0].severity).toBe("warning");
    expect(legacy.passed).toBe(true);
  });

  it("v2 结论里绝不携带修复建议字段（§15：只报告）", () => {
    const keys = Object.keys(validateBeatValidationV2Result(SAMPLE_BEAT_VALIDATION_V2_FAILED)).sort();
    expect(keys).toEqual(["diagnostics", "passed", "summary"]);
    const diagnosticKeys = Object.keys(SAMPLE_BEAT_VALIDATION_V2_FAILED.diagnostics[0]).sort();
    expect(diagnosticKeys).toEqual([
      "category", "id", "message", "relatedBeatIds", "severity", "source", "target",
    ]);
  });
});

describe("v1.4.0 checkBeatPlanDeterministic（§3 规则层，不调 LLM）", () => {
  it("空骨架：只有一条 EMPTY_PLAN error，直接短路", () => {
    const diagnostics = checkBeatPlanDeterministic(rawPlan([]));
    expect(diagnostics).toEqual([
      {
        id: "beat-validator-1",
        source: "beat-validator",
        category: "EMPTY_PLAN",
        severity: "error",
        target: "beat-plan",
        message: "BeatPlan 里没有任何一拍，没有可生成的剧情骨架。",
      },
    ]);
  });

  it("少于 3 拍：TOO_FEW_BEATS 是 warning，不阻断", () => {
    const diagnostics = checkBeatPlanDeterministic(planOf([beat(1, "建立危机", "证人失踪。")]));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].category).toBe("TOO_FEW_BEATS");
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].relatedBeatIds).toEqual([1]);
  });

  it("编号重复：DUPLICATE_BEAT error，且不叠加 BROKEN_SEQUENCE", () => {
    const diagnostics = checkBeatPlanDeterministic(
      rawPlan([beat(1, "a", "甲。"), beat(1, "b", "乙。"), beat(2, "c", "丙。")]),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].category).toBe("DUPLICATE_BEAT");
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].relatedBeatIds).toEqual([1]);
  });

  it("编号不连续：BROKEN_SEQUENCE error，并报出当前编号", () => {
    const diagnostics = checkBeatPlanDeterministic(
      rawPlan([beat(1, "a", "甲。"), beat(3, "b", "乙。"), beat(4, "c", "丙。")]),
    );
    expect(diagnostics).toEqual([
      {
        id: "beat-validator-1",
        source: "beat-validator",
        category: "BROKEN_SEQUENCE",
        severity: "error",
        target: "beat-plan",
        message: "Beat 编号必须从 1 连续递增，当前是 1、3、4。顺序不唯一就无法确认事件的先后。",
        relatedBeatIds: [1, 3, 4],
      },
    ]);
  });

  it("§16 空拍：没有 purpose 或 event 的拍报 EMPTY_PLAN error 并点名是哪几拍", () => {
    const diagnostics = checkBeatPlanDeterministic(
      rawPlan([
        beat(1, "建立危机", "证人失踪。"),
        { id: 2, purpose: "  ", event: "", characters: ["陈岚"] },
        beat(3, "高潮对峙", "码头截人。"),
        beat(4, "收束", "案件重审。"),
      ]),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].category).toBe("EMPTY_PLAN");
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].relatedBeatIds).toEqual([2]);
  });

  it("结构完好的骨架：一条都不报", () => {
    expect(checkBeatPlanDeterministic(SAMPLE_BEAT_PLAN)).toEqual([]);
  });
});

describe("v1.4.0 BeatValidator（§3/§5/§10）", () => {
  it("规则层干净时把 Prompt 交给 LLM，用低温度，并带结构校验者 system", async () => {
    const llm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_VALIDATION_V2_FAILED)]);
    const validator = new BeatValidator(llm as never);

    const result = await validator.validate(SAMPLE_CONFIG, SAMPLE_BEAT_PLAN);

    expect(result).toEqual(SAMPLE_BEAT_VALIDATION_V2_FAILED);
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0].temperature).toBe(BEAT_VALIDATION_TEMPERATURE);
    expect(BEAT_VALIDATION_TEMPERATURE).toBeLessThan(0.7);
    expect(llm.prompts[0].system).toContain("结构校验");
    expect(llm.prompts[0].system).toContain("JSON");
  });

  it("Prompt 里带入 config 与摊平后的 BeatPlan，且没有残留占位符", async () => {
    const llm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_VALIDATION_V2)]);
    const validator = new BeatValidator(llm as never);

    const prompt = validator.buildBeatValidationPrompt(SAMPLE_CONFIG, SAMPLE_BEAT_PLAN);

    expect(prompt).toContain(SAMPLE_CONFIG.title);
    expect(prompt).toContain(SAMPLE_CONFIG.premise);
    expect(prompt).toContain(SAMPLE_CONFIG.ending);
    expect(prompt).toContain(SAMPLE_CONFIG.protagonist?.name ?? "");
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(prompt).toContain("Beat 1｜结构作用：建立危机");
    expect(prompt).toContain("事件：证人失踪，陈岚接到电话。");
    expect(prompt).toContain("出场人物：陈岚、周衡");
  });

  it("规则层报错时不再请求模型（§10：不花冤枉钱）", async () => {
    const llm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_VALIDATION_V2)]);
    const validator = new BeatValidator(llm as never);

    const result = await validator.validate(SAMPLE_CONFIG, rawPlan([]));

    expect(result.passed).toBe(false);
    expect(result.diagnostics[0].category).toBe("EMPTY_PLAN");
    expect(result.summary).toContain("EMPTY_PLAN");
    expect(llm.prompts).toHaveLength(0);
  });

  it("passed 以合并后的诊断重新推导，不采信模型自报的 passed", async () => {
    const lying = { passed: true, diagnostics: [], summary: "我觉得行。" };
    const llm = new FakeLLM([JSON.stringify(lying)]);
    const validator = new BeatValidator(llm as never);

    // 只有 2 拍：规则层给一条 warning，模型自报 passed=true。
    // warning 不阻断，所以 passed 仍是 true——但诊断必须留下规则层那一份。
    const result = await validator.validate(
      SAMPLE_CONFIG,
      planOf([beat(1, "建立危机", "证人失踪。"), beat(2, "高潮对峙", "码头截人。")]),
    );

    expect(result.passed).toBe(true);
    expect(result.diagnostics.map((d) => d.category)).toEqual(["TOO_FEW_BEATS"]);
    expect(result.summary).toBe("我觉得行。");
  });

  it("规则层与模型报同一条问题时只留一份（去重）", async () => {
    const llm = new FakeLLM([
      JSON.stringify({
        passed: false,
        diagnostics: [
          {
            category: "TOO_FEW_BEATS",
            severity: "warning",
            target: "beat-plan",
            message: "模型的版本。",
            relatedBeatIds: [1, 2],
          },
          {
            category: "MISSING_CLIMAX",
            severity: "error",
            target: "beat-plan",
            message: "没有高潮。",
            relatedBeatIds: [2],
          },
        ],
        summary: "拍数太少，且没有高潮。",
      }),
    ]);
    const validator = new BeatValidator(llm as never);
    const shortPlan = planOf([beat(1, "建立危机", "证人失踪。"), beat(2, "收束", "案件重审。")]);

    const result = await validator.validate(SAMPLE_CONFIG, shortPlan);

    // TOO_FEW_BEATS 的 category|relatedBeatIds 与规则层完全一致，只保留规则层那一份
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].message).not.toBe("模型的版本。");
    expect(result.diagnostics[0].relatedBeatIds).toEqual([1, 2]);
    expect(result.passed).toBe(false);
  });

  it("合并两层结论后 id 连续重排：不会出现两个 beat-validator-1", async () => {
    const llm = new FakeLLM([
      JSON.stringify({
        diagnostics: [
          {
            category: "MISSING_CLIMAX",
            severity: "error",
            target: "beat-plan",
            message: "没有高潮。",
            relatedBeatIds: [2],
          },
        ],
        summary: "拍数太少，且没有高潮。",
      }),
    ]);
    const validator = new BeatValidator(llm as never);
    const shortPlan = planOf([beat(1, "建立危机", "证人失踪。"), beat(2, "收束", "案件重审。")]);

    const result = await validator.validate(SAMPLE_CONFIG, shortPlan);
    expect(result.diagnostics.map((d) => d.id)).toEqual(["beat-validator-1", "beat-validator-2"]);
    expect(result.diagnostics.map((d) => d.category)).toEqual(["TOO_FEW_BEATS", "MISSING_CLIMAX"]);
  });

  it("模板读不到时构造就失败，不拖到运行时", () => {
    expect(() => new BeatValidator(new FakeLLM([]) as never, join(repoRoot(), "prompts", "no_such_file.txt"))).toThrow(
      /模板读取失败/,
    );
  });

  it("结论里绝不携带修复建议字段（§15：只报告）", async () => {
    const llm = new FakeLLM([
      JSON.stringify({
        diagnostics: [],
        summary: "行。",
        rewritten_plan: "…",
        fixed_beats: [],
        suggestion: "补一拍高潮",
      }),
    ]);
    const validator = new BeatValidator(llm as never);
    const result = await validator.validate(SAMPLE_CONFIG, SAMPLE_BEAT_PLAN);
    expect(Object.keys(result).sort()).toEqual(["diagnostics", "passed", "summary"]);
  });

  it("不修改传入的 BeatPlan（§4 只读）", async () => {
    const llm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_VALIDATION_V2)]);
    const validator = new BeatValidator(llm as never);
    const plan = structuredClone(SAMPLE_BEAT_PLAN);
    await validator.validate(SAMPLE_CONFIG, plan);
    expect(plan).toEqual(SAMPLE_BEAT_PLAN);
  });

  it("诊断列表为空时也算通过（passed=true，summary 非空）", async () => {
    const llm = new FakeLLM([JSON.stringify({ passed: true, diagnostics: [], summary: "结构完整。" })]);
    const validator = new BeatValidator(llm as never);
    const result = await validator.validate(SAMPLE_CONFIG, SAMPLE_BEAT_PLAN);
    expect(result).toEqual({ passed: true, diagnostics: [], summary: "结构完整。" });
  });
});

/** 让类型层也参与编译期检查：这些形状必须仍然合法。 */
const TYPE_GUARD: BeatValidationIssue = {
  code: "ENDING_NOT_PREPARED",
  severity: "warning",
  message: "结局所需条件没有铺垫。",
  beat_ids: [1, 2],
};

describe("v1.4.0 形状守卫", () => {
  it("BeatValidationIssue 的四个字段都在白名单内", () => {
    expect(Object.keys(TYPE_GUARD).sort()).toEqual(["beat_ids", "code", "message", "severity"]);
  });
});
