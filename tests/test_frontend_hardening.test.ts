import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RunApiError,
  apiErrorDetailOf,
  fetchProjectVersion,
  fetchRun,
  planStory,
  repairStory,
  reviewStory,
  validateStory,
} from "@/lib/api";
import { reviewPanelState } from "@/lib/review-view";
import { validationPanelState } from "@/lib/validation-view";
import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";

/**
 * v0.9.0 前端收口契约（§33~§38/§47）：
 * §33 组件不许自己 fetch，全部走 src/lib/api.ts 一个出口；
 * §34 Network / Timeout / Invalid Response / API Error 四种失败统一成 RunApiError；
 * §35 重复提交由 ref 同步挡住（state 挡不住双击）；
 * §36 没有正文就没有 Review / Validate 对象，按钮禁用；
 * §37 review = null / validation = null / repair 缺失都不能白屏；
 * §38 前端不新增未来能力入口。
 */

const config: StoryConfig = validateStoryConfig({
  config_version: STORY_CONFIG_VERSION,
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然失踪。",
  target_words: 5000,
});

const plan: BeatPlan = {
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立失踪事件", event: "证人没有出庭。", characters: ["记者", "证人"] },
    { id: 2, purpose: "推进追查", event: "记者发现伪造的笔录。", characters: ["记者", "检察官"] },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 剥掉注释再扫描：源码里写「不提供 X 入口」的说明文字不算提供了入口。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** §33 的检查范围：组件与页面。服务端代码（如 src/lib/llm.ts 的模型客户端）不在其列。 */
const CLIENT_FILES = listSourceFiles(join("src", "components")).concat(
  listSourceFiles(join("src", "app")),
);

describe("§33 前端 API 访问集中", () => {
  it("组件与页面没有任何一处直接 fetch，请求全走 src/lib/api.ts", () => {
    const offenders = CLIENT_FILES.filter((file) => codeOnly(readFileSync(file, "utf8")).includes("fetch("));
    expect(offenders).toEqual([]);
  });

  it("api.ts 是前端唯一的请求出口：只有一处 await fetch，且每个导出函数都经它发请求", () => {
    const src = readFileSync(join("src", "lib", "api.ts"), "utf8");
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThanOrEqual(9);
    expect(src.match(/await fetch\(/g)?.length ?? 0).toBe(1);
    // 内部请求助手：requestJson 本身，以及包住它的 postRun
    const HELPERS = ["requestJson", "postRun"];
    for (const name of exported) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const next = body.indexOf("\nexport async function");
      const chunk = next === -1 ? body : body.slice(0, next);
      expect(HELPERS.some((h) => chunk.includes(h))).toBe(true);
    }
  });

  it("组件与页面不自己解释错误码，只消费 RunApiError", () => {
    const offenders = CLIENT_FILES.filter((file) => /res\.ok|HTTP \$\{res\.status\}/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("§34 四种失败统一成 RunApiError", () => {
  it("Network Error：fetch 抛异常时给 kind=network 与可读提示", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await fetchRun("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe("network");
    expect((err as RunApiError).message).toContain("读取 Run 失败");
    expect((err as RunApiError).message).toContain("网络错误");
  });

  it("Timeout：AbortError / TimeoutError 给 kind=timeout，不写成网络错误", async () => {
    stubFetch(() => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });
    const err = await fetchRun("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe("timeout");
    expect((err as RunApiError).message).toContain("超时");
  });

  it("Invalid Response：HTTP 200 但响应不是 JSON 时给 kind=invalid_response", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }));
    const err = await fetchProjectVersion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe("invalid_response");
    expect((err as RunApiError).message).toContain("不是合法 JSON");
  });

  it("Invalid Response：版本号缺失也算响应不合法，不返回空串", async () => {
    stubFetch(() => jsonResponse({}));
    const err = await fetchProjectVersion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe("invalid_response");
  });

  it("API Error：取服务端 code/message/run_id/stage，不拼 HTTP 状态码", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "LLM_TIMEOUT",
            message: "模型请求超时，请稍后重试",
            run_id: "run-9",
            stage: "generating",
          },
        },
        false,
        504,
      ),
    );
    const err = await planStory(config, { model: "m" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).message).toBe("模型请求超时，请稍后重试");
    expect((err as RunApiError).runId).toBe("run-9");
    expect((err as RunApiError).stage).toBe("generating");
    expect((err as RunApiError).kind).toBe("api");
  });

  it("API Error：响应体不认识时给一句兜底话，不把堆栈透到前端", async () => {
    stubFetch(() => jsonResponse({ nope: true }, false, 500));
    const detail = apiErrorDetailOf({ nope: true }, "读取 Run 失败（HTTP 500）");
    expect(detail.code).toBe("INTERNAL_ERROR");
    expect(detail.message).toBe("读取 Run 失败（HTTP 500）");

    const err = await fetchRun("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).message).not.toMatch(/at\s+[\w$.<>/\\-]+:\d+:\d+/);
  });

  it("每个出口都带超时信号，UI 不会永远转圈", async () => {
    const fetchMock = stubFetch(() => jsonResponse(plan));
    await planStory(config, {});
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeDefined();
  });

  it("成功时原样返回数据，不吞字段", async () => {
    stubFetch(() => jsonResponse(plan));
    await expect(planStory(config, {})).resolves.toEqual(plan);
  });
});

describe("§36 没有正文就没有 Review / Validate 对象", () => {
  it("Review 面板在没有正文时禁用 Review Again", () => {
    const src = readFileSync(join("src", "app", "page.tsx"), "utf8");
    expect(src).toMatch(/<ReviewPanel[\s\S]{0,400}disabled=\{!baseStory\}/);
    expect(src).toMatch(/<ValidationPanel[\s\S]{0,400}disabled=\{!baseStory\}/);
  });

  it("两个面板的按钮同时受 disabled 与进行中状态保护", () => {
    for (const file of ["review-panel.tsx", "validation-panel.tsx"]) {
      const src = readFileSync(join("src", "components", file), "utf8");
      expect(src).toMatch(/disabled=\{disabled \|\| re\w+\}/);
      expect(src).toMatch(/onClick=\{on(Review|Validate)Again\}/);
    }
  });
});

describe("§35 重复提交保护", () => {
  it("Generate / Plan 已由 ref 同步挡住", () => {
    const src = readFileSync(join("src", "app", "page.tsx"), "utf8");
    expect(src).toContain("if (busyRef.current) return;");
    expect(src).toContain("if (planBusyRef.current) return;");
  });

  it("Review Again / Validate Again / Targeted Repair 也用 ref，不只靠 state", () => {
    const page = readFileSync(join("src", "app", "page.tsx"), "utf8");
    expect(page).toContain("if (reReviewingRef.current || !result) return;");
    expect(page).toContain("if (revalidatingRef.current || !result) return;");

    const repair = readFileSync(join("src", "components", "repair-panel.tsx"), "utf8");
    expect(repair).toContain("if (repairingRef.current) return;");
  });

  it("ManualRepair 在没有正文或没有问题说明时不可提交", () => {
    const src = readFileSync(join("src", "components", "repair-panel.tsx"), "utf8");
    expect(src).toContain("story.trim().length > 0 && issueMessage.trim().length > 0");
  });
});

describe("§37 Null safety：review / validation / repair 缺失都不白屏", () => {
  it("review = null 且没有失败时，Review 区域整体隐藏", () => {
    expect(reviewPanelState({ review: null, reviewStatus: "pending" }).kind).toBe("hidden");
  });

  it("validation = null 且没有失败时，Validation 区域整体隐藏", () => {
    expect(validationPanelState({ validation: null, validationStatus: "pending" }).kind).toBe("hidden");
  });

  it("review = null 但状态是 failed 时给失败态与一句兜底说明，不给 undefined", () => {
    const state = reviewPanelState({ review: null, reviewStatus: "failed" });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("unreachable");
    expect(state.error).toBe("Reviewer 未返回有效评价");
  });

  it("review_error 为空串时也不渲染空错误块", () => {
    const state = reviewPanelState({ review: null, reviewStatus: "failed", reviewError: "   " });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("unreachable");
    expect(state.error.trim().length).toBeGreaterThan(0);
  });

  it("validation = null 但状态是 failed 时给失败态与一句兜底说明", () => {
    const state = validationPanelState({ validation: null, validationStatus: "failed" });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("unreachable");
    expect(state.error).toBe("Validator 未返回有效校验结果");
  });

  it("进行中状态优先于任何陈旧结论", () => {
    expect(reviewPanelState({ review: null, reviewStatus: "failed", reReviewing: true }).kind).toBe("loading");
    expect(validationPanelState({ validation: null, validationStatus: "failed", revalidating: true }).kind).toBe("loading");
  });

  it("分数缺失时显示 —，不显示 NaN / undefined", () => {
    const state = reviewPanelState({
      review: { score: Number.NaN, summary: "s", strengths: [], problems: [] },
      reviewStatus: "completed",
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.scoreText).toBe("—");
  });
});

describe("§38 前端不新增未来能力", () => {
  /**
   * v1.7.0 起「Experiment」不再是保留能力：受控实验框架已经交付（实验列表页 / 详情页 /
   * /api/experiments 一组路由），所以这个词连同因果维度的 meanCausality 都不再算越界。
   * 仍然保留的是这个版本明确不做的事：跑分平台、仪表盘、失败归因、因果图、自适应生成。
   * 「因果图」与 v1.3.0 就有的「因果」维度是两件事，所以这里按 CausalGraph / 因果图 精确匹配。
   */
  const FORBIDDEN = ["Benchmark", "Dashboard", "Failure Analysis", "CausalGraph", "Adaptive"];
  const FORBIDDEN_PHRASES = ["因果图"];

  it("组件 / 页面 / api 客户端里没有未来能力入口", () => {
    const files = listSourceFiles(join("src", "components")).concat(
      listSourceFiles(join("src", "app")),
      join("src", "lib", "api.ts"),
    );
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const word of FORBIDDEN) {
        if (new RegExp(word, "i").test(src)) hits.push(`${file}:${word}`);
      }
      for (const phrase of FORBIDDEN_PHRASES) {
        if (src.includes(phrase)) hits.push(`${file}:${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("Review 面板不提供 Fix / Repair / Rewrite 入口", () => {
    const src = codeOnly(readFileSync(join("src", "components", "review-panel.tsx"), "utf8"));
    expect(src).not.toMatch(/Fix|Repair|Rewrite/i);
  });

  it("Validation 失败时不提供 Auto Retry / Fix Automatically", () => {
    const src = codeOnly(readFileSync(join("src", "components", "validation-panel.tsx"), "utf8"));
    expect(src).not.toMatch(/Auto Retry|Fix Automatically/i);
  });
});

describe("§47 手动入口仍然只做一件事", () => {
  it("Review Again 只发 /api/review，不带 retry_policy", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ score: 70, summary: "s", strengths: [], problems: [] }));
    await reviewStory(config, "正文", {}, "run-1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/review");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ config, story: "正文", run_id: "run-1" });
    expect(body.retry_policy).toBeUndefined();
  });

  it("Validate Again 只发 /api/validate，不触发生成", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ passed: true, issues: [] }));
    await validateStory(config, "正文", "run-1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/validate");
  });

  it("Targeted Repair 只发 /api/repair，且带上 issue_type / issue_message", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ repaired_story: "新正文", issue_type: "ending", success: true, notes: null }),
    );
    await repairStory(config, plan, "正文", "ending", "故事缺少明确结局");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/repair");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      config,
      beat_plan: plan,
      story: "正文",
      issue_type: "ending",
      issue_message: "故事缺少明确结局",
    });
  });
});
