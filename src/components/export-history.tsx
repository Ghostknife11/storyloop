"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { downloadExport, type ExportResultApi } from "@/interface/api";
import { byteSizeLabel, exportFormatLabel, exportRowOf, timestampLabel } from "@/interface/workspace-view";

/**
 * §32 导出历史：每一行是一次真实发生过的导出，带下载。
 *
 * 只列 index.json 里真有的记录。文件被人删了也会照列（记录说的是"导出过"，
 * 不是"文件现在还在"），点下载会得到一句"文件已经不在了"——不偷偷拿别的文件顶上。
 */

export function ExportHistory({
  projectId,
  exports: history,
}: {
  projectId: string;
  exports: ExportResultApi[];
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function download(row: ExportResultApi): Promise<void> {
    setBusyId(row.id);
    try {
      await downloadExport(projectId, row.id, row.filename);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "下载失败");
    } finally {
      setBusyId(null);
    }
  }

  if (history.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        还没有导出过。稿子定稿之后，可以从上面选 Word 或 EPUB。
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {history.map((item) => {
        const row = exportRowOf(item);
        return (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-3 py-2.5 text-sm ring-1 ring-border/50 dark:ring-white/10"
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate">{row.filename}</p>
              <p className="text-xs text-muted-foreground">
                {exportFormatLabel(row.format)} · {byteSizeLabel(row.byteSize)} · {timestampLabel(row.createdAt)}
              </p>
            </div>
            <Badge variant="outline">{row.format}</Badge>
            <Button size="sm" variant="secondary" disabled={busyId === row.id} onClick={() => void download(item)}>
              <Download className="size-4" />
              {busyId === row.id ? "下载中" : "下载"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** 稿件在别处被引用时给一句提示：导出是按稿件走的，链接回到那一篇。 */
export function ExportSourceHint({ documentId, titles }: { documentId: string | null; titles: Map<string, string> }) {
  if (!documentId) return null;
  const title = titles.get(documentId);
  if (!title) return null;
  return (
    <p className="text-xs text-muted-foreground">
      这些文件来自稿件「{title}」。
      <Link className="ml-1 underline" href={`#drafts`}>
        回到稿件列表
      </Link>
    </p>
  );
}
