"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FilePlus2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExportHistory, ExportSourceHint } from "@/components/export-history";
import { HealthPanel } from "@/components/health-panel";
import { ProjectOverview } from "@/components/project-overview";
import { QualityCenter } from "@/components/quality-center";
import { StoryEditor } from "@/components/story-editor";
import type { BeatValidationResult } from "@/domain/beat-validation";
import type { CommercialReviewResult } from "@/domain/commercial-review";
import type { ReviewResult } from "@/domain/review-result";
import {
  fetchDocuments,
  fetchExports,
  fetchProject,
  fetchProjectHealth,
  fetchRun,
  postDocumentFromRun,
  type DocumentSummaryApi,
  type ExportResultApi,
  type ProjectDetailApi,
  type ProjectHealthApi,
  type RunDetailApi,
} from "@/interface/api";
import { timestampLabel } from "@/interface/workspace-view";

/**
 * `/workspace/<id>`（v2.2.0 §14/§37）：项目内五个签。
 *
 * 五个签照 TASK 推荐的来：Overview / Editor / Runs / Quality / Exports。
 * 三条边界写在下面，因为它们都是「看起来该有、做了就过度」的地方：
 *   - 没有「删除项目 / 删除稿件」入口（§40：归档不删数据，本版本不提供永久删除）；
 *   - Runs 签不做历史列表：一次项目名下有几条 Run 就从 Manifest 归纳几条，
 *     每条只给一个链接（§39 本版本没有 /runs/<id> 页面，链接直读 JSON）；
 *   - Quality 签复用 v2.1.0 的 Quality Center，不另造一套分数口径。
 */

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "editor", label: "Editor" },
  { key: "runs", label: "Runs" },
  { key: "quality", label: "Quality" },
  { key: "exports", label: "Exports" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function ProjectWorkspacePage() {
  const params = useParams<{ id: string }>();
  const projectId = decodeURIComponent(String(params?.id ?? ""));

  const [tab, setTab] = useState<TabKey>("overview");
  const [detail, setDetail] = useState<ProjectDetailApi | null>(null);
  const [documents, setDocuments] = useState<DocumentSummaryApi[]>([]);
  const [exports, setExports] = useState<ExportResultApi[]>([]);
  const [health, setHealth] = useState<ProjectHealthApi | null>(null);
  const [latestRun, setLatestRun] = useState<RunDetailApi | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftingRunId, setDraftingRunId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [nextDetail, nextDocuments, nextExports, nextHealth] = await Promise.all([
        fetchProject(projectId),
        fetchDocuments(projectId),
        fetchExports(projectId),
        fetchProjectHealth(projectId),
      ]);
      setDetail(nextDetail);
      setDocuments(nextDocuments);
      setExports(nextExports);
      setHealth(nextHealth);
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "读取项目失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 最近一次 Run：Overview 与 Quality 两个签都要引用它，所以跟着 detail 一起取。
  // 取不到（Run 目录被清过、或一次都还没跑）就当作没有——不编一份空结论顶上。
  const latestRunId = detail?.runIds[0] ?? null;
  useEffect(() => {
    if (!latestRunId) {
      setLatestRun(null);
      return;
    }
    let cancelled = false;
    fetchRun(latestRunId)
      .then((run) => {
        if (!cancelled) setLatestRun(run);
      })
      .catch(() => {
        if (!cancelled) setLatestRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [latestRunId]);

  /** §8 Run → Draft：把一次 Run 的正文复制成一篇独立稿件。 */
  async function draftFromRun(runId: string): Promise<void> {
    setDraftingRunId(runId);
    try {
      const document = await postDocumentFromRun(projectId, { runId });
      await reload();
      toast.success(`已建稿「${document.title}」，Run 的正文一个字都没动`);
      setTab("editor");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "建稿失败");
    } finally {
      setDraftingRunId(null);
    }
  }

  const titles = useMemo(() => new Map(documents.map((d) => [d.id, d.title])), [documents]);

  if (problem !== null && detail === null) {
    return (
      <div className="h-full overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          <Link href="/workspace" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            回到项目列表
          </Link>
          <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{problem}</p>
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="grid h-full place-items-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载中…
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/workspace" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" />
              回到项目列表
            </Link>
            <h1 className="mt-1.5 flex flex-wrap items-center gap-2 text-lg font-bold tracking-tight">
              <span className="truncate">{detail.project.name}</span>
              <Badge variant={detail.project.status === "archived" ? "secondary" : "outline"}>
                {detail.project.status === "archived" ? "已归档" : "进行中"}
              </Badge>
              {detail.project.isFavorite && <Badge variant="outline">已收藏</Badge>}
            </h1>
            <p className="mt-1 text-[11px] text-muted-foreground font-mono">
              {detail.project.id} · 更新于 {timestampLabel(detail.project.updatedAt)}
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void reload()}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>

        <div role="tablist" aria-label="工作区视图" className="flex flex-wrap gap-1 border-b border-border">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === item.key
                  ? "border-violet-600 font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <section className="space-y-5">
            <ProjectOverview detail={detail} documents={documents} health={health} latestRun={latestRun} />
            {/* §16 Creator Health：与总览同一屏，不再单开一个签——它回答的是
                「这个项目还能不能接着写」，本来就和上面的九行事实连在一起看。 */}
            <div className="rounded-2xl border border-border bg-muted/40 p-4">
              <h2 className="mb-3 text-sm font-bold tracking-tight">Creator Health</h2>
              {health === null ? <p className="text-sm text-muted-foreground">健康结论读不到。</p> : <HealthPanel health={health} />}
            </div>
          </section>
        )}

        {tab === "editor" && <StoryEditor projectId={projectId} documents={documents} initialDocumentId={detail.project.currentDocumentId} />}

        {tab === "runs" && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">名下的 Run</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                归属由每次 Run 的 Manifest 自己声明（run-manifest.json 里的 projectId），不在项目文件里另存一份名单（§19）。
              </p>
            </div>
            {detail.runIds.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                还没有 Run 归到这个项目。先生成一个故事，生成完再回来把它变成第一篇稿。
              </p>
            ) : (
              <ul className="space-y-2">
                {detail.runIds.map((runId) => {
                  const drafted = documents.some((d) => d.sourceRunId === runId);
                  return (
                    <li
                      key={runId}
                      className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-3 py-2.5 text-sm ring-1 ring-border/50 dark:ring-white/10"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{runId}</span>
                      {runId === latestRunId && <Badge variant="outline">最近一次</Badge>}
                      {drafted && <Badge variant="secondary">已建稿</Badge>}
                      {/* §39 本版本没有 /runs/<id> 页面：与实验页同一约定，直读 JSON */}
                      <a
                        href={`/api/runs/${encodeURIComponent(runId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg px-2 py-1 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
                      >
                        看这次 Run
                      </a>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={draftingRunId !== null}
                        onClick={() => void draftFromRun(runId)}
                      >
                        {draftingRunId === runId ? <Loader2 className="size-3.5 animate-spin" /> : <FilePlus2 className="size-3.5" />}
                        {drafted ? "再复制一份" : "变成稿件"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {tab === "quality" && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">质量</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                这里摆的是最近一次 Run 已经给出的结论，不重跑、不代替你判断。
              </p>
            </div>
            {latestRun === null ? (
              <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                还读不到任何一次 Run 的结论。
              </p>
            ) : (
              <QualityCenter
                qualityStack={latestRun.qualityStack}
                review={(latestRun.review as ReviewResult | null) ?? null}
                commercialReview={(latestRun.commercial_review as CommercialReviewResult | null) ?? null}
                beatValidation={(latestRun.beat_validation as BeatValidationResult | null) ?? null}
              />
            )}
          </section>
        )}

        {tab === "exports" && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">导出</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                每条记录对应 exports/ 里一个真实存在过的文件；文件被删了记录还在，下载时会明说。
              </p>
            </div>
            <ExportSourceHint documentId={exports[0]?.documentId ?? null} titles={titles} />
            <ExportHistory projectId={projectId} exports={exports} />
          </section>
        )}
      </div>
    </div>
  );
}
