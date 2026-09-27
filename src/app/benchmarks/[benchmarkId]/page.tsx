"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Download, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BenchmarkBarChart, BenchmarkDistributionChart } from "@/components/benchmark-charts";
import {
  downloadBenchmarkExport,
  fetchBenchmarkExecution,
  fetchBenchmarkExecutions,
  postBenchmarkBaseline,
  RunApiError,
  type BenchmarkExecutionDetailApi,
  type BenchmarkExecutionItemApi,
} from "@/interface/api";
import {
  benchmarkCaseRows,
  benchmarkComparisonRows,
  benchmarkExecutionTitle,
  benchmarkFailureRows,
  benchmarkGroupRows,
  benchmarkMetricRowsOfGroup,
  benchmarkMetricText,
  benchmarkPassText,
  benchmarkProtocolRows,
  benchmarkSampleRowOf,
  benchmarkSnapshotRows,
  benchmarkStageRows,
  benchmarkStatusLabel,
  benchmarkTimestampLabel,
  BENCHMARK_EMPTY,
  type BenchmarkTone,
} from "@/interface/benchmark-view";
import type { BenchmarkMetricGroup } from "@/domain/benchmark-metric";
import { benchmarkMetricGroups } from "@/domain/benchmark-metric";

/**
 * `/benchmarks/<id>`（v2.3.0 §88）：一次执行的完整读数。
 *
 * 七个签：Overview / 质量 / 商业 / 可靠性 / 失败 / 效率 / 样本。前五个签是按
 * 指标注册表的分组切的，不按「看起来重要」重排——注册表顺序就是读数顺序（§26）。
 *
 * 三条边界：
 *   - 没有「再看一次 / 重跑」按钮（§44 落盘不可变）：想看新条件下什么表现，
 *     回到列表换个说明再测一次；
 *   - 比较是「两个数放在一起」（§59），不给「更好 / 更差」的结论；
 *   - 指标是 null 就显示「—」，样本表里也不补 0（§30）。
 */

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "quality", label: "质量" },
  { key: "commercial", label: "商业" },
  { key: "reliability", label: "可靠性" },
  { key: "failure", label: "失败" },
  { key: "efficiency", label: "效率" },
  { key: "samples", label: "样本" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const GROUP_TAB: Record<string, BenchmarkMetricGroup> = {
  quality: "quality",
  commercial: "commercial",
  reliability: "reliability",
  failure: "failure",
  efficiency: "efficiency",
};

const BADGE_VARIANT: Record<BenchmarkTone, "default" | "secondary" | "destructive" | "outline"> = {
  good: "default",
  warn: "secondary",
  bad: "destructive",
  neutral: "outline",
};

export default function BenchmarkDetailPage() {
  const params = useParams<{ benchmarkId: string }>();
  const benchmarkId = decodeURIComponent(String(params?.benchmarkId ?? ""));

  const [tab, setTab] = useState<TabKey>("overview");
  const [detail, setDetail] = useState<BenchmarkExecutionDetailApi | null>(null);
  const [executions, setExecutions] = useState<BenchmarkExecutionItemApi[]>([]);
  const [compareWith, setCompareWith] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // compareWith 变化就是换一次比较对象：取数回调跟着它变， effect 自然重跑，
  // 不需要额外的事件处理把两件事接起来。
  const load = useCallback(async (): Promise<void> => {
    if (!benchmarkId) return;
    setLoading(true);
    try {
      const [nextDetail, other] = await Promise.all([
        fetchBenchmarkExecution(benchmarkId, compareWith || null),
        fetchBenchmarkExecutions(),
      ]);
      setDetail(nextDetail);
        setExecutions(other);
        setProblem(null);
      } catch (e) {
        setProblem(e instanceof RunApiError ? e.message : "读取执行详情失败");
      } finally {
        setLoading(false);
      }
    },
    [benchmarkId, compareWith],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const execution = detail?.execution ?? null;
  const aggregate = execution?.aggregate ?? null;
  const suite = detail?.suite ?? null;
  const status = benchmarkStatusLabel(execution?.status ?? "");
  const accepted = suite?.protocol.acceptedMetrics;
  const title = execution ? benchmarkExecutionTitle({ id: execution.id, label: execution.snapshot.label }) : benchmarkId;

  const metricRows = useMemo(
    () => (GROUP_TAB[tab] ? benchmarkMetricRowsOfGroup(aggregate, GROUP_TAB[tab]) : []),
    [tab, aggregate],
  );

  const comparisonRows = useMemo(() => benchmarkComparisonRows(detail?.comparison ?? null), [detail]);
  const groupRows = useMemo(
    () => ({
      genre: benchmarkGroupRows(aggregate?.byGenre),
      tag: benchmarkGroupRows(aggregate?.byTag),
    }),
    [aggregate],
  );
  const sampleRows = useMemo(
    () => (execution ? execution.samples.map((sample) => benchmarkSampleRowOf(sample, accepted)) : []),
    [execution, accepted],
  );

  const isBaseline = detail?.isBaseline === true;

  async function toggleBaseline(): Promise<void> {
    if (!execution) return;
    try {
      const next = await postBenchmarkBaseline(execution.id, !isBaseline);
      toast.success(next ? "已标为基线（仅本次会话）" : "已取消基线标记");
      await load();
    } catch (e) {
      toast.error(e instanceof RunApiError ? e.message : "标记基线失败");
    }
  }

  if (problem !== null && detail === null) {
    return (
      <div className="h-full overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <Link href="/benchmarks" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            回到 Benchmark 列表
          </Link>
          <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{problem}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <Link href="/benchmarks" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          回到 Benchmark 列表
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight truncate">{title}</h1>
            <p className="text-[11px] text-muted-foreground font-mono mt-1">
              {execution ? `${execution.suiteId}@${execution.suiteVersion} · ${benchmarkId}` : benchmarkId}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {execution ? `开始于 ${benchmarkTimestampLabel(execution.startedAt)}` : ""}
              {execution?.completedAt ? ` · 结束于 ${benchmarkTimestampLabel(execution.completedAt)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={BADGE_VARIANT[status.tone]}>{status.label}</Badge>
            <Button size="sm" variant="outline" onClick={toggleBaseline} disabled={!execution}>
              <Star className={`h-3.5 w-3.5 ${isBaseline ? "fill-current" : ""}`} />
              {isBaseline ? "取消基线" : "标为基线"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadBenchmarkExport(benchmarkId, "json", `${benchmarkId}.json`)}
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadBenchmarkExport(benchmarkId, "csv", `${benchmarkId}.csv`)}
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>

        {isBaseline ? (
          <p className="rounded-2xl border border-border bg-muted/40 px-4 py-3 text-[11px] text-muted-foreground">
            基线只是本次会话里的一个标签（§93）：它不参与排序、不进导出文件、刷新页面就忘。
          </p>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                tab === item.key
                  ? "bg-violet-600 text-white"
                  : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <div className="space-y-5">
            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-2">
              <h2 className="text-sm font-bold tracking-tight">这一次测到了什么</h2>
              {aggregate ? (
                <ul className="text-[11px] space-y-1">
                  <li className="flex justify-between gap-3">
                    <span className="text-muted-foreground">样本</span>
                    <span className="font-mono">
                      {aggregate.completedSamples} 完成 / {aggregate.failedSamples} 失败 / 共 {aggregate.totalSamples} 条
                    </span>
                  </li>
                  <li className="flex justify-between gap-3">
                    <span className="text-muted-foreground">整体质量均值</span>
                    <span className="font-mono">
                      {benchmarkMetricText(aggregate.metrics?.overall_quality?.mean ?? null, "score")}
                      {" · "}
                      {aggregate.metrics?.overall_quality?.count ?? 0} 条样本有值
                    </span>
                  </li>
                  <li className="flex justify-between gap-3">
                    <span className="text-muted-foreground">PASS（阈值来自 Suite 协议）</span>
                    <span className="font-mono">{benchmarkPassText(aggregate)}</span>
                  </li>
                </ul>
              ) : (
                <p className="text-[11px] text-muted-foreground">这次执行还没有聚合结果：可能仍在运行，也可能没有一条样本跑成。</p>
              )}
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-2">
                <h2 className="text-sm font-bold tracking-tight">协议</h2>
                <ul className="text-[11px] space-y-1">
                  {benchmarkProtocolRows(suite).map((row) => (
                    <li key={row.label} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-mono text-right">{row.value}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-2">
                <h2 className="text-sm font-bold tracking-tight">环境快照</h2>
                <ul className="text-[11px] space-y-1">
                  {benchmarkSnapshotRows(detail).map((row) => (
                    <li key={row.label} className="flex justify-between gap-3">
                      <span className="text-muted-foreground shrink-0">{row.label}</span>
                      <span className="font-mono text-right truncate" title={row.value}>
                        {row.value}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-muted-foreground/70 pt-1">
                  只记录模型名与提示词摘要，不记录任何密钥或接口地址。
                </p>
              </section>
            </div>

            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-bold tracking-tight">按题材 / 按标签（来自题面元数据）</h2>
              <GroupTable title="按题材" rows={groupRows.genre} />
              <GroupTable title="按标签" rows={groupRows.tag} />
            </section>

            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-bold tracking-tight">和另一次执行放在一起</h2>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={compareWith}
                  onChange={(e) => setCompareWith(e.target.value)}
                  className="h-9 rounded-xl border border-border bg-background/60 px-3 text-xs"
                >
                  <option value="">不比较</option>
                  {executions
                    .filter((item) => item.id !== benchmarkId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {benchmarkExecutionTitle(item)}（{item.suiteId}@{item.suiteVersion}）
                      </option>
                    ))}
                </select>
                <span className="text-[11px] text-muted-foreground">
                  只把两边的均值并排摆出来。差值只是减法，不说明哪一次更好。
                </span>
              </div>
              {detail?.comparison ? (
                <div className="space-y-2">
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">指标</th>
                          <th className="px-3 py-2 text-right font-medium">基准</th>
                          <th className="px-3 py-2 text-right font-medium">这一次</th>
                          <th className="px-3 py-2 text-right font-medium">差值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparisonRows.map((row) => (
                          <tr key={row.metric} className="border-t border-border">
                            <td className="px-3 py-2">{row.label}</td>
                            <td className="px-3 py-2 text-right font-mono">{row.baseText}</td>
                            <td className="px-3 py-2 text-right font-mono">{row.targetText}</td>
                            <td className="px-3 py-2 text-right font-mono">
                              {row.deltaText}
                              {row.deltaPercentText !== BENCHMARK_EMPTY ? (
                                <span className="ml-1 text-muted-foreground">({row.deltaPercentText})</span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{detail.comparison.caveat}</p>
                  <p className="text-[10px] text-muted-foreground/70">
                    两次执行的题面、协议、模型、参数只要有一样不同，这两个数就不可比——快照在上面两栏里，请自己核对。
                  </p>
                </div>
              ) : null}
            </section>
          </div>
        )}

        {GROUP_TAB[tab] && (
          <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-bold tracking-tight">{benchmarkMetricGroups().find((g) => g.group === GROUP_TAB[tab])?.label}</h2>
              <span className="text-[11px] text-muted-foreground">按注册表顺序读数，不按数值重排</span>
            </div>
            {metricRows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">这份 Suite 没有采纳这一组的指标。</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">指标</th>
                      <th className="px-3 py-2 text-right font-medium">均值</th>
                      <th className="px-3 py-2 text-right font-medium">区间</th>
                      <th className="px-3 py-2 text-right font-medium">有值样本</th>
                      <th className="px-3 py-2 text-left font-medium">口径</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricRows.map((row) => (
                      <tr key={row.key} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div>{row.label}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{row.key}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{row.meanText}</td>
                        <td className="px-3 py-2 text-right font-mono">{row.rangeText}</td>
                        <td className="px-3 py-2 text-right font-mono">{row.countText}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {row.sourceLabel} · {row.definition}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <BenchmarkBarChart
              tone="violet"
              items={metricRows.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.mean,
                display: row.meanText,
              }))}
              emptyText="这一组还没有任何有值指标"
            />
          </section>
        )}

        {tab === "failure" && (
          <div className="space-y-4">
            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-bold tracking-tight">失败类别</h2>
              <FailureRows aggregate={aggregate} />
              <p className="text-[10px] text-muted-foreground/70">
                类别来自失败分析已经分好的结论，Benchmark 自己不再推断一次。
              </p>
            </section>
            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-bold tracking-tight">失败样本</h2>
              {sampleRows.filter((row) => row.status === "failed").length === 0 ? (
                <p className="text-[11px] text-muted-foreground">没有失败的样本。</p>
              ) : (
                <ul className="space-y-1.5">
                  {sampleRows
                    .filter((row) => row.status === "failed")
                    .map((row) => (
                      <li key={`${row.caseId}-${row.repetition}`} className="rounded-xl border border-border bg-background/40 px-3 py-2">
                        <div className="text-[11px] font-mono">
                          {row.caseId} · 第 {row.repetition} 次
                        </div>
                        <div className="text-[11px] text-muted-foreground">{row.failure ?? "未记录失败原因"}</div>
                        {row.runId ? (
                          <Link href={`/runs/${encodeURIComponent(row.runId)}`} className="text-[11px] text-violet-600 hover:underline">
                            看这条 Run 的产物
                          </Link>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {tab === "samples" && (
          <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-sm font-bold tracking-tight">样本</h2>
              <span className="text-[11px] text-muted-foreground">
                每条样本只列指标与失败原因，不含正文、不含提示词
              </span>
            </div>
            {sampleRows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">还没有样本数据。</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">题</th>
                      <th className="px-3 py-2 text-left font-medium">次数</th>
                      <th className="px-3 py-2 text-left font-medium">Run</th>
                      <th className="px-3 py-2 text-left font-medium">状态</th>
                      <th className="px-3 py-2 text-left font-medium">耗时</th>
                      {sampleRows[0]?.metrics.map((metric) => (
                        <th key={metric.key} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          {metric.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows.map((row) => (
                      <tr key={`${row.caseId}-${row.repetition}`} className="border-t border-border">
                        <td className="px-3 py-2 font-mono">{row.caseId}</td>
                        <td className="px-3 py-2 font-mono">{row.repetition}</td>
                        <td className="px-3 py-2 font-mono">
                          {row.runId ? (
                            <Link href={`/runs/${encodeURIComponent(row.runId)}`} className="text-violet-600 hover:underline">
                              {row.runId}
                            </Link>
                          ) : (
                            BENCHMARK_EMPTY
                          )}
                        </td>
                        <td className="px-3 py-2">{row.status === "completed" ? "跑成" : "失败"}</td>
                        <td className="px-3 py-2 font-mono">{row.durationText}</td>
                        {row.metrics.map((metric) => (
                          <td key={metric.key} className="px-3 py-2 text-right font-mono">
                            {metric.text}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">整体质量这一项，哪些样本有值：</p>
              <BenchmarkDistributionChart
                label="整体质量有值样本"
                total={sampleRows.length}
                measured={sampleRows.filter((row) => row.metrics.find((m) => m.key === "overall_quality")?.text !== BENCHMARK_EMPTY).length}
                cells={sampleRows.map((row) => ({
                  key: `${row.caseId}-${row.repetition}`,
                  hasValue: row.metrics.find((m) => m.key === "overall_quality")?.text !== BENCHMARK_EMPTY,
                }))}
              />
            </div>
          </section>
        )}

        {suite && (
          <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-2">
            <h2 className="text-sm font-bold tracking-tight">题目</h2>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-[11px]">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">id</th>
                    <th className="px-3 py-2 text-left font-medium">标题</th>
                    <th className="px-3 py-2 text-left font-medium">题材</th>
                    <th className="px-3 py-2 text-left font-medium">规划方式</th>
                    <th className="px-3 py-2 text-left font-medium">标签</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarkCaseRows(suite).map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono">{row.id}</td>
                      <td className="px-3 py-2">{row.title}</td>
                      <td className="px-3 py-2">{row.genre}</td>
                      <td className="px-3 py-2">{row.mode}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.tags || BENCHMARK_EMPTY}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** 按题材 / 按标签的小表。没有分组就整段不画——空表会被读成「测过但没有差异」。 */
function GroupTable({ title, rows }: { title: string; rows: ReturnType<typeof benchmarkGroupRows> }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[11px]">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{title}</th>
              <th className="px-3 py-2 text-right font-medium">题数</th>
              <th className="px-3 py-2 text-right font-medium">样本</th>
              <th className="px-3 py-2 text-right font-medium">失败</th>
              <th className="px-3 py-2 text-right font-medium">整体质量</th>
              <th className="px-3 py-2 text-right font-medium">失败率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-t border-border">
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2 text-right font-mono">{row.caseCount}</td>
                <td className="px-3 py-2 text-right font-mono">{row.sampleCount}</td>
                <td className="px-3 py-2 text-right font-mono">{row.failedSamples}</td>
                <td className="px-3 py-2 text-right font-mono">{row.overallQuality}</td>
                <td className="px-3 py-2 text-right font-mono">{row.failureRate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 失败类别 + 阶段分布。类别顺序固定，不按条数重排。 */
function FailureRows({ aggregate }: { aggregate: BenchmarkExecutionDetailApi["execution"]["aggregate"] }) {
  const rows = benchmarkFailureRows(aggregate);
  const stages = benchmarkStageRows(aggregate);
  if (rows.length === 0 && stages.length === 0) {
    return <p className="text-[11px] text-muted-foreground">没有失败记录。</p>;
  }
  return (
    <div className="space-y-3">
      <BenchmarkBarChart
        tone="amber"
        items={rows.map((row) => ({ key: row.category, label: row.label, value: row.count, display: `×${row.count}` }))}
        emptyText="没有失败记录"
      />
      {stages.length > 0 && (
        <ul className="text-[11px] space-y-1">
          {stages.map((row) => (
            <li key={row.stage} className="flex justify-between gap-3">
              <span className="text-muted-foreground font-mono">{row.stage}</span>
              <span className="font-mono">×{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
