"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Gauge, Play, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  downloadBenchmarkExport,
  fetchBenchmarkExecutions,
  fetchBenchmarkSuites,
  postBenchmarkBaseline,
  RunApiError,
  startBenchmarkRun,
  type BenchmarkExecutionItemApi,
  type BenchmarkSuiteItemApi,
} from "@/interface/api";
import {
  benchmarkExecutionRow,
  benchmarkOriginLabel,
  benchmarkStatusLabel,
  benchmarkSuiteRow,
  benchmarkTimestampLabel,
} from "@/interface/benchmark-view";

/**
 * `/benchmarks`（v2.3.0 §88）：Suite 列表 + 执行历史 + 「跑一次测量」。
 *
 * 这一页只做三件事：看有哪些固定题面、看过去测过什么、跑一次新的测量。
 * 刻意没有的东西，和没有的理由：
 *   - 没有「跑分排行 / 谁更好」（§26 不排名）：执行列表按时间倒序，
 *     指标表按注册表顺序，任何一处都不按数值重排；
 *   - 没有「按上次结果自动调整」入口（§2 Benchmark 不控制生成）：页面上的
 *     每个按钮都只是「发起一次测量」或「导出一份结果」；
 *   - 没有删入口（§44）：执行与 Suite 一经落盘不可变，改条件就换标签再跑一次。
 */

const LARGE_RUN_HINT = "样本数超过 30 会真实调用模型，勾选后才允许发起。";

export default function BenchmarksPage() {
  const router = useRouter();
  const [suites, setSuites] = useState<BenchmarkSuiteItemApi[] | null>(null);
  const [executions, setExecutions] = useState<BenchmarkExecutionItemApi[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [suiteId, setSuiteId] = useState("");
  const [label, setLabel] = useState("");
  const [allowLarge, setAllowLarge] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchBenchmarkSuites(), fetchBenchmarkExecutions()])
      .then(([nextSuites, nextExecutions]) => {
        setSuites(nextSuites);
        setExecutions(nextExecutions);
        setProblem(null);
        setSuiteId((prev) => (prev || nextSuites.length === 0 ? prev : nextSuites[0]?.id ?? ""));
      })
      .catch((e) => {
        setSuites([]);
        setExecutions([]);
        setProblem(e instanceof RunApiError ? e.message : "读取 Benchmark 数据失败");
      });
  }, []);

  useEffect(load, [load]);

  const selected = suites?.find((item) => item.id === suiteId) ?? null;
  const planned = selected?.plannedSamples ?? 0;
  const needsConfirm = planned > 30;

  async function startRun(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      const execution = await startBenchmarkRun({
        suiteId: selected.id,
        suiteVersion: selected.version,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(needsConfirm ? { allowLargeBenchmark: allowLarge } : {}),
      });
      toast.success(`已开始测量：${selected.id}@${selected.version}，${planned} 条样本`);
      router.push(`/benchmarks/${encodeURIComponent(execution.id)}`);
    } catch (e) {
      const message = e instanceof RunApiError ? e.message : "发起测量失败";
      setProblem(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleBaseline(item: BenchmarkExecutionItemApi): Promise<void> {
    try {
      const next = await postBenchmarkBaseline(item.id, !item.isBaseline);
      toast.success(next ? `已把 ${item.id} 标为基线（仅本次会话）` : `已取消 ${item.id} 的基线标记`);
      load();
    } catch (e) {
      toast.error(e instanceof RunApiError ? e.message : "标记基线失败");
    }
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Benchmarks</h1>
            <p className="text-xs text-muted-foreground mt-1">
              固定题面、固定协议，反复测量这条流水线；只出数字，不改任何生成参数
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>

        <p className="rounded-2xl border border-border bg-muted/40 px-4 py-3 text-[11px] text-muted-foreground">
          Benchmark measures the system. Benchmark does not control the system.
          —— 这一页上的每个操作都只是「测一次」或「导出一份结果」，没有任何按钮会改动模型、提示词、温度或重试策略。
        </p>

        {problem !== null && (
          <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{problem}</p>
        )}

        <section className="space-y-3 rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-bold tracking-tight">跑一次测量</h2>
            <p className="text-[11px] text-muted-foreground mt-1">
              执行用的是当前服务的默认配置。这一次的结果只描述「当前这一版是什么表现」，不构成任何调参建议。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Suite（题面 + 协议，落盘后不可变）</Label>
              <select
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-background/60 px-3 text-sm"
                disabled={suites === null || suites.length === 0}
              >
                {suites === null ? <option value="">加载中…</option> : null}
                {suites?.length === 0 ? <option value="">还没有 Suite</option> : null}
                {(suites ?? []).map((item) => (
                  <option key={`${item.id}@${item.version}`} value={item.id}>
                    {item.id}@{item.version}（{item.plannedSamples} 条样本）
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">说明（可选，写「这次为什么测」）</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如：2.3.0 发布前的第一次基线"
                maxLength={120}
                className="h-10"
              />
            </div>
          </div>

          {selected && (
            <div className="rounded-xl border border-border bg-background/40 px-3 py-2.5 space-y-1">
              <p className="text-[11px] text-muted-foreground">
                {benchmarkOriginLabel(selected.source)} · Suite 摘要{" "}
                <span className="font-mono">{selected.suiteDigest.slice(0, 12)}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">
                这一次会真实调用模型 <span className="font-mono">{planned}</span> 次（{selected.caseCount} 道题 ×{" "}
                {selected.repetitions} 次）。同样配置并不保证模型输出逐字节一致。
              </p>
            </div>
          )}

          {needsConfirm && (
            <label className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
              <input
                type="checkbox"
                checked={allowLarge}
                onChange={(e) => setAllowLarge(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span className="text-[11px] text-muted-foreground">
                {LARGE_RUN_HINT}当前计划 <span className="font-mono">{planned}</span> 条样本。
              </span>
            </label>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-muted-foreground">
              执行过程中可以离开这个页面：进度每次样本完成后落盘，回来刷新就能看到。
            </p>
            <Button size="sm" onClick={startRun} disabled={busy || !selected || (needsConfirm && !allowLarge)}>
              <Play className="h-3.5 w-3.5" />
              {busy ? "测量中…" : "开始测量"}
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">Suite</h2>
          {suites === null ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : suites.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center">
              <Gauge className="h-5 w-5 mx-auto text-muted-foreground" />
              <p className="text-xs text-muted-foreground mt-2">
                还没有 Suite。在 benchmarks/suites/ 下放一份固定题面就能开始测量。
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-hidden">
              {suites.map((item, i) => {
                const row = benchmarkSuiteRow(item);
                return (
                  <div key={`${item.id}@${item.version}`} className={`px-4 sm:px-5 py-3.5 ${i > 0 ? "border-t border-border" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{row.name}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          {item.id}@{item.version}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{row.subtitle}</div>
                        {row.description ? (
                          <div className="text-[11px] text-muted-foreground mt-1">{row.description}</div>
                        ) : null}
                        <div className="text-[11px] text-muted-foreground">{row.origin}</div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setSuiteId(item.id)}>
                        选它
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            执行历史
            <Link href="/benchmarks/history" className="ml-2 text-violet-600 hover:underline">
              看历史图
            </Link>
          </h2>
          {executions === null ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : executions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center">
              <Gauge className="h-5 w-5 mx-auto text-muted-foreground" />
              <p className="text-xs text-muted-foreground mt-2">还没有测过。选一份 Suite，跑第一次。</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-hidden">
              {executions.map((item, i) => {
                const row = benchmarkExecutionRow(item);
                const status = benchmarkStatusLabel(item.status);
                return (
                  <div key={item.id} className={`px-4 sm:px-5 py-3.5 ${i > 0 ? "border-t border-border" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <Link href={`/benchmarks/${encodeURIComponent(item.id)}`} className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {row.title}
                          {item.isBaseline ? (
                            <Badge variant="secondary" className="ml-2 align-middle">
                              基线
                            </Badge>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono">{item.id}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {row.suite} · {row.subtitle} · {benchmarkTimestampLabel(item.startedAt)}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono">{row.passText}</div>
                      </Link>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {item.completedSamples} 完成 / {item.failedSamples} 失败
                        </span>
                        <Badge
                          variant={status.tone === "good" ? "default" : status.tone === "bad" ? "destructive" : "secondary"}
                        >
                          {status.label}
                        </Badge>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          title={item.isBaseline ? "取消基线标记（仅本次会话）" : "标为基线（仅本次会话）"}
                          onClick={() => toggleBaseline(item)}
                        >
                          <Star className={`h-3.5 w-3.5 ${item.isBaseline ? "fill-current" : ""}`} />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title="导出 JSON"
                          onClick={() => downloadBenchmarkExport(item.id, "json", `${item.id}.json`)}
                        >
                          <Download className="h-3.5 w-3.5" />
                          JSON
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title="导出 CSV"
                          onClick={() => downloadBenchmarkExport(item.id, "csv", `${item.id}.csv`)}
                        >
                          <Download className="h-3.5 w-3.5" />
                          CSV
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
