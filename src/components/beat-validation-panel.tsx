"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BeatValidationResult } from "@/types/beat-validation";
import { beatIssueLabel, beatValidationPanelState } from "@/lib/beat-validation-view";

/**
 * v1.4.0 Beat Validation 面板：Passed / Not Passed + Issues（Code / Severity / Message / Beat）。
 * §4 与 Validation 面板分开：这里检查剧情骨架，不显示正文校验结论，也不显示任何分数。
 * §4/§10 失败时没有 Auto Fix / Regenerate Beats / Repair Plan——本版本只报告，
 * 用户可以自己改骨架，再点 Validate Beats 重新检查。
 */
export interface BeatValidationPanelProps {
  beatValidation: BeatValidationResult | null;
  beatValidationStatus: string;
  beatValidationError?: string | null;
  validating?: boolean;
  disabled?: boolean;
  onValidateAgain?: () => void;
}

const SEVERITY_STYLE: Record<string, string> = {
  error: "text-red-500 border-red-500/30 bg-red-500/10",
  warning: "text-amber-500 border-amber-500/30 bg-amber-500/10",
};

export function BeatValidationPanel({
  beatValidation,
  beatValidationStatus,
  beatValidationError,
  validating = false,
  disabled = false,
  onValidateAgain,
}: BeatValidationPanelProps) {
  const state = beatValidationPanelState({
    beatValidation,
    beatValidationStatus,
    beatValidationError,
    validating,
  });
  if (state.kind === "hidden") return null;

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className={`h-2 w-2 rounded-full ${
            state.kind === "failed"
              ? "bg-red-500"
              : state.kind === "ready" && !state.passed
                ? "bg-amber-500"
                : "bg-emerald-500"
          }`}
        />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Beat Validation</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          Beat plan structure
        </span>
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center gap-2 py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span className="text-xs font-mono">Validating beats...</span>
        </div>
      )}

      {state.kind === "ready" && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span
              className={`text-lg font-semibold tracking-tight ${
                state.passed ? "text-emerald-400" : "text-amber-400"
              }`}
            >
              {state.passed ? "Passed" : "Not Passed"}
            </span>
            <span className="text-[11px] text-muted-foreground font-mono">
              {state.issues.length === 0
                ? "no issues"
                : `${state.issues.length} issue${state.issues.length > 1 ? "s" : ""}`}
            </span>
          </div>

          <div className="text-[12px] leading-5 text-zinc-300">{state.summary}</div>

          {state.issues.length > 0 && (
            <ul className="space-y-2">
              {state.issues.map((issue, i) => (
                <li
                  key={`${issue.code}-${i}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-2.5 py-2 space-y-1"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-mono font-medium text-zinc-200">{issue.code}</span>
                    <span
                      className={`text-[10px] font-mono uppercase tracking-wider rounded-full border px-1.5 py-px ${
                        SEVERITY_STYLE[issue.severity] ?? "text-muted-foreground border-white/10"
                      }`}
                    >
                      {issue.severity}
                    </span>
                    {beatIssueLabel(issue.beat_ids) && (
                      <span className="text-[10px] font-mono text-violet-300">
                        {beatIssueLabel(issue.beat_ids)}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] leading-5 text-zinc-300">{issue.message}</div>
                </li>
              ))}
            </ul>
          )}

          {/* §4/§10：只报告。骨架怎么改由用户决定，系统不顺手改写。 */}
          <div className="text-[11px] text-muted-foreground">
            剧情骨架本身没有被改动——可以直接在上方编辑 Beat，再点 Validate Beats 重新检查。
          </div>
          {onValidateAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onValidateAgain}
              disabled={disabled || validating}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Validate Beats
            </Button>
          )}
        </div>
      )}

      {state.kind === "failed" && (
        <div className="space-y-2.5">
          <div className="text-[13px] font-medium text-red-500">Beat validation failed.</div>
          <div className="text-[11px] text-muted-foreground break-all">{state.error}</div>
          <div className="text-[11px] text-muted-foreground">
            剧情骨架已保留（beats.json 未受影响）。可以点击 Validate Beats 只重新检查骨架，不会生成正文。
          </div>
          {onValidateAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onValidateAgain}
              disabled={disabled || validating}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Validate Beats
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
