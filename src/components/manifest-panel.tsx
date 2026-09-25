"use client";

import { GitCommitHorizontal } from "lucide-react";
import type { RunManifest } from "@/types/run-manifest";
import {
  artifactCountOf,
  attemptStatusText,
  manifestPanelState,
  modelRowText,
  promptRowsOf,
  temperatureRowsOf,
} from "@/lib/manifest-view";

/**
 * v1.6.0 出身面板：把 run-manifest.json 里已经写下的事实摆出来——这次 Run 跑在哪个版本上、
 * 用了哪个模型、哪六份提示词、哪几个温度、试了几次、修了几轮、清单在哪。
 *
 * 边界（与 1.x 的一贯约定一致）：
 *   - 只读展示：没有「对比两次 Run」「看哪次更好」「失败归因」这类入口，本版本不做这些。
 *   - §37 v1.6.0 之前生成的 Run 没有这份清单，整个面板不出现，不占位、不白屏。
 *   - 不显示 baseUrl 本身：清单里存的只是来源类别（服务端配置 / 请求里的公网覆盖）。
 */
export interface ManifestPanelProps {
  manifest: RunManifest | null | undefined;
}

export function ManifestPanel({ manifest }: ManifestPanelProps) {
  const state = manifestPanelState(manifest);
  if (state.kind === "hidden") return null;
  const m = state.manifest;

  return (
    <details className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 sm:p-4" open>
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs sm:text-[13px] font-semibold tracking-tight">Run Provenance</h3>
        <span className="ml-auto text-[10px] font-mono tracking-widest uppercase text-muted-foreground">
          {`${artifactCountOf(m)} artifacts`}
        </span>
      </summary>

      <div className="mt-3 space-y-3 text-[12px] leading-5">
        <section className="space-y-1">
          <Row label="Project version" value={m.project.version} mono />
          {m.project.commit ? <Row label="Commit" value={m.project.commit} mono /> : null}
          <Row label="Model" value={modelRowText(m)} mono />
        </section>

        <section className="space-y-1.5">
          <SectionTitle>Prompt versions</SectionTitle>
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {promptRowsOf(m).map((row) => (
              <li key={row.role} className="flex items-baseline gap-2">
                <span className="text-foreground">{row.label}</span>
                <span>{`v${row.version ?? "?"}`}</span>
                {row.digest ? <span className="truncate">{row.digest}</span> : <span>no digest</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-1.5">
          <SectionTitle>Temperatures</SectionTitle>
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {temperatureRowsOf(m).map((row) => (
              <li key={row.key} className="flex items-baseline justify-between gap-3">
                <span className="text-foreground">{row.label}</span>
                <span>{row.value}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-1.5">
          <SectionTitle>Retry policy</SectionTitle>
          <div className="font-mono text-[11px] text-muted-foreground">
            {`max attempts ${m.parameters.retry.maxAttempts} · min review score ${m.parameters.retry.minReviewScore} · ${m.parameters.retry.retryOnValidationFailure ? "retry on validation failure" : "no retry on validation failure"} · ${m.parameters.retry.enableRepair ? `repair on（≤ ${m.parameters.retry.maxRepairsPerAttempt} per attempt）` : "repair off"}`}
          </div>
        </section>

        {m.attempts.length > 0 && (
          <section className="space-y-1.5">
            <SectionTitle>Attempts</SectionTitle>
            <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {m.attempts.map((a) => (
                <li key={a.attemptId} className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground">{`Attempt ${a.index}`}</span>
                  <span
                    className={
                      a.status === "accepted"
                        ? "text-right text-emerald-600 dark:text-emerald-400"
                        : "text-right"
                    }
                  >
                    {attemptStatusText(a)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-1.5">
          <SectionTitle>Where it is</SectionTitle>
          <div className="font-mono text-[11px] text-muted-foreground">
            {`run-manifest.json · ${m.storyConfigRef}${m.beatPlanRef ? ` · ${m.beatPlanRef}` : ""}`}
          </div>
        </section>
      </div>
    </details>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{children}</div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right break-all ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}
