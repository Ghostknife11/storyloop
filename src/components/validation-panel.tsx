"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ValidationResult } from "@/types/validation-result";
import { validationPanelState } from "@/lib/validation-view";

/**
 * §28/§30 Validation 面板：Passed / Failed + Issues（Code / Severity / Message）。
 * §29 与 Review 面板分开：这里只做硬性有效性检查，不显示分数，不显示 Strengths / Problems。
 * §30 失败时不提供 Auto Retry / Fix Automatically / Repair Story；只允许用户主动
 * Validate Again（重新跑规则，不重新生成正文）与 Generate Again（新建 Run，用户手动触发）。
 */
export interface ValidationPanelProps {
  validation: ValidationResult | null;
  validationStatus: string;
  validationError?: string | null;
  revalidating?: boolean;
  /** §36 没有正文就没有校验对象，按钮禁用；也避免正在请求时重复提交（§35）。 */
  disabled?: boolean;
  onValidateAgain?: () => void;
}

const SEVERITY_STYLE: Record<string, string> = {
  error: "text-red-500 border-red-500/30 bg-red-500/10",
  warning: "text-amber-500 border-amber-500/30 bg-amber-500/10",
};

export function ValidationPanel({
  validation,
  validationStatus,
  validationError,
  revalidating = false,
  disabled = false,
  onValidateAgain,
}: ValidationPanelProps) {
  const state = validationPanelState({ validation, validationStatus, validationError, revalidating });
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
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Validation</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          Hard checks
        </span>
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center gap-2 py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span className="text-xs font-mono">Validating...</span>
        </div>
      )}

      {state.kind === "ready" && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            {/* §28/§30：只有 Passed / Failed，没有分数，没有等级 */}
            <span
              className={`text-lg font-semibold tracking-tight ${
                state.passed ? "text-emerald-400" : "text-amber-400"
              }`}
            >
              {state.passed ? "Passed" : "Failed"}
            </span>
            <span className="text-[11px] text-muted-foreground font-mono">
              {state.issues.length === 0
                ? "no issues"
                : `${state.issues.length} issue${state.issues.length > 1 ? "s" : ""}`}
            </span>
          </div>

          {!state.passed && (
            <div className="text-[12px] text-amber-400/90">
              This story failed basic validation.
            </div>
          )}

          {state.issues.length > 0 && (
            <ul className="space-y-2">
              {state.issues.map((issue, i) => (
                <li
                  key={`${issue.code}-${i}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-2.5 py-2 space-y-1"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* §28：Code + Severity 直接展示，稳定机器可读 */}
                    <span className="text-[11px] font-mono font-medium text-zinc-200">{issue.code}</span>
                    <span
                      className={`text-[10px] font-mono uppercase tracking-wider rounded-full border px-1.5 py-px ${
                        SEVERITY_STYLE[issue.severity] ?? "text-muted-foreground border-white/10"
                      }`}
                    >
                      {issue.severity}
                    </span>
                  </div>
                  <div className="text-[12px] leading-5 text-zinc-300">{issue.message}</div>
                </li>
              ))}
            </ul>
          )}

          {/* §30：失败不丢正文，也不自动做任何事；用户可主动重新校验 */}
          {!state.passed && (
            <div className="text-[11px] text-muted-foreground">
              正文已保留（story.md 未受影响）。系统不会自动重试或修复——可以点击 Validate Again 只重新跑硬性检查。
            </div>
          )}
          {onValidateAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onValidateAgain}
              disabled={disabled || revalidating}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Validate Again
            </Button>
          )}
        </div>
      )}

      {state.kind === "failed" && (
        <div className="space-y-2.5">
          <div className="text-[13px] font-medium text-red-500">Validation failed.</div>
          <div className="text-[11px] text-muted-foreground break-all">{state.error}</div>
          <div className="text-[11px] text-muted-foreground">
            正文已保留（story.md 未受影响）。可以点击 Validate Again 只重新跑硬性检查，不会重新生成正文。
          </div>
          {onValidateAgain && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs"
              onClick={onValidateAgain}
              disabled={disabled || revalidating}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Validate Again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
