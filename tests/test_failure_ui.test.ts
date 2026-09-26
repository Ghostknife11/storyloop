import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRunFailureAnalysis } from "@/lib/api";
import { categoryLabel, failurePanelState, severityClass } from "@/lib/failure-view";
import { validateFailureAnalysis, type FailureAnalysisResult } from "@/types/failure-analysis";

/**
 * v1.9.0 失败分析面板契约（TASK §32~§34）。
 *
 * 面板与 Observability 面板分开（§2）：这里只给失败分类与证据，没有执行过程数字，
 * 也没有任何按钮。浏览器渲染跑在 React 里，这里覆盖它依赖的 API 客户端函数与
 * 纯状态推导函数。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 一份带信号与证据的失败分析（结构与落盘文件一致）。 */
function detected(): FailureAnalysisResult {
  return validateFailureAnalysis({
    schemaVersion: "1",
    runId: "20260101_120000_fail01",
    status: "detected",
    primaryCategory: "GENERATION",
    secondaryCategories: ["VALIDATION"],
    summary: "Detected a run-level failure in the category GENERATION.",
    signals: [
      { code: "LLM_TIMEOUT", source: "telemetry", severity: "error", message: "模型请求超时。" },
      { code: "TOO_SHORT", source: "story-validation", severity: "error", message: "正文长度不足。" },
    ],
    evidence: [
      {
        sourceArtifact: "telemetry.json",
        sourceField: "failureCode",
        stage: "generating",
        code: "LLM_TIMEOUT",
        note: "遥测记录的失败码。",
      },
      {
        sourceArtifact: "attempts/01/validation.json",
        sourceField: "issues[0].code",
        attemptId: "attempt-01",
        value: "TOO_SHORT",
        note: "首次校验的问题码。",
      },
    ],
    firstFailureStage: "generating",
    terminalState: "failed",
  });
}

/** §28 成功 Run：一份 status=none 的分析。 */
function none(): FailureAnalysisResult {
  return validateFailureAnalysis({
    schemaVersion: "1",
    runId: "20260101_120000_ok0001",
    status: "none",
    primaryCategory: null,
    secondaryCategories: [],
    summary: "No run-level failure detected.",
    signals: [],
    evidence: [],
    firstFailureStage: null,
    terminalState: "completed",
  });
}

describe("fetchRunFailureAnalysis（v1.9.0 §31）", () => {
  it("请求打到 /api/runs/<id>/failure-analysis，run_id 过 URL 编码", async () => {
    const fetchMock = stubJson({ failureAnalysis: none() });
    const analysis = await fetchRunFailureAnalysis("20260101_120000_ok0001");
    expect(analysis?.status).toBe("none");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe("/api/runs/20260101_120000_ok0001/failure-analysis");
    // 只读：不发 body、不用 POST
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("§35 旧 Run：接口 200 且 failureAnalysis 是 null 时返回 null（不抛错）", async () => {
    stubJson({ failureAnalysis: null });
    await expect(fetchRunFailureAnalysis("legacy")).resolves.toBeNull();
  });
});

describe("failurePanelState（§32/§34）", () => {
  it("§30 没有分析时整个面板不出现", () => {
    expect(failurePanelState(null).kind).toBe("hidden");
    expect(failurePanelState(undefined).kind).toBe("hidden");
  });

  it("主要 / 次要类别、首个失败阶段、终态都摆出来", () => {
    const state = failurePanelState(detected());
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.primaryLabel).toBe("正文生成问题");
    expect(state.secondaryLabels).toEqual(["正文校验问题"]);
    expect(state.firstFailureStageText).toBe("generating");
    expect(state.terminalStateText).toBe("failed");
    expect(state.signals).toHaveLength(2);
    expect(state.evidence).toHaveLength(2);
  });

  it("§33 证据行带上文件、字段、阶段、Attempt 与实际值", () => {
    const state = failurePanelState(detected());
    if (state.kind !== "ready") return;
    const [first, second] = state.evidence;
    expect(first.locationText).toBe("telemetry.json · failureCode");
    expect(first.stageText).toBe("generating");
    expect(first.attemptText).toBe("—");
    expect(first.valueText).toBe("—");
    expect(second.locationText).toBe("attempts/01/validation.json · issues[0].code");
    expect(second.attemptText).toBe("attempt-01");
    expect(second.valueText).toBe("TOO_SHORT");
    expect(second.repairText).toBe("—");
  });

  it("§28/§34 成功 Run：一句确定的话，没有信号也没有证据", () => {
    const state = failurePanelState(none());
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.analysis.summary).toBe("No run-level failure detected.");
    expect(state.statusText).toBe("没有检测到运行级失败");
    expect(state.primaryLabel).toBeNull();
    expect(state.secondaryLabels).toEqual([]);
    expect(state.signals).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.firstFailureStageText).toBe("—");
    expect(state.terminalStateText).toBe("completed");
  });

  it("UNKNOWN 也只能说「未能归类」，不替它挑一个类别", () => {
    const state = failurePanelState(
      validateFailureAnalysis({
        schemaVersion: "1",
        runId: "20260101_120000_unkn01",
        status: "unknown",
        primaryCategory: "UNKNOWN",
        secondaryCategories: [],
        summary: "Failure signals were found, but none of them maps to a known category.",
        signals: [
          { code: "SOME_NEW_CODE", source: "metadata", severity: "warning", message: "新错误码。" },
        ],
        evidence: [],
        firstFailureStage: null,
        terminalState: "failed",
      }),
    );
    if (state.kind !== "ready") return;
    expect(state.statusText).toBe("有失败迹象，但归不进任何已知类别");
    expect(state.primaryLabel).toBe("未能归类");
  });

  it("十二个类别都有中文展示名，白名单之外的原样显示", () => {
    expect(categoryLabel("SECURITY")).toBe("安全策略阻止");
    expect(categoryLabel("COMMERCIAL")).toBe("商业可读性偏低");
    expect(categoryLabel(null)).toBeNull();
    expect(categoryLabel(undefined)).toBeNull();
    // @ts-expect-error 故意传一个不在白名单里的类别
    expect(categoryLabel("NOT_A_CATEGORY")).toBe("NOT_A_CATEGORY");
  });

  it("严重度 → 展示色：error 红、warning 琥珀、info 灰", () => {
    expect(severityClass("error")).toContain("red");
    expect(severityClass("warning")).toContain("amber");
    expect(severityClass("info")).toContain("muted");
  });
});

describe("失败分析面板的措辞边界", () => {
  it("§33/§69 不出现根因类措辞，也没有任何按钮入口", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "failure-panel.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/根因|真正原因|很可能是因为|Because of/i);
    // 没有交互入口：一个按钮 / 一个 onClick 都没有（repairText 是证据里的修订编号字段名）
    expect(code).not.toMatch(/<button|onClick/i);
    expect(code).not.toMatch(/(fix|retry|regenerate|rerun)/i);
    // §34 成功 Run 的措辞来自 analysis.summary 本身，面板不另造一句「没问题」
    expect(src).toContain("state.analysis.summary");
  });
});
