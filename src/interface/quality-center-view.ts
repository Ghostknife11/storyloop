/**
 * v2.1.0 TASK §33/§34/§35 Quality Center 的唯一状态推导。
 *
 * 与 quality-view / commercial-view / failure-view 同一套写法：组件只管渲染，
 * 「怎么显示、筛出哪些」全在这里算完。这里是纯函数，没有 React、没有副作用，
 * 于是 §33 的结构、§34 的筛选、§35 的边界都能在不启动浏览器的情况下对拍。
 *
 * §35 三条边界，本文件一条都不破：
 *   1. Beat Planning 只有 passed / diagnostics 计数——不编「Beat Score 83」这种
 *      骨架层根本没有的分数；
 *   2. 全篇没有任何 confidence / 概率 / 置信度字段，一个都不造；
 *   3. 诊断只原样呈现（含审阅给的 suggestion），不加工、不改写、不排序成「严重程度排行榜」。
 *
 * §27/§32 数据来源：三套结论的分数走既有的 review / commercial_review（v1 DTO，
 * ReviewPanel / CommercialPanel 已经在显示同一份），qualityStack 只提供
 * status / diagnostics / summary。于是这里没有第二处事实来源。
 */

import type { BeatValidationResult } from "@/domain/beat-validation";
import type { CommercialReviewResult } from "@/domain/commercial-review";
import {
  COMMERCIAL_DIMENSION_KEYS,
  COMMERCIAL_DIMENSION_LABELS,
  COMMERCIAL_DIMENSION_SHORTS,
} from "@/domain/commercial-review";
import {
  DIMENSION_LABELS,
  QUALITY_DIMENSION_KEYS,
  type QualityDimensionKey,
} from "@/domain/quality-dimensions";
import type { QualityDiagnostic, QualityDiagnosticSource } from "@/domain/quality-diagnostic";
import { QUALITY_DIAGNOSTIC_SOURCES } from "@/domain/quality-diagnostic";
import type { ReviewResult } from "@/domain/review-result";
import type { QualityStackStatus, QualityStackSummary, QualityStackView } from "@/domain/quality-stack";

/** §33 三个分区：Overview / Diagnostics / Detailed Scores。 */
export const QUALITY_CENTER_SECTIONS = ["overview", "diagnostics", "scores"] as const;
export type QualityCenterSection = (typeof QUALITY_CENTER_SECTIONS)[number];

/** §34 筛选维度。四类都支持「全部」，默认就是全部。 */
export interface QualityCenterFilters {
  source: QualityDiagnosticSource | "all";
  severity: "error" | "warning" | "info" | "all";
  target: string;
  category: string;
}

export const QUALITY_CENTER_FILTERS_ALL: QualityCenterFilters = {
  source: "all",
  severity: "all",
  target: "all",
  category: "all",
};

/** §33 Overview 的三行：Planning / Story Quality / Commercial。 */
export type QualityCenterOverviewKey = "planning" | "story" | "commercial";

export interface QualityCenterOverviewRow {
  key: QualityCenterOverviewKey;
  label: string;
  /** 这一路的结论状态：通过 / 未通过 / 缺结论。 */
  statusText: string;
  tone: "ok" | "bad" | "partial" | "unknown";
  /** §35：Beat Planning 一律是 null——骨架层没有分数，不编一个。 */
  scoreText: string | null;
  /** 一句话补充：诊断条数、维度数，或「这一路没有结论」。 */
  detailText: string;
}

/** §33 Diagnostics 的一行。字段与盘上那条 QualityDiagnostic 一一对应。 */
export interface QualityCenterDiagnosticRow {
  id: string;
  source: QualityDiagnosticSource;
  sourceLabel: string;
  severity: QualityDiagnostic["severity"];
  target: QualityDiagnostic["target"];
  category: string;
  message: string;
  suggestion: string | null;
}

/** §33 Detailed Scores 的一行：短标记 + 维度名 + 分数 + 进度条 + 短评。 */
export interface QualityCenterScoreRow {
  key: string;
  short: string;
  label: string;
  scoreText: string;
  /** 0 ~ 100，直接用作进度条宽度。 */
  percent: number;
  summary: string;
}

/** §34 每个筛选维度的可选项：只列这次真的出现过的值，不列空选项。 */
export interface QualityCenterFilterOptions {
  sources: QualityDiagnosticSource[];
  targets: string[];
  categories: string[];
  severities: Array<"error" | "warning" | "info">;
}

export type QualityCenterState =
  | { kind: "hidden" }
  | {
      kind: "ready";
      /** quality-stack.json 的 status 原值（complete / partial / failed）。 */
      status: QualityStackStatus;
      statusText: string;
      overview: QualityCenterOverviewRow[];
      /** 按 severity 分组：§33 的 Errors / Warnings / Info 三栏。 */
      errors: QualityCenterDiagnosticRow[];
      warnings: QualityCenterDiagnosticRow[];
      info: QualityCenterDiagnosticRow[];
      /** 全部诊断（未筛选）与按 §34 筛选后的结果。 */
      all: QualityCenterDiagnosticRow[];
      filtered: QualityCenterDiagnosticRow[];
      filterOptions: QualityCenterFilterOptions;
      /** §33 Detailed Scores：Co / N / C / Ca 与 H / P / E / Pf。 */
      qualityScores: QualityCenterScoreRow[];
      commercialScores: QualityCenterScoreRow[];
      summary: QualityStackSummary;
    };

/** §6 severity 的展示口径：三栏各自的小圆点颜色。 */
const SEVERITY_TONE = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
} as const;

export function severityTone(severity: QualityDiagnostic["severity"]): string {
  return SEVERITY_TONE[severity];
}

/** §4 诊断来源的中文名：三套组件各一个，UI 与文档共用。 */
const SOURCE_LABELS: Record<QualityDiagnosticSource, string> = {
  "beat-validator": "骨架校验",
  "quality-reviewer": "故事质量",
  "commercial-reviewer": "商业可读性",
};

/** §33 Detailed Scores 的短标记：Co / N / C / Ca（商业侧用现成的 H / P / E / Pf）。 */
const QUALITY_DIMENSION_SHORTS: Record<QualityDimensionKey, string> = {
  coherence: "Co",
  narrative: "N",
  character: "C",
  causality: "Ca",
};

const SEVERITY_ORDER = ["error", "warning", "info"] as const;

const STATUS_TEXTS: Record<QualityStackStatus, string> = {
  complete: "三套结论齐全",
  partial: "部分结论缺失",
  failed: "没有质量结论",
};

function scoreTextOf(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function percentOf(score: number): number {
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
}

/** §35：分数文本一律来自 review 的维度；没有维度（旧 Run）时整段不出现，不补 0。 */
function qualityScoreRowsOf(review: ReviewResult | null): QualityCenterScoreRow[] {
  const dimensions = review?.dimensions;
  if (!dimensions) return [];
  return QUALITY_DIMENSION_KEYS.map((key) => {
    const d = dimensions[key];
    return {
      key,
      short: QUALITY_DIMENSION_SHORTS[key],
      label: DIMENSION_LABELS[key],
      scoreText: scoreTextOf(d.score),
      percent: percentOf(d.score),
      summary: d.summary,
    };
  });
}

function commercialScoreRowsOf(review: CommercialReviewResult | null): QualityCenterScoreRow[] {
  const dimensions = review?.dimensions;
  if (!dimensions) return [];
  return COMMERCIAL_DIMENSION_KEYS.map((key) => {
    const d = dimensions[key];
    return {
      key,
      short: COMMERCIAL_DIMENSION_SHORTS[key],
      label: COMMERCIAL_DIMENSION_LABELS[key],
      scoreText: scoreTextOf(d.score),
      percent: percentOf(d.score),
      summary: d.summary,
    };
  });
}

/**
 * §33 Overview 的 Planning 行：passed / diagnostics，没有分数。
 * §7：校验没跑过与校验没过是两件事，文案必须能区分。
 */
function planningRowOf(
  beatValidation: BeatValidationResult | null,
  beatDiagnostics: QualityCenterDiagnosticRow[],
): QualityCenterOverviewRow {
  if (beatValidation === null) {
    return {
      key: "planning",
      label: "Planning",
      statusText: "未运行",
      tone: "unknown",
      scoreText: null,
      detailText: "这次 Run 没有骨架校验结论。",
    };
  }
  const passed = beatValidation.passed === true;
  return {
    key: "planning",
    label: "Planning",
    statusText: passed ? "通过" : "未通过",
    tone: passed ? "ok" : "bad",
    scoreText: null,
    detailText: `${beatDiagnostics.length} 条诊断`,
  };
}

function storyRowOf(
  review: ReviewResult | null,
  reviewDiagnostics: QualityCenterDiagnosticRow[],
): QualityCenterOverviewRow {
  if (review === null) {
    return {
      key: "story",
      label: "Story Quality",
      statusText: "无结论",
      tone: "partial",
      scoreText: null,
      detailText: "这一路没有结论（质量视图为 partial 的原因可能就在这里）。",
    };
  }
  return {
    key: "story",
    label: "Story Quality",
    statusText: review.score === null ? "无分数" : "已评分",
    tone: "ok",
    scoreText: scoreTextOf(review.score),
    detailText: `${reviewDiagnostics.length} 条诊断`,
  };
}

function commercialRowOf(
  review: CommercialReviewResult | null,
  commercialDiagnostics: QualityCenterDiagnosticRow[],
): QualityCenterOverviewRow {
  if (review === null) {
    return {
      key: "commercial",
      label: "Commercial",
      statusText: "无结论",
      tone: "partial",
      scoreText: null,
      detailText: "这一路没有结论（质量视图为 partial 的原因可能就在这里）。",
    };
  }
  return {
    key: "commercial",
    label: "Commercial",
    statusText: "已评分",
    tone: "ok",
    scoreText: scoreTextOf(review.score),
    detailText: `${commercialDiagnostics.length} 条诊断`,
  };
}

function diagnosticRowOf(d: QualityDiagnostic): QualityCenterDiagnosticRow {
  return {
    id: d.id,
    source: d.source,
    sourceLabel: SOURCE_LABELS[d.source],
    severity: d.severity,
    target: d.target,
    category: d.category,
    message: d.message,
    suggestion: d.suggestion ?? null,
  };
}

/** §34：四类筛选条件同时生效（AND），「全部」等于不筛。 */
export function filterDiagnostics(
  rows: readonly QualityCenterDiagnosticRow[],
  filters: QualityCenterFilters,
): QualityCenterDiagnosticRow[] {
  return rows.filter((row) => {
    if (filters.source !== "all" && row.source !== filters.source) return false;
    if (filters.severity !== "all" && row.severity !== filters.severity) return false;
    if (filters.target !== "all" && row.target !== filters.target) return false;
    if (filters.category !== "all" && row.category !== filters.category) return false;
    return true;
  });
}

/**
 * §34 可选项：只列这一次真的出现过的值。
 * 选项按固定的稳定顺序排（来源按 §4 的顺序、severity 按 error → warning → info、
 * target / category 按忽略大小写的字母序），不按诊断出现顺序——否则同一次 Run 里选项顺序会飘。
 */
function filterOptionsOf(rows: readonly QualityCenterDiagnosticRow[]): QualityCenterFilterOptions {
  const sources = QUALITY_DIAGNOSTIC_SOURCES.filter((s) => rows.some((r) => r.source === s));
  const severities = SEVERITY_ORDER.filter((s) => rows.some((r) => r.severity === s));
  const targets = [...new Set(rows.map((r) => r.target))].sort((a, b) => a.localeCompare(b));
  const categories = [...new Set(rows.map((r) => r.category))].sort((a, b) => a.localeCompare(b));
  return { sources, targets, categories, severities };
}

/**
 * §33/§34 Quality Center 的全部显示状态。
 *
 * §37：没有 quality-stack.json（v2.0.0 及更早的 Run）时 kind 是 hidden——
 * 整个区域不出现，不占位、不白屏，也不编一份「0 条诊断」冒充跑过。
 */
export function qualityCenterState(input: {
  stack: QualityStackView | null;
  review: ReviewResult | null;
  commercialReview: CommercialReviewResult | null;
  beatValidation: BeatValidationResult | null;
  filters?: QualityCenterFilters;
}): QualityCenterState {
  const stack = input.stack;
  if (stack === null) return { kind: "hidden" };

  const all = stack.diagnostics.map(diagnosticRowOf);
  const bySeverity = (severity: QualityDiagnostic["severity"]) =>
    all.filter((row) => row.severity === severity);

  const beatDiagnostics = all.filter((row) => row.source === "beat-validator");
  const reviewDiagnostics = all.filter((row) => row.source === "quality-reviewer");
  const commercialDiagnostics = all.filter((row) => row.source === "commercial-reviewer");

  return {
    kind: "ready",
    status: stack.status,
    statusText: STATUS_TEXTS[stack.status],
    overview: [
      planningRowOf(input.beatValidation, beatDiagnostics),
      storyRowOf(input.review, reviewDiagnostics),
      commercialRowOf(input.commercialReview, commercialDiagnostics),
    ],
    errors: bySeverity("error"),
    warnings: bySeverity("warning"),
    info: bySeverity("info"),
    all,
    filtered: filterDiagnostics(all, input.filters ?? QUALITY_CENTER_FILTERS_ALL),
    filterOptions: filterOptionsOf(all),
    qualityScores: qualityScoreRowsOf(input.review),
    commercialScores: commercialScoreRowsOf(input.commercialReview),
    summary: stack.summary,
  };
}
