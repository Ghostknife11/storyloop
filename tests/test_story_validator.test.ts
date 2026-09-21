import { describe, expect, it } from "vitest";
import { StoryValidator } from "@/lib/story-validator";
import {
  countStoryLength,
  minimumLengthFloor,
  STORY_VALIDATION_RULES,
} from "@/lib/validation-rules";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";

/**
 * §34~§37 StoryValidator 硬性规则。
 * §3：确定性规则优先；§12 长度规则不过严；§13 截断不过度推断；§36 不写过度脆弱的启发式测试。
 * 只用 Fixture，绝不打真实付费 API。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

/** 长度足够、含主角名、以句号结尾：应通过全部硬规则。 */
const goodStory = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

function codes(result: ReturnType<StoryValidator["validate"]>): string[] {
  return result.issues.map((i) => i.code);
}

function severityOf(result: ReturnType<StoryValidator["validate"]>, code: string): string | undefined {
  return result.issues.find((i) => i.code === code)?.severity;
}

const validator = new StoryValidator();

describe("countStoryLength / minimumLengthFloor（§11/§12）", () => {
  it("CJK 按字符计，英文按词计，标点与空白不计", () => {
    expect(countStoryLength("你好世界")).toBe(4);
    expect(countStoryLength("hello world")).toBe(2);
    expect(countStoryLength("你好，world！")).toBe(3);
    expect(countStoryLength("   \n\t  ")).toBe(0);
    expect(countStoryLength("")).toBe(0);
  });

  it("长度下限 = max(300, target_words * 0.15)", () => {
    expect(minimumLengthFloor(5000)).toBe(750);
    expect(minimumLengthFloor(2000)).toBe(300);
    expect(minimumLengthFloor(500)).toBe(300);
    expect(minimumLengthFloor(100000)).toBe(15000);
    expect(minimumLengthFloor(0)).toBe(300);
    expect(minimumLengthFloor(Number.NaN)).toBe(300);
  });
});

describe("EmptyContentValidator（§10/§34）", () => {
  it('None / "" / "   " 都判 EMPTY_CONTENT 且 passed=false', () => {
    for (const empty of [null, undefined, "", "   ", "\n\t "]) {
      const r = validator.validate(config, empty as unknown as string);
      expect(codes(r)).toContain("EMPTY_CONTENT");
      expect(r.passed).toBe(false);
      expect(severityOf(r, "EMPTY_CONTENT")).toBe("error");
    }
  });
});

describe("MinimumLengthValidator（§11/§12/§35）", () => {
  it("very short story → TOO_SHORT error", () => {
    const r = validator.validate(config, "只有一句话。");
    expect(codes(r)).toContain("TOO_SHORT");
    expect(r.passed).toBe(false);
    expect(severityOf(r, "TOO_SHORT")).toBe("error");
  });

  it("reasonable story → no error", () => {
    const r = validator.validate(config, goodStory);
    expect(codes(r)).not.toContain("TOO_SHORT");
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("near target but not exact → no error（§12 不要求精确达标）", () => {
    // 4300 字左右、差 target_words 一点：只测长度，其它规则都要能过
    const near = `陈岚${"字".repeat(4290)}。`;
    expect(countStoryLength(near)).toBe(4292);
    const r = validator.validate(config, near);
    expect(codes(r)).not.toContain("TOO_SHORT");
    expect(r.passed).toBe(true);
  });

  it("下限本身不算过短（边界）", () => {
    const r = validator.validate(config, "字".repeat(750));
    expect(codes(r)).not.toContain("TOO_SHORT");
  });
});

describe("PossibleTruncationValidator（§13/§36）", () => {
  it("obvious unfinished sentence → POSSIBLE_TRUNCATION", () => {
    const r = validator.validate(config, `${goodStory}陈岚转过身去，`);
    expect(codes(r)).toContain("POSSIBLE_TRUNCATION");
    expect(r.passed).toBe(false);
    expect(severityOf(r, "POSSIBLE_TRUNCATION")).toBe("error");
  });

  it("引号未闭合 → POSSIBLE_TRUNCATION", () => {
    const r = validator.validate(config, `${goodStory}她说：「我们走吧。`);
    expect(codes(r)).toContain("POSSIBLE_TRUNCATION");
  });

  it("normal completed ending → no truncation issue", () => {
    const r = validator.validate(config, goodStory);
    expect(codes(r)).not.toContain("POSSIBLE_TRUNCATION");
  });

  it("properly closed dialogue → no truncation issue", () => {
    const r = validator.validate(config, `${goodStory}她说：「我们走吧。」然后关上了门。`);
    expect(codes(r)).not.toContain("POSSIBLE_TRUNCATION");
    expect(r.passed).toBe(true);
  });
});

describe("EndingPresenceValidator（§15/§36）", () => {
  it("最后一行没有终止标点 → MISSING_ENDING（warning，不强制失败）", () => {
    const r = validator.validate(config, `${goodStory}陈岚转过身去`);
    expect(codes(r)).toContain("MISSING_ENDING");
    expect(severityOf(r, "MISSING_ENDING")).toBe("warning");
    // §5：只有 warning 时 passed 仍为 true
    expect(r.passed).toBe(true);
  });

  it("正常句号结尾 → 无 MISSING_ENDING", () => {
    expect(codes(validator.validate(config, goodStory))).not.toContain("MISSING_ENDING");
  });

  it("省略号 / 收尾引号结尾 → 无 MISSING_ENDING", () => {
    expect(codes(validator.validate(config, `${goodStory}此后的事，谁也不知道……`))).not.toContain("MISSING_ENDING");
    expect(codes(validator.validate(config, `${goodStory}她轻轻说：「会好的。」`))).not.toContain("MISSING_ENDING");
  });

  it("空正文不触发结尾检查（由 EMPTY_CONTENT 负责）", () => {
    const r = validator.validate(config, "");
    expect(codes(r)).toEqual(["EMPTY_CONTENT"]);
  });
});

describe("ProtagonistPresenceValidator（§14/§37）", () => {
  it("配置了主角且名字缺失 → MISSING_PROTAGONIST", () => {
    const r = validator.validate(config, `${"林述安走在长长的走廊里。".repeat(90)}`);
    expect(codes(r)).toContain("MISSING_PROTAGONIST");
    expect(r.passed).toBe(false);
    expect(severityOf(r, "MISSING_PROTAGONIST")).toBe("error");
  });

  it("配置了主角且名字出现 → 该规则通过", () => {
    const r = validator.validate(config, goodStory);
    expect(codes(r)).not.toContain("MISSING_PROTAGONIST");
  });

  it("未配置 protagonist → 跳过该规则", () => {
    const noProtagonist = validateStoryConfig({
      title: "无主角配置",
      genre: "其他",
      premise: "一个没有主角配置的故事。",
      target_words: 5000,
    });
    const r = validator.validate(noProtagonist, goodStory);
    expect(codes(r)).not.toContain("MISSING_PROTAGONIST");
    expect(r.passed).toBe(true);
  });
});

describe("InvalidOutputValidator（§16）", () => {
  it("整篇是错误 JSON → INVALID_OUTPUT", () => {
    const r = validator.validate(config, '{"error":{"message":"rate limited","code":429}}');
    expect(codes(r)).toContain("INVALID_OUTPUT");
    expect(r.passed).toBe(false);
  });

  it("API 错误字符串 → INVALID_OUTPUT", () => {
    for (const bad of ["API Error: 429 Too Many Requests", "Error: upstream timeout", "[object Object]"]) {
      expect(codes(validator.validate(config, bad))).toContain("INVALID_OUTPUT");
    }
  });

  it("正常正文即使以引号开头也不算 INVALID_OUTPUT", () => {
    expect(codes(validator.validate(config, goodStory))).not.toContain("INVALID_OUTPUT");
  });
});

describe("StoryValidator 聚合（§5/§9/§58）", () => {
  it("默认聚合本版本全部硬规则，顺序固定", () => {
    expect(STORY_VALIDATION_RULES.map((r) => r.code)).toEqual([
      "INVALID_OUTPUT", "EMPTY_CONTENT", "TOO_SHORT",
      "POSSIBLE_TRUNCATION", "MISSING_PROTAGONIST", "MISSING_ENDING",
    ]);
  });

  it("passed 只由 severity=error 决定（§5/§59）", () => {
    const onlyWarning = new StoryValidator([
      { code: "MISSING_ENDING", check: () => ({ code: "MISSING_ENDING", severity: "warning", message: "m" }) },
    ]);
    expect(onlyWarning.validate(config, goodStory).passed).toBe(true);

    const withError = new StoryValidator([
      { code: "MISSING_ENDING", check: () => ({ code: "MISSING_ENDING", severity: "warning", message: "m" }) },
      { code: "TOO_SHORT", check: () => ({ code: "TOO_SHORT", severity: "error", message: "m" }) },
    ]);
    expect(withError.validate(config, goodStory).passed).toBe(false);
  });

  it("规则可注入（测试用），默认使用内置规则", () => {
    const stub = new StoryValidator([{ code: "EMPTY_CONTENT", check: () => null }]);
    expect(stub.validate(config, "")).toEqual({ passed: true, issues: [] });
  });

  it("§58 只返回 ValidationResult，不返回任何修复后的正文", () => {
    const r = validator.validate(config, "太短") as unknown as Record<string, unknown>;
    for (const forbidden of ["fixed_story", "revised_story", "patched_story", "story", "suggestion"]) {
      expect(r).not.toHaveProperty(forbidden);
    }
  });

  it("§2 Validator 不调用 LLM：validate 是同步纯函数", () => {
    const r = validator.validate(config, goodStory);
    expect(r).not.toBeInstanceOf(Promise);
  });
});
