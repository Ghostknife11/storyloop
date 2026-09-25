"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReviewResult } from "@/types/review-result";
import { reviewPanelState } from "@/lib/review-view";

/**
 * §31/§32/§33/§34 Review 面板：Score（只显示「74 /100」）/ Summary / Strengths（✓）/ Problems（•）。
 * Problems 只展示，不提供 Fix / Repair / Rewrite / Retry 入口（§33）。
 * Review 失败时 Story 继续显示，只把本面板切成失败态并提供 Review Again（§34）。
 */
export interface ReviewPanelProps {
  review: ReviewResult | null;
  reviewStatus: string;
  reviewError?: string | null;
  reReviewing?: boolean;
  /** §36 没有正文就没有审阅对象，按钮禁用；也避免正在请求时重复提交（§35）。 */
  disabled?: boolean;
  onReviewAgain?: () => void;
}

export function ReviewPanel({
  review,
  reviewStatus,
  reviewError,
  reReviewing = false,
  disabled = false,
  onReviewAgain,
}: ReviewPanelProps) {
  const state = reviewPanelState({ review, reviewStatus, reviewError, reReviewing });
  if (state.kind === "hidden") return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span className={`h-2 w-2 rounded-full ${state.kind === "failed" ? "bg-red-500" : "bg-violet-500"}`} />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Review</h3>
        {state.kind === "ready" && (
          <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
            Overall Score
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
            {/* §32：只有「74 / 100」，没有 PASS / FAIL / 等级 */}
            <span className="text-3xl font-bold tracking-tight text-primary tabular-nums">
              {state.scoreText}
            </span>
            <span className="text-sm text-muted-foreground font-mono">/ 100</span>
          </div>

          <p className="text-[13px] leading-6 text-foreground">{state.summary}</p>

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
        </div>
      )}

      {state.kind === "failed" && (
        <div className="space-y-2.5">
          <div className="text-[13px] font-medium text-red-500">Review failed.</div>
          <div className="text-[11px] text-muted-foreground break-all">{state.error}</div>
          {/* §34：失败不丢正文，只提示可以重新审阅 */}
          <div className="text-[11px] text-muted-foreground">
            正文已保留（story.md 未受影响）。可以点击 Review Again 只重新审阅，不会重新生成正文。
          </div>
          {onReviewAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onReviewAgain}
              disabled={disabled || reReviewing}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Review Again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
