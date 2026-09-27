"use client";

import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ProjectHealthApi } from "@/interface/api";
import { healthStatusLabel, healthViewOf, timestampLabel, type Tone } from "@/interface/workspace-view";

/**
 * §39 Creator Health 面板（与 QualityPanel / ReviewPanel 同一套命名：这里是 Panel。
 * 那类"仪表盘"式的聚合视图本版本明确没有交付，所以名字里也不留那个词——免得看代码的人
 * 以为还有一屏总览指标等着被点亮）。
 *
 * 这个面板上一个数字都没有——没有分数、没有百分比、没有"建议下一步"。
 * 它只回答六个是非题：这个项目能不能继续写、最近一次 Run 正常吗、当前稿件在吗、
 * 质量诊断有 blocker 吗、是不是频繁重试、有没有可导出的稿件。
 * 结论来自 /health，那里同样只给事实（§19：Health 不做 Recommendation）。
 */

const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  neutral: "outline",
  good: "default",
  warn: "secondary",
  bad: "destructive",
};

const SEVERITY_LABEL: Record<string, string> = {
  info: "提示",
  warning: "注意",
  error: "必须处理",
};

export function HealthPanel({ health }: { health: ProjectHealthApi }) {
  const view = healthViewOf(health);
  const status = healthStatusLabel(view.status);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Activity className="size-4 text-muted-foreground" />
        <Badge variant={TONE_VARIANT[status.tone]}>{status.label}</Badge>
        <span className="text-xs text-muted-foreground">判定于 {timestampLabel(health.updatedAt)}</span>
      </div>

      {view.signals.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          这个项目现在没有需要你处理的事。
        </p>
      ) : (
        <ul className="space-y-2">
          {view.signals.map((signal) => (
            <li
              key={signal.code}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-card px-3 py-2.5 text-sm ring-1 ring-border/50 dark:ring-white/10"
            >
              <Badge variant={TONE_VARIANT[signal.severity === "error" ? "bad" : signal.severity === "warning" ? "warn" : "neutral"]}>
                {SEVERITY_LABEL[signal.severity] ?? signal.severity}
              </Badge>
              <span className="flex-1">{signal.message}</span>
              {/* §17：信号认码不认文案。文案服务端改了界面照样对得上，码摆在这儿就是为了对得上。 */}
              <span className="font-mono text-xs text-muted-foreground">{signal.code}</span>
              {signal.source && <span className="font-mono text-xs text-muted-foreground">{signal.source}</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        这里只列已经发生的事实，不给建议、不打分。要不要改、怎么改，你自己定。
      </p>
    </section>
  );
}
