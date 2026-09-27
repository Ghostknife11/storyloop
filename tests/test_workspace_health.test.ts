import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEALTH_SIGNAL_CODES,
  RETRY_PRESSURE_SHARE,
  assessProjectHealth,
  type HealthObservation,
  type ProjectHealthResult,
} from "@/domain/project-health";
import { WorkspaceNotFoundError, WorkspaceValidationError } from "@/domain/workspace";
import { assessProjectHealthUseCase } from "@/application/workspace-health";
import { createProject, setProjectStatus } from "@/application/workspace-projects";
import { createDocumentFromRun, saveDocument } from "@/application/workspace-documents";
import { DEFAULT_RETRY_POLICY } from "@/domain/retry-policy";
import type { QualityResult } from "@/domain/quality";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { buildRunManifest } from "@/infrastructure/tracking/manifest-builder";

/**
 * v2.2.0 Creator Health（TASK §16/§18/§19/§53）。
 *
 * 这一份要守住三件事：
 *   1. **确定性**：同一份观察结果，两次调用必得同一个结论（连信号顺序都一样）。
 *   2. **不调模型**：健康判定不许碰 LLM。这里用「源码里没有那些入口」来证明——
 *      Domain 那个文件甚至不该有 import。
 *   3. **不给建议**：能说「有 2 条质量 warning」，不能说「换个模型」。
 *      这一条也按源码断言：整个健康相关源码里不出现那些词。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function roots(): { runs: string; projects: string } {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-health-"));
  return { runs: join(tmp, "runs"), projects: join(tmp, "projects") };
}

function observation(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    runCount: 1,
    retriedShare: 0,
    latestRunOutcome: "accepted",
    qualityErrorCount: 0,
    qualityWarningCount: 0,
    qualityCurrent: true,
    hasCurrentDocument: true,
    exportCount: 1,
    archived: false,
    latestRunId: "20260927_100000_ab12cd",
    documentId: "doc_20260927_100000_cd34ef",
    ...overrides,
  };
}

const STORY = "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n\n第二天，报上只有一行寻人启事。";

function putRun(
  store: ArtifactStore,
  runId: string,
  story: string,
  options: { projectId?: string; attempts?: number; quality?: QualityResult | null; selected?: boolean } = {},
): void {
  store.createRunDirectory(runId);
  writeFileSync(join(store.resolveRunDir(runId), "story.md"), story, "utf8");
  const attempts = options.attempts ?? 1;
  const base = buildRunManifest(
    {
      runId,
      startedAt: "2026-09-27T10:00:00.000Z",
      policy: DEFAULT_RETRY_POLICY,
      attempts: Array.from({ length: attempts }, (_, i) => ({
        attemptNumber: i + 1,
        accepted: attempts === 1,
        retryReason: attempts === 1 ? null : "REVIEW_SCORE_BELOW_MIN",
        repairs: [],
      })),
      selectedAttemptNumber: options.selected === false ? null : 1,
    },
    store,
    () => new Date("2026-09-27T10:00:01.000Z"),
  );
  store.putManifest(runId, {
    ...base,
    ...(options.projectId !== undefined ? { workspace: { projectId: options.projectId } } : {}),
  });
  if (options.quality) store.putQuality(runId, options.quality);
}

const CLEAN_QUALITY: QualityResult = {
  overall_score: 82,
  validation_passed: true,
  accepted: true,
  issues: [],
  suggestions: [],
  summary: "主线清楚。",
};

const WARNED_QUALITY: QualityResult = {
  ...CLEAN_QUALITY,
  issues: [
    { id: "review-1", source: "review", category: "review_problem", message: "中段线索重复" },
    { id: "review-2", source: "review", category: "review_problem", message: "高潮转折略突然" },
  ],
};

const BLOCKED_QUALITY: QualityResult = {
  ...CLEAN_QUALITY,
  issues: [
    { id: "validation-1", source: "validation", category: "TOO_SHORT", message: "正文长度不足。", severity: "error" },
  ],
};

describe("项目健康规则（§18，纯函数）", () => {
  it("healthy：没有 blocker 也没有 warning", () => {
    const result = assessProjectHealth(observation(), "2026-09-27T12:00:00.000Z");
    expect(result.status).toBe("healthy");
    expect(result.signals).toEqual([]);
    expect(result.updatedAt).toBe("2026-09-27T12:00:00.000Z");
  });

  it("blocked：最近一次运行失败", () => {
    const result = assessProjectHealth(observation({ latestRunOutcome: "failed" }), "2026-09-27T12:00:00.000Z");
    expect(result.status).toBe("blocked");
    expect(result.signals.map((s) => s.code)).toContain("latest_run_failed");
  });

  it("blocked：重试预算用尽仍没被接受", () => {
    const result = assessProjectHealth(observation({ latestRunOutcome: "exhausted" }), "2026-09-27T12:00:00.000Z");
    expect(result.status).toBe("blocked");
    const signal = result.signals.find((s) => s.code === "latest_run_failed");
    expect(signal?.severity).toBe("error");
    expect(signal?.source).toBe("20260927_100000_ab12cd");
    expect(signal?.message).toContain("重试预算用尽");
  });

  it("blocked：质量诊断里有 error 级问题", () => {
    const result = assessProjectHealth(observation({ qualityErrorCount: 2 }), "2026-09-27T12:00:00.000Z");
    expect(result.status).toBe("blocked");
    expect(result.signals.find((s) => s.code === "quality_blockers")?.message).toBe(
      "最近一次运行的质量诊断有 2 项 blocker",
    );
  });

  it("attention：质量 warning / 没有当前稿件 / 质量已过期 / 重试压力 各自单独成立", () => {
    const cases: Array<[string, Partial<HealthObservation>, string]> = [
      ["quality_warnings", { qualityWarningCount: 3 }, "quality_warnings"],
      ["no_current_document", { hasCurrentDocument: false }, "no_current_document"],
      ["quality_stale", { qualityCurrent: false }, "quality_stale"],
      ["retry_pressure", { retriedShare: RETRY_PRESSURE_SHARE }, "retry_pressure"],
    ];
    for (const [label, patch, code] of cases) {
      const result = assessProjectHealth(observation(patch), "2026-09-27T12:00:00.000Z");
      expect(result.status, label).toBe("attention");
      expect(result.signals.map((s) => s.code), label).toContain(code);
    }
  });

  it("error 压过 warning：一次失败的 Run 与一个过期稿件同时出现，两个信号都在", () => {
    const result = assessProjectHealth(
      observation({ latestRunOutcome: "failed", qualityCurrent: false, qualityWarningCount: 1 }),
      "2026-09-27T12:00:00.000Z",
    );
    expect(result.status).toBe("blocked");
    expect(result.signals.map((s) => s.code).sort()).toEqual([
      "latest_run_failed",
      "quality_stale",
      "quality_warnings",
    ]);
  });

  it("刚建的项目：没有 Run、没有稿件，一条 info 就够，状态仍是 healthy", () => {
    const result = assessProjectHealth(
      observation({ runCount: 0, retriedShare: null, latestRunOutcome: null, hasCurrentDocument: false, exportCount: 0, qualityCurrent: null, qualityErrorCount: null, qualityWarningCount: null, latestRunId: undefined, documentId: undefined }),
      "2026-09-27T12:00:00.000Z",
    );
    expect(result.status).toBe("healthy");
    expect(result.signals).toEqual([
      { code: "no_runs", severity: "info", message: "这个项目还没有任何运行记录" },
    ]);
  });

  it("「读不到」不出信号：没有质量结论、无从比较新旧，都不画红也不画绿", () => {
    const result = assessProjectHealth(
      observation({ qualityErrorCount: null, qualityWarningCount: null, qualityCurrent: null }),
      "2026-09-27T12:00:00.000Z",
    );
    expect(result.status).toBe("healthy");
    expect(result.signals).toEqual([]);
  });

  it("info 级信号照样列出来，只是不把状态顶上去", () => {
    const result = assessProjectHealth(observation({ exportCount: 0, archived: true }), "2026-09-27T12:00:00.000Z");
    expect(result.status).toBe("healthy");
    expect(result.signals.map((s) => s.code).sort()).toEqual(["archived", "no_exports"]);
    expect(result.signals.every((s) => s.severity === "info")).toBe(true);
  });

  it("确定性：同一份观察两次判定，结论逐字相同（含信号顺序）", () => {
    const view = observation({ qualityWarningCount: 1, retriedShare: 0.75, exportCount: 0 });
    const first = assessProjectHealth(view, "2026-09-27T12:00:00.000Z");
    const second = assessProjectHealth(view, "2026-09-27T12:00:00.000Z");
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // 信号按码排序，所以顺序不依赖对象键的插入顺序
    expect(first.signals.map((s) => s.code)).toEqual([...first.signals.map((s) => s.code)].sort());
  });

  it("每个信号码都在登记表里，登记表里没有多余码", () => {
    const view = observation({
      runCount: 0,
      retriedShare: null,
      latestRunOutcome: "failed",
      qualityErrorCount: 1,
      qualityWarningCount: 1,
      hasCurrentDocument: false,
      exportCount: 0,
      archived: true,
      qualityCurrent: null,
      latestRunId: undefined,
      documentId: undefined,
    });
    const result = assessProjectHealth(view, "2026-09-27T12:00:00.000Z");
    for (const signal of result.signals) expect(HEALTH_SIGNAL_CODES).toContain(signal.code);
    // 上面这一份观察触发了除 no_current_document / retry_pressure / quality_stale 外的全部
    expect(result.signals.length).toBeGreaterThanOrEqual(4);
    expect([...HEALTH_SIGNAL_CODES]).toEqual([...HEALTH_SIGNAL_CODES].sort());
  });

  it("不给建议（§19）：源码里没有调用模型的入口，信号文案也不教用户改什么", () => {
    const sources = ["src/domain/project-health.ts", "src/application/workspace-health.ts"];
    const codeTokens = [
      "fetch(",
      "XMLHttpRequest",
      "child_process",
      "execSync",
      "spawnSync",
      "LLMClient",
      "anthropic",
      "openai",
      "temperature",
      "max_tokens",
      "提示词",
    ];
    for (const source of sources) {
      // 先剥注释：禁词不许出现在代码里，但允许出现在「解释为什么禁」的注释里
      const code = readFileSync(join(process.cwd(), source), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const token of codeTokens) {
        expect(code.includes(token), `${source} 不许可出现「${token}」`).toBe(false);
      }
    }
  });

  it("不给建议（§19）：每一条信号都只是一句话事实，不含主张", () => {
    // 主张词：一旦出现，说明这条信号在教用户做事而不是陈述事实
    const claims = /建议|应该|改用|换个模型|更强|尝试|不妨|最好/;
    const views: HealthObservation[] = [
      observation(),
      observation({ runCount: 0, retriedShare: null, latestRunOutcome: null, hasCurrentDocument: false, exportCount: 0, qualityCurrent: null, qualityErrorCount: null, qualityWarningCount: null, latestRunId: undefined, documentId: undefined }),
      observation({ latestRunOutcome: "exhausted", qualityErrorCount: 1, qualityWarningCount: 2, qualityCurrent: false, exportCount: 0, archived: true, retriedShare: 1 }),
    ];
    for (const view of views) {
      for (const signal of assessProjectHealth(view, "2026-09-27T12:00:00.000Z").signals) {
        expect(claims.test(signal.message), `${signal.code}：${signal.message}`).toBe(false);
      }
    }
  });

  it("不调模型：Domain 那个文件一个 import 都没有", () => {
    const text = readFileSync(join(process.cwd(), "src/domain/project-health.ts"), "utf8");
    expect(text).not.toMatch(/^import /m);
  });
});

describe("assessProjectHealthUseCase（§39，接真实数据）", () => {
  it("一次干净的成功运行：healthy，且 runs/ 一个字节都没动", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "干净的项目" }, { projects: projects_ });
    const runId = "20260927_100000_ab12cd";
    putRun(artifactStore, runId, STORY, { projectId: project.id, quality: CLEAN_QUALITY });
    const before = new Map<string, string>();
    const walk = (dir: string, out: Map<string, string>): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile()) out.set(relative(runs, full), `${readFileSync(full)}|${statSync(full).mtimeMs}`);
      }
    };
    walk(runs, before);

    const health = await assessProjectHealthUseCase(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore,
    });

    // 有 Run、没有当前稿件 → 一条 warning，状态 attention（这是「该建一篇稿」的意思）
    expect(health.status).toBe("attention");
    expect(health.signals.map((s) => s.code)).toEqual(["no_current_document"]);

    const after = new Map<string, string>();
    walk(runs, after);
    expect(after).toEqual(before);
  });

  it("最近一次运行失败 → blocked，且指明是哪一次", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "失败的项目" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, {
      projectId: project.id,
      selected: false,
      attempts: 3,
      quality: null,
    });

    const health = await assessProjectHealthUseCase(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore,
    });

    expect(health.status).toBe("blocked");
    const signal = health.signals.find((s) => s.code === "latest_run_failed");
    expect(signal?.source).toBe("20260927_100000_ab12cd");
    // 3 次 Attempt 全落选：重试压力也一并报出来
    expect(health.signals.map((s) => s.code)).toContain("retry_pressure");
  });

  it("质量诊断按严重度分别计数：error 进 blocked，warning 进 attention", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "有 warning 的项目" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, { projectId: project.id, quality: WARNED_QUALITY });

    const health = await assessProjectHealthUseCase(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore,
    });
    expect(health.signals.find((s) => s.code === "quality_warnings")?.message).toBe(
      "最近一次运行的质量诊断有 2 项 warning",
    );
    expect(health.status).toBe("attention");

    putRun(artifactStore, "20260927_110000_ef56ab", STORY, { projectId: project.id, quality: BLOCKED_QUALITY });
    const blocked = await assessProjectHealthUseCase(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.signals.find((s) => s.code === "quality_blockers")?.source).toBe("20260927_110000_ef56ab");
  });

  it("§20 质量时效：建稿时 current，编辑之后 stale", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const documents = new FileDocumentRepository(projects);
    const project = await createProject({ name: "要改稿的项目" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, { projectId: project.id, quality: CLEAN_QUALITY });
    const deps = { projects: projects_, documents, exports: new FileExportRepository(projects), artifactStore };

    const fresh = await assessProjectHealthUseCase(project.id, deps);
    expect(fresh.signals.find((s) => s.code === "no_current_document")?.severity).toBe("warning");

    const document = await createDocumentFromRun(project.id, { runId: "20260927_100000_ab12cd" }, deps);
    const current = await assessProjectHealthUseCase(project.id, deps);
    expect(current.signals.find((s) => s.code === "quality_stale")).toBeUndefined();
    // 只剩「还没导出过」这一条，而它是 info——info 只报不抬状态
    expect(current.status).toBe("healthy");
    expect(current.signals).toEqual([
      { code: "no_exports", severity: "info", message: "当前稿件还没有导出过 DOCX / EPUB", source: document.id },
    ]);

    await saveDocument(project.id, document.id, { content: "我把最后一段整个换掉了。" }, deps);
    const stale = await assessProjectHealthUseCase(project.id, deps);
    const signal = stale.signals.find((s) => s.code === "quality_stale");
    expect(signal?.severity).toBe("warning");
    expect(signal?.source).toBe(document.id);
    expect(signal?.message).toContain("不再代表这一版");
  });

  it("没有 Run 也没有稿件：一条 info，healthy", async () => {
    const { runs, projects } = roots();
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "空的" }, { projects: projects_ });
    const health = await assessProjectHealthUseCase(project.id, {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore: new ArtifactStore(runs),
    });
    expect(health.status).toBe("healthy");
    expect(health.signals.map((s) => s.code)).toEqual(["no_runs"]);
  });

  it("归档项目：一条 info 说明它在档案里，其它判定照旧", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "旧项目" }, { projects: projects_ });
    const deps = { projects: projects_, documents: new FileDocumentRepository(projects), exports: new FileExportRepository(projects), artifactStore };
    const active = await assessProjectHealthUseCase(project.id, deps);
    expect(active.signals.find((s) => s.code === "archived")).toBeUndefined();

    putRun(artifactStore, "20260927_100000_ab12cd", STORY, { projectId: project.id, quality: CLEAN_QUALITY });
    await setProjectStatus(project.id, "archived", deps);
    const health = await assessProjectHealthUseCase(project.id, deps);
    const signal = health.signals.find((s) => s.code === "archived");
    expect(signal?.severity).toBe("info");
    // 归档只是把项目挪到后面，不是把它判成有问题：状态仍旧由其它信号定
    expect(health.status).toBe("attention");
    expect(health.signals.map((s) => s.code)).toEqual(["archived", "no_current_document"]);
  });

  it("项目不存在 / id 不合法：404 与 400 分清，不 500", async () => {
    const { runs, projects } = roots();
    const deps = {
      projects: new FileProjectRepository(projects),
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore: new ArtifactStore(runs),
    };
    await expect(assessProjectHealthUseCase("prj_20260927_100000_missing", deps)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    await expect(assessProjectHealthUseCase("../escape", deps)).rejects.toThrow(WorkspaceValidationError);
  });
});

describe("判定只依赖观察结果（§18 确定性）", () => {
  it("同一份观察结果经两次不同路径得到同一结论", async () => {
    const { runs, projects } = roots();
    const artifactStore = new ArtifactStore(runs);
    const projects_ = new FileProjectRepository(projects);
    const project = await createProject({ name: "重试多的项目" }, { projects: projects_ });
    putRun(artifactStore, "20260927_100000_ab12cd", STORY, { projectId: project.id, attempts: 2 });
    putRun(artifactStore, "20260927_110000_cd34ef", STORY, { projectId: project.id, attempts: 2 });
    putRun(artifactStore, "20260927_120000_ef56ab", STORY, { projectId: project.id });
    const deps = {
      projects: projects_,
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore,
    };

    const first: ProjectHealthResult = await assessProjectHealthUseCase(project.id, deps);
    const second: ProjectHealthResult = await assessProjectHealthUseCase(project.id, deps);
    // 时间戳由外部注入，两次调用会不同；剥掉它之后其余必须逐字相同
    expect({ ...first, updatedAt: "" }).toEqual({ ...second, updatedAt: "" });
    expect(first.signals.map((s) => s.code)).toContain("retry_pressure");
  });
});
