import { describe, expect, it } from "vitest";
import {
  BEAT_PLAN_VERSION,
  BeatPlanValidationError,
  validateBeatPlan,
  type BeatPlan,
} from "@/types/beat-plan";

/** §12 BeatPlan schema 校验：只查结构，不评价 Beat 质量（§55）。 */

const valid: BeatPlan = {
  beat_plan_version: BEAT_PLAN_VERSION,
  summary: "证人失踪到真相的连续推进",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    {
      id: 2, purpose: "升级冲突", event: "内部泄密。", characters: ["陈岚", "周衡"],
      conflict: "保护行动被监视", expected_outcome: "陈岚失去警方支援",
    },
  ],
};

describe("validateBeatPlan", () => {
  it("合法 BeatPlan 原样通过", () => {
    expect(validateBeatPlan(valid)).toEqual(valid);
  });

  it("缺 beat_plan_version 时回退到当前版本", () => {
    const raw = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    delete raw.beat_plan_version;
    expect(validateBeatPlan(raw).beat_plan_version).toBe(BEAT_PLAN_VERSION);
  });

  it("beats 不是数组 → 拒绝", () => {
    expect(() => validateBeatPlan({ beats: "nope" })).toThrow(BeatPlanValidationError);
  });

  it("beats 为空 → 拒绝（§6 非空）", () => {
    expect(() => validateBeatPlan({ beat_plan_version: "1", beats: [] })).toThrow(/不能为空/);
  });

  it("id 非正整数 → 拒绝", () => {
    const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (broken.beats as Array<Record<string, unknown>>)[0].id = 0;
    expect(() => validateBeatPlan(broken)).toThrow(/id 必须是正整数/);
  });

  it("id 不连续 → 拒绝", () => {
    const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (broken.beats as Array<Record<string, unknown>>)[1].id = 3;
    expect(() => validateBeatPlan(broken)).toThrow(/连续/);
  });

  it("id 重复 → 拒绝", () => {
    const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (broken.beats as Array<Record<string, unknown>>)[1].id = 1;
    expect(() => validateBeatPlan(broken)).toThrow(/重复/);
  });

  it("purpose / event 为空 → 拒绝", () => {
    const a = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (a.beats as Array<Record<string, unknown>>)[0].purpose = "   ";
    expect(() => validateBeatPlan(a)).toThrow(/purpose/);

    const b = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (b.beats as Array<Record<string, unknown>>)[0].event = "";
    expect(() => validateBeatPlan(b)).toThrow(/event/);
  });

  it("characters 不是数组 → 拒绝", () => {
    const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (broken.beats as Array<Record<string, unknown>>)[0].characters = "陈岚";
    expect(() => validateBeatPlan(broken)).toThrow(/characters/);
  });

  it("可选字段为空串时被丢弃，非空时 trim", () => {
    const raw = {
      beat_plan_version: "1",
      beats: [{
        id: 1, purpose: " 建立危机 ", event: " 证人失踪。", characters: ["陈岚"],
        conflict: "   ", expected_outcome: "  线索出现  ",
      }],
    };
    const plan = validateBeatPlan(raw);
    expect(plan.beats[0].conflict).toBeUndefined();
    expect(plan.beats[0].expected_outcome).toBe("线索出现");
    expect(plan.beats[0].purpose).toBe("建立危机");
  });

  it("null/undefined 输入不崩溃，给出结构错误", () => {
    expect(() => validateBeatPlan(null)).toThrow(BeatPlanValidationError);
    expect(() => validateBeatPlan(undefined)).toThrow(BeatPlanValidationError);
  });
});
