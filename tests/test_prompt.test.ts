import { describe, expect, it } from "vitest";
import { buildPrompt, PromptValidationError } from "@/lib/prompt";

describe("buildPrompt", () => {
  it("Title 被写入 Prompt", () => {
    const p = buildPrompt("消失的目击者", "写一篇都市悬疑。");
    expect(p).toContain("消失的目击者");
  });

  it("User Prompt 被写入 Prompt", () => {
    const p = buildPrompt("标题", "女主是一宗商业贿赂案唯一证人。");
    expect(p).toContain("女主是一宗商业贿赂案唯一证人。");
  });

  it("空标题拒绝", () => {
    expect(() => buildPrompt("", "内容")).toThrow(PromptValidationError);
    expect(() => buildPrompt("   ", "内容")).toThrow(PromptValidationError);
  });

  it("空 Prompt 拒绝", () => {
    expect(() => buildPrompt("标题", "")).toThrow(PromptValidationError);
    expect(() => buildPrompt("标题", "  \n ")).toThrow(PromptValidationError);
  });
});
