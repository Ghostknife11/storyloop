"use client";

import type { QualityResult } from "@/types/quality";
import { qualityPanelState } from "@/lib/quality-view";

/**
 * v1.2.0 §31/§32/§33 Quality Summary 面板：总览。
 * 顺序是 Quality（总览）→ Validation（详情）→ Review（详情），所以本面板只做汇总，
 * 不重复 Validation / Review 的条目，也不提供Fix / Retry / 重写一类入口（§32/§65）。
 * v1.3.0 §36：多出「维度评分」一小节——四个基础维度 + 各自的短评，都是审阅输出，
 * 仍然没有等级、没有趋势、没有雷达图，某个维度低也不会多出什么按钮。
 */
export interface QualityPanelProps {
  quality: QualityResult | null;
}

/** 校验结论三种状态各自的小圆点颜色。 */
const VALIDATION_TONE = {
  ok: "bg-emerald-500",
  bad: "bg-red-500",
  unknown: "bg-zinc-500",
} as const;

export function QualityPanel({ quality }: QualityPanelProps) {
  const state = qualityPanelState({ quality });
  // §37：没有质量快照（更早的 Run / 尚未装配）时整个区域不出现，不占位、不白屏
  if (state.kind === "hidden") return null;

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="h-2 w-2 rounded-full bg-violet-500" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Quality</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          Summary
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-1.5">
          {/* §33：只有一个整体分，没有维度、没有等级 */}
          <span className="text-3xl font-bold tracking-tight text-violet-300 tabular-nums">
            {state.overallScoreText}
          </span>
          <span className="text-sm text-muted-foreground font-mono">/ 100</span>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-[12px]">
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Validation</dt>
            <dd className="flex items-center gap-1.5 text-zinc-300">
              <span className={`h-1.5 w-1.5 rounded-full ${VALIDATION_TONE[state.validationTone]}`} />
              {state.validationText}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-zinc-300">{state.acceptedText}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Issues</dt>
            <dd className="text-zinc-300 tabular-nums">{state.issues.length}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Suggestions</dt>
            <dd className="text-zinc-300 tabular-nums">{state.suggestions.length}</dd>
          </div>
        </dl>
      </div>

      {state.summary && (
        <p className="mt-2.5 text-[13px] leading-6 text-zinc-300">{state.summary}</p>
      )}

      {/* v1.3.0 §36：维度评分。旧 Run 没有维度时这一段整体不出现（§37）。 */}
      {state.dimensions.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] font-mono tracking-widest uppercase text-violet-500/80">
            维度评分
          </div>
          <ul className="mt-1.5 space-y-2">
            {state.dimensions.map((d) => (
              <li key={d.key}>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[12px] text-zinc-300">{d.label}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-violet-400"
                      style={{ width: `${d.percent}%` }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-zinc-300 font-mono">
                    {d.scoreText}
                  </span>
                </div>
                <p className="mt-0.5 ml-14 text-[12px] leading-5 text-muted-foreground">
                  {d.summary}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono tracking-widest uppercase text-amber-500/80">Issues</div>
          <ul className="space-y-1">
            {state.issues.length === 0 && (
              <li className="text-[12px] text-muted-foreground">（没有问题）</li>
            )}
            {state.issues.map((issue) => (
              <li key={issue.id} className="flex gap-1.5 text-[12px] leading-5 text-zinc-300">
                <span className="text-amber-500 shrink-0">•</span>
                <span>
                  {issue.message}
                  <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                    {issue.source}/{issue.category}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono tracking-widest uppercase text-emerald-500/80">Suggestions</div>
          <ul className="space-y-1">
            {state.suggestions.length === 0 && (
              <li className="text-[12px] text-muted-foreground">（没有建议）</li>
            )}
            {state.suggestions.map((s) => (
              <li key={s.id} className="flex gap-1.5 text-[12px] leading-5 text-zinc-300">
                <span className="text-emerald-500 shrink-0">→</span>
                <span>{s.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
