import { describe, expect, it } from "vitest";
import {
  byteSizeLabel,
  currentDocumentLabel,
  documentRowOf,
  documentSourceLabel,
  documentStatusLabel,
  exportFormatLabel,
  exportRowOf,
  healthStatusLabel,
  healthViewOf,
  matchesDocumentQuery,
  matchesProjectQuery,
  projectRowOf,
  projectStatusLabel,
  timestampLabel,
} from "@/interface/workspace-view";
import type { DocumentSummaryApi, ExportResultApi, ProjectHealthApi, ProjectSummaryApi } from "@/interface/api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers/fixtures";

/**
 * v2.2.0 工作区界面推导契约（TASK §36-§39）。
 *
 * 这一份盯三件事：
 *   1. **只显示真实数据**（§39）。缺的显示「—」或一句话说明，不补 0、不编百分比。
 *      尤其不许出现「创作效率 92%」这类伪指标——这里没有任何一个数字不是服务端给的。
 *   2. **确定性**：健康信号的排序由 code 与 severity 决定，同一份输入两次渲染逐字相同。
 *   3. **干净**：所有行都不带服务器绝对路径（§67）。
 */

function summary(over: Partial<ProjectSummaryApi> = {}): ProjectSummaryApi {
  return {
    project: {
      schemaVersion: "1",
      id: "prj_20260927_101500_j442h6",
      name: "夜行列车",
      status: "active",
      createdAt: "2026-09-27T10:15:00.000Z",
      updatedAt: "2026-09-27T12:00:00.000Z",
      storyConfigRef: null,
      currentDocumentId: null,
      isFavorite: false,
      ...(over.project ?? {}),
    },
    runCount: over.runCount ?? 0,
  };
}

function documentItem(over: Partial<DocumentSummaryApi> = {}): DocumentSummaryApi {
  return {
    id: "doc_20260927_101500_ab12cd",
    title: "第一章",
    status: "draft",
    source: "generated",
    sourceRunId: "20260927_100000_ab12cd",
    wordCount: 1234,
    updatedAt: "2026-09-27T11:00:00.000Z",
    createdAt: "2026-09-27T10:00:00.000Z",
    isFavorite: false,
    ...over,
  };
}

function exportItem(over: Partial<ExportResultApi> = {}): ExportResultApi {
  return {
    schemaVersion: "1",
    id: "out_20260927_121500_zz9999",
    projectId: "prj_20260927_101500_j442h6",
    documentId: "doc_20260927_101500_ab12cd",
    format: "docx",
    artifactPath: "exports/夜行列车.docx",
    contentHash: "a".repeat(64),
    filename: "夜行列车.docx",
    byteSize: 20480,
    createdAt: "2026-09-27T12:15:00.000Z",
    ...over,
  };
}

function health(over: Partial<ProjectHealthApi> = {}): ProjectHealthApi {
  return {
    status: "healthy",
    signals: [],
    updatedAt: "2026-09-27T12:20:00.000Z",
    ...over,
  };
}

describe("§36 项目列表行", () => {
  it("行里带项目本身、Run 数、当前稿件标题——都是服务端给的数，一个不加工", () => {
    const row = projectRowOf(summary({ runCount: 3 }), new Map([["doc_x", "第一章"]]));
    expect(row).toEqual({
      id: "prj_20260927_101500_j442h6",
      name: "夜行列车",
      status: "active",
      isFavorite: false,
      runCount: 3,
      currentDocumentTitle: null,
      updatedAt: "2026-09-27T12:00:00.000Z",
    });
  });

  it("没有当前稿件时标题是 null，展示层自己会说「还没有稿件」", () => {
    expect(currentDocumentLabel(null)).toBe("还没有稿件");
    expect(currentDocumentLabel("第一章")).toBe("第一章");
  });

  it("归档是中性状态，不是失败", () => {
    expect(projectStatusLabel("archived")).toEqual({ label: "已归档", tone: "neutral" });
    expect(projectStatusLabel("active")).toEqual({ label: "进行中", tone: "good" });
  });

  it("§41 搜索：空查询匹配全部，大小写不敏感，不匹配中文以外的花样", () => {
    expect(matchesProjectQuery("夜行列车", "")).toBe(true);
    expect(matchesProjectQuery("Night Train", "night")).toBe(true);
    expect(matchesProjectQuery("夜行列车", "夜行")).toBe(true);
    expect(matchesProjectQuery("夜行列车", "白昼")).toBe(false);
    expect(matchesDocumentQuery("第一章", "一章")).toBe(true);
  });
});

describe("§31 稿件列表行", () => {
  it("草稿 / 定稿分开标，来源一句话说清", () => {
    const draft = documentRowOf(documentItem());
    expect(draft.statusLabel).toBe("草稿");
    expect(draft.tone).toBe("neutral");
    expect(draft.sourceLabel).toBe("来自 Run 20260927_100000_ab12cd");
    expect(draft.wordCount).toBe(1234);

    const final = documentRowOf(documentItem({ status: "final", source: "edited" }));
    expect(final.statusLabel).toBe("定稿");
    expect(final.tone).toBe("good");
    expect(documentSourceLabel("edited", "20260927_100000_ab12cd")).toBe("手动编辑过");
    expect(documentSourceLabel("imported", null)).toBe("从外部导入");
  });

  it("来源说不准时不编：generated 但没有 Run id 只说「来自 Run」", () => {
    expect(documentSourceLabel("generated", null)).toBe("来自 Run");
    expect(documentStatusLabel("something-else")).toEqual({ label: "草稿", Tone: "neutral" });
  });
});

describe("§39 健康面板：只有事实，没有伪指标", () => {
  it("三种结论各有各的语气，blocked 说的是「有必须处理的事」不是「项目坏了」", () => {
    expect(healthStatusLabel("healthy")).toEqual({ label: "可以继续写", tone: "good" });
    expect(healthStatusLabel("attention")).toEqual({ label: "有几件事要处理", tone: "warn" });
    expect(healthStatusLabel("blocked")).toEqual({ label: "有必须处理的事", tone: "bad" });
  });

  it("信号按 severity 分组、组内按码排：同一输入两次渲染逐字相同", () => {
    const view = healthViewOf(
      health({
        signals: [
          { code: "quality_warnings", severity: "warning", message: "2 条质量 warning", source: "20260927_100000_ab12cd" },
          { code: "quality_blockers", severity: "error", message: "1 条质量 blocker" },
          { code: "no_exports", severity: "info", message: "还没有导出过" },
          { code: "no_runs", severity: "warning", message: "还没有 Run" },
        ],
      }),
    );
    expect(view.signals.map((s) => s.code)).toEqual([
      "quality_blockers",
      "no_runs",
      "quality_warnings",
      "no_exports",
    ]);
    // 二次渲染逐字相同
    expect(healthViewOf(health({ signals: [...view.signals] } as ProjectHealthApi)).signals).toEqual(view.signals);
    // 没有 source 的信号展示 null，不写 "null" 字符串
    expect(view.signals[0].source).toBeNull();
    expect(view.signals[2].source).toBe("20260927_100000_ab12cd");
  });

  it("§67：健康视图里不出现服务器绝对路径", () => {
    const view = healthViewOf(health({ signals: [{ code: "no_current_document", severity: "warning", message: "还没有稿件" }] }));
    expect(JSON.stringify(view)).not.toContain(":\\");
    expect(JSON.stringify(view)).not.toContain("/home/");
  });
});

describe("§32 导出历史与下载", () => {
  it("行里带格式、字节数、时间与文件名；字节数换档只在这里做", () => {
    expect(byteSizeLabel(512)).toBe("512 B");
    expect(byteSizeLabel(2048)).toBe("2.0 KB");
    expect(byteSizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
    // 没有的数不补 0，也不说 "0"
    expect(byteSizeLabel(Number.NaN)).toBe("—");
    expect(byteSizeLabel(-1)).toBe("—");
  });

  it("导出记录带的是文件名与格式，artifactPath（路径）不进界面行", () => {
    const row = exportRowOf(exportItem());
    // 服务端给的路径是项目内相对路径；界面行干脆不带它——没有一行需要它
    expect(Object.keys(row).sort()).toEqual(["byteSize", "contentHash", "createdAt", "documentId", "filename", "format", "id"]);
    expect(row.filename).toBe("夜行列车.docx");
    expect(row.format).toBe("docx");
    expect(exportFormatLabel("epub")).toBe("EPUB 电子书 (.epub)");
  });

  it("时间戳解析不出来时原样返回，不显示 Invalid Date", () => {
    expect(timestampLabel("2026-09-27T10:15:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(timestampLabel("某个不是时间的东西")).toBe("某个不是时间的东西");
  });
});

describe("界面不许说的话", () => {
  /** 剥掉块注释与行注释再扫：禁词不许出现在代码里，但允许出现在「解释为什么禁」的注释里。 */
  function codeOf(relative: string): string {
    return readFileSync(join(repoRoot(), relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("§39 禁止伪指标：工作区界面源码里不出现那类词", () => {
    for (const file of ["src/interface/workspace-view.ts", "src/interface/api.ts"]) {
      const source = codeOf(file);
      for (const word of [
        "爆款概率",
        "必火",
        "市场成功率",
        "签约概率",
        "销量预测",
        "创作效率",
        "爆款潜力",
        "hit probability",
        "market potential",
      ]) {
        expect(source, `${file} 里出现了「${word}」`).not.toContain(word);
      }
    }
  });

  it("§59 不把没有的能力写进界面：本版本不出现分支 / 合并 / 协作", () => {
    for (const word of ["branch", "merge", "rebase", "collaborat", "多人协作", "冲突解决"]) {
      expect(codeOf("src/interface/workspace-view.ts"), `出现了「${word}」`).not.toContain(word);
    }
  });
});
