"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, ScrollText } from "lucide-react";
import { fetchProjectVersion } from "@/lib/api";

/**
 * `/about`（TASK §6）：Version / Project / License / Repository。
 */
export default function AboutPage() {
  const [version, setVersion] = useState("…");
  useEffect(() => {
    // §43：版本号只有一个入口，取不到就明说读不到，不在这里放第二份硬编码版本
    fetchProjectVersion().then(setVersion).catch(() => setVersion("未知"));
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
          <p className="text-xs text-muted-foreground mt-1">一个具备剧情规划、基础有效性检查、自动审阅、自动重试和定点修订能力的 AI 短篇小说生成器</p>
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
          本项目按版本逐步公开演进。v1.0.0 是冻结版本：不新增智能能力，而是把已经能跑的每一条契约写成公开承诺——StoryConfig v1、BeatPlan v1、Run 产物布局、HTTP API、CLI、运行时默认值与错误 schema 全部定稿，并用合同测试看守、用 docs/ 固定下来。能力本身与 0.9.x 一致：提示词工程、StoryConfig 复用、剧情规划、正文生成、基于 Run 的生成流水线、正文的基础有效性检查（硬性规则，回答「基本可用吗」）、基础自动审阅（分数 / 摘要 / 优点 / 问题，回答「写得好吗」）、基于确定性策略的自动重试与定点修订。Attempt 不通过时先按某一条明确的问题（结局、篇幅、主角在场、前后连贯、结构，或审阅指出的具体问题）改写在手的这篇正文，修订后重新校验与重新审阅，修订彻底失败或仍不达标才带着同一份配置整篇重新生成，直到满足策略或达到尝试次数上限；每次尝试与每次修订都会单独归档。定点修订只使用简单问题类别，不做因果诊断，也不做失败归因。v1.2.0 开始建立统一质量工程层：把校验结论、审阅结论与采纳结论汇成一份 QualityResult（整体分 / 校验是否通过 / 是否采纳 / 问题清单 / 建议清单 / 摘要），落在 quality.json、API 的 quality 字段与 Quality Summary 面板三处。这一层只做汇总，不调用模型、不重新打分、没有 PASS / FAIL 阈值，也不参与任何校验、审阅或重试判定；v1.2.0 之前生成的 Run 没有 quality.json，读取时按同一套规则临时装配（v1.2.1 起与落盘同口径，取这次尝试最终留下的那一版结论）。v1.3.0 给审阅结论加了四个可选的基础维度（连贯性 / 叙事 / 人物 / 因果，各自 0–100 分加一句短评），整体分在有维度时就是四维均分（纯算术、无权重）；维度只是评价输出，不新增阈值、不驱动重试或修订，1.3.0 之前生成的 Run 没有这个字段，读出来与当年一致。v0.9.x 做的是加固：配置来源、错误响应、日志、超时与重试、产物与 CLI 行为收口，错误文本不再夹带服务器绝对路径。更细的维度拆解、Best-of-N 择优、PASS / FAIL 质量门禁、实验、基准与自适应生成尚未包含在本版本中，将在后续版本逐步引入。
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
