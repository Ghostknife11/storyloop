"use client";

import { useMemo, useState } from "react";
import type { BeatValidationResult } from "@/domain/beat-validation";
import type { CommercialReviewResult } from "@/domain/commercial-review";
import type { ReviewResult } from "@/domain/review-result";
import type { QualityStackView } from "@/domain/quality-stack";
import {
  QUALITY_CENTER_FILTERS_ALL,
  qualityCenterState,
  severityTone,
  type QualityCenterDiagnosticRow,
  type QualityCenterFilters,
  type QualityCenterSection,
  type QualityCenterScoreRow,
} from "@/interface/quality-center-view";

/**
 * v2.1.0 TASK §33/§34/§35 Quality Center：把质量相关展示收成一个统一区域。
 *
 * 三个分区（§33）：
 *   Overview        —— Planning / Story Quality / Commercial 三行各自的状态
 *   Diagnostics     —— Errors / Warnings / Info 三栏，可按 source / severity /
 *                      target / category 筛选（§34）
 *   Detailed Scores —— Co / N / C / Ca 与 H / P / E / Pf
 *
 * §35 三条边界在这里落地：
 *   - Planning 行只有 passed / 诊断条数，没有分数（骨架层没有分数可报）；
 *   - 全篇没有 confidence / 概率一类的数字；
 *   - 诊断原样呈现，不加工、不排序成「严重程度排行榜」。
 *
 * §37：没有 quality-stack.json（v2.0.0 及更早的 Run）时整个区域不出现——
 * 不占位、不白屏，也不编一份「0 条诊断」冒充跑过。所有判断都在
 * quality-center-view.ts 里算完，本组件只负责渲染。
 */
export interface QualityCenterProps {
  qualityStack: QualityStackView | null;
  review: ReviewResult | null;
  commercialReview: CommercialReviewResult | null;
  beatValidation: BeatValidationResult | null;
}

const SECTION_TABS: Array<{ key: QualityCenterSection; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "diagnostics", label: "Diagnostics" },
  { key: "scores", label: "Detailed Scores" },
];

const TONE_DOT = {
  ok: "bg-emerald-500",
  bad: "bg-red-500",
  partial: "bg-amber-500",
  unknown: "bg-muted-foreground",
} as const;

const SEVERITY_BADGE = {
  error: "text-red-500 border-red-500/30 bg-red-500/10",
  warning: "text-amber-500 border-amber-500/30 bg-amber-500/10",
  info: "text-sky-500 border-sky-500/30 bg-sky-500/10",
} as const;

export function QualityCenter({
  qualityStack,
  review,
  commercialReview,
  beatValidation,
}: QualityCenterProps) {
  const [section, setSection] = useState<QualityCenterSection>("overview");
  const [filters, setFilters] = useState<QualityCenterFilters>(QUALITY_CENTER_FILTERS_ALL);

  const state = useMemo(
    () => qualityCenterState({ stack: qualityStack, review, commercialReview, beatValidation, filters }),
    [qualityStack, review, commercialReview, beatValidation, filters],
  );

  if (state.kind === "hidden") return null;

  const filteredCount = state.filtered.length;

  return (
    <div className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2.5 flex-wrap">
        <span className="h-2 w-2 rounded-full bg-violet-500" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Quality Center</h3>
        <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          {state.status}
        </span>
        <span className="text-[11px] text-muted-foreground">{state.statusText}</span>
      </div>

      <div className="flex items-center gap-1 mb-3 border-b border-border">
        {SECTION_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSection(tab.key)}
            aria-pressed={section === tab.key}
            className={`px-2.5 py-1.5 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
              section === tab.key
                ? "border-violet-500 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {section === "overview" && (
        <div className="space-y-2">
          {state.overview.map((row) => (
            <div
              key={row.key}
              className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[row.tone]}`} />
              <span className="text-[12px] font-medium text-foreground w-[104px] shrink-0">
                {row.label}
              </span>
              <span className="text-[12px] text-foreground w-[72px] shrink-0">{row.statusText}</span>
              {/* §35：scoreText 为 null 时这一段整个不出现——骨架层没有分数，不编一个 */}
              {row.scoreText !== null && (
                <span className="text-[13px] font-semibold tabular-nums text-primary shrink-0">
                  {row.scoreText}
                  <span className="text-[10px] font-normal text-muted-foreground"> / 100</span>
                </span>
              )}
              <span className="text-[11px] text-muted-foreground ml-auto text-right">
                {row.detailText}
              </span>
            </div>
          ))}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-[12px] pt-1">
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Diagnostics</dt>
              <dd className="text-foreground tabular-nums">{state.summary.totalDiagnostics}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Errors</dt>
              <dd className="text-foreground tabular-nums">{state.summary.errors}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Warnings</dt>
              <dd className="text-foreground tabular-nums">{state.summary.warnings}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Info</dt>
              <dd className="text-foreground tabular-nums">{state.summary.info}</dd>
            </div>
          </dl>
        </div>
      )}

      {section === "diagnostics" && (
        <div className="space-y-3">
          {/* §34：四个筛选维度。可选项只列这次真的出现过的值。 */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="source"
              value={filters.source}
              options={state.filterOptions.sources.map((s) => ({ value: s, label: s }))}
              onChange={(value) => setFilters({ ...filters, source: value as QualityCenterFilters["source"] })}
            />
            <FilterSelect
              label="severity"
              value={filters.severity}
              options={state.filterOptions.severities.map((s) => ({ value: s, label: s }))}
              onChange={(value) => setFilters({ ...filters, severity: value as QualityCenterFilters["severity"] })}
            />
            <FilterSelect
              label="target"
              value={filters.target}
              options={state.filterOptions.targets.map((t) => ({ value: t, label: t }))}
              onChange={(value) => setFilters({ ...filters, target: value })}
            />
            <FilterSelect
              label="category"
              value={filters.category}
              options={state.filterOptions.categories.map((c) => ({ value: c, label: c }))}
              onChange={(value) => setFilters({ ...filters, category: value })}
            />
            <span className="text-[11px] font-mono text-muted-foreground ml-auto">
              {filteredCount} / {state.all.length}
            </span>
            {(filters.source !== "all" ||
              filters.severity !== "all" ||
              filters.target !== "all" ||
              filters.category !== "all") && (
              <button
                type="button"
                onClick={() => setFilters(QUALITY_CENTER_FILTERS_ALL)}
                className="text-[11px] text-violet-600 dark:text-violet-300 hover:underline"
              >
                清除筛选
              </button>
            )}
          </div>

          <DiagnosticColumn title="Errors" rows={state.errors} filtered={state.filtered} />
          <DiagnosticColumn title="Warnings" rows={state.warnings} filtered={state.filtered} />
          <DiagnosticColumn title="Info" rows={state.info} filtered={state.filtered} />

          {filteredCount === 0 && (
            <div className="text-[11px] text-muted-foreground">
              {state.all.length === 0
                ? "这一轮没有诊断。"
                : "当前筛选条件下没有诊断——换个条件，或点「清除筛选」。"}
            </div>
          )}
        </div>
      )}

      {section === "scores" && (
        <div className="space-y-4">
          <ScoreBlock title="Story Quality" rows={state.qualityScores} note="Co / N / C / Ca" />
          <ScoreBlock title="Commercial" rows={state.commercialScores} note="H / P / E / Pf" />
          {state.qualityScores.length === 0 && state.commercialScores.length === 0 && (
            <div className="text-[11px] text-muted-foreground">
              这次 Run 没有维度评分可显示（更早的产物不带维度）。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-full border border-border bg-background px-2 text-[11px] text-foreground"
      >
        <option value="all">all</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * §33 的一栏。筛选生效时不在结果里的行整条不渲染——
 * 不是置灰、不是打叉，那样读者会以为「有一条被隐藏的问题」。
 */
function DiagnosticColumn({
  title,
  rows,
  filtered,
}: {
  title: string;
  rows: QualityCenterDiagnosticRow[];
  filtered: QualityCenterDiagnosticRow[];
}) {
  const visible = rows.filter((row) => filtered.some((f) => f.id === row.id));
  if (visible.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1.5">
        {title} · {visible.length}
      </div>
      <ul className="space-y-1.5">
        {visible.map((row) => (
          <li key={row.id} className="rounded-xl border border-border bg-muted/40 px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`h-1.5 w-1.5 rounded-full ${severityTone(row.severity)}`} />
              <span
                className={`text-[10px] font-mono uppercase tracking-wider rounded-full border px-1.5 py-px ${
                  SEVERITY_BADGE[row.severity]
                }`}
              >
                {row.severity}
              </span>
              <span className="text-[10px] font-mono text-violet-600 dark:text-violet-300">
                {row.sourceLabel}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground">{row.category}</span>
              <span className="text-[10px] font-mono text-muted-foreground">→ {row.target}</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">{row.id}</span>
            </div>
            <div className="text-[12px] leading-5 text-foreground">{row.message}</div>
            {row.suggestion && (
              <div className="text-[11px] leading-5 text-muted-foreground">
                建议：{row.suggestion}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScoreBlock({
  title,
  rows,
  note,
}: {
  title: string;
  rows: QualityCenterScoreRow[];
  note: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1.5">
        {title} · {note}
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.key} className="rounded-xl border border-border bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-mono font-semibold text-violet-600 dark:text-violet-300 w-8">
                {row.short}
              </span>
              <span className="text-[12px] text-foreground">{row.label}</span>
              <span className="text-[12px] font-semibold tabular-nums text-primary ml-auto">
                {row.scoreText}
              </span>
            </div>
            <div className="h-1 w-full rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-violet-500" style={{ width: `${row.percent}%` }} />
            </div>
            <div className="text-[11px] leading-5 text-muted-foreground mt-1">{row.summary}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
