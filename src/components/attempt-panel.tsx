"use client";

import { CheckCircle2, Loader2, RotateCcw, Wrench, XCircle } from "lucide-react";
import type { AttemptSummaryApi } from "@/lib/api";
import { formatScore } from "@/lib/review-view";
import { repairIssueLabel } from "@/components/repair-panel";

/** §22/§35 Retry Reason → 中文说明。只有一个原因字段，不做失败归因（§67）。 */
const RETRY_REASON_LABELS: Record<string, string> = {
  generation_error: "生成失败",
  validation_failed: "有效性检查未通过",
  review_score_below_threshold: "审阅分数低于阈值",
};

export function retryReasonLabel(reason: string | null): string {
  if (!reason) return "—";
  return RETRY_REASON_LABELS[reason] ?? reason;
}

export interface AttemptPanelProps {
  attempts: AttemptSummaryApi[];
  selectedAttempt: number;
  qualityStatus: "accepted" | "exhausted";
  /** 当前正在查看第几次 Attempt；触发时由父组件重取该 Attempt 详情。 */
  viewingAttempt: number;
  onViewAttempt: (attemptNumber: number) => void;
  loadingAttempt?: number | null;
}

/**
 * §34/§35 Attempt 面板：Attempts 计数 / Selected Attempt / Quality Status，
 * 每次 Attempt 一行可点开的摘要（正文、Validation、Review Score、Accepted、Retry Reason）。
 * §35 禁止：Attempt Comparison Table、Score Delta Chart、Best Attempt Ranking——
 * 所以这里只按编号罗列，不排序、不比较、不算差值。
 */
export function AttemptPanel({
  attempts,
  selectedAttempt,
  qualityStatus,
  viewingAttempt,
  onViewAttempt,
  loadingAttempt = null,
}: AttemptPanelProps) {
  if (attempts.length === 0) return null;

  const exhausted = qualityStatus === "exhausted";
  // §40：修订发生在 Attempt 内部，所以总数是各 Attempt 修订次数之和。
  const totalRepairs = attempts.reduce((sum, a) => sum + a.repair_count, 0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Attempts</h3>
        <span className="text-[11px] font-mono text-muted-foreground" data-testid="attempt-count">
          Attempts: {attempts.length}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground" data-testid="selected-attempt">
          Selected Attempt: {selectedAttempt}
        </span>
        {/* §40：Run 级修订次数 = 各 Attempt 修订次数之和，Repair 不新增 Attempt 行 */}
        {totalRepairs > 0 && (
          <span className="text-[11px] font-mono text-violet-300" data-testid="run-repair-count">
            Repairs: {totalRepairs}
          </span>
        )}
        <span
          className={`ml-auto text-[10px] font-mono tracking-widest uppercase px-2 py-0.5 rounded-full border ${
            exhausted
              ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          }`}
          data-testid="quality-status"
        >
          Quality Status: {qualityStatus}
        </span>
      </div>

      {/* §32：次数用尽时明确告知，但不提供任何自动修复入口 */}
      {exhausted && (
        <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] text-muted-foreground leading-5">
          已达最大尝试次数，正在展示最后一次生成结果。可在设置中调整 Max Attempts 后重新生成
          （会自动增加 API 调用与费用）。
        </div>
      )}

      <div className="space-y-1.5">
        {attempts.map((attempt) => {
          const isSelected = attempt.attempt_number === selectedAttempt;
          const isViewing = attempt.attempt_number === viewingAttempt;
          return (
            <div
              key={attempt.attempt_number}
              className={`rounded-xl border px-3 py-2 ${
                isViewing ? "border-violet-500/40 bg-violet-500/5" : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <button
                type="button"
                onClick={() => onViewAttempt(attempt.attempt_number)}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 text-left"
                aria-label={`查看 Attempt ${attempt.attempt_number}`}
              >
                <span className="text-[12px] font-mono font-medium">Attempt {attempt.attempt_number}</span>
                {isSelected && (
                  <span className="text-[10px] font-mono text-violet-300 border border-violet-500/30 rounded-full px-1.5 py-0.5">
                    Selected
                  </span>
                )}
                {loadingAttempt === attempt.attempt_number ? (
                  <Loader2 className="h-3 w-3 animate-spin text-violet-400 ml-auto" />
                ) : attempt.accepted ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> Accepted
                  </span>
                ) : (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-400">
                    <RotateCcw className="h-3 w-3" /> {retryReasonLabel(attempt.retry_reason)}
                  </span>
                )}
              </button>

              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
                <span>
                  Review Score:{" "}
                  {attempt.review_score === null ? "—" : `${formatScore(attempt.review_score)} / 100`}
                </span>
                <span>
                  Validation:{" "}
                  {attempt.validation_passed === null ? "—" : attempt.validation_passed ? "PASSED" : "FAILED"}
                </span>
                {!attempt.accepted && (
                  <span className="inline-flex items-center gap-1">
                    <XCircle className="h-3 w-3" />
                    Retry Reason: {retryReasonLabel(attempt.retry_reason)}
                  </span>
                )}
                {/* §40：Repair 挂在这个 Attempt 内部，不新增 Attempt 行 */}
                {attempt.repair_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-violet-300" data-testid={`attempt-${attempt.attempt_number}-repairs`}>
                    <Wrench className="h-3 w-3" />
                    Repairs: {attempt.repair_count}
                    {attempt.repairs.map((r) => (
                      <span key={r.repair_number}>
                        {repairIssueLabel(r.issue_type)}
                        {r.success ? " ✓" : " ✗"}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
