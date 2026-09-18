import { describe, expect, it } from "vitest";
import { validateStoryRequest } from "@/lib/story-request";

const valid = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
};

describe("validateStoryRequest", () => {
  it("valid request accepted", () => {
    const r = validateStoryRequest(valid);
    expect(r.title).toBe("消失的目击者");
    expect(r.target_words).toBe(5000);
    expect(r.style).toBeUndefined();
    expect(r.extra_requirements).toBeUndefined();
  });

  it("missing title rejected", () => {
    expect(() => validateStoryRequest({ ...valid, title: "" })).toThrow(/标题/);
    expect(() => validateStoryRequest({ ...valid, title: "   " })).toThrow(/标题/);
  });

  it("missing premise rejected", () => {
    expect(() => validateStoryRequest({ ...valid, premise: "" })).toThrow(/premise/);
  });

  it("missing genre rejected", () => {
    expect(() => validateStoryRequest({ ...valid, genre: "" })).toThrow(/题材/);
  });

  it("invalid target_words rejected", () => {
    expect(() => validateStoryRequest({ ...valid, target_words: -1 })).toThrow(/目标字数/);
    expect(() => validateStoryRequest({ ...valid, target_words: 499 })).toThrow(/目标字数/);
    expect(() => validateStoryRequest({ ...valid, target_words: 30001 })).toThrow(/目标字数/);
    expect(() => validateStoryRequest({ ...valid, target_words: 1.5 })).toThrow(/整数/);
    expect(() => validateStoryRequest({ ...valid, target_words: "5000" })).toThrow(/整数/);
  });

  it("optional style accepted", () => {
    const r = validateStoryRequest({ ...valid, style: "冷峻、节奏紧凑" });
    expect(r.style).toBe("冷峻、节奏紧凑");
  });

  it("optional extra_requirements accepted", () => {
    const r = validateStoryRequest({ ...valid, extra_requirements: "不要超自然元素。" });
    expect(r.extra_requirements).toBe("不要超自然元素。");
  });

  it("title over 120 chars rejected", () => {
    expect(() => validateStoryRequest({ ...valid, title: "长".repeat(121) })).toThrow(/120/);
  });
});
