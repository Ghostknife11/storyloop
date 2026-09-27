"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  downloadExport,
  fetchDocument,
  patchDocument,
  postExport,
  type DocumentSummaryApi,
  type ExportOutcomeApi,
} from "@/interface/api";
import { documentSourceLabel, documentStatusLabel, editorViewOf, timestampLabel } from "@/interface/workspace-view";
import { wordCountOf } from "@/domain/story-document";

/**
 * §38 编辑器。
 *
 * 界面上必须有的六样：标题、正文、字数、保存状态、来源 Run 链接、草稿/定稿、导出入口。
 * 保存走 PATCH：只发白名单内的四个字段（title / content / status / isFavorite），
 * contentHash 不在其中——哈希是服务端算的，界面上报一个哈希没有任何意义（并且会被 400 拒绝）。
 *
 * 自动保存刻意不做「每次按键都发请求」：停手 1.2 秒才发一次，且保存期间输入框可继续编辑。
 * 上一版的正文始终显示在屏幕上——保存失败不会让用户丢字。
 */

const AUTOSAVE_DELAY_MS = 1200;

interface Props {
  projectId: string;
  documents: DocumentSummaryApi[];
  /** 打开时要选中的稿件；服务端给的 currentDocumentId 或者其他任一篇。 */
  initialDocumentId: string | null;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function StoryEditor({ projectId, documents, initialDocumentId }: Props) {
  const firstId = initialDocumentId ?? documents[0]?.id ?? null;
  const [activeId, setActiveId] = useState<string | null>(firstId);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"draft" | "final">("draft");
  const [sourceRunId, setSourceRunId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 上一次保存成功时的正文快照： dirty 判定用它，不用「加载进来的初始值」。 */
  const savedRef = useRef({ title: "", content: "", status: "draft" as "draft" | "final" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const summary = useMemo(() => documents.find((d) => d.id === activeId) ?? null, [documents, activeId]);
  const wordCount = useMemo(() => wordCountOf(content), [content]);
  const view = useMemo(
    () => editorViewOf({ id: activeId ?? "", title, status, content, sourceRunId, updatedAt, contentHash: "" }, wordCount),
    [activeId, title, status, content, sourceRunId, updatedAt, wordCount],
  );

  // 换一篇稿：把编辑器整个换掉，保存状态回到 idle（上一篇的状态不跟着过来）
  useEffect(() => {
    if (!activeId) {
      setTitle("");
      setContent("");
      setStatus("draft");
      setSourceRunId(null);
      setUpdatedAt("");
      setSaveState("idle");
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDocument(projectId, activeId)
      .then((doc) => {
        if (cancelled) return;
        setTitle(doc.title);
        setContent(doc.content);
        setStatus(doc.status);
        setSourceRunId(doc.sourceRunId);
        setUpdatedAt(doc.updatedAt);
        savedRef.current = { title: doc.title, content: doc.content, status: doc.status };
        setSaveState("idle");
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "读取稿件失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, projectId]);

  async function save(): Promise<boolean> {
    if (!activeId) return false;
    setSaveState("saving");
    try {
      const saved = await patchDocument(projectId, activeId, { title, content, status });
      savedRef.current = { title, content, status };
      setUpdatedAt(saved.updatedAt);
      setSaveState("saved");
      return true;
    } catch (e) {
      setSaveState("error");
      toast.error(e instanceof Error ? e.message : "保存失败");
      return false;
    }
  }

  // 停下打字 1.2 秒后自动保存；保存中再改字也照发——最后一次为准。
  useEffect(() => {
    const dirty =
      title !== savedRef.current.title || content !== savedRef.current.content || status !== savedRef.current.status;
    if (!dirty) return;
    setSaveState((prev) => (prev === "saving" ? prev : "dirty"));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, content, status]);

  async function exportAs(format: "docx" | "epub"): Promise<void> {
    if (!activeId) return;
    // 导出前先把改动存住：否则导出去的是上一版正文，而屏幕上的是这一版
    const ok = await save();
    if (!ok) {
      toast.error("保存没成功，先解决保存再导出");
      return;
    }
    setExporting(true);
    try {
      const outcome: ExportOutcomeApi = await postExport(projectId, { documentId: activeId, format });
      toast.success(`已导出 ${outcome.result.filename}`);
      await downloadExport(projectId, outcome.result.id, outcome.result.filename);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  if (documents.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        这个项目还没有稿件。到「Runs」里挑一次生成，把它变成第一篇稿。
      </p>
    );
  }

  const statusLabel = documentStatusLabel(view.status);

  return (
    <div className="grid gap-4 lg:grid-cols-[13rem_1fr]">
      <aside className="space-y-1">
        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">稿件（{documents.length}）</p>
        <ul className="space-y-1">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => setActiveId(doc.id)}
                className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  doc.id === activeId ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"
                }`}
              >
                <span className="block truncate">{doc.title}</span>
                <span className="text-xs text-muted-foreground">{timestampLabel(doc.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-sm"
            value={title}
            aria-label="稿件标题"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Badge variant={view.status === "final" ? "default" : "outline"}>{statusLabel.label}</Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setStatus(view.status === "final" ? "draft" : "final")}
          >
            {view.status === "final" ? "改回草稿" : "标为定稿"}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="save-state">
            {saveState === "saving" && (
              <>
                <Loader2 className="mr-1 inline size-3 animate-spin" />
                保存中…
              </>
            )}
            {saveState === "dirty" && "有未保存的改动"}
            {saveState === "saved" && (
              <>
                <Check className="mr-1 inline size-3" />
                已保存
              </>
            )}
            {saveState === "error" && "保存失败，改动还在"}
            {saveState === "idle" && updatedAt && `保存于 ${timestampLabel(updatedAt)}`}
          </span>
          <span className="ml-auto text-xs text-muted-foreground" data-testid="word-count">
            {wordCount} 字
          </span>
        </div>

        <Textarea
          className="min-h-[26rem] font-mono text-sm leading-relaxed"
          value={content}
          aria-label="正文"
          onChange={(e) => setContent(e.target.value)}
        />

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{documentSourceLabel(summary?.source ?? "generated", sourceRunId)}</span>
          {sourceRunId && (
            /* 本版本没有 /runs/<id> 页面（TASK §39）：与实验页同一约定打开 JSON。 */
            <a className="underline" href={`/api/runs/${encodeURIComponent(sourceRunId)}`} target="_blank" rel="noreferrer">
              看那次 Run
            </a>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" disabled={exporting || loading} onClick={() => void exportAs("docx")}>
              <FileDown className="size-4" />
              导出 Word
            </Button>
            <Button size="sm" variant="secondary" disabled={exporting || loading} onClick={() => void exportAs("epub")}>
              <Download className="size-4" />
              导出 EPUB
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void save()}>
              立即保存
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
