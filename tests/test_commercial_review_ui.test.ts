import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommercialPanel } from "@/components/commercial-panel";
import { commercialPanelState } from "@/lib/commercial-view";
import type { CommercialReviewResult } from "@/types/commercial-review";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.5.0 TASK §27 Commercial Review UI 契约。
 *
 * 面板必须显示：Commercial Score、四个维度（H / P / E / Pf）、Strengths、Problems、
 * Suggestions。§29 绝不出现爆款概率 / 必火 / 市场成功率 / 签约概率 / 销量预测一类
 * 市场化预言，也不提供 Fix / Retry / 重写入口（§15：商业分不驱动任何自动动作）。
 * 渲染走 renderToStaticMarkup，不需要浏览器。
 */

const READY: CommercialReviewResult = {
  score: 71.5,
  summary: "开篇三句内进入冲突，中段略拖，结尾收得住。",
  strengths: ["第一段就抛出失踪悬念"],
  problems: ["中段推理过程重复"],
  suggestions: ["把中段两次排查合并成一次带新信息的排查"],
  dimensions: {
    hook: { score: 82, summary: "开场即冲突，读完想往下看。" },
    pacing: { score: 68, summary: "中段排查过程拖了两轮。" },
    engagement: { score: 74, summary: "主角动机明确，动力持续住了。" },
    payoff: { score: 62, summary: "结局收得干脆但回报略赶。" },
  },
};

/** §29/§48/§49：任何版本树里都不许出现的市场化预言措辞。 */
const MARKET_WORDS = ["爆款概率", "必火", "市场成功率", "签约概率", "销量预测", "hit probability", "market potential"];

describe("§27 Commercial Review 面板渲染", () => {
  it("Commercial Score / 总结 / 四个维度 / 三组清单全部渲染", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: READY,
      commercialReviewStatus: "completed",
      onReviewAgain: () => {},
    }));
    expect(html).toContain("Commercial Review");
    expect(html).toContain("Commercial Score");
    expect(html).toContain("71.5");
    expect(html).toContain("/ 100");
    expect(html).toContain("开篇三句内进入冲突，中段略拖，结尾收得住。");
    // 四个维度按固定顺序 H / P / E / Pf，名字、记号、分数、短评都在
    for (const [label, summary] of [
      ["Hook", "开场即冲突，读完想往下看。"],
      ["Pacing", "中段排查过程拖了两轮。"],
      ["Engagement", "主角动机明确，动力持续住了。"],
      ["Payoff", "结局收得干脆但回报略赶。"],
    ] as const) {
      expect(html).toContain(label);
      expect(html).toContain(summary);
    }
    for (const score of ["82", "68", "74", "62"]) {
      expect(html).toContain(score);
    }
    expect(html).toContain("Dimensions");
    expect(html).toContain("Strengths");
    expect(html).toContain("第一段就抛出失踪悬念");
    expect(html).toContain("Problems");
    expect(html).toContain("中段推理过程重复");
    expect(html).toContain("Suggestions");
    expect(html).toContain("把中段两次排查合并成一次带新信息的排查");
  });

  it("维度顺序固定：Hook → Pacing → Engagement → Payoff", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: READY,
      commercialReviewStatus: "completed",
    }));
    const order = ["Hook", "Pacing", "Engagement", "Payoff"].map((label) => html.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("只有一个动作：Commercial Review Again，没有 Fix / Retry / 重写入口", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: READY,
      commercialReviewStatus: "completed",
      onReviewAgain: () => {},
    }));
    expect(html).toContain("Commercial Review Again");
    for (const forbidden of ["Fix", "Retry", "重写", "修订", "重试", "Regenerate", "重新生成"]) {
      expect(html, `面板不应提供 ${forbidden} 入口`).not.toContain(forbidden);
    }
  });

  it("面板文本里没有任何市场化预言", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: READY,
      commercialReviewStatus: "completed",
      onReviewAgain: () => {},
    }));
    for (const word of MARKET_WORDS) {
      expect(html, `面板不应出现 ${word}`).not.toContain(word);
    }
  });

  it("没有优点 / 没有问题时给占位文案，不渲染空列表", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: { ...READY, strengths: [], problems: [], suggestions: [] },
      commercialReviewStatus: "completed",
    }));
    expect(html.match(/（未提供）/g)?.length).toBe(2);
    expect(html).not.toContain("Suggestions");
    expect(html).not.toContain("第一段就抛出失踪悬念");
  });
});

describe("§32 旧 Run 没有商业结论：整个区域不出现", () => {
  it("commercialReview 为 null 且 status 不是 failed → hidden，不占位、不渲染 0 分", () => {
    expect(commercialPanelState({ commercialReview: null, commercialReviewStatus: "not_started" })).toEqual({
      kind: "hidden",
    });
    expect(
      renderToStaticMarkup(createElement(CommercialPanel, {
        commercialReview: null,
        commercialReviewStatus: "not_started",
      })),
    ).toBe("");
  });

  it('status 是 "reviewing" 但没有结论时也不出现：不编一份评价', () => {
    expect(commercialPanelState({ commercialReview: null, commercialReviewStatus: "reviewing" })).toEqual({
      kind: "hidden",
    });
  });
});

describe("§24/§25 商业审阅自身失败：只坏这一块", () => {
  it("显示失败文案与原因，并说明其它结论已保留", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: null,
      commercialReviewStatus: "failed",
      commercialReviewError: "commercial review failed：HTTP 500",
      onReviewAgain: () => {},
    }));
    expect(html).toContain("Commercial review failed.");
    expect(html).toContain("commercial review failed：HTTP 500");
    expect(html).toContain("正文、校验与质量结论已保留");
    expect(html).toContain("Commercial Review Again");
    // 没有伪造一个 0 分
    expect(html).not.toContain("Commercial Score");
  });

  it("失败但没带原因时给兜底文案，不出现 undefined", () => {
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: null,
      commercialReviewStatus: "failed",
    }));
    expect(html).toContain("商业审阅未返回有效评价");
    expect(html).not.toContain("undefined");
  });

  it("正在重新商业审阅时转 loading，正文一个字都不动", () => {
    const state = commercialPanelState({
      commercialReview: READY,
      commercialReviewStatus: "completed",
      reReviewing: true,
    });
    expect(state.kind).toBe("loading");
    const html = renderToStaticMarkup(createElement(CommercialPanel, {
      commercialReview: READY,
      commercialReviewStatus: "completed",
      reReviewing: true,
    }));
    expect(html).toContain("Reviewing...");
    expect(html).not.toContain("71.5");
  });
});

describe("§27/§31 面板状态推导只做展示换算", () => {
  it("整体分与四个维度同源：面板显示的均分就是 (82+68+74+62)/4", () => {
    const state = commercialPanelState({ commercialReview: READY, commercialReviewStatus: "completed" });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.scoreText).toBe("71.5");
    expect(state.dimensions.map((d) => d.short)).toEqual(["H", "P", "E", "Pf"]);
    expect(state.dimensions.map((d) => d.percent)).toEqual([82, 68, 74, 62]);
  });

  it("维度分越界时进度条被夹在 0 ~ 100，不撑破布局", () => {
    const state = commercialPanelState({
      commercialReview: REVIEW_WITH_WEIRD_SCORES,
      commercialReviewStatus: "completed",
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    for (const d of state.dimensions) {
      expect(d.percent).toBeGreaterThanOrEqual(0);
      expect(d.percent).toBeLessThanOrEqual(100);
    }
  });
});

const REVIEW_WITH_WEIRD_SCORES: CommercialReviewResult = {
  ...READY,
  dimensions: {
    hook: { score: 0, summary: "最低" },
    pacing: { score: 100, summary: "最高" },
    engagement: { score: 1000, summary: "离谱" },
    payoff: { score: -50, summary: "负分" },
  },
};

describe("§27 page.tsx 接线", () => {
  const page = readFileSync(join(repoRoot(), "src", "app", "page.tsx"), "utf8");

  it("CommercialPanel 紧跟 ReviewPanel 挂载，两个审阅结论并列展示", () => {
    expect(page).toContain("import { CommercialPanel } from \"@/components/commercial-panel\";");
    expect(page.indexOf("<ReviewPanel")).toBeGreaterThan(-1);
    expect(page.indexOf("<CommercialPanel")).toBeGreaterThan(page.indexOf("<ReviewPanel"));
  });

  it("Commercial Review Again 送当前正文，只在展示的就是 Run 落盘那版时带 run_id", () => {
    expect(page).toMatch(/reviewStoryCommercial\(\s*formToConfig\(form\),\s*baseStory,/);
    expect(page).toMatch(/shownStoryIsRunStory \? result\.run_id : undefined/);
    // 不重新生成正文、不动结构审阅产物
    const body = page.slice(
      page.indexOf("async function handleCommercialReviewAgain"),
      page.indexOf("async function handleValidateAgain"),
    );
    expect(body).not.toContain("generateStory");
    expect(body).not.toContain("/api/generate");
    expect(body).toContain("setCommercialReviewOverride(review)");
  });

  it("切换 Attempt / 重新生成时商业结论跟着重置，不残留上一版的分数", () => {
    expect(page).toContain("const [commercialReviewOverride, setCommercialReviewOverride] = useState<CommercialReviewResult | null>(null);");
    expect(page.match(/setCommercialReviewOverride\(null\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("看别的 Attempt 时显示那次尝试自己的商业结论", () => {
    expect(page).toContain("commercial_review: detail.commercial_review,");
    expect(page).toContain("const shownCommercialReview = viewAttempt");
  });

  it("重新生成时把「正在重新商业审阅」的开关关掉，不然面板会卡在 loading", () => {
    expect(page).toContain("const reCommercialReviewingRef = useRef(false);");
    expect(page).toContain("if (reCommercialReviewingRef.current || !result) return;");
    expect(page).toContain("reCommercialReviewingRef.current = false;");
  });
});
