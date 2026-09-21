import { describe, expect, it } from "vitest";
import {
  REPAIR_ISSUE_TYPES,
  RepairValidationError,
  repairDirectoryName,
  repairRequestOf,
  repairSummary,
  repairTarget,
  validateRepairIssueType,
  validateRepairRecord,
  type RepairRecord,
  type RepairRequest,
} from "@/types/repair";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §3~§6/§43 Repair 数据模型：Fixture 结构校验，绝不打真实付费 API。
 * §5 明确禁止 root cause / causal diagnosis / strategy score / policy id / confidence。
 */

const PASSED: ValidationResult = { passed: true, issues: [] };
const FAILED: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度明显不足。" }],
};

function record(patch: Partial<RepairRecord> = {}): RepairRecord {
  return {
    repair_number: 1,
    issue_type: "length",
    issue_message: "正文长度 12 明显短于目标字数（下限 750）。",
    before_validation: FAILED,
    after_validation: PASSED,
    before_review_score: 63,
    after_review_score: 74,
    success: true,
    ...patch,
  };
}

describe("RepairIssueType（§6）", () => {
  it("只有六种 issue type，一个不多", () => {
    expect([...REPAIR_ISSUE_TYPES]).toEqual([
      "length",
      "ending",
      "character_presence",
      "continuity",
      "structure",
      "general",
    ]);
  });

  it("白名单内的类型原样返回", () => {
    for (const t of REPAIR_ISSUE_TYPES) {
      expect(validateRepairIssueType(t)).toBe(t);
    }
  });

  it("白名单之外的类型一律拒绝，不猜、不改写", () => {
    for (const bad of ["tone", "Length", "", null, undefined, 1, {}]) {
      expect(() => validateRepairIssueType(bad)).toThrow(RepairValidationError);
    }
  });
});

describe("RepairRequest（§3）", () => {
  it("repairTarget 只带要修什么，repairRequestOf 才补齐拿什么去修", () => {
    const target = repairTarget("ending", "故事缺少明确结局");
    expect(target).toEqual({ issue_type: "ending", issue_message: "故事缺少明确结局" });

    const request: RepairRequest = repairRequestOf(target, "正文", { title: "t" }, { beats: [] });
    expect(request).toEqual({
      story: "正文",
      issue_type: "ending",
      issue_message: "故事缺少明确结局",
      config: { title: "t" },
      beat_plan: { beats: [] },
    });
    // §9：Strategy 不接触 StoryConfig / BeatPlan / 正文，所以 target 上没有这些字段
    expect(Object.keys(target).sort()).toEqual(["issue_message", "issue_type"]);
  });
});

describe("validateRepairRecord（§5）", () => {
  it("合法 repair record 原样通过校验", () => {
    expect(validateRepairRecord(record())).toEqual(record());
  });

  it("只记录前后对比字段，没有任何失败归因字段", () => {
    const keys = Object.keys(record()).sort();
    expect(keys).toEqual([
      "after_review_score",
      "after_validation",
      "before_review_score",
      "before_validation",
      "issue_message",
      "issue_type",
      "repair_number",
      "success",
    ]);
    for (const forbidden of [
      "root_cause", "cause", "diagnosis", "causal", "strategy", "policy",
      "confidence", "attribution", "rank",
    ]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it("repair_number 必须是从 1 开始的整数", () => {
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      expect(() => validateRepairRecord(record({ repair_number: bad as never }))).toThrow(
        RepairValidationError,
      );
    }
  });

  it("issue_message 必须是非空字符串", () => {
    for (const bad of ["", "   ", 7, null, undefined]) {
      expect(() => validateRepairRecord(record({ issue_message: bad as never }))).toThrow(
        /issue_message/,
      );
    }
  });

  it("success 必须是布尔值", () => {
    expect(() => validateRepairRecord(record({ success: "yes" as never }))).toThrow(/success/);
  });

  it("after_validation 为 null 表示修订后没有拿到校验结论（§12）", () => {
    const r = record({ after_validation: null });
    expect(validateRepairRecord(r).after_validation).toBeNull();
  });

  it("非有限分数按 null 处理，不编造 0 分", () => {
    const r = record({ before_review_score: NaN, after_review_score: undefined as never });
    const out = validateRepairRecord(r);
    expect(out.before_review_score).toBeNull();
    expect(out.after_review_score).toBeNull();
  });

  it("结构损坏的 validation 不炸整条记录，按 null 处理", () => {
    const r = record({ after_validation: { nonsense: true } as never });
    expect(validateRepairRecord(r).after_validation).toBeNull();
  });
});

describe("repairSummary（§39/§40）", () => {
  it("只暴露编号 / 类型 / 成败", () => {
    expect(repairSummary(record())).toEqual({
      repair_number: 1,
      issue_type: "length",
      success: true,
    });
    expect(JSON.stringify(repairSummary(record()))).not.toContain("正文长度");
  });
});

describe("repairDirectoryName（§29/§33）", () => {
  it("两位零填充，与 attempt 编号同一套规则", () => {
    expect(repairDirectoryName(1)).toBe("01");
    expect(repairDirectoryName(9)).toBe("09");
    expect(repairDirectoryName(42)).toBe("42");
    expect(repairDirectoryName(99)).toBe("99");
  });

  it("越界与非整数拒绝", () => {
    for (const bad of [0, -1, 1.5, 100, "1", null]) {
      expect(() => repairDirectoryName(bad as never)).toThrow(RepairValidationError);
    }
  });
});
