import { describe, expect, it } from "vitest";
import {
  experimentListRow,
  experimentStatusLabel,
  meanText,
  resultRowsOf,
  runRowsOf,
  variantCardsOf,
} from "@/lib/experiment-view";
import type { ExperimentDetailApi, ExperimentListItemApi } from "@/lib/api";

/**
 * v1.7.0 实验界面推导（TASK §25/§26）：三条承诺——不排名、缺数不补 0、
 * 只给链接不给第二份正文。全部是纯函数测试，不打任何端点。
 */

const DEFINITION: ExperimentDetailApi["definition"] = {
  schemaVersion: "1",
  experimentId: "exp-view",
  name: "模型对比",
  base: {
    storyConfig: { config_version: "1", title: "消", genre: "悬疑", premise: "唯一证人消失。", target_words: 5000, protagonist: { name: "陈岚" } },
    beatPlanMode: "fixed",
    beatPlan: { beat_plan_version: "1", beats: [] },
    modelConfig: { model: "model-base" },
    generationParameters: { temperature: 0.7 },
    retryPolicy: { max_attempts: 3, min_review_score: 65, retry_on_validation_failure: true, enable_repair: false, max_repairs_per_attempt: 0 },
  },
  variants: [
    { id: "model-a", name: "模型 A", overrides: { model: "model-a-1" } },
    { id: "model-b", name: "模型 B", overrides: { generation: { temperature: 1.2 }, retry: { maxAttempts: 1 } } },
    { id: "same", name: "原样基线", overrides: {} },
  ],
  repetitions: 2,
  createdAt: "2026-09-26T00:00:00.000Z",
};

/** 模拟一份「b 组一条没跑出来」的结果摘要。 */
const DETAIL: ExperimentDetailApi = {
  definition: DEFINITION,
  runs: {
    experimentId: "exp-view",
    totalRuns: 6,
    entries: [
      { variantId: "model-a", repetition: 1, runId: "run-a1", status: "completed" },
      { variantId: "model-a", repetition: 2, runId: "run-a2", status: "failed", failure: "generating: 上游 502" },
      { variantId: "model-b", repetition: 1, runId: "run-b1", status: "completed" },
      { variantId: "model-b", repetition: 2, runId: "run-b2", status: "completed" },
      { variantId: "same", repetition: 1, runId: "run-s1", status: "completed" },
      { variantId: "same", repetition: 2, runId: "run-s2", status: "completed" },
    ],
  },
  result: {
    experimentId: "exp-view",
    status: "partial",
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:10:00.000Z",
    runs: [
      { variantId: "model-a", repetition: 1, runId: "run-a1", status: "completed", overallScore: 80, commercialScore: 70 },
      { variantId: "model-a", repetition: 2, runId: "run-a2", status: "failed", overallScore: null, commercialScore: null },
      { variantId: "model-b", repetition: 1, runId: "run-b1", status: "completed", overallScore: 60, commercialScore: 40 },
      { variantId: "model-b", repetition: 2, runId: "run-b2", status: "completed", overallScore: 70, commercialScore: 50 },
    ],
    summary: {
      runCount: 4,
      successCount: 3,
      failureCount: 1,
      variants: [
        {
          variantId: "model-a", runCount: 2, successCount: 1, failureCount: 1,
          meanOverallScore: 80, meanCommercialScore: 70,
          meanCoherence: null, meanNarrative: null, meanCharacter: null, meanCausality: null,
          meanHook: null, meanPacing: null, meanEngagement: null, meanPayoff: null,
        },
        {
          variantId: "model-b", runCount: 2, successCount: 2, failureCount: 0,
          meanOverallScore: 65, meanCommercialScore: 45,
          meanCoherence: null, meanNarrative: null, meanCharacter: null, meanCausality: null,
          meanHook: null, meanPacing: null, meanEngagement: null, meanPayoff: null,
        },
      ],
    },
  },
};

describe("状态文案", () => {
  it("五种状态各有中性语气，partial 不是失败", () => {
    expect(experimentStatusLabel("completed")).toEqual({ label: "全部完成", tone: "good" });
    expect(experimentStatusLabel("partial")).toEqual({ label: "部分完成", tone: "warn" });
    expect(experimentStatusLabel("failed")).toEqual({ label: "没有可用样本", tone: "bad" });
    expect(experimentStatusLabel("running")).toEqual({ label: "正在运行", tone: "neutral" });
    expect(experimentStatusLabel("pending")).toEqual({ label: "尚未运行", tone: "neutral" });
  });
});

describe("均值展示", () => {
  it("null 显示「—」，不是 0", () => {
    expect(meanText(null)).toBe("—");
    expect(meanText(undefined)).toBe("—");
    expect(meanText(0)).toBe("0");
    expect(meanText(65)).toBe("65");
  });
});

describe("结果行", () => {
  it("没跑过 → null（界面整段隐藏）", () => {
    expect(resultRowsOf(null)).toBeNull();
    expect(resultRowsOf({ definition: DEFINITION, runs: null, result: null })).toBeNull();
  });

  it("行顺序 = 定义顺序，不按分数重排", () => {
    const rows = resultRowsOf(DETAIL);
    expect(rows).not.toBeNull();
    // b 组没有出现在 summary 里（一条都没跑出来）时也要有它的行，各项 — 
    expect(rows?.map((r) => r.variantId)).toEqual(["model-a", "model-b", "same"]);
    expect(rows?.[0].meanOverallScore).toBe(80);
    expect(rows?.[1].meanOverallScore).toBe(65);
    expect(rows?.[2].meanOverallScore).toBeNull();
    expect(rows?.[2].runCount).toBe(0);
  });

  it("服务端把 summary 顺序打乱也照定义顺序摆（这里重建行，不信排序）", () => {
    const shuffled: ExperimentDetailApi = {
      ...DETAIL,
      result: {
        ...DETAIL.result!,
        summary: {
          ...DETAIL.result!.summary,
          variants: [...DETAIL.result!.summary.variants].reverse(),
        },
      },
    };
    expect(resultRowsOf(shuffled)?.map((r) => r.variantId)).toEqual(["model-a", "model-b", "same"]);
  });
});

describe("变体卡片", () => {
  it("卡片写「Base 值 → 变体值」，原样基线写与 Base 相同", () => {
    const cards = variantCardsOf(DEFINITION);
    expect(cards).toEqual([
      { variantId: "model-a", variantName: "模型 A", changes: [{ label: "Model", value: "model-base → model-a-1" }] },
      {
        variantId: "model-b",
        variantName: "模型 B",
        changes: [
          { label: "Temperature", value: "0.7 → 1.2" },
          { label: "Max Attempts", value: "3 → 1" },
        ],
      },
      { variantId: "same", variantName: "原样基线", changes: [] },
    ]);
  });
});

describe("样本行", () => {
  it("顺序 = runs.json，失败带摘要，分数从结果里取", () => {
    const rows = runRowsOf(DETAIL);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ variantId: "model-a", repetition: 1, runId: "run-a1", status: "completed", overallScore: 80 });
    expect(rows[1]).toMatchObject({ variantId: "model-a", repetition: 2, runId: "run-a2", status: "failed" });
    expect(rows[1].failure).toContain("generating");
    // overallScore 只按结果里给的填，没有就不猜
    expect(rows[1].overallScore).toBeNull();
    expect(rows[4].overallScore).toBeNull();
  });

  it("没跑过 → 空数组", () => {
    expect(runRowsOf(null)).toEqual([]);
    expect(runRowsOf({ definition: DEFINITION, runs: null, result: null })).toEqual([]);
  });
});

describe("列表行", () => {
  it("副标题说明样本数，语气跟随实验状态", () => {
    const item: ExperimentListItemApi = {
      experimentId: "exp-view",
      name: "模型对比",
      repetitions: 2,
      variantCount: 3,
      totalRuns: 6,
      createdAt: "2026-09-26T00:00:00.000Z",
      status: "partial",
      successCount: 3,
      failureCount: 1,
    };
    expect(experimentListRow(item)).toEqual({
      title: "模型对比",
      subtitle: "3 个变体 × 2 次 = 6 条样本",
      status: { label: "部分完成", tone: "warn" },
    });
  });
});
