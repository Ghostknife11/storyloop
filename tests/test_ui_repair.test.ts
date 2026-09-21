import { describe, expect, it, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RepairPanel,
  ManualRepair,
  defaultRepairTarget,
  repairIssueLabel,
  repairStageLabels,
  scoreTransition,
  validationTransition,
} from "@/components/repair-panel";
import { MAX_REPAIRS_RANGE, retryPolicyOf, type AppSettings } from "@/lib/settings-store";
import { repairStory, startRun, type RepairDetailApi } from "@/lib/api";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

/**
 * §34~§38/§50/§63 Repair UI 契约。
 * 运行在 node 环境：覆盖设置推导、面板用到的纯映射、API 客户端与字段白名单；
 * 开关 / 输入框 / 按钮的渲染由页面自身承担（与 test_ui_retry 同一套约定）。
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

const failed: ValidationResult = {
  passed: false,
  issues: [{ code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" }],
};

const passed: ValidationResult = { passed: true, issues: [] };

const review: ReviewResult = {
  score: 61,
  summary: "总结。",
  strengths: ["强"],
  problems: ["结尾没收住，真相没有落地。"],
};

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

/** §36 面板的一条修订记录：Attempt 详情接口给前端的形状。 */
const repair: RepairDetailApi = {
  repair_number: 1,
  issue_type: "ending",
  issue_message: "故事缺少明确结局。",
  success: true,
  before_review_score: 61,
  after_review_score: 80,
  before_validation_passed: false,
  after_validation_passed: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("§34 修订设置 → 请求体", () => {
  it("默认把 Enable Targeted Repair / Max Repairs Per Attempt 带给后端", async () => {
    const fetchMock = stubJson({
      run_id: "20260922_000000_ab12cd",
      quality_status: "accepted",
      attempt_count: 1,
      selected_attempt: 1,
      attempts: [],
    });
    await startRun(config, {}, retryPolicyOf(settings()));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.retry_policy).toMatchObject({ enable_repair: true, max_repairs_per_attempt: 1 });
    // §19：上限只能是 0 ~ 3，UI 输入框与策略同一个范围
    expect(MAX_REPAIRS_RANGE).toEqual({ min: 0, max: 3 });
  });

  it("关闭修订时请求体带 enable_repair=false 且上限归零（§51-E）", () => {
    const p = retryPolicyOf(settings({ repairEnabled: false, maxRepairsPerAttempt: 2 }));
    expect(p.enable_repair).toBe(false);
    expect(p.max_repairs_per_attempt).toBe(0);
    // 重试行为不受影响
    expect(p.max_attempts).toBe(2);
    expect(p.min_review_score).toBe(70);
  });
});

describe("§35 修订阶段标记", () => {
  it("只有真的发生过修订才出现 Repairing / Revalidating / Re-reviewing", () => {
    expect(repairStageLabels(0)).toEqual([]);
    expect(repairStageLabels(1)).toEqual(["Repairing", "Revalidating", "Re-reviewing"]);
    expect(repairStageLabels(3)).toEqual(["Repairing", "Revalidating", "Re-reviewing"]);
  });

  it("§64 没有修订时不显示任何修订阶段，也不伪造过程", () => {
    // 面板本身同理：没有修订记录就不渲染
    expect(RepairPanel({ repairs: [] })).toBeNull();
  });
});

describe("§36 Repair 结果面板字段", () => {
  it("Issue Type → 中文标签：六类映射，未知类型原样返回", () => {
    expect(repairIssueLabel("length")).toBe("篇幅不足");
    expect(repairIssueLabel("ending")).toBe("结局问题");
    expect(repairIssueLabel("character_presence")).toBe("主角缺席");
    expect(repairIssueLabel("continuity")).toBe("前后连贯");
    expect(repairIssueLabel("structure")).toBe("结构断层");
    expect(repairIssueLabel("general")).toBe("综合问题");
    expect(repairIssueLabel("unknown_type")).toBe("unknown_type");
  });

  it("前后分数：Before Score → After Score", () => {
    expect(scoreTransition(61, 80)).toBe("61 → 80");
    expect(scoreTransition(null, 80)).toBe("— → 80");
    expect(scoreTransition(61, null)).toBe("61 → —");
    expect(scoreTransition(null, null)).toBe("— → —");
  });

  it("校验变化：Validation: FAILED → PASSED", () => {
    expect(validationTransition(false, true)).toBe("FAILED → PASSED");
    expect(validationTransition(true, false)).toBe("PASSED → FAILED");
    expect(validationTransition(null, true)).toBe("— → PASSED");
    expect(validationTransition(false, null)).toBe("FAILED → —");
  });

  it("§63 面板只暴露八类字段：没有失败归因 / 策略排名 / 自适应建议", () => {
    const keys = Object.keys(repair).sort();
    expect(keys).toEqual([
      "after_review_score",
      "after_validation_passed",
      "before_review_score",
      "before_validation_passed",
      "issue_message",
      "issue_type",
      "repair_number",
      "success",
    ]);
    for (const forbidden of ["root_cause", "causal", "diagnos", "strategy", "policy", "rank", "confidence", "attribution", "dimension"]) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it("面板在有修订记录时渲染（Repair Applied / Type / Reason / 前后对比）", () => {
    const html = renderToStaticMarkup(createElement(RepairPanel, { repairs: [repair] }));
    expect(html).toContain("Repair Applied");
    expect(html).toContain("Repair 1");
    expect(html).toContain("Type: ending（结局问题）");
    expect(html).toContain("Reason: 故事缺少明确结局。");
    expect(html).toContain("Before Score: 61 · After Score: 80");
    expect(html).toContain("Validation: FAILED → PASSED");
    // §36：修好了就是 Repaired，修不好显示 Not repaired
    expect(html).toContain("Repaired");
    const failedHtml = renderToStaticMarkup(createElement(RepairPanel, { repairs: [{ ...repair, success: false, after_review_score: null, after_validation_passed: null }] }));
    expect(failedHtml).toContain("Not repaired");
    expect(failedHtml).toContain("After Score: —");
    expect(failedHtml).toContain("Validation: FAILED → —");
  });
});

describe("§36 预填要修的问题（与 RepairStrategy 同一套固定规则）", () => {
  it("优先用硬性校验里的问题码，取它的原文做说明", () => {
    expect(defaultRepairTarget(failed, review)).toEqual({
      issue_type: "ending",
      issue_message: "故事缺少明确结局。",
    });
  });

  it("校验通过时退回审阅 problem 的关键词分类", () => {
    const target = defaultRepairTarget(passed, review);
    expect(target.issue_message).toBe("结尾没收住，真相没有落地。");
    expect(["length", "ending", "character_presence", "continuity", "structure", "general"]).toContain(target.issue_type);
  });

  it("两项都没有时不猜，退回 general 且说明为空", () => {
    expect(defaultRepairTarget(null, null)).toEqual({ issue_type: "general", issue_message: "" });
  });
});

describe("§38/§50 手动修订客户端", () => {
  it("POST /api/repair：请求体带 config / beat_plan / story / issue_type / issue_message", async () => {
    const fetchMock = stubJson({
      repaired_story: "修订后的正文。",
      issue_type: "ending",
      success: true,
      notes: null,
    });
    const out = await repairStory(config, plan, "原正文。", "ending", "故事缺少明确结局。", { temperature: 0.7 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/repair");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      config,
      beat_plan: plan,
      story: "原正文。",
      issue_type: "ending",
      issue_message: "故事缺少明确结局。",
      temperature: 0.7,
    });
    expect(out.repaired_story).toBe("修订后的正文。");
    expect(out.success).toBe(true);
  });

  it("§65 只改正文：请求体里没有 retry_policy / score / 策略字段", async () => {
    const fetchMock = stubJson({ repaired_story: "s", issue_type: "length", success: true, notes: null });
    await repairStory(config, plan, "原正文。", "length", "正文太短。");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    for (const forbidden of ["retry_policy", "max_attempts", "min_review_score", "enable_repair", "strategy", "score"]) {
      expect(body[forbidden]).toBeUndefined();
    }
  });

  it("§15 失败时抛出可读错误，不静默、不自动重试", async () => {
    stubJson({ error: "Repair failed. 原因：上游模型超时" }, false, 502);
    await expect(
      repairStory(config, plan, "原正文。", "ending", "缺结局。"),
    ).rejects.toThrow("上游模型超时");
  });

  it("ManualRepair 组件暴露修订入口：先选类型、再写说明（§63 没有策略选择器）", () => {
    const html = renderToStaticMarkup(
      createElement(ManualRepair, {
        config,
        plan,
        story: "原正文。",
        validation: failed,
        review,
        runtime: {},
        onRepaired: () => {},
      }),
    );
    // §63 允许的：Issue Type 下拉 + Issue Message 输入 + 修订按钮
    expect(html).toContain("Issue Type");
    expect(html).toContain("Issue Message");
    expect(html).toContain("Targeted Repair");
    // §36：默认按校验问题码预填，用户看得见这次要修什么
    expect(html).toContain("故事缺少明确结局。");
    // §6：下拉里正好是六类，没有第七个「智能策略」
    for (const t of ["length", "ending", "character_presence", "continuity", "structure", "general"]) {
      expect(html).toContain(t);
    }
    // §63 禁止的：策略 / 归因 / 自适应入口
    for (const forbidden of ["Strategy", "Diagnos", "Attribution", "Adaptive", "Ranking", "Policy"]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
