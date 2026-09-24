import { afterEach, describe, expect, it, vi } from "vitest";
import { validateStoryBeats } from "@/lib/api";
import { beatIssueLabel, beatValidationPanelState } from "@/lib/beat-validation-view";
import type { BeatValidationResult } from "@/types/beat-validation";
import { SAMPLE_BEAT_VALIDATION, SAMPLE_BEAT_VALIDATION_FAILED } from "./helpers/fixtures";

/**
 * v1.4.0 Beat Validation UI 契约（TASK §8/§9）。
 *
 * 面板与 Validation 面板分开（§2）：这里检查剧情骨架，不显示正文校验结论、不显示分数、
 * 也没有 Auto Fix / Regenerate Beats（§4/§10——本版本只报告）。
 * 浏览器渲染跑在 React 里，这里覆盖它依赖的 API 客户端函数与纯状态推导函数。
 */

const warned: BeatValidationResult = {
  passed: true,
  issues: [
    {
      code: "ENDING_NOT_PREPARED",
      severity: "warning",
      message: "结局所需的「三分钟去向」在前三拍没有铺垫。",
      beat_ids: [1, 2, 3],
    },
  ],
  summary: "骨架四拍齐全，结局缺一笔铺垫。",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Validate Beats：validateStoryBeats（v1.4.0 §7）", () => {
  it("POST /api/validate-beats，请求体带 config 与 beat_plan", async () => {
    const fetchMock = stubJson(SAMPLE_BEAT_VALIDATION);
    const r = await validateStoryBeats(
      { title: "消失的目击者", premise: "证人失踪。" } as never,
      { beats: [] } as never,
    );
    expect(r).toEqual(SAMPLE_BEAT_VALIDATION);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/validate-beats");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body.config).toMatchObject({ title: "消失的目击者" });
    expect(body.beat_plan).toEqual({ beats: [] });
  });

  it("不发送 run_id：外部调用不该改 Run 里那一份 beat-validation.json", async () => {
    const fetchMock = stubJson(SAMPLE_BEAT_VALIDATION);
    await validateStoryBeats({ title: "t" } as never, { beats: [] } as never);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String((init as RequestInit).body))).not.toHaveProperty("run_id");
  });

  it("骨架不达标的结论照样返回（passed=false 是业务结果，不是异常）", async () => {
    stubJson(SAMPLE_BEAT_VALIDATION_FAILED);
    const r = await validateStoryBeats({ title: "t" } as never, { beats: [] } as never);
    expect(r.passed).toBe(false);
    expect(r.issues[0].code).toBe("MISSING_CLIMAX");
  });

  it("502 BEAT_VALIDATION_FAILED → 抛出可读错误", async () => {
    stubJson(
      { error: { code: "BEAT_VALIDATION_FAILED", message: "Beat validation failed. 原因：输出不是合法 JSON" } },
      false,
      502,
    );
    await expect(validateStoryBeats({ title: "t" } as never, { beats: [] } as never)).rejects.toThrow(
      /BEAT_VALIDATION_FAILED|Beat validation failed/,
    );
  });

  it("响应里不携带任何改写后的骨架字段（§10 只报告，不修复）", async () => {
    const fetchMock = stubJson(SAMPLE_BEAT_VALIDATION_FAILED, false, 400);
    await expect(validateStoryBeats({ title: "t" } as never, { beats: [] } as never)).rejects.toThrow();
    const raw = JSON.stringify(fetchMock.mock.results[0]?.value);
    expect(raw).not.toContain("fixed_beats");
    expect(raw).not.toContain("rewritten_plan");
    expect(raw).not.toContain("suggested_plan");
  });
});

describe("beatValidationPanelState（v1.4.0 §8/§9）", () => {
  it("hidden：没有结论且没在跑时不渲染面板", () => {
    expect(beatValidationPanelState({ beatValidation: null, beatValidationStatus: "not_started" })).toEqual({
      kind: "hidden",
    });
  });

  it("validating 中且没有结论时不渲染面板", () => {
    expect(
      beatValidationPanelState({ beatValidation: null, beatValidationStatus: "validating" }),
    ).toEqual({ kind: "hidden" });
  });

  it("loading：重新校验优先于已有结论", () => {
    const state = beatValidationPanelState({
      beatValidation: SAMPLE_BEAT_VALIDATION,
      beatValidationStatus: "completed",
      validating: true,
    });
    expect(state.kind).toBe("loading");
  });

  it("ready：passed + issues 与 summary 一并可渲染", () => {
    const state = beatValidationPanelState({
      beatValidation: SAMPLE_BEAT_VALIDATION,
      beatValidationStatus: "completed",
    });
    expect(state).toEqual({
      kind: "ready",
      passed: true,
      issues: [],
      summary: SAMPLE_BEAT_VALIDATION.summary,
    });
  });

  it("ready：只有 warning 时 passed 仍是 true（不误导用户当成失败）", () => {
    const state = beatValidationPanelState({ beatValidation: warned, beatValidationStatus: "completed" });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.passed).toBe(true);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0].severity).toBe("warning");
  });

  it("ready：带 error 时 passed=false，issue 仍带 code / severity / message / beat_ids", () => {
    const state = beatValidationPanelState({
      beatValidation: SAMPLE_BEAT_VALIDATION_FAILED,
      beatValidationStatus: "completed",
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.passed).toBe(false);
    expect(state.issues[0]).toEqual({
      code: "MISSING_CLIMAX",
      severity: "error",
      message: "第 4 拍直接跳到结局，没有任何高潮或决定性对抗。",
      beat_ids: [4],
    });
  });

  it("failed：校验器自身异常，读 beat_validation_error，没有结论就不渲染结果区", () => {
    const state = beatValidationPanelState({
      beatValidation: null,
      beatValidationStatus: "failed",
      beatValidationError: "结构校验模型超时",
    });
    expect(state).toEqual({ kind: "failed", error: "结构校验模型超时" });
  });

  it("failed 但没带原因时用兜底文案，不出现空错误", () => {
    const state = beatValidationPanelState({ beatValidation: null, beatValidationStatus: "failed" });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.error).toBeTruthy();
  });

  it("骨架不过 ≠ 校验器失败：passed=false 仍是 ready，不是 failed", () => {
    const state = beatValidationPanelState({
      beatValidation: SAMPLE_BEAT_VALIDATION_FAILED,
      beatValidationStatus: "completed",
    });
    expect(state.kind).not.toBe("failed");
  });
});

describe("beatIssueLabel（v1.4.0 §8）", () => {
  it("单拍 → Beat 3", () => {
    expect(beatIssueLabel([3])).toBe("Beat 3");
  });

  it("多拍 → Beat 3 / Beat 4（每个编号都带 Beat 前缀，读起来不必回翻）", () => {
    expect(beatIssueLabel([3, 4])).toBe("Beat 3 / Beat 4");
  });

  it("没填 beat_ids → null（整份骨架的问题，不指认具体哪一拍）", () => {
    expect(beatIssueLabel(undefined)).toBeNull();
    expect(beatIssueLabel([])).toBeNull();
  });
});

describe("v1.4.0 面板不越界（§4/§10）", () => {
  it("面板状态里没有任何「改写 / 重排 / 补拍」的动作槽位", () => {
    const state = beatValidationPanelState({
      beatValidation: SAMPLE_BEAT_VALIDATION_FAILED,
      beatValidationStatus: "completed",
    });
    // 只有四种 kind，没有 repair / regenerate / fix 之类的中间态
    expect(Object.keys(state).sort()).toEqual(["issues", "kind", "passed", "summary"]);
  });
});
