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
          <p className="text-xs text-muted-foreground mt-1">一个具备剧情规划、基础有效性检查、自动审阅、商业可读性审阅、自动重试和定点修订能力的 AI 短篇小说生成器</p>
        </div>

        <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-hidden">
          {rows.map((r, i) => (
            <div key={r.label} className={`flex items-center justify-between px-4 sm:px-5 py-3.5 ${i > 0 ? "border-t border-border" : ""}`}>
              <span className="text-xs text-muted-foreground">{r.label}</span>
              <span className="text-sm font-medium font-mono">{r.value}</span>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 text-xs text-muted-foreground leading-5">
          本项目按版本逐步公开演进。v1.0.0 是冻结版本：不新增智能能力，而是把已经能跑的每一条契约写成公开承诺——StoryConfig v1、BeatPlan v1、Run 产物布局、HTTP API、CLI、运行时默认值与错误 schema 全部定稿，并用合同测试看守、用 docs/ 固定下来。能力本身与 0.9.x 一致：提示词工程、StoryConfig 复用、剧情规划、正文生成、基于 Run 的生成流水线、正文的基础有效性检查（硬性规则，回答「基本可用吗」）、基础自动审阅（分数 / 摘要 / 优点 / 问题，回答「写得好吗」）、基于确定性策略的自动重试与定点修订。Attempt 不通过时先按某一条明确的问题（结局、篇幅、主角在场、前后连贯、结构，或审阅指出的具体问题）改写在手的这篇正文，修订后重新校验与重新审阅，修订彻底失败或仍不达标才带着同一份配置整篇重新生成，直到满足策略或达到尝试次数上限；每次尝试与每次修订都会单独归档。定点修订只使用简单问题类别，不做因果诊断，也不做失败归因。v1.2.0 开始建立统一质量工程层：把校验结论、审阅结论与采纳结论汇成一份 QualityResult（整体分 / 校验是否通过 / 是否采纳 / 问题清单 / 建议清单 / 摘要），落在 quality.json、API 的 quality 字段与 Quality Summary 面板三处。这一层只做汇总，不调用模型、不重新打分、没有 PASS / FAIL 阈值，也不参与任何校验、审阅或重试判定；v1.2.0 之前生成的 Run 没有 quality.json，读取时按同一套规则临时装配（v1.2.1 起与落盘同口径，取这次尝试最终留下的那一版结论）。v1.3.0 给审阅结论加了四个可选的基础维度（连贯性 / 叙事 / 人物 / 因果，各自 0–100 分加一句短评），整体分在有维度时就是四维均分（纯算术、无权重）；维度只是评价输出，不新增阈值、不驱动重试或修订，1.3.0 之前生成的 Run 没有这个字段，读出来与当年一致。v1.4.0 在写正文之前加了一道 BeatPlan 结构校验：剧情骨架先过一次结构检查（四拍结构是否齐全、结局是否被铺垫、是否有人物或事件前后对不上），结论落在 beat-validation.json、API 的 beat_validation 字段与 Beat Validation 面板三处；这条校验只报告不修复——不改写、不重排、不补拍任何一拍，也不据此重新规划，骨架结构带 error 级问题时 Run 在写正文之前结束（warning 级不阻断），骨架怎么改由使用者决定。v1.4.1 是一次修订版本：不新增能力，只把此前几个版本里「文档承诺了、实现没做到」的地方改回承诺的样子——attempt 摘要的审阅分与门槛分、质量快照同口径（有审阅维度时都是四维均分），`beat_validation_error` 真的会出现在响应里，落盘的结论文件被改坏时读接口仍然 200 而不是 500，落盘改为临时文件加重命名、中断时不再留下半份产物，CLI 的 `--temperature` 会透传给规划、而审阅与修订收到它会明确说「已忽略」（它们用固定温度），复制 / 下载与「重新」操作都以当前展示的那一版正文为准。v1.5.0 加了一道与结构审阅完全并列的商业可读性审阅：同一个故事再拿给一个独立的审阅者，从「读者会不会继续读下去」的角度给 Hook（开篇抓力）/ Pacing（节奏）/ Engagement（全篇持续阅读动力）/ Payoff（回报）四个固定维度各打 0–100 分并附一句短评，整体分是这四个数的等权均分（纯算术、无权重）。两个审阅者各自独立的提示词、解析器与产物文件，不合成一个八维大 Prompt；商业分不触发重试、不触发修订、不进质量快照，只回答「读者读不读得下去」，不预测市场、销量或商业结果。这一步自身失败只让它的状态变成 failed，正文、校验结论、结构审阅结论与质量快照一个都不受影响；不注入这个审阅者时流程与 v1.4.1 逐字一致。v0.9.x 做的是加固：配置来源、错误响应、日志、超时与重试、产物与 CLI 行为收口，错误文本不再夹带服务器绝对路径。更细的维度拆解、Beat 规划质量评价、Best-of-N 择优、PASS / FAIL 质量门禁、实验、基准与自适应生成尚未包含在本版本中，将在后续版本逐步引入。
        </div>

        <div className="flex gap-2">
          <a
            href="https://github.com/Ghostknife11/storyloop"
            target="_blank"
            rel="noreferrer"
            className="flex-1"
          >
            <div className="h-10 rounded-full border border-border bg-muted/50 flex items-center justify-center gap-2 text-xs hover:bg-muted transition-colors">
              <ExternalLink className="h-3.5 w-3.5" /> GitHub 仓库
            </div>
          </a>
          <a href="https://github.com/Ghostknife11/storyloop/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer" className="flex-1">
            <div className="h-10 rounded-full border border-border bg-muted/50 flex items-center justify-center gap-2 text-xs hover:bg-muted transition-colors">
              <ScrollText className="h-3.5 w-3.5" /> 更新日志
            </div>
          </a>
        </div>

        <div className="text-center">
          <Link href="/" className="text-xs text-violet-600 dark:text-violet-400 hover:text-violet-600 dark:text-violet-300">← 返回 Generate</Link>
        </div>
      </div>
    </div>
  );
}
