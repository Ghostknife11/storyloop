import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_DIMENSION_KEYS,
  COMMERCIAL_SCORE_MAX,
  COMMERCIAL_SCORE_MIN,
  CommercialReviewValidationError,
  aggregateCommercialDimensions,
  commercialOverallScore,
  commercialReviewResultOf,
  validateCommercialDimensions,
  validateCommercialReviewResult,
  type CommercialDimensions,
} from "@/types/commercial-review";
import { parseCommercialReviewResult } from "@/lib/commercial-review-parser";
import { CommercialReviewer, COMMERCIAL_REVIEW_TEMPERATURE } from "@/lib/commercial-reviewer";
import { SAMPLE_COMMERCIAL_REVIEW, SAMPLE_CONFIG, SAMPLE_STORY, FakeLLM } from "./helpers/fixtures";

/**
 * v1.5.0 商业可读性审阅模型层（TASK §9/§10/§11/§23）。
 *
 * 四组约定：
 * 1. 四个维度齐全、各自 0 ~ 100 且带非空短评——缺一个就不是合法结论；
 * 2. 整体分 = (H + P + E + Pf) / 4 的确定性均分，与 `reviewOverallScore` 同一套
 *    「重新聚合、不轻信模型自报分」的规则；
 * 3. 与 Co/N/C/Ca 那套结构审阅结论互不引用、互不换算（§12）；
 * 4. 非法输出抛 CommercialReviewValidationError / CommercialReviewParseError，
 *    业务层不自动重试（§15）。
 */

function dims(scores: Partial<Record<(typeof COMMERCIAL_DIMENSION_KEYS)[number], number>> = {}): CommercialDimensions {
  const out = {} as CommercialDimensions;
  for (const key of COMMERCIAL_DIMENSION_KEYS) {
    out[key] = { score: scores[key] ?? 50, summary: `${key} 短评` };
  }
  return out;
}

describe("v1.5.0 CommercialReviewResult schema（§9/§23）", () => {
  it("一份合法结论原样通过，字段一个不多一个不少", () => {
    const out = validateCommercialReviewResult(SAMPLE_COMMERCIAL_REVIEW);
    expect(out).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(Object.keys(out).sort()).toEqual([
      "dimensions",
      "problems",
      "score",
      "strengths",
      "suggestions",
      "summary",
    ]);
  });

  it("模型自报的 score 不作为最终口径：一律换成四维均分", () => {
    const raw = {
      ...SAMPLE_COMMERCIAL_REVIEW,
      score: 99,
      dimensions: dims({ hook: 10, pacing: 20, engagement: 30, payoff: 40 }),
    };
    const out = validateCommercialReviewResult(raw);
    expect(out.score).toBe(25);
    expect(out.score).not.toBe(99);
  });

  it("四个维度必须齐全：缺 hook / 缺 payoff 都算非法", () => {
    const missingHook = dims({ hook: 60 });
    delete (missingHook as unknown as Record<string, unknown>).hook;
    expect(() => validateCommercialDimensions(missingHook)).toThrow(CommercialReviewValidationError);
    expect(() => validateCommercialDimensions(missingHook)).toThrow(/hook/);

    const missingPayoff = dims({ payoff: 60 });
    delete (missingPayoff as unknown as Record<string, unknown>).payoff;
    expect(() => validateCommercialDimensions(missingPayoff)).toThrow(/payoff/);
  });

  it("多一个未知维度也算非法：只认固定四个键", () => {
    const extra = { ...dims(), reread_value: { score: 90, summary: "想重读一遍" } } as unknown;
    expect(() => validateCommercialDimensions(extra)).toThrow(/未知维度 reread_value/);
  });

  it("维度分越界（-1 / 101 / NaN / 非数字）一律拒绝，不补 0", () => {
    // 直接塞进维度对象：helper 的 `?? 50` 会把 null/undefined 当成没给，测不到真越界
    for (const bad of [-1, 101, Number.NaN, "80", null, undefined]) {
      const d = dims();
      d.hook = { score: bad as number, summary: "短评" };
      expect(() => validateCommercialDimensions(d)).toThrow(CommercialReviewValidationError);
    }
  });

  it("维度短评不能为空：缺 summary / 空白字符串都算非法", () => {
    const d = dims();
    d.pacing = { score: 70, summary: "   " };
    expect(() => validateCommercialDimensions(d)).toThrow(/pacing\.summary/);
    const d2 = dims();
    d2.engagement = { score: 70 } as unknown as CommercialDimensions["engagement"];
    expect(() => validateCommercialDimensions(d2)).toThrow(/engagement\.summary/);
  });

  it("边界值 0 与 100 都是合法分数", () => {
    expect(validateCommercialDimensions(dims({ hook: COMMERCIAL_SCORE_MIN, payoff: COMMERCIAL_SCORE_MAX }))).toBeTruthy();
  });

  it("整体 score 缺失或越界就是非法输出", () => {
    const noScore = { ...SAMPLE_COMMERCIAL_REVIEW } as Record<string, unknown>;
    delete noScore.score;
    expect(() => validateCommercialReviewResult(noScore)).toThrow(/score/);
    expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, score: 101 })).toThrow(/score/);
    expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, score: -1 })).toThrow(/score/);
    expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, score: "80" })).toThrow(/score/);
  });

  it("summary 不能为空，strengths / problems / suggestions 必须是非空字符串数组", () => {
    expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, summary: "  " })).toThrow(/summary/);
    expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, strengths: "很强" })).toThrow(
      /strengths 必须是数组/,
    );
    expect(() =>
      validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, problems: ["", "中段重复"] }),
    ).toThrow(/problems\[0\]/);
    expect(() =>
      validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, suggestions: [42] as unknown as string[] }),
    ).toThrow(/suggestions\[0\]/);
  });

  it("空数组是合法的：没有建议不等于结论非法", () => {
    const out = validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, suggestions: [] });
    expect(out.suggestions).toEqual([]);
  });

  it("维度对象被换成数组 / null / 字符串时按非法处理", () => {
    for (const bad of [null, [], "hook", 42]) {
      expect(() => validateCommercialReviewResult({ ...SAMPLE_COMMERCIAL_REVIEW, dimensions: bad })).toThrow(
        CommercialReviewValidationError,
      );
    }
  });
});

describe("v1.5.0 商业整体分：确定性均分（§11）", () => {
  it("(82 + 68 + 74 + 62) / 4 = 71.5，四舍五入到一位小数", () => {
    expect(aggregateCommercialDimensions(SAMPLE_COMMERCIAL_REVIEW.dimensions)).toBe(71.5);
    expect(commercialOverallScore(SAMPLE_COMMERCIAL_REVIEW)).toBe(71.5);
  });

  it("纯算术：没有题材权重、没有动态权重、没有学习出来的权重", () => {
    // 悬疑题型的分数换到别的题型上，聚合结果一模一样
    expect(aggregateCommercialDimensions(dims({ hook: 80, pacing: 60, engagement: 90, payoff: 70 }))).toBe(75);
    expect(aggregateCommercialDimensions(dims({ hook: 80, pacing: 60, engagement: 90, payoff: 70 }))).toBe(75);
  });

  it("均分不是整数时只保留一位小数，同一输入永远同一输出", () => {
    expect(aggregateCommercialDimensions(dims({ hook: 1, pacing: 1, engagement: 1, payoff: 2 }))).toBe(1.3);
    expect(aggregateCommercialDimensions(dims({ hook: 0, pacing: 0, engagement: 0, payoff: 0 }))).toBe(0);
    expect(aggregateCommercialDimensions(dims({ hook: 100, pacing: 100, engagement: 100, payoff: 100 }))).toBe(100);
  });

  it("四个维度等权：不存在某个维度说了算", () => {
    const oneLow = dims({ hook: 10, pacing: 90, engagement: 90, payoff: 90 });
    expect(aggregateCommercialDimensions(oneLow)).toBe(70);
  });
});

describe("v1.5.0 commercialReviewResultOf：读旧 / 坏数据只给 null（§32）", () => {
  it("合法数据原样返回", () => {
    expect(commercialReviewResultOf(SAMPLE_COMMERCIAL_REVIEW)).toEqual(SAMPLE_COMMERCIAL_REVIEW);
  });

  it("v1.5.0 之前的 Run（没有这个文件、半份 JSON、缺维度）一律 null，绝不补默认值", () => {
    expect(commercialReviewResultOf(null)).toBeNull();
    expect(commercialReviewResultOf(undefined)).toBeNull();
    expect(commercialReviewResultOf("{ not json")).toBeNull();
    expect(commercialReviewResultOf({ score: 71.5 })).toBeNull();
    expect(commercialReviewResultOf({ ...SAMPLE_COMMERCIAL_REVIEW, dimensions: undefined })).toBeNull();
  });

  it("磁盘上手改坏的分数照样 null，不会把 101 分当成真实评价返回", () => {
    expect(commercialReviewResultOf({ ...SAMPLE_COMMERCIAL_REVIEW, score: 101 })).toBeNull();
  });
});

describe("v1.5.0 parseCommercialReviewResult（§23）", () => {
  it("带 ```json 围栏的输出也能解析", () => {
    const raw = "```json\n" + JSON.stringify(SAMPLE_COMMERCIAL_REVIEW) + "\n```";
    expect(parseCommercialReviewResult(raw)).toEqual(SAMPLE_COMMERCIAL_REVIEW);
  });

  it("不是合法 JSON → CommercialReviewParseError，不尝试自动修 JSON", () => {
    expect(() => parseCommercialReviewResult("我觉得这篇挺抓人的")).toThrow(/不是合法 JSON/);
  });

  it("JSON 合法但 schema 不过 → CommercialReviewParseError，缺 hook 就是这个下场", () => {
    const bad = { ...SAMPLE_COMMERCIAL_REVIEW } as Record<string, unknown>;
    const d = { ...SAMPLE_COMMERCIAL_REVIEW.dimensions } as Record<string, unknown>;
    delete d.hook;
    bad.dimensions = d;
    expect(() => parseCommercialReviewResult(JSON.stringify(bad))).toThrow(/hook/);
  });
});

describe("v1.5.0 CommercialReviewer（§12/§13/§14）", () => {
  const calls: { prompt: string; temperature: number; system: string }[] = [];
  const llm = new FakeLLM([JSON.stringify(SAMPLE_COMMERCIAL_REVIEW)]) as never;
  const spied = {
    generate: async (prompt: string, temperature: number, system: string) => {
      calls.push({ prompt, temperature, system });
      return JSON.stringify(SAMPLE_COMMERCIAL_REVIEW);
    },
  };

  it("Prompt 带齐四个维度定义，且不残留占位符", async () => {
    const reviewer = new CommercialReviewer(spied as never);
    const prompt = reviewer.buildCommercialReviewPrompt(SAMPLE_CONFIG, SAMPLE_STORY);
    expect(prompt).toContain(SAMPLE_CONFIG.title);
    expect(prompt).toContain(SAMPLE_CONFIG.genre);
    expect(prompt).toContain(SAMPLE_CONFIG.premise);
    expect(prompt).toContain("开篇抓力、冲突进入速度");
    expect(prompt).toContain("阅读节奏、拖沓与推进速度");
    expect(prompt).toContain("全篇持续阅读动力");
    expect(prompt).toContain("高潮与结尾对前文承诺的回报");
    expect(prompt).toContain(SAMPLE_STORY);
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("温度固定 0.3，system 提示只谈四个商业维度", async () => {
    const reviewer = new CommercialReviewer(spied as never);
    const out = await reviewer.review(SAMPLE_CONFIG, SAMPLE_STORY);
    expect(out).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(calls.at(-1)?.temperature).toBe(COMMERCIAL_REVIEW_TEMPERATURE);
    expect(COMMERCIAL_REVIEW_TEMPERATURE).toBe(0.3);
    expect(calls.at(-1)?.system).toContain("商业可读性");
    expect(calls.at(-1)?.system).toContain("只输出 JSON");
  });

  it("默认模板路径就是 prompts/commercial_reviewer.txt，与 BasicReviewer 各读各的", async () => {
    // 不传模板路径：能构造成功说明默认文件存在，两个审阅者不共用一份 prompt
    const reviewer = new CommercialReviewer(llm);
    const out = await reviewer.review(SAMPLE_CONFIG, SAMPLE_STORY);
    expect(out.score).toBe(71.5);
  });

  it("模板缺失时报错说清楚是哪个文件，不静默降级", () => {
    expect(() => new CommercialReviewer(llm, "D:/nope/commercial_reviewer.txt")).toThrow(
      /commercial_reviewer\.txt/,
    );
  });

  it("这一路不写正文、不改 config：review() 只读输入", async () => {
    const reviewer = new CommercialReviewer(spied as never);
    const before = JSON.stringify(SAMPLE_CONFIG);
    await reviewer.review(SAMPLE_CONFIG, SAMPLE_STORY);
    expect(JSON.stringify(SAMPLE_CONFIG)).toBe(before);
  });
});
