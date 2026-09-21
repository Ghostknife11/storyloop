"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { classifyProblem, issueTypeOfCode } from "@/core/repair-strategy";
import { REPAIR_ISSUE_TYPES } from "@/types/repair";
import { repairStory, type RepairDetailApi } from "@/lib/api";
import { formatScore } from "@/lib/review-view";
import type { BeatPlan } from "@/types/beat-plan";
import type { StoryConfig } from "@/types/story-config";
import type { ValidationResult } from "@/types/validation-result";
import type { ReviewResult } from "@/types/review-result";

/** §6/§63 Issue Type → 中文说明：只有这六类，不扩类、不排序。 */
const REPAIR_ISSUE_LABELS: Record<string, string> = {
  length: "篇幅不足",
  ending: "结局问题",
  character_presence: "主角缺席",
  continuity: "前后连贯",
  structure: "结构断层",
  general: "综合问题",
};

export function repairIssueLabel(issueType: string): string {
  return REPAIR_ISSUE_LABELS[issueType] ?? issueType;
}

/** §36 分数变化：64 → 73；缺失一侧只显示 —。 */
function scoreText(score: number | null): string {
  return score === null ? "—" : formatScore(score);
}

/** §36 Validation 变化：FAILED → PASSED。null 表示当时没有这项结论。 */
export function validationTransition(before: boolean | null, after: boolean | null): string {
  const show = (v: boolean | null) => (v === null ? "—" : v ? "PASSED" : "FAILED");
  return `${show(before)} → ${show(after)}`;
}

/** §36 前后分数：64 → 73。 */
export function scoreTransition(before: number | null, after: number | null): string {
  return `${scoreText(before)} → ${scoreText(after)}`;
}

/**
 * §35 修订阶段标记：只有整个 Run 真的发生过修订才展示
 * Repairing / Revalidating / Re-reviewing——没有修订的 Run 一个都不显示，也不伪造过程。
 */
export function repairStageLabels(repairCount: number): string[] {
  return repairCount > 0 ? ["Repairing", "Revalidating", "Re-reviewing"] : [];
}

/**
 * §36 预填要修的问题：先看硬性校验里的问题码，再看审阅 problem 的关键词，
 * 与 RepairStrategy 是同一套固定规则（§8/§63）——不学习、不排序、不做归因。
 */
export function defaultRepairTarget(
  validation: ValidationResult | null,
  review: ReviewResult | null,
): { issue_type: string; issue_message: string } {
  const issue = validation?.issues.find((i) => issueTypeOfCode(i.code)) ?? null;
  if (issue) {
    return { issue_type: issueTypeOfCode(issue.code) as string, issue_message: issue.message };
  }
  const problem = review?.problems.find((p) => p.trim().length > 0) ?? null;
  if (problem) return { issue_type: classifyProblem(problem), issue_message: problem };
  return { issue_type: "general", issue_message: "" };
}

export interface RepairPanelProps {
  /** §36：这个 Attempt 内发生过的定点修订，按发生顺序排列。 */
  repairs: RepairDetailApi[];
}

/**
 * §36 Repair 结果面板：Type / Reason / Before Score / After Score / Validation 变化。
 * §63 只展示这几项——没有失败归因、策略排名、自适应建议。
 */
export function RepairPanel({ repairs }: RepairPanelProps) {
  if (repairs.length === 0) return null;

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-testid="repair-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Repair Applied</h3>
        <span className="text-[11px] font-mono text-muted-foreground" data-testid="repair-count">
          Repairs: {repairs.length}
        </span>
      </div>

      <div className="space-y-1.5">
        {repairs.map((repair) => (
          <div key={repair.repair_number} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[12px] font-mono font-medium">Repair {repair.repair_number}</span>
              <span className="text-[11px] font-mono text-muted-foreground">
                Type: {repair.issue_type}（{repairIssueLabel(repair.issue_type)}）
              </span>
              {repair.success ? (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Repaired
                </span>
              ) : (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-400">
                  <XCircle className="h-3 w-3" /> Not repaired
                </span>
              )}
            </div>
            {repair.issue_message && (
              <div className="mt-1 text-[11px] text-muted-foreground leading-5">
                Reason: {repair.issue_message}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
              <span data-testid={`repair-${repair.repair_number}-scores`}>
                Before Score: {scoreText(repair.before_review_score)} · After Score:{" "}
                {scoreText(repair.after_review_score)}
              </span>
              <span data-testid={`repair-${repair.repair_number}-validation`}>
                Validation: {validationTransition(repair.before_validation_passed, repair.after_validation_passed)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ManualRepairProps {
  config: StoryConfig;
  plan: BeatPlan;
  /** 当前正在查看的正文（修订前的版本）。 */
  story: string;
  validation: ValidationResult | null;
  review: ReviewResult | null;
  runtime: { model?: string; baseUrl?: string; temperature?: number };
  /** §37：修订成功后由父组件把展示的正文换成修订版（Before / After 两个 Tab）。 */
  onRepaired: (story: string) => void;
  disabled?: boolean;
}

/**
 * §38/§50 手动定点修订：选一个 Issue Type、写清要修什么，针对当前正文修一次。
 * §65 只改正文——不改 StoryConfig / BeatPlan / 模型 / 温度，也不自动重试。
 * §63 只暴露这六类与一段问题说明，没有策略选择与失败归因入口。
 */
export function ManualRepair({
  config,
  plan,
  story,
  validation,
  review,
  runtime,
  onRepaired,
  disabled = false,
}: ManualRepairProps) {
  const initial = defaultRepairTarget(validation, review);
  const [issueType, setIssueType] = useState(initial.issue_type);
  const [issueMessage, setIssueMessage] = useState(initial.issue_message);
  const [repairing, setRepairing] = useState(false);

  const canRepair = !repairing && !disabled && story.trim().length > 0 && issueMessage.trim().length > 0;

  async function handleRepair() {
    if (!canRepair) return;
    setRepairing(true);
    try {
      const result = await repairStory(config, plan, story, issueType, issueMessage.trim(), runtime);
      if (!result.success) {
        toast.error(`修订失败：${result.notes ?? "未知原因"}`);
        return;
      }
      onRepaired(result.repaired_story);
      toast.success(`修订完成：${repairIssueLabel(result.issue_type)}（${result.issue_type}）`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "修订失败");
    } finally {
      setRepairing(false);
    }
  }

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-testid="manual-repair">
      <div className="flex items-center gap-2 mb-2">
        <Wrench className="h-3.5 w-3.5 text-violet-400" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Manual Targeted Repair</h3>
      </div>
      <p className="text-[11px] text-muted-foreground leading-5 mb-3">
        针对一条明确问题修订当前正文（一次一个问题），修订后可自行复制或替换展示版本；
        不会改写 StoryConfig / BeatPlan，也不会自动重试。
      </p>
      <div className="space-y-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Issue Type</Label>
          <select
            value={issueType}
            onChange={(e) => setIssueType(e.target.value)}
            disabled={repairing}
            className="w-full h-9 rounded-xl border border-white/10 bg-zinc-800/60 px-3 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            aria-label="Issue Type"
          >
            {REPAIR_ISSUE_TYPES.map((t) => (
              <option key={t} value={t} className="bg-zinc-900">
                {t}（{repairIssueLabel(t)}）
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Issue Message（要修什么）</Label>
          <Textarea
            value={issueMessage}
            onChange={(e) => setIssueMessage(e.target.value)}
            placeholder="例如：故事缺少明确结局。"
            disabled={repairing}
            className="min-h-[56px] resize-none"
          />
        </div>
        <div className="flex justify-end">
          <Button
            onClick={handleRepair}
            disabled={!canRepair}
            className="h-8 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-xs"
          >
            {repairing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Repairing...</> : "Targeted Repair"}
          </Button>
        </div>
      </div>
    </div>
  );
}
