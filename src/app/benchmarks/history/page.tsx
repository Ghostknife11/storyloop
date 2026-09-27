"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BenchmarkLineChart } from "@/components/benchmark-charts";
import {
  fetchBenchmarkHistory,
  fetchBenchmarkSuites,
  RunApiError,
  type BenchmarkHistoryPointApi,
  type BenchmarkSuiteItemApi,
} from "@/interface/api";
import {
  benchmarkHistoryLines,
  benchmarkHistorySeries,
  benchmarkMetricText,
  benchmarkStatusLabel,
  benchmarkTimestampLabel,
} from "@/interface/benchmark-view";

/**
 * `/benchmarks/history`（v2.3.0 §91）：同一份 Suite 的历次执行摆成折线。
 *
 * 两条写死在实现里的规矩：
 *   - **没有的点就不画**（§92）。图上的横轴是真实发生过的执行，缺指标的点让线断开，
 *     不做插值、不按时间补点；「这一版没测过」和「这一版测出来是 0」在图上完全不同。
 *   - **一指标一张小图**。分数（0~100）与耗时（毫秒）不共用坐标轴——硬画在一起
 *     只会让读者读出两个数之间不存在的关系。
 */

const LINES = [
  { key: "overallQuality", label: "整体质量", unit: "score" },
  { key: "commercialOverall", label: "商业可读性", unit: "score" },
  { key: "failureRate", label: "样本失败率", unit: "percent" },
  { key: "durationMs", label: "平均耗时", unit: "ms" },
] as const;

export default function BenchmarkHistoryPage() {
  const [suites, setSuites] = useState<BenchmarkSuiteItemApi[]>([]);
  const [suiteId, setSuiteId] = useState("");
  const [points, setPoints] = useState<BenchmarkHistoryPointApi[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // 取数不清空旧数据：换 Suite 的瞬间保留上一份读数，比闪一下空白更接近事实
  const load = useCallback(async (): Promise<void> => {
    try {
      setPoints(await fetchBenchmarkHistory(suiteId || undefined));
      setProblem(null);
    } catch (e) {
      setPoints([]);
      setProblem(e instanceof RunApiError ? e.message : "读取执行历史失败");
    }
  }, [suiteId]);

  useEffect(() => {
    fetchBenchmarkSuites()
      .then(setSuites)
      .catch(() => setSuites([]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const series = useMemo(() => benchmarkHistorySeries(points ?? []), [points]);
  const available = useMemo(() => new Set(benchmarkHistoryLines(series).map((line) => line.key)), [series]);

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <Link href="/benchmarks" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          回到 Benchmark 列表
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">执行历史</h1>
            <p className="text-xs text-muted-foreground mt-1">
              同一份 Suite 历次测量的读数。只画真实保存过的执行，缺指标的地方线会断开
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={suiteId}
              onChange={(e) => setSuiteId(e.target.value)}
              className="h-9 rounded-xl border border-border bg-background/60 px-3 text-xs"
            >
              <option value="">全部 Suite</option>
              {suites.map((item) => (
                <option key={`${item.id}@${item.version}`} value={item.id}>
                  {item.id}@{item.version}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>

        {problem !== null && (
          <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{problem}</p>
        )}

        {points === null ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : series.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center">
            <p className="text-xs text-muted-foreground">还没有执行记录。跑第一次测量，这里才会有线。</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {LINES.filter((line) => available.has(line.key)).map((line) => (
                <div key={line.key} className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4">
                  <BenchmarkLineChart
                    title={line.label}
                    unit={line.unit}
                    points={series.map((point) => ({ label: point.label, value: point[line.key] }))}
                    emptyText={`还没有测到${line.label}`}
                  />
                </div>
              ))}
            </div>

            <section className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-2">
              <h2 className="text-sm font-bold tracking-tight">明细</h2>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">执行</th>
                      <th className="px-3 py-2 text-left font-medium">Suite</th>
                      <th className="px-3 py-2 text-left font-medium">时间</th>
                      <th className="px-3 py-2 text-left font-medium">状态</th>
                      <th className="px-3 py-2 text-right font-medium">整体质量</th>
                      <th className="px-3 py-2 text-right font-medium">商业可读性</th>
                      <th className="px-3 py-2 text-right font-medium">失败率</th>
                      <th className="px-3 py-2 text-right font-medium">平均耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((point) => {
                      const status = benchmarkStatusLabel(point.status);
                      return (
                        <tr key={point.id} className="border-t border-border">
                          <td className="px-3 py-2">
                            <Link href={`/benchmarks/${encodeURIComponent(point.id)}`} className="text-violet-600 hover:underline">
                              {point.label}
                            </Link>
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {point.suiteId}@{point.suiteVersion}
                          </td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{benchmarkTimestampLabel(point.startedAt)}</td>
                          <td className="px-3 py-2">{status.label}</td>
                          <td className="px-3 py-2 text-right font-mono">{benchmarkMetricText(point.overallQuality, "score")}</td>
                          <td className="px-3 py-2 text-right font-mono">{benchmarkMetricText(point.commercialOverall, "score")}</td>
                          <td className="px-3 py-2 text-right font-mono">{benchmarkMetricText(point.failureRate, "percent")}</td>
                          <td className="px-3 py-2 text-right font-mono">{benchmarkMetricText(point.durationMs, "ms")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground/70">
                这张表按时间正序：执行历史是「什么时候测的」，不是排行榜。
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
