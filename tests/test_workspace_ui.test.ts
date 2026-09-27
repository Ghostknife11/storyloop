import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectList } from "@/components/project-list";
import { ProjectOverview } from "@/components/project-overview";
import { HealthPanel } from "@/components/health-panel";
import { ExportHistory } from "@/components/export-history";
import { StoryEditor } from "@/components/story-editor";
import type {
  DocumentSummaryApi,
  ExportResultApi,
  ProjectDetailApi,
  ProjectHealthApi,
  RunDetailApi,
} from "@/interface/api";
import { HEALTH_SIGNAL_CODES } from "@/domain/project-health";

/**
 * v2.2.0 §36-§39 工作区界面契约。
 *
 * 渲染走 renderToStaticMarkup（与 quality-ui / commercial-ui 同一套）： useEffect 不跑，
 * 所以这里断言的都是「第一帧就该摆出来的东西」，以及几处绝不能出现的字。
 * 事件行为（保存、导出、归档）由 API 测试与用例测试覆盖，这里不重复。
 */

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(ui);
}

/** 剥掉注释再扫描（与仓库其它界面测试同一套）：注释里的说明文字不算代码。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const PROJECT = {
  schemaVersion: "1",
  id: "night-train",
  name: "夜行列车",
  status: "active" as const,
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-27T11:20:00.000Z",
  storyConfigRef: null,
  currentDocumentId: "doc_ab12cd",
  isFavorite: true,
};

const DOCUMENT: DocumentSummaryApi = {
  id: "doc_ab12cd",
  title: "雨里下车的人",
  status: "draft",
  source: "generated",
  sourceRunId: "20260927_110000_cd34ef",
  wordCount: 1284,
  createdAt: "2026-09-27T11:00:00.000Z",
  updatedAt: "2026-09-27T11:20:00.000Z",
  isFavorite: false,
};

const DETAIL: ProjectDetailApi = {
  project: PROJECT,
  runIds: ["20260927_110000_cd34ef", "20260927_100000_ab12cd"],
  documentIds: [DOCUMENT.id],
};

const EXPORT_ROW: ExportResultApi = {
  schemaVersion: "1",
  id: "exp_1f2e3d",
  projectId: PROJECT.id,
  documentId: DOCUMENT.id,
  format: "docx",
  artifactPath: "exports/exp_1f2e3d.docx",
  contentHash: "a".repeat(64),
  filename: "night-train.docx",
  byteSize: 20480,
  createdAt: "2026-09-27T11:30:00.000Z",
};

// 码必须是真的：这里出现任何未登记的码，下面「码全在册」那条断言就会红。
// §17 的原则是「认码不认文案」，所以夹具更不能自己编一个码来摆看。
const HEALTH: ProjectHealthApi = {
  status: "attention",
  signals: [
    {
      code: "quality_stale",
      severity: "warning",
      message: "当前稿件在最近一次审阅之后改过：那次质量结论不再代表这一版。",
    },
    {
      code: "no_current_document",
      severity: "info",
      message: "有运行记录但还没有在写的稿件：可以从任意一次运行建一篇。",
    },
  ],
  updatedAt: "2026-09-27T11:35:00.000Z",
};

describe("§36 项目列表", () => {
  it("建 / 开 / 收藏 / 归档 / 最近更新 / 当前稿件六样都在", () => {
    const html = render(
      createElement(ProjectList, {
        initial: [{ project: PROJECT, runCount: 2 }],
      }),
    );
    expect(html).toContain("新项目");
    expect(html).toContain("创建");
    expect(html).toContain("夜行列车");
    expect(html).toContain(`href="/workspace/${PROJECT.id}"`);
    expect(html).toContain("2 次 Run");
    expect(html).toContain("更新于");
    expect(html).toContain("收藏");
    expect(html).toContain("归档");
    expect(html).toContain("进行中");
    expect(html).toContain("还没有稿件");
  });

  it("归档的项目仍然列出，并且说明数据没被删掉", () => {
    const html = render(
      createElement(ProjectList, {
        initial: [{ project: { ...PROJECT, status: "archived", currentDocumentId: null, isFavorite: false }, runCount: 0 }],
      }),
    );
    expect(html).toContain("已归档");
    expect(html).toContain("0 次 Run");
    // 没有删除入口：这一页上任何「删除」字样都不该出现（§40）
    expect(html).not.toContain("删除");
  });

  it("一个项目都没有时给一句建项目的话，不渲染空列表", () => {
    const html = render(createElement(ProjectList, { initial: [] }));
    expect(html).toContain("还没有项目");
  });
});

describe("§15 项目总览", () => {
  it("九行事实齐了，最近一次 Run 的结论照抄，不自己算", () => {
    const latest: RunDetailApi = {
      run_id: "20260927_110000_cd34ef",
      status: "success",
      quality_status: "accepted",
      attempt_count: 2,
      selected_attempt: 2,
      max_attempts: 3,
      min_review_score: 70,
      enable_repair: true,
      max_repairs_per_attempt: 2,
      repair_count: 1,
      story: "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n",
      beat_validation: null,
      beat_validation_status: "missing",
      validation: null,
      validation_status: "missing",
      review: { score: 82, summary: "主线明确", passed: true },
      review_status: "ready",
      commercial_review: { score: 76, summary: "开头有钩子", passed: true },
      commercial_review_status: "ready",
      quality: null,
      manifest: null,
      telemetry: null,
      failureAnalysis: null,
      qualityStack: null,
      attempts: [],
    } as unknown as RunDetailApi;

    const html = render(
      createElement(ProjectOverview, { detail: DETAIL, documents: [DOCUMENT], health: HEALTH, latestRun: latest }),
    );
    for (const label of ["项目名", "当前稿件", "最近更新", "最近一次 Run", "质量结论", "商业可读性", "Run 数", "稿件数", "收藏"]) {
      expect(html, `总览应有「${label}」这一行`).toContain(label);
    }
    expect(html).toContain("夜行列车");
    expect(html).toContain("82");
    expect(html).toContain("76");
    expect(html).toContain("质量通过");
    expect(html).toContain("已收藏");
  });

  it("没有质量 / 商业结论时显示「—」，不补 0 也不补「略」", () => {
    const latest = {
      run_id: "20260927_100000_ab12cd",
      quality_status: null,
      review: null,
      commercial_review: null,
    } as unknown as RunDetailApi;
    const html = render(
      createElement(ProjectOverview, { detail: DETAIL, documents: [], health: HEALTH, latestRun: latest }),
    );
    expect(html).toContain("—");
    expect(html).not.toContain(">0<");
    expect(html).not.toContain("略");
  });

  it("Run 链接走 /api/runs/<id>：本版本没有 /runs/<id> 页面", () => {
    const html = render(createElement(ProjectOverview, { detail: DETAIL, documents: [], health: null, latestRun: null }));
    expect(html).toContain(`href="/api/runs/${DETAIL.runIds[0]}"`);
    expect(html).not.toContain(`href="/runs/`);
  });
});

describe("§39 Creator Health", () => {
  it("信号按 severity 分组摆出来，认码不认文案", () => {
    const html = render(createElement(HealthPanel, { health: HEALTH }));
    expect(html).toContain("有几件事要处理");
    expect(html).toContain("quality_stale");
    expect(html).toContain("no_current_document");
    expect(html).toContain("注意");
    expect(html).toContain("提示");
  });

  // §17：码是契约，文案只是说明。夹具里搁一个域里根本不存在的码，等于
  // 一边认码一边用假码测自己——所以这里连着HEALTH_SIGNAL_CODES一起断。
  it("夹具里用到的码都在 HEALTH_SIGNAL_CODES 里登记过", () => {
    const registered = new Set<string>(HEALTH_SIGNAL_CODES);
    const used = HEALTH.signals.map((s) => s.code);
    expect(used.length).toBeGreaterThan(0);
    for (const code of used) {
      expect(registered.has(code), `未登记的码：${code}`).toBe(true);
    }
  });

  it("一个数字都没有：没有百分比、没有伪指标（§39 禁）", () => {
    const html = render(createElement(HealthPanel, { health: HEALTH }));
    expect(html).not.toContain("%");
    expect(html).not.toContain("创作效率");
    expect(html).not.toContain("爆款潜力");
    expect(html).toContain("不给建议、不打分");
  });

  it("没有信号时说「没有需要你处理的事」", () => {
    const html = render(createElement(HealthPanel, { health: { ...HEALTH, signals: [] } }));
    expect(html).toContain("这个项目现在没有需要你处理的事");
  });
});

describe("§38 编辑器", () => {
  it("标题、正文、字数、保存状态、草稿/定稿、导出入口都在", () => {
    const html = render(
      createElement(StoryEditor, { projectId: PROJECT.id, documents: [DOCUMENT], initialDocumentId: DOCUMENT.id }),
    );
    expect(html).toContain('aria-label="稿件标题"');
    expect(html).toContain('aria-label="正文"');
    expect(html).toContain('data-testid="word-count"');
    expect(html).toContain('data-testid="save-state"');
    expect(html).toContain("草稿");
    expect(html).toContain("标为定稿");
    expect(html).toContain("导出 Word");
    expect(html).toContain("导出 EPUB");
    expect(html).toContain("立即保存");
    expect(html).toContain("稿件（1）");
  });

  it("没有稿件时指向 Runs 签，不渲染一个空编辑器", () => {
    const html = render(createElement(StoryEditor, { projectId: PROJECT.id, documents: [], initialDocumentId: null }));
    expect(html).toContain("这个项目还没有稿件");
    expect(html).not.toContain("导出 Word");
  });
});

describe("§32 导出历史", () => {
  it("一行一次导出：文件名、格式、大小、时间、下载", () => {
    const html = render(createElement(ExportHistory, { projectId: PROJECT.id, exports: [EXPORT_ROW] }));
    expect(html).toContain("night-train.docx");
    expect(html).toContain("Word 文档 (.docx)");
    expect(html).toContain("20.0 KB");
    expect(html).toContain("下载");
  });

  it("一条记录都没有时说清楚去哪导，不渲染空列表", () => {
    const html = render(createElement(ExportHistory, { projectId: PROJECT.id, exports: [] }));
    expect(html).toContain("还没有导出过");
  });
});

describe("§37 工作区页结构", () => {
  const workspace = readFileSync(join("src", "app", "workspace", "page.tsx"), "utf8");
  const detail = readFileSync(join("src", "app", "workspace", "[id]", "page.tsx"), "utf8");

  it("项目页五个签照 TASK 推荐来", () => {
    for (const label of ["Overview", "Editor", "Runs", "Quality", "Exports"]) {
      expect(detail, `工作区应有「${label}」这个签`).toContain(label);
    }
  });

  it("详情页从 useParams 取 id 并解码，不自己拼 URL", () => {
    expect(detail).toContain("useParams");
    expect(detail).toContain("decodeURIComponent");
  });

  it("列表页与服务端渲染的入口都在，且都不是「删除」入口", () => {
    expect(workspace).toContain("ProjectList");
    expect(codeOnly(workspace)).not.toContain("删除");
    expect(codeOnly(detail)).not.toContain("删除");
  });
});

describe("§67 / §35 工作区界面的边界", () => {
  const files = [
    join("src", "app", "workspace", "page.tsx"),
    join("src", "app", "workspace", "[id]", "page.tsx"),
    join("src", "components", "project-list.tsx"),
    join("src", "components", "project-overview.tsx"),
    join("src", "components", "story-editor.tsx"),
    join("src", "components", "health-panel.tsx"),
    join("src", "components", "export-history.tsx"),
  ];

  it("界面文件不碰进程环境、不碰文件系统（§35 Interface 必须 Thin）", () => {
    for (const file of files) {
      const src = codeOnly(readFileSync(file, "utf8"));
      expect(src, `${file} 不得 import node: 模块`).not.toMatch(/from "node:/);
      expect(src, `${file} 不得读 process.env`).not.toContain("process.env");
      expect(src, `${file} 不得自己算服务端路径`).not.toMatch(/\bjoin\(|\bresolve\(|\breadFileSync|\bwriteFileSync|\bmkdirSync/);
      expect(src, `${file} 不得 import 基础设施层`).not.toMatch(/@\/infrastructure|@\/composition|@\/application|@\/ports/);
    }
  });

  it("界面文案里没有本版本没有的能力（§59）", () => {
    const forbidden = ["创作效率", "爆款潜力", "协作", "分支", "合并", "自动优化", "一键成稿"];
    for (const file of files) {
      const src = codeOnly(readFileSync(file, "utf8"));
      for (const word of forbidden) {
        expect(src, `${file} 不得出现「${word}」`).not.toContain(word);
      }
    }
  });
});
