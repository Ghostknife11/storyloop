import { describe, expect, it } from "vitest";
import { BeatParseError, parseBeatPlan } from "@/lib/beat-parser";
import { validateBeatPlan } from "@/types/beat-plan";

/** §12 BeatPlan Parser：清理 → JSON parse → schema 校验。禁止智能修复。 */

const goodJson = JSON.stringify({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "周衡"] },
  ],
});

describe("parseBeatPlan", () => {
  it("纯 JSON 直接解析", () => {
    const plan = parseBeatPlan(goodJson);
    expect(plan.beats).toHaveLength(2);
    expect(validateBeatPlan(plan)).toEqual(plan);
  });

  it("容忍 ```json code fence（§12 允许的清理）", () => {
    const fenced = `\`\`\`json\n${goodJson}\n\`\`\``;
    expect(parseBeatPlan(fenced).beats[1].purpose).toBe("高潮");
  });

  it("容忍裸 ``` fence 与前后空白", () => {
    const fenced = `\n   \`\`\`\n${goodJson}\n\`\`\`   \n`;
    expect(parseBeatPlan(fenced).beats).toHaveLength(2);
  });

  it("非 JSON 文本 → BeatParseError", () => {
    expect(() => parseBeatPlan("这是小说正文，不是 JSON。")).toThrow(BeatParseError);
    expect(() => parseBeatPlan("这是小说正文，不是 JSON。")).toThrow(/不是合法 JSON/);
  });

  it("空输出 → BeatParseError", () => {
    expect(() => parseBeatPlan("   ")).toThrow(BeatParseError);
  });

  it("JSON 合法但 schema 非法 → 透出 BeatPlanValidationError（不修复，§12/§13）", () => {
    expect(() => parseBeatPlan(JSON.stringify({ beat_plan_version: "1", beats: [] })))
      .toThrow(/不能为空/);
    expect(() => parseBeatPlan(JSON.stringify({ beat_plan_version: "1", beats: [{ id: 2, purpose: "p", event: "e", characters: [] }] })))
      .toThrow(/连续/);
  });

  it("JSON 数组顶层 → 结构错误", () => {
    expect(() => parseBeatPlan("[1, 2, 3]")).toThrow(/beats/);
  });
});
