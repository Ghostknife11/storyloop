"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Plus, Search, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postProject, patchProject, type ProjectSummaryApi } from "@/interface/api";
import {
  currentDocumentLabel,
  matchesProjectQuery,
  projectRowOf,
  projectStatusLabel,
  timestampLabel,
  type ProjectRow,
  type Tone,
} from "@/interface/workspace-view";

/**
 * §36 项目列表：建、开、收藏、归档。
 *
 * 四件事都只打一个 PATCH / POST，没有一个动作会去删东西（§40：归档不删数据，
 * 本版本不提供永久删除）。搜索是 §41 的「允许实现」，所以它是纯客户端的名字过滤，
 * 不引入任何新接口。
 */

/** 语气 → 徽标配色。tone 是"这件事本身是好是坏"，中性事实用 outline。 */
const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  neutral: "outline",
  good: "default",
  warn: "secondary",
  bad: "destructive",
};

interface Props {
  initial: ProjectSummaryApi[];
}

export function ProjectList({ initial }: Props) {
  const [items, setItems] = useState<ProjectSummaryApi[]>(initial);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // 排序与服务端一致（收藏在前、未归档在前、更新时间倒序），这里不再自作主张——
  // 两处排序规则不一致时，用户看到的是"刷新一下顺序就变了"。
  const rows: ProjectRow[] = useMemo(() => {
    return items
      .filter((item) => matchesProjectQuery(item.project.name, query))
      .map((item) => projectRowOf(item))
      .sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        if (a.status !== b.status) return a.status === "archived" ? 1 : -1;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
  }, [items, query]);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("先给项目起个名字");
      return;
    }
    setBusy(true);
    try {
      const created = await postProject({ name: trimmed });
      setItems((prev) => [{ project: created, runCount: 0 }, ...prev]);
      setName("");
      toast.success(`已创建项目「${created.name}」`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建项目失败");
    } finally {
      setBusy(false);
    }
  }

  /** 收藏 / 归档：都只是改状态（§40），成功后就地替换列表项。 */
  async function patch(id: string, payload: unknown, done: string): Promise<void> {
    setBusy(true);
    try {
      const updated = await patchProject(id, payload);
      setItems((prev) => prev.map((item) => (item.project.id === id ? { ...item, project: updated } : item)));
      toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新项目失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="project-name">新项目</Label>
          <div className="flex gap-2">
            <Input
              id="project-name"
              value={name}
              placeholder="例如：夜行列车"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
            <Button onClick={() => void create()} disabled={busy}>
              <Plus className="size-4" />
              创建
            </Button>
          </div>
        </div>
        <div className="space-y-1.5 sm:w-64">
          <Label htmlFor="project-query">搜索项目名</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="project-query"
              className="pl-8"
              value={query}
              placeholder="输入名字的一部分"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {items.length === 0 ? "还没有项目。建一个，把已经跑过的 Run 归到一起。" : "没有名字匹配的项目。"}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => {
            const status = projectStatusLabel(row.status);
            return (
              <li key={row.id} className="rounded-2xl bg-card p-4 ring-1 ring-border/50 dark:ring-white/10">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/workspace/${row.id}`} className="block truncate font-heading text-base hover:underline">
                      {row.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.runCount} 次 Run · 更新于 {timestampLabel(row.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Badge variant={TONE_VARIANT[status.tone]}>{status.label}</Badge>
                    {row.isFavorite && (
                      <Badge variant="outline">
                        <Star className="size-3" />
                        收藏
                      </Badge>
                    )}
                  </div>
                </div>

                <p className="mt-3 truncate text-sm text-muted-foreground">当前稿件：{currentDocumentLabel(row.currentDocumentTitle)}</p>

                  <div className="mt-3 flex items-center gap-2">
                    <Link
                      href={`/workspace/${row.id}`}
                      className={buttonVariants({ size: "sm", variant: "secondary" })}
                    >
                      打开
                    </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void patch(row.id, { isFavorite: !row.isFavorite }, row.isFavorite ? "已取消收藏" : "已收藏")}
                  >
                    <Star className={row.isFavorite ? "size-4 fill-current" : "size-4"} />
                    {row.isFavorite ? "取消收藏" : "收藏"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void patch(
                        row.id,
                        { status: row.status === "archived" ? "active" : "archived" },
                        row.status === "archived" ? "已恢复" : "已归档，数据一份没删",
                      )
                    }
                  >
                    {row.status === "archived" ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                    {row.status === "archived" ? "恢复" : "归档"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
