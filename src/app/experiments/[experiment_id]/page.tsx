"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FlaskConical, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchExperiment,
  runExperiment,
  RunApiError,
  type ExperimentDetailApi,
} from "@/lib/api";import {
  efficiencyCellText,
  experimentStatusLabel,
  meanText,
  msText,
  resultRowsOf,
  runRowsOf,
  variantCardsOf,
  type ExperimentResultRow,
} from "@/lib/experiment-view";

/**
 * `/experiments/<id>`（v1.7.0）：变体卡片 + 结果表 + 样本 Run 下钻。
 *
 * 三个「不」写在这里，因为它们分别是这个版本承诺过的边界：
 *   - 不排名：结果表的行顺序就是定义里变体的声明顺序，永远不按分数重排；
 *   - 不给结论：只有计数与均值，没有「推荐变体 / 更优解 / 显著性」；
 *   - 不复制正文：样本要看细节，点 runId 走既有的 /api/runs/<run_id>。
 */

const MEAN_COLUMNS = [
  { key: "meanOverallScore", label: "整体分" },
  { key: "meanCommercialScore", label: "商业分" },
  { key: "meanCoherence", label: "连贯" },
  { key: "meanNarrative", label: "叙事" },
  { key: "meanCharacter", label: "人物" },
  { key: "meanCausality", label: "因果" },
  { key: "meanHook", label: "H" },
  { key: "meanPacing", label: "P" },
  { key: "meanEngagement", label: "E" },
  { key: "meanPayoff", label: "Pf" },
] as const;

/**
 * v1.8.0 §23 效率列。每格是「均值 · 有值样本数/本组样本数」：
 * 一条样本没有 telemetry.json（1.8.0 之前跑的）时它不进分母，这一格就少算一个——
 * 所以分母小于本组样本数是正常的，不是数据丢了。
 */
const EFFICIENCY_COLUMNS = [
  { key: "durationMs", label: "平均时长", format: (v: number) => msText(v) },
  { key: "llmCalls", label: "平均调用", format: (v: number) => String(v) },
  { key: "totalTokens", label: "平均 token", format: (v: number) => String(v) },
  { key: "retries", label: "平均重试", format: (v: number) => String(v) },
  { key: "repairs", label: "平均修订", format: (v: number) => String(v) },
] as const;

/** 整组一个样本都没遥测时，这张表不值得占地方。 */
function hasAnyEfficiency(rows: ExperimentResultRow[]): boolean {
  return rows.some((row) =>
    (Object.values(row.efficiency) as { sampleCount: number }[]).some((m) => m.sampleCount > 0),
  );
}

export default function ExperimentDetailPage() {
  const params = useParams<{ experiment_id: string }>();
  const experimentId = decodeURIComponent(String(params?.experiment_id ?? ""));
  const [detail, setDetail] = useState<ExperimentDetailApi | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchExperiment(experimentId)
      .then(setDetail)
      .catch((e) => setProblem(e instanceof RunApiError ? e.message : "读取实验失败"));
  }, [experimentId]);

  useEffect(load, [load]);

  const run = async () => {
    setBusy(true);
    try {
      const result = await runExperiment(experimentId);
      toast.success(`实验跑完：${experimentStatusLabel(result.status).label}`);
      load();
    } catch (e) {
      toast.error(e instanceof RunApiError ? e.message : "运行实验失败");
    } finally {
      setBusy(false);
    }
  };

  if (problem !== null) {
    return (
      <div className="h-full overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <Link href="/experiments" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            返回实验列表
          </Link>
          <p className="text-sm text-destructive">{problem}</p>
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="h-full overflow-auto p-4 sm:p-6">
        <p className="text-xs text-muted-foreground">加载中…</p>
      </div>
    );
  }

  const rows = resultRowsOf(detail);
  const cards = variantCardsOf(detail.definition);
  const runRows = runRowsOf(detail);
  const status = experimentStatusLabel(detail.result?.status ?? "pending");
  const alreadyRun = detail.result !== null;

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/experiments" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
              实验列表
            </Link>
            <h1 className="text-lg font-bold tracking-tight mt-2 truncate">{detail.definition.name}</h1>
            <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{detail.definition.experimentId}</p>
            {detail.definition.description && (
              <p className="text-xs text-muted-foreground mt-1">{detail.definition.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status.tone === "good" ? "default" : status.tone === "bad" ? "destructive" : "secondary"}>
              {status.label}
            </Badge>
            <Button size="sm" onClick={run} disabled={busy || alreadyRun}>
              <Play className="h-3.5 w-3.5" />
              {alreadyRun ? "已跑过" : busy ? "运行中…" : "运行实验"}
            </Button>
          </div>
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">变体</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((card) => (
              <div key={card.variantId} className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-3.5">
                <div className="text-sm font-medium truncate">{card.variantName}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{card.variantId}</div>
                <div className="mt-2 space-y-1">
                  {card.changes.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">与 Base 相同</p>
                  ) : (
                    card.changes.map((change) => (
                      <div key={change.label} className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="text-muted-foreground">{change.label}</span>
                        <span className="font-mono truncate">{change.value}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {rows !== null && detail.result && (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xs font-medium text-muted-foreground">结果（{detail.result.summary.runCount} 条样本）</h2>
              <p className="text-[10px] text-muted-foreground">行顺序 = 定义里的变体顺序，不按分数排名；「—」表示这一组没有可算均值的样本</p>
            </div>
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">变体</th>
                    <th className="text-right font-medium px-3 py-2">样本</th>
                    {MEAN_COLUMNS.map((col) => (
                      <th key={col.key} className="text-right font-medium px-2 py-2 whitespace-nowrap">{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.variantName}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {row.successCount} 成功 / {row.failureCount} 失败
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{row.runCount}</td>
                      {MEAN_COLUMNS.map((col) => (
                        <td key={col.key} className="px-2 py-2 text-right font-mono">
                          {meanText(row[col.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {rows !== null && detail.result && hasAnyEfficiency(rows) && (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xs font-medium text-muted-foreground">效率</h2>
              <p className="text-[10px] text-muted-foreground">
                每格「均值 · 有值样本数 / 本组样本数」；没有 telemetry.json 的样本不进分母，也不当 0
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">变体</th>
                    {EFFICIENCY_COLUMNS.map((col) => (
                      <th key={col.key} className="text-right font-medium px-2 py-2 whitespace-nowrap">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.variantId} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{row.variantName}</td>
                      {EFFICIENCY_COLUMNS.map((col) => (
                        <td key={col.key} className="px-2 py-2 text-right font-mono">
                          {efficiencyCellText(row.efficiency[col.key], row.runCount, col.format)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {runRows.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">样本 Run</h2>
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-hidden">
              {runRows.map((row, index) => (
                <div
                  key={`${row.variantId}-${row.repetition}-${index}`}
                  className={`flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium">
                      {row.variantName} · 第 {row.repetition} 次
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {row.runId ? (
                        <a
                          href={`/api/runs/${encodeURIComponent(row.runId)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono hover:text-foreground underline decoration-dotted"
                        >
                          {row.runId}
                        </a>
                      ) : (
                        <span className="font-mono">—</span>
                      )}
                      {row.failure ? <span className="ml-2 text-destructive">{row.failure}</span> : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-muted-foreground font-mono">
                      整体 {meanText(row.overallScore)} · 商业 {meanText(row.commercialScore)}
                    </span>
                    <Badge variant={row.status === "failed" ? "destructive" : row.status === "completed" ? "default" : "secondary"}>
                      {row.status === "completed" ? "完成" : row.status === "failed" ? "失败" : "未跑"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!alreadyRun && (
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center">
            <FlaskConical className="h-5 w-5 mx-auto text-muted-foreground" />
            <p className="text-xs text-muted-foreground mt-2">
              还没跑过。点「运行实验」会按定义顺序跑完全部 {detail.definition.variants.length * detail.definition.repetitions} 条样本，每条都是一次完整 Run。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
