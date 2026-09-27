"use client";

/**
 * v2.3.0 Benchmark 图表（TASK §90/§91）。
 *
 * 只画三种图，没有图表库，也没有第四种：
 *   1. `BenchmarkBarChart` —— 横向条形：指标均值、失败类别计数、分组对比都用它；
 *   2. `BenchmarkLineChart` —— 折线：执行历史（整体质量 / 商业 / 失败率 / 耗时）；
 *   3. `BenchmarkDistributionChart` —— 计数分布：一条样本里各指标的「有值 / 无数」。
 *
 * 两条写死在实现里的规矩：
 *   - **没有数就不画**。null 不补 0、不插值、不外推：折线在缺失点断开，
 *     条形不留半根。读者看到的空缺就是数据的空缺（§92 不编时间序列）。
 *   - **坐标轴从 0 开始，没有对数轴、没有双轴**。0 基线是读数的一部分，
 *     截断轴会把「74 与 71」画成天差地别，那是本版本不做的暗示（§26 不排名）。
 */

import { benchmarkMetricText } from "@/interface/benchmark-view";

export interface BenchmarkBarItem {
  key: string;
  label: string;
  /** null = 没有测到这个数。条形整段不画，只留文字。 */
  value: number | null;
  /** 已经格式化好的文字；没有就由 unit + value 现场算。 */
  display?: string;
  unit?: string;
  /** 右侧补充说明（例如「5/8 条样本」）。 */
  note?: string;
}

/** 横向条形图。最大值缺省取数据里的最大正值；全为 null 时整段显示占位。 */
export function BenchmarkBarChart({
  items,
  max,
  emptyText = "还没有可画的数据",
  tone = "violet",
}: {
  items: readonly BenchmarkBarItem[];
  max?: number;
  emptyText?: string;
  tone?: "violet" | "emerald" | "amber";
}) {
  const withValue = items.filter((item) => typeof item.value === "number" && Number.isFinite(item.value));
  const ceiling = max ?? (withValue.length > 0 ? Math.max(...withValue.map((item) => item.value as number)) : 0);
  const fill =
    tone === "emerald" ? "bg-emerald-500/70" : tone === "amber" ? "bg-amber-500/70" : "bg-violet-500/70";

  if (withValue.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
        <p className="text-[11px] text-muted-foreground">{emptyText}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const value = typeof item.value === "number" && Number.isFinite(item.value) ? item.value : null;
        const text = item.display ?? (value === null ? "—" : benchmarkMetricText(value, item.unit ?? "score"));
        const width = value === null || ceiling <= 0 ? 0 : Math.max(1.5, (value / ceiling) * 100);
        return (
          <li key={item.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2">
            <span className="truncate text-[11px] text-muted-foreground" title={item.label}>
              {item.label}
            </span>
            <span className="relative h-2 rounded-full bg-muted overflow-hidden">
              {value === null ? (
                <span className="absolute inset-0 border border-dashed border-border rounded-full" aria-hidden />
              ) : (
                <span className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${width}%` }} aria-hidden />
              )}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-right min-w-[3.5rem]">
              {text}
              {item.note ? <span className="ml-1 text-[10px] text-muted-foreground">{item.note}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface BenchmarkLinePoint {
  label: string;
  value: number | null;
}

/**
 * 折线图（执行历史，§91）。
 *
 * 一个图只画一条线、只用一种单位——把 0~100 的分数和几千毫秒的耗时塞进同一张
 * 双轴图会让两个数都能被读出不存在的关系，所以一指标一张小图。
 */
export function BenchmarkLineChart({
  title,
  unit,
  points,
  emptyText = "还没有测到这个指标",
  height = 96,
}: {
  title: string;
  unit: string;
  points: readonly BenchmarkLinePoint[];
  emptyText?: string;
  height?: number;
}) {
  const known = points.filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
  if (known.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
        <p className="text-[11px] text-muted-foreground">{emptyText}</p>
      </div>
    );
  }

  const width = 320;
  const padX = 10;
  const padY = 12;
  const values = known.map((point) => point.value as number);
  const ceiling = Math.max(...values, 1);
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const xOf = (index: number): number => padX + step * index;
  const yOf = (value: number): number => height - padY - (value / ceiling) * (height - padY * 2);

  // 逐段连线：中间出现 null 就断开，绝不跨过缺口插值（§92）
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xOf(index).toFixed(1)},${yOf(point.value as number).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{title}</span>
        <span className="font-mono text-[11px] tabular-nums">
          {benchmarkMetricText(values[values.length - 1] as number, unit)}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${title}：${known.length} 个有值数据点，最新 ${benchmarkMetricText(values[values.length - 1] as number, unit)}`}
      >
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} className="stroke-border" strokeWidth={1} />
        {segments.map((segment) => (
          <polyline key={segment} points={segment} fill="none" className="stroke-violet-500" strokeWidth={1.5} strokeLinejoin="round" />
        ))}
        {points.map((point, index) =>
          point.value === null ? null : (
            <circle
              key={`${point.label}-${index}`}
              cx={xOf(index)}
              cy={yOf(point.value as number)}
              r={2.5}
              className="fill-violet-500"
            />
          ),
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground/70 font-mono">
        <span className="truncate max-w-[45%]">{points[0]?.label ?? ""}</span>
        <span className="truncate max-w-[45%] text-right">{points[points.length - 1]?.label ?? ""}</span>
      </div>
    </figure>
  );
}

/**
 * 计数分布（§90 的 distribution counts）。
 * 每一格代表一条样本：有值画实心，没有画空心。分子分母都看得见。
 */
export function BenchmarkDistributionChart({
  cells,
  total,
  measured,
  label,
}: {
  cells: readonly { key: string; hasValue: boolean }[];
  total: number;
  measured: number;
  label: string;
}) {
  if (total <= 0 || cells.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
        <p className="text-[11px] text-muted-foreground">还没有样本</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1" role="img" aria-label={`${label}：${measured}/${total} 条样本有值`}>
        {cells.map((cell) => (
          <span
            key={cell.key}
            className={`h-3 w-3 rounded-[3px] ${cell.hasValue ? "bg-violet-500/70" : "border border-dashed border-border"}`}
            title={cell.hasValue ? "有值" : "没有这个数"}
          />
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground font-mono">
        {measured}/{total} 条样本有值
      </p>
    </div>
  );
}
