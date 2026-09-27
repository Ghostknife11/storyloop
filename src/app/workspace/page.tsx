"use client";

import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { ProjectList } from "@/components/project-list";
import { fetchProjects, type ProjectSummaryApi } from "@/interface/api";

/**
 * `/workspace`（v2.2.0 §14/§36）：项目列表。
 *
 * 这一页只做一件事：把 runs/ 里已经跑过的东西归到项目下。列表本身、收藏、归档
 * 都在 <ProjectList> 里（那里的注释写了为什么没有删除入口）。
 * 数据在客户端取：模型与参数这一层不该在服务端渲染时就去打自己的 /api（§35）。
 */
export default function WorkspacePage() {
  const [items, setItems] = useState<ProjectSummaryApi[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((data) => {
        if (cancelled) return;
        setItems(data);
        setProblem(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setProblem(e instanceof Error ? e.message : "读取项目列表失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <FolderOpen className="size-5 text-violet-600" />
            Workspace
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            项目把已经跑过的 Run 归到一起，接着写、存成稿、导出去。这里不排名、不打分，也不给「建议下一步」。
          </p>
        </div>

        {problem !== null && (
          <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {problem}
          </p>
        )}

        {items === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (
          <ProjectList initial={items} />
        )}
      </div>
    </div>
  );
}
