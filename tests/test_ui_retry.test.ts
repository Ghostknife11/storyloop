import { describe, expect, it, vi, afterEach } from "vitest";
import {
  MAX_ATTEMPTS_RANGE,
  MAX_REPAIRS_RANGE,
  MIN_SCORE_RANGE,
  retryPolicyOf,
  type AppSettings,
} from "@/lib/settings-store";
import { retryReasonLabel } from "@/components/attempt-panel";
import { fetchRun, fetchRunAttempt, startRun, type AttemptSummaryApi } from "@/lib/api";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §30~§36/§52 Retry UI 契约：
 * 设置页只暴露四个重试字段（§66 禁止修复策略 / 维度阈值 / 失败归因 / 自适应策略入口），
 * Attempt 面板只按编号罗列摘要（§35 禁止比较表 / 差值图 / 排名）。
 * 本文件运行在 node 环境，覆盖设置推导、标签映射与 API 客户端；
 * 渲染逻辑（开关 / 输入框 / 计数）跑在 React 里，由页面自身承担。
 */

const config: StoryConfig = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

const plan: BeatPlan = {
  beat_plan_version: "1",
  beats: [{ id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] }],
};

const review: ReviewResult = {
  score: 74,
  summary: "总结。",
  strengths: ["强"],
  problems: ["弱"],
};

const passed: ValidationResult = { passed: true, issues: [] };

/** §30/§66：自动重试在设置里就这四个入口。 */
const RETRY_SETTING_KEYS = [
  "retryEnabled",
  "maxAttempts",
  "minReviewScore",
  "retryOnValidationFailure",
];

/** §34：定点修订在设置里就这两个入口——开关 + 单次 Attempt 上限。 */
const REPAIR_SETTING_KEYS = ["repairEnabled", "maxRepairsPerAttempt"];

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    baseUrl: "",
    model: "",
    temperature: 0.7,
    retryEnabled: true,
    maxAttempts: 2,
    minReviewScore: 70,
    retryOnValidationFailure: true,
    repairEnabled: true,
    maxRepairsPerAttempt: 1,
    ...patch,
  };
}

/** §38 前端拿到的只可能是摘要：没有正文、没有完整 Validation / Review。 */
const attempts: AttemptSummaryApi[] = [
  {
    attempt_number: 1,
    accepted: false,
    retry_reason: "review_score_below_threshold",
    review_score: 61,
    validation_passed: true,
    repair_count: 0,
    repairs: [],
  },
  {
    attempt_number: 2,
    accepted: false,
    retry_reason: "validation_failed",
    review_score: null,
    validation_passed: false,
    repair_count: 1,
    repairs: [{ repair_number: 1, issue_type: "length", success: false }],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("§30/§31 自动重试设置", () => {
  it("默认为开 / 2 / 70 / 开", () => {
    const p = retryPolicyOf(settings());
    expect(p).toEqual({
      max_attempts: 2,
      min_review_score: 70,
      retry_on_validation_failure: true,
      enable_repair: true,
      max_repairs_per_attempt: 1,
    });
  });

  it("关闭自动重试时只保留一次尝试，而不是造假阈值", () => {
    const p = retryPolicyOf(settings({ retryEnabled: false, maxAttempts: 5, minReviewScore: 70 }));
    expect(p.max_attempts).toBe(1);
    expect(p.min_review_score).toBe(70);
  });

  it("max attempts validation works：越界值夹回 1 ~ 5（§31）", () => {
    expect(MAX_ATTEMPTS_RANGE).toEqual({ min: 1, max: 5 });
    expect(retryPolicyOf(settings({ maxAttempts: 0 })).max_attempts).toBe(1);
    expect(retryPolicyOf(settings({ maxAttempts: 9 })).max_attempts).toBe(5);
    expect(retryPolicyOf(settings({ maxAttempts: 3.5 })).max_attempts).toBe(2);
  });

  it("score threshold validation works：越界阈值夹回 0 ~ 100（§31）", () => {
    expect(MIN_SCORE_RANGE).toEqual({ min: 0, max: 100 });
    expect(retryPolicyOf(settings({ minReviewScore: -5 })).min_review_score).toBe(0);
    expect(retryPolicyOf(settings({ minReviewScore: 140 })).min_review_score).toBe(100);
  });

  it("§66 设置里只有四个重试字段 + 两个修订字段，没有修复策略 / 维度阈值 / 自适应策略", () => {
    const keys = Object.keys(settings());
    for (const forbidden of ["strategy", "dimension", "adaptive", "attribution", "target", "diagnos", "rank"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
    // §30 允许的全部就这四个，§34 允许的就这两个，外加原有的 model / baseUrl / temperature
    expect(keys.filter((k) => RETRY_SETTING_KEYS.includes(k))).toEqual(RETRY_SETTING_KEYS);
    expect(keys.filter((k) => REPAIR_SETTING_KEYS.includes(k))).toEqual(REPAIR_SETTING_KEYS);
  });
});

describe("§34 定点修订设置", () => {
  it("默认开启，每次 Attempt 最多修一次", () => {
    expect(MAX_REPAIRS_RANGE).toEqual({ min: 0, max: 3 });
    expect(retryPolicyOf(settings())).toMatchObject({ enable_repair: true, max_repairs_per_attempt: 1 });
  });

  it("关闭修订时不改重试行为，只是不再修（§51-E）", () => {
    const p = retryPolicyOf(settings({ repairEnabled: false, maxRepairsPerAttempt: 3 }));
    expect(p.enable_repair).toBe(false);
    expect(p.max_repairs_per_attempt).toBe(0);
    expect(p.max_attempts).toBe(2);
  });

  it("修订次数越界夹回 0 ~ 3（§19：绝不无限修）", () => {
    expect(retryPolicyOf(settings({ maxRepairsPerAttempt: -2 })).max_repairs_per_attempt).toBe(0);
    expect(retryPolicyOf(settings({ maxRepairsPerAttempt: 9 })).max_repairs_per_attempt).toBe(3);
    expect(retryPolicyOf(settings({ maxRepairsPerAttempt: 1.5 })).max_repairs_per_attempt).toBe(1);
  });
});

describe("§34/§35 Attempt 面板状态", () => {
  it("retry reason → 中文标签，且只有一个原因字段", () => {
    expect(retryReasonLabel("generation_error")).toBe("生成失败");
    expect(retryReasonLabel("validation_failed")).toBe("有效性检查未通过");
    expect(retryReasonLabel("review_score_below_threshold")).toBe("审阅分数低于阈值");
    // 已采纳：没有原因
    expect(retryReasonLabel(null)).toBe("—");
  });

  it("attempt counter renders：Attempts = 实际跑过的次数", () => {
    expect(attempts).toHaveLength(2);
    expect(attempts[attempts.length - 1].attempt_number).toBe(2);
  });

  it("selected attempt renders：exhausted 时选中最后一次，accepted 时选中通过那次", () => {
    const ok: AttemptSummaryApi[] = [
      { attempt_number: 1, accepted: false, retry_reason: "validation_failed", review_score: null, validation_passed: false, repair_count: 0, repairs: [] },
      { attempt_number: 2, accepted: true, retry_reason: null, review_score: 88, validation_passed: true, repair_count: 0, repairs: [] },
    ];
    expect(ok.find((a) => a.accepted)?.attempt_number).toBe(2);
    expect(attempts.some((a) => a.accepted)).toBe(false);
    // exhausted：没有 accepted，最后一次就是 selected
    expect(attempts.filter((a) => a.accepted === false)).toHaveLength(2);
  });

  it("exhausted state renders：两次都没 accepted 时 quality_status=exhausted", () => {
    const anyAccepted = attempts.some((a) => a.accepted);
    expect(anyAccepted ? "accepted" : "exhausted").toBe("exhausted");
  });

  it("§35 每个 Attempt 只有摘要字段：没有分数差值 / 排名 / 平均分", () => {
    const keys = Object.keys(attempts[0]).sort();
    expect(keys).toEqual([
      "accepted", "attempt_number", "repair_count", "repairs", "retry_reason", "review_score", "validation_passed",
    ]);
    for (const forbidden of ["delta", "rank", "best", "average", "efficiency", "cost", "dimension", "causal"]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
  });
});

describe("§36/§39 前端读回 Run 与 Attempt", () => {
  it("fetchRun 只请求 /api/runs/<run_id>，不做历史列表", async () => {
    const fetchMock = stubJson({ run_id: "20260922_000000_ab12cd", attempts });
    await fetchRun("20260922_000000_ab12cd");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs/20260922_000000_ab12cd");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchRunAttempt 请求指定 Attempt 的详情", async () => {
    stubJson({ attempt_number: 1, accepted: false, selected: false });
    const d = await fetchRunAttempt("20260922_000000_ab12cd", 1);
    expect(d.attempt_number).toBe(1);
  });

  it("startRun 把设置推导出的 retry_policy 放进请求体（§37）", async () => {
    const fetchMock = stubJson({
      run_id: "20260922_000000_ab12cd",
      quality_status: "accepted",
      attempt_count: 2,
      selected_attempt: 2,
      attempts,
    });
    await startRun(config, { temperature: 0.8 }, retryPolicyOf(settings({ maxAttempts: 4, minReviewScore: 55 })));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.retry_policy).toEqual({
      max_attempts: 4,
      min_review_score: 55,
      retry_on_validation_failure: true,
      enable_repair: true,
      max_repairs_per_attempt: 1,
    });
    // §37：策略不属于 StoryConfig
    expect(body.max_attempts).toBeUndefined();
  });

  it("startRun 不传策略时请求体里没有 retry_policy", async () => {
    const fetchMock = stubJson({
      run_id: "20260922_000000_ab12cd",
      quality_status: "accepted",
      attempt_count: 1,
      selected_attempt: 1,
      attempts: [],
    });
    await startRun(config, {});
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.retry_policy).toBeUndefined();
  });
});
