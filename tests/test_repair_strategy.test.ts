import { describe, expect, it } from "vitest";
import { RepairStrategy, classifyProblem } from "@/core/repair-strategy";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { ValidationIssueCode } from "@/types/validation-result";
import type { RepairIssueType } from "@/types/repair";

/**
 * §43/§7/§8/§12~§14 RepairStrategy：固定规则映射，没有学习、没有 LLM 分类器。
 * 纯 Fixture 决策表，绝不打真实付费 API。
 */

function validation(codes: string[], messages?: string[]): ValidationResult {
  return {
    passed: false,
    issues: codes.map((code, i) => ({
      code: code as ValidationIssueCode,
      severity: "error" as const,
      message: messages?.[i] ?? `${code} 的说明。`,
    })),
  };
}

function review(problems: string[], score = 63): ReviewResult {
  return { score, summary: "总结。", strengths: ["强"], problems };
}

const PASSED: ValidationResult = { passed: true, issues: [] };

describe("§7 Validation code → issue type", () => {
  const strategy = new RepairStrategy();
  const cases: Array<[string, RepairIssueType]> = [
    ["TOO_SHORT", "length"],
    ["MISSING_ENDING", "ending"],
    ["POSSIBLE_TRUNCATION", "ending"],
    ["MISSING_PROTAGONIST", "character_presence"],
  ];

  it.each(cases)("%s → %s", (code, issueType) => {
    const target = strategy.choose(validation([code]), null);
    expect(target?.issue_type).toBe(issueType);
    expect(target?.issue_message).toBe(`${code} 的说明。`);
  });

  it("§22 EMPTY_CONTENT / INVALID_OUTPUT 不修，直接 null", () => {
    expect(strategy.choose(validation(["EMPTY_CONTENT"]), null)).toBeNull();
    expect(strategy.choose(validation(["INVALID_OUTPUT"]), null)).toBeNull();
    // 与其它问题码同时出现也不修：正文整个不可用
    expect(strategy.choose(validation(["EMPTY_CONTENT", "TOO_SHORT"]), null)).toBeNull();
  });

  it("未登记的 Validation code 不猜类，转去问 Reviewer", () => {
    expect(strategy.choose(validation(["SOME_FUTURE_CODE"]), null)).toBeNull();
    expect(strategy.choose(validation(["SOME_FUTURE_CODE"]), review(["结尾没收住"]))?.issue_type).toBe(
      "ending",
    );
  });
});

describe("§13 固定优先级", () => {
  const strategy = new RepairStrategy();

  it("MISSING_ENDING 优先于 POSSIBLE_TRUNCATION", () => {
    const target = strategy.choose(validation(["POSSIBLE_TRUNCATION", "MISSING_ENDING"]), null);
    expect(target?.issue_type).toBe("ending");
    expect(target?.issue_message).toBe("MISSING_ENDING 的说明。");
  });

  it("结尾 → 长度 → 主角 依次降级", () => {
    expect(
      strategy.choose(validation(["MISSING_PROTAGONIST", "TOO_SHORT"]), null)?.issue_message,
    ).toBe("TOO_SHORT 的说明。");
    expect(
      strategy.choose(validation(["MISSING_PROTAGONIST", "TOO_SHORT", "MISSING_ENDING"]), null)
        ?.issue_message,
    ).toBe("MISSING_ENDING 的说明。");
  });

  it("issue 顺序不影响优先级：规则固定，不随输入顺序漂移", () => {
    const a = strategy.choose(validation(["TOO_SHORT", "MISSING_ENDING"]), null);
    const b = strategy.choose(validation(["MISSING_ENDING", "TOO_SHORT"]), null);
    expect(a).toEqual(b);
  });
});

describe("§8 Review problem → issue type", () => {
  const strategy = new RepairStrategy();

  it("命中关键词用对应类型", () => {
    const cases: Array<[string, RepairIssueType]> = [
      ["结尾略显仓促", "ending"],
      ["The ending feels abrupt", "ending"],
      ["正文太短，展开不足", "length"],
      ["字数明显不够", "length"],
      ["主角在后半段缺席", "character_presence"],
      ["protagonist disappears", "character_presence"],
      ["时间线前后矛盾", "continuity"],
      ["情绪转变脱节", "continuity"],
      ["中段结构松散", "structure"],
      ["pacing drops in the middle", "structure"],
    ];
    for (const [problem, issueType] of cases) {
      expect(strategy.choose(PASSED, review([problem]))?.issue_type).toBe(issueType);
      expect(classifyProblem(problem)).toBe(issueType);
    }
  });

  it("映射不上 → general（§8：不发明复杂分类器）", () => {
    expect(classifyProblem("整体读起来有点平")).toBe("general");
    expect(strategy.choose(PASSED, review(["整体读起来有点平"]))?.issue_type).toBe("general");
    expect(strategy.choose(PASSED, review(["This is fine"]))?.issue_type).toBe("general");
  });

  it("一次只取一个问题（§14），取第一个非空的", () => {
    const target = strategy.choose(PASSED, review(["", "   ", "结尾没收住", "字数不够"]));
    expect(target?.issue_message).toBe("结尾没收住");
  });

  it("没有 Validation 问题也没有 Review problem → null（不需要修）", () => {
    expect(strategy.choose(PASSED, review([]))).toBeNull();
    expect(strategy.choose(PASSED, null)).toBeNull();
    expect(strategy.choose(null, null)).toBeNull();
  });
});

describe("§12 Strategy 的职责边界", () => {
  it("只返回类型 + 说明，不返回 config / beat_plan / story", () => {
    const target = new RepairStrategy().choose(validation(["TOO_SHORT"]), null);
    expect(Object.keys(target ?? {}).sort()).toEqual(["issue_message", "issue_type"]);
  });

  it("同一输入永远得到同一结论（固定规则，无学习）", () => {
    const strategy = new RepairStrategy();
    const once = strategy.choose(validation(["TOO_SHORT", "MISSING_ENDING"]), review(["结构松散"]));
    for (let i = 0; i < 5; i++) {
      expect(strategy.choose(validation(["TOO_SHORT", "MISSING_ENDING"]), review(["结构松散"]))).toEqual(once);
    }
  });
});
