"use client";

import { ShieldAlert } from "lucide-react";
import type { FailureAnalysisResult } from "@/types/failure-analysis";
import { failurePanelState, severityClass } from "@/lib/failure-view";

/**
 * v1.9.0 失败分析面板：把这次 Run 的失败分类摆出来——哪一类是主要的、还有哪几类、
 * 在哪个阶段出的问题、每条信号与它指向的证据。
 *
 * 边界（TASK §33/§34/§69/§70）：
 *   - 只读展示，没有任何按钮：没有重试、没有重跑、没有「按建议修复」——
 *     本版本只分析，不控制。
 *   - 不写「根因」「真正原因」「很可能是因为」：这里显示的是分类与证据本身，
 *     每个类别背后的事实要读者自己打开证据指向的那份文件看。
 *   - §30 v1.9.0 之前生成的 Run 没有 failure-analysis.json，此时整个面板不出现，
 *     由父层显示「这个 Run 没有失败分析」。
 *   - REVVIEWER 一类是「审阅环节自身出了问题」，与「故事写得不好」是两件事，
 *     面板不给它任何价值判断（§8）。
 */
export interface FailurePanelProps {
  analysis: FailureAnalysisResult | null | undefined;
}

export function FailurePanel({ analysis }: FailurePanelProps) {
  const state = failurePanelState(analysis);
  // §30：旧 Run / 文件被改坏时整个面板不出现
  if (state.kind === "hidden") return null;

  return (
    <details className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 sm:p-4" open>
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">失败分类</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          {`failure v${state.schemaVersion}`}
        </span>
      </summary>

      <div className="mt-3 space-y-3.5 text-[12px] leading-5">
        {/* §28 成功 Run：一句确定的话，不摆空表格 */}
        <section className="space-y-1">
          <SectionTitle>结论</SectionTitle>
          <div className="font-mono text-[11px]">{state.analysis.summary}</div>
          <div className="text-[10px] text-muted-foreground">{state.statusText}</div>
        </section>

        {/* §32 主要 / 次要类别与阶段事实 */}
        <section className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          <Field label="主要失败类别" value={state.primaryLabel ?? "—"} />
          <Field label="次要失败类别" value={state.secondaryLabels.length > 0 ? state.secondaryLabels.join("、") : "—"} />
          <Field label="首个失败阶段" value={state.firstFailureStageText} />
          <Field label="终态" value={state.terminalStateText} />
        </section>

        {/* §32 信号表 */}
        <section className="space-y-1.5">
          <SectionTitle>信号</SectionTitle>
          {state.signals.length === 0 ? (
            <Empty>没有信号</Empty>
          ) : (
            <ul className="space-y-0.5 font-mono text-[11px]">
              {state.signals.map((row) => (
                <li key={row.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={severityClass(row.severity)}>{row.code}</span>
                  <span className="text-muted-foreground">{row.sourceText}</span>
                  <span className="text-foreground">{row.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* §32 证据表：每条证据都指向一份真实存在的文件 */}
        <section className="space-y-1.5">
          <SectionTitle>证据</SectionTitle>
          {state.evidence.length === 0 ? (
            <Empty>没有证据</Empty>
          ) : (
            <ul className="space-y-1 font-mono text-[11px]">
              {state.evidence.map((row) => (
                <li key={row.key} className="space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-foreground">{row.locationText}</span>
                    {row.stageText !== "—" && <span className="text-muted-foreground">{row.stageText}</span>}
                    {row.attemptText !== "—" && <span className="text-muted-foreground">{row.attemptText}</span>}
                    {row.repairText !== "—" && <span className="text-muted-foreground">{row.repairText}</span>}
                  </div>
                  {row.valueText !== "—" && <div className="text-muted-foreground">{row.valueText}</div>}
                  {row.note !== "" && <div className="text-[10px] text-muted-foreground">{row.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-[12px]">{value}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[11px] text-muted-foreground">{children}</div>;
}
