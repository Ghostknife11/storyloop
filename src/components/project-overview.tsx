"use client";

import { Badge } from "@/components/ui/badge";
import type { DocumentSummaryApi, ProjectDetailApi, ProjectHealthApi, RunDetailApi } from "@/interface/api";
import {
  currentDocumentLabel,
  documentStatusLabel,
  healthStatusLabel,
  timestampLabel,
  type OverviewRow,
  type Tone,
} from "@/interface/workspace-view";

/**
 * §15 项目总览。
 *
 * 九行分别是：项目名、当前稿件、最近更新、最近一次 Run、质量结论、商业结论、
 * Run 数、稿件数、收藏状态。其中"最近一次 Run / 质量 / 商业"三行的值来自
 * /api/runs/<run_id> 已经给出的事实，这里只读不算——缺的显示「—」，不补 0。
 */

const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  neutral: "outline",
  good: "default",
  warn: "secondary",
  bad: "destructive",
};

interface Props {
  detail: ProjectDetailApi;
  documents: DocumentSummaryApi[];
  health: ProjectHealthApi | null;
  /**
   * 最近一次 Run 的读回结果；没有 Run 时是 null。
   * 直接吃 RunDetailApi（snake_case 的 v1 DTO），不另造一份驼峰镜像：
   * 两处形状一旦不一致，界面上那句「—」就会变成一个编出来的数字。
   */
  latestRun: RunDetailApi | null;
}

function outcomeLabel(outcome: RunDetailApi["quality_status"]): string {
  if (outcome === "accepted") return "质量通过";
  if (outcome === "exhausted") return "重试后仍未通过";
  return "—";
}

function scoreLabel(score: number | null): string {
  // 没有分数就没有数字（§39）：不补 0，不显示「略」
  return typeof score === "number" && Number.isFinite(score) ? String(score) : "—";
}

export function ProjectOverview({ detail, documents, health, latestRun }: Props) {
  const current = detail.project.currentDocumentId
    ? documents.find((d) => d.id === detail.project.currentDocumentId) ?? null
    : null;
  const currentStatus = current ? documentStatusLabel(current.status) : null;
  const healthStatus = health ? healthStatusLabel(health.status) : null;

  const rows: OverviewRow[] = [
    { label: "项目名", value: detail.project.name, tone: "neutral" },
    { label: "当前稿件", value: current ? current.title : "还没有稿件", tone: current ? "good" : "neutral" },
    { label: "最近更新", value: timestampLabel(detail.project.updatedAt), tone: "neutral" },
    {
      label: "最近一次 Run",
      value: latestRun ? `${latestRun.run_id} · ${outcomeLabel(latestRun.quality_status)}` : "还没有 Run",
      tone: latestRun?.quality_status === "accepted" ? "good" : latestRun ? "warn" : "neutral",
    },
    {
      label: "质量结论",
      value: scoreLabel(latestRun?.review?.score ?? null),
      tone: "neutral",
    },
    {
      label: "商业可读性",
      value: scoreLabel(latestRun?.commercial_review?.score ?? null),
      tone: "neutral",
    },
    { label: "Run 数", value: String(detail.runIds.length), tone: "neutral" },
    { label: "稿件数", value: String(detail.documentIds.length), tone: "neutral" },
    { label: "收藏", value: detail.project.isFavorite ? "已收藏" : "未收藏", tone: "neutral" },
  ];

  return (
    <div className="space-y-4">
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 rounded-xl bg-card px-3 py-2.5 text-sm ring-1 ring-border/50 dark:ring-white/10">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="flex items-center gap-2 truncate">
              <span className="truncate">{row.value}</span>
              {row.tone !== "neutral" && (
                <Badge variant={TONE_VARIANT[row.tone]}>
                  {row.tone === "good" ? "正常" : row.tone === "warn" ? "待处理" : "有问题"}
                </Badge>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">项目状态</span>
        {healthStatus && <Badge variant={TONE_VARIANT[healthStatus.tone]}>{healthStatus.label}</Badge>}
        <span className="text-muted-foreground">当前稿件</span>
        {currentStatus ? (
          <Badge variant={TONE_VARIANT[currentStatus.Tone]}>{currentStatus.label}</Badge>
        ) : (
          <span>{currentDocumentLabel(current?.title ?? null)}</span>
        )}
      </div>

      {detail.runIds.length > 0 && (
        <div className="text-sm">
          <p className="text-muted-foreground">最近的 Run</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {detail.runIds.slice(0, 5).map((runId) => (
              <li key={runId}>
                {/* 本版本没有 /runs/<id> 页面（TASK §39）：与实验页同一约定，直读 JSON 接口。
                    写死 /runs/<id> 会出现一个 404 入口，那等于承诺了一个没有的能力。 */}
                <a
                  href={`/api/runs/${encodeURIComponent(runId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-card px-2 py-1 font-mono text-xs ring-1 ring-border/50 hover:underline dark:ring-white/10"
                >
                  {runId}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
