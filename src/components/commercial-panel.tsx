"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CommercialReviewResult } from "@/types/commercial-review";
import { commercialPanelState } from "@/lib/commercial-view";

/**
 * v1.5.0 TASK §27 Commercial Review 面板：与 Review 面板完全并列的第二份结论。
 * 展示 Commercial Score、四个维度（H / P / E / Pf）、Strengths、Problems、Suggestions。
 * TASK §29：这里的文字只描述可读性，绝不出现爆款概率 / 必火 / 市场成功率一类市场化预言，
 * 也不提供 Fix / Retry / 重写入口（§15：商业分不驱动任何自动动作）。
 */
export interface CommercialPanelProps {
  commercialReview: CommercialReviewResult | null;
  commercialReviewStatus: string;
  commercialReviewError?: string | null;
  /** 手动重新商业审阅中：本面板转 loading，正文不动。 */
  reReviewing?: boolean;
  /** §27 没有正文就没有审阅对象，按钮禁用；也避免正在请求时重复提交。 */
  disabled?: boolean;
  onReviewAgain?: () => void;
}

export function CommercialPanel({
  commercialReview,
  commercialReviewStatus,
  commercialReviewError,
  reReviewing = false,
  disabled = false,
  onReviewAgain,
}: CommercialPanelProps) {
  const state = commercialPanelState({
    commercialReview,
    commercialReviewStatus,
    commercialReviewError,
    reReviewing,
  });
  // §32：没跑过这一步的旧 Run 整个区域不出现，不占位、不白屏
  if (state.kind === "hidden") return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className={`h-2 w-2 rounded-full ${state.kind === "failed" ? "bg-red-500" : "bg-violet-500"}`} />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Commercial Review</h3>
        {state.kind === "ready" && (
          <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
            Commercial Score
          </span>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center gap-2 py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-violet-600 dark:text-violet-400" />
          <span className="text-xs font-mono">Reviewing...</span>
        </div>
      )}

      {state.kind === "ready" && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-1.5">
            {/* §11：只有一个整体分，就是四维均分；没有等级、没有雷达图 */}
            <span className="text-3xl font-bold tracking-tight text-primary tabular-nums">
              {state.scoreText}
            </span>
            <span className="text-sm text-muted-foreground font-mono">/ 100</span>
          </div>

          <p className="text-[13px] leading-6 text-foreground">{state.summary}</p>

          {/* §27/§11：四个固定维度，各自一条短评 */}
          <div className="mt-3">
            <div className="text-[10px] font-mono tracking-widest uppercase text-violet-500/80">
              Dimensions
            </div>
            <ul className="mt-1.5 space-y-2">
              {state.dimensions.map((d) => (
                <li key={d.key}>
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-[12px] text-foreground">{d.label}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-violet-400"
                        style={{ width: `${d.percent}%` }}
                      />
                    </span>
                    <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-foreground font-mono">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono tracking-widest uppercase text-emerald-500/80">Strengths</div>
              <ul className="space-y-1">
                {state.strengths.length === 0 && (
                  <li className="text-[12px] text-muted-foreground">（未提供）</li>
                )}
                {state.strengths.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-[12px] leading-5 text-foreground">
                    <span className="text-emerald-500 shrink-0">✓</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono tracking-widest uppercase text-amber-500/80">Problems</div>
              <ul className="space-y-1">
                {state.problems.length === 0 && (
                  <li className="text-[12px] text-muted-foreground">（未提供）</li>
                )}
                {state.problems.map((p, i) => (
                  <li key={i} className="flex gap-1.5 text-[12px] leading-5 text-foreground">
                    <span className="text-amber-500 shrink-0">•</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {state.suggestions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono tracking-widest uppercase text-emerald-500/80">Suggestions</div>
              <ul className="space-y-1">
                {state.suggestions.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-[12px] leading-5 text-foreground">
                    <span className="text-emerald-500 shrink-0">→</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* §15/§29：只有「再评一次」这一个动作，而且只重跑商业审阅 */}
          {onReviewAgain && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full text-xs"
                onClick={onReviewAgain}
                disabled={disabled || reReviewing}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Commercial Review Again
              </Button>
            </div>
          )}
        </div>
      )}

      {state.kind === "failed" && (
        <div className="space-y-2.5">
          <div className="text-[13px] font-medium text-red-500">Commercial review failed.</div>
          <div className="text-[11px] text-muted-foreground break-all">{state.error}</div>
          {/* §24/§25：失败不丢任何已生成的结论，只提示可以只重新商业审阅 */}
          <div className="text-[11px] text-muted-foreground">
            正文、校验与质量结论已保留，均未受影响。可以点击 Commercial Review Again
            只重新商业审阅，不会重新生成正文，也不会改动结构审阅结论。
          </div>
          {onReviewAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onReviewAgain}
              disabled={disabled || reReviewing}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Commercial Review Again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
