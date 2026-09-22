import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEAT_PLAN_VERSION,
  BeatPlanValidationError,
  validateBeatPlan,
  type BeatPlan,
  type StoryBeat,
} from "@/types/beat-plan";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.0.0 合同测试：BeatPlan v1 schema 冻结（TASK §6/§49）。
 *
 * 与 test_beat_plan.test.ts 的分工：那份测「校验规则怎么判」，
 * 这份钉死「schema 不许变」——字段集、id 规则、版本号，以及文档示例必须真的能过校验。
 */

const FROZEN_BEAT_PLAN = {
  required: ["beat_plan_version", "beats"],
  optional: ["summary"],
} as const;

const FROZEN_STORY_BEAT = {
  required: ["id", "purpose", "event", "characters"],
  optional: ["conflict", "expected_outcome"],
} as const;

function fullPlan() {
  return validateBeatPlan({
    beat_plan_version: "1",
    summary: "证人失踪案的三个节点。",
    beats: [
      {
        id: 1,
        purpose: "建立危机",
        event: "证人没有出庭。",
        characters: ["陈岚"],
        conflict: "距离开庭只剩一天。",
        expected_outcome: "读者明白时间压力。",
      },
      { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "周牧"] },
    ],
  });
}

/** 从 markdown 里抠出所有 ```json 代码块。文档示例必须是真能用的 JSON。 */
function jsonBlocks(markdown: string): unknown[] {
  const blocks = [...markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.map((block) => JSON.parse(block) as unknown);
}

describe("v1.0.0 BeatPlan v1 freeze — 版本与字段集", () => {
  it("beat_plan_version 冻结为 1", () => {
    expect(BEAT_PLAN_VERSION).toBe("1");
  });

  it("填满可选字段的对象，键集恰好是冻结的全集（不多不少）", () => {
    const plan = fullPlan();
    expect(Object.keys(plan).sort()).toEqual(
      [...FROZEN_BEAT_PLAN.required, ...FROZEN_BEAT_PLAN.optional].sort(),
    );
  });

  it("StoryBeat 键集同样被冻结", () => {
    const [first] = fullPlan().beats;
    expect(Object.keys(first).sort()).toEqual(
      [...FROZEN_STORY_BEAT.required, ...FROZEN_STORY_BEAT.optional].sort(),
    );
  });

  it("省略可选字段的 beat 不会带 undefined 占位键", () => {
    const [, second] = fullPlan().beats;
    expect(Object.keys(second).sort()).toEqual(["characters", "event", "id", "purpose"]);
  });

  it("省略 summary 与 beat_plan_version 时自动补齐，缺省即当前版本", () => {
    const plan = validateBeatPlan({
      beats: [{ id: 1, purpose: "起", event: "事件。", characters: [] }],
    });
    expect(plan.beat_plan_version).toBe("1");
    expect(plan.summary).toBeUndefined();
  });
});

describe("v1.0.0 BeatPlan v1 freeze — id 与 characters 规则", () => {
  it("id 必须是从 1 连续的正整数", () => {
    expect(() => validateBeatPlan({
      beat_plan_version: "1",
      beats: [
        { id: 1, purpose: "a", event: "甲。", characters: [] },
        { id: 2, purpose: "b", event: "乙。", characters: [] },
        { id: 3, purpose: "c", event: "丙。", characters: [] },
      ],
    })).not.toThrow();
    expect(() => validateBeatPlan({
      beat_plan_version: "1",
      beats: [{ id: 2, purpose: "a", event: "甲。", characters: [] }],
    })).toThrow(BeatPlanValidationError);
    expect(() => validateBeatPlan({
      beat_plan_version: "1",
      beats: [
        { id: 1, purpose: "a", event: "甲。", characters: [] },
        { id: 1, purpose: "b", event: "乙。", characters: [] },
      ],
    })).toThrow(/重复/);
  });

  it("characters 必须是字符串数组，models 之外的字段不会存活", () => {
    const plan = validateBeatPlan({
      beat_plan_version: "1",
      beats: [{ id: 1, purpose: "a", event: "甲。", characters: ["陈岚", "周牧"] }],
    });
    expect(plan.beats[0].characters).toEqual(["陈岚", "周牧"]);
    const beat = plan.beats[0] as unknown as Record<string, unknown>;
    expect(beat.quality_dimension).toBeUndefined();
    expect(beat.confidence).toBeUndefined();
  });

  it("beats 不能为空", () => {
    expect(() => validateBeatPlan({ beat_plan_version: "1", beats: [] })).toThrow(BeatPlanValidationError);
  });
});

describe("v1.0.0 文档示例必须真的能过校验", () => {
  const docPath = join(repoRoot(), "docs", "beat-plan.md");
  let markdown: string;
  try {
    markdown = readFileSync(docPath, "utf8");
  } catch {
    markdown = "";
  }

  it("docs/beat-plan.md 存在，且每个 ```json 示例都是合法 BeatPlan v1", () => {
    expect(markdown, "docs/beat-plan.md 缺失").not.toBe("");
    const blocks = jsonBlocks(markdown);
    expect(blocks.length, "文档里至少应有一个 JSON 示例").toBeGreaterThan(0);
    for (const [i, block] of blocks.entries()) {
      const plan = validateBeatPlan(block) as BeatPlan;
      expect(Array.isArray(plan.beats), `示例 ${i + 1} 的 beats 必须是数组`).toBe(true);
      expect(plan.beats.length, `示例 ${i + 1} 不能没有 beat`).toBeGreaterThan(0);
    }
  });

  it("文档：包含小结（summary）、beats 与 StoryBeat 六个字段的说明", () => {
    for (const field of [...FROZEN_STORY_BEAT.required, ...FROZEN_STORY_BEAT.optional]) {
      expect(markdown, `docs/beat-plan.md 应说明字段 ${field}`).toContain(field);
    }
    expect(markdown).toContain(FROZEN_BEAT_PLAN.optional[0]);
  });
});

describe("v1.0.0 BeatPlan v1 freeze — 类型层面的最小验证", () => {
  it("StoryBeat 可选字段确实可省略（类型不必强转）", () => {
    const minimal: StoryBeat = { id: 1, purpose: "起", event: "事件。", characters: [] };
    expect(Object.keys(minimal)).toEqual(["id", "purpose", "event", "characters"]);
    const plan: BeatPlan = { beat_plan_version: "1", beats: [minimal] };
    expect(validateBeatPlan(plan).beats).toHaveLength(1);
  });
});
