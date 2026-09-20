"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, ScrollText } from "lucide-react";

/**
 * `/about`（TASK §6）：Version / Project / License / Repository。
 */
export default function AboutPage() {
  const [version, setVersion] = useState("…");
  useEffect(() => {
    fetch("/api/version").then(r => r.json()).then(d => { if (d?.version) setVersion(d.version); }).catch(() => setVersion("0.0.1"));
  }, []);

  const rows = [
    { label: "Version", value: `v${version}` },
    { label: "Project", value: "Storyloop · AI 故事工场" },
    { label: "License", value: "MIT" },
    { label: "Repository", value: "github.com/Ghostknife11/storyloop" },
  ];

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight">About</h1>
          <p className="text-xs text-muted-foreground mt-1">一个带现代 Web UI 的 AI 短篇小说生成器</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur overflow-hidden">
          {rows.map((r, i) => (
            <div key={r.label} className={`flex items-center justify-between px-4 sm:px-5 py-3.5 ${i > 0 ? "border-t border-white/5" : ""}`}>
              <span className="text-xs text-muted-foreground">{r.label}</span>
              <span className="text-sm font-medium font-mono">{r.value}</span>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 sm:p-5 text-xs text-muted-foreground leading-5">
          本项目按版本逐步公开演进。当前版本已包含提示词工程、StoryConfig 复用、两阶段生成（规划 + 写作）与基于 Run 的生成流水线；内容评审、质量校验、自动修复、质量重试、实验、基准与自适应生成尚未包含在本版本中，将在后续版本逐步引入。
        </div>

        <div className="flex gap-2">
          <a
            href="https://github.com/Ghostknife11/storyloop"
            target="_blank"
            rel="noreferrer"
            className="flex-1"
          >
            <div className="h-10 rounded-full border border-white/10 bg-white/5 flex items-center justify-center gap-2 text-xs hover:bg-white/10 transition-colors">
              <ExternalLink className="h-3.5 w-3.5" /> GitHub 仓库
            </div>
          </a>
          <a href="https://github.com/Ghostknife11/storyloop/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer" className="flex-1">
            <div className="h-10 rounded-full border border-white/10 bg-white/5 flex items-center justify-center gap-2 text-xs hover:bg-white/10 transition-colors">
              <ScrollText className="h-3.5 w-3.5" /> 更新日志
            </div>
          </a>
        </div>

        <div className="text-center">
          <Link href="/" className="text-xs text-violet-400 hover:text-violet-300">← 返回 Generate</Link>
        </div>
      </div>
    </div>
  );
}
