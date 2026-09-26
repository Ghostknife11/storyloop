"use client";

import { Activity } from "lucide-react";
import type { RunTelemetry } from "@/types/telemetry";
import { telemetryPanelState, type StageTimelineRow } from "@/lib/telemetry-view";

/**
 * v1.8.0 Observability 面板：把这次 Run 的执行过程摆出来——总共多久、调了几次模型、
 * 试了几次、修了几轮、每段阶段各花了多久、每次调用分别落在哪个阶段、失败时断在哪。
 *
 * 边界（TASK §26-§30）：
 *   - 只读展示，没有任何按钮：没有重试、没有重跑、没有依据遥测改生成行为（§61）。
 *   - 没有全局监控总览页、没有告警、没有失败归因（§30/§31/§60）。
 *   - §29 v1.8.0 之前生成的 Run 没有 telemetry.json，此时整个面板不出现，
 *     由父层显示「Telemetry unavailable for this run」。
 *   - 取不到的值一律 —，绝不补 0（§24）。
 */
export interface TelemetryPanelProps {
  telemetry: RunTelemetry | null | undefined;
}

export function TelemetryPanel({ telemetry }: TelemetryPanelProps) {
  const state = telemetryPanelState(telemetry);
  // §29：旧 Run / 文件被改坏时整个面板不出现
  if (state.kind === "hidden") return null;

  return (
    <details className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 sm:p-4" open>
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Observability</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          {`telemetry v${state.schemaVersion}`}
        </span>
      </summary>

      <div className="mt-3 space-y-3.5 text-[12px] leading-5">
        {/* §13 失败阶段：成功 Run 整段不渲染 */}
        {state.failure && (
          <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
            <SectionTitle>Failure stage</SectionTitle>
            <div className="mt-1 font-mono text-[11px] text-red-600 dark:text-red-400">
              {`${state.failure.stageText} · ${state.failure.codeText}`}
            </div>
            {/* §60：到错误码为止。原因要从 md 正文 / 校验结论里看，遥测不推断 */}
            <p className="mt-1 text-[10px] text-muted-foreground">
              遥测只记录失败发生在哪一步，不记录原因。
            </p>
          </section>
        )}

        {/* §26 总量 */}
        <section className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          {state.summary.map((row) => (
            <div key={row.key} className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {row.label}
              </span>
              <span
                className={`font-mono text-[12px] tabular-nums ${row.unknown ? "text-muted-foreground" : "text-foreground"}`}
              >
                {row.value}
              </span>
            </div>
          ))}
        </section>

        {/* §27 阶段时间线 */}
        <section className="space-y-1.5">
          <SectionTitle>Stage timeline</SectionTitle>
          {state.stages.length === 0 ? (
            <Empty>没有阶段记录</Empty>
          ) : (
            <ul className="space-y-1">
              {state.stages.map((row) => (
                <StageRow key={row.key} row={row} />
              ))}
            </ul>
          )}
        </section>

        {/* §28 模型调用表 */}
        <section className="space-y-1.5">
          <SectionTitle>LLM calls</SectionTitle>
          {state.calls.length === 0 ? (
            <Empty>这次 Run 没有记录到模型调用</Empty>
          ) : (
            <ul className="space-y-0.5 font-mono text-[11px]">
              {state.calls.map((call) => (
                <li key={call.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-foreground">{call.stageLabel}</span>
                  <span className="text-muted-foreground">{call.model}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {`in ${call.inputText} / out ${call.outputText} · ${call.durationText}`}
                  </span>
                  <span className={call.status === "failed" ? "text-red-500" : "text-muted-foreground"}>
                    {call.status === "failed" ? call.errorText ?? "failed" : call.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Attempt 侧的计数：每次尝试各自调了几次、修了几轮 */}
        {state.attempts.length > 0 && (
          <section className="space-y-1.5">
            <SectionTitle>Attempts</SectionTitle>
            <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {state.attempts.map((a) => (
                <li key={a.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-foreground">{a.label}</span>
                  <span>{a.statusText}</span>
                  <span className="ml-auto tabular-nums">
                    {`${a.callsText} · repairs ${a.repairsText} · ${a.durationText}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}

function StageRow({ row }: { row: StageTimelineRow }) {
  return (
    <li className="space-y-0.5">
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="text-foreground">{row.label}</span>
        {row.attemptLabel && <span className="text-muted-foreground">{row.attemptLabel}</span>}
        <span
          className={
            row.status === "failed"
              ? "text-red-500"
              : row.status === "skipped"
                ? "text-muted-foreground/70"
                : "text-muted-foreground"
          }
        >
          {row.statusText}
        </span>
        <span className="ml-auto tabular-nums text-muted-foreground">{row.durationText}</span>
      </div>
      {/* 条宽相对最慢阶段：只用于阶段之间横向比较，不与总时长对齐 */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className={
            row.status === "failed"
              ? "h-full rounded-full bg-red-500/60"
              : "h-full rounded-full bg-violet-500/50"
          }
          style={{ width: `${Math.max(row.percent, row.status === "completed" ? 2 : 0)}%` }}
        />
      </div>
      {row.errorText && (
        <div className="font-mono text-[10px] text-red-600 dark:text-red-400">{row.errorText}</div>
      )}
    </li>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[11px] text-muted-foreground">{children}</div>;
}
