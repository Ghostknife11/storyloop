import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportDocument,
  listProjectExports,
  readExportArtifact,
} from "@/application/workspace-exports";
import { createDocument, createDocumentFromRun, saveDocument } from "@/application/workspace-documents";
import { createProject } from "@/application/workspace-projects";
import { WorkspaceNotFoundError, WorkspaceValidationError } from "@/domain/workspace";
import { EXPORT_MIME, type ExportFormat } from "@/domain/export-artifact";
import type { DocumentExporter, ExportInput } from "@/ports/document-exporter";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { docxExporter } from "@/infrastructure/export/docx-exporter";
import { epubExporter } from "@/infrastructure/export/epub-exporter";
import type { ExportResult } from "@/domain/export-artifact";

/**
 * v2.2.0 导出用例（TASK §22/§25/§28/§42/§67）。
 *
 * 存储与字节那一层在 test_workspace_export_store.test.ts 与 test_workspace_export.test.ts；
 * 这里只问工作流该守的事：
 *   1. **导出的源是稿件**，不是 Run 的 story.md（§22）。改了三天的稿子导不出来才叫导出。
 *   2. **记账对得上那一版**（§28）。导出后稿件又改了，旧记录仍旧指向旧字节。
 *   3. **文件名敢用用户标题**，但路径一步都不许跑出 exports/（§25/§42）。
 *   4. **失败要分得清**：400（请求不对）与 404（东西不在），不许 500。
 *   5. 响应体里没有绝对路径（§67）。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function roots(): { runs: string; projects: string } {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-export-case-"));
  return { runs: join(tmp, "runs"), projects: join(tmp, "projects") };
}

const STORY = "# 夜行列车\n\n她从最后一节车厢走进了雨里。\n\n第二天，报上只有一行寻人启事。";
const AT = "2026-09-27T10:15:00.000Z";

/** 假导出器：把收到的稿件原样记下来，字节就是标题+正文拼一句。 */
function fakeExporter(format: ExportFormat, seen: ExportInput[]): DocumentExporter {
  return {
    format,
    mimeType: EXPORT_MIME[format],
    render(input) {
      seen.push(input);
      const text = `${format}|${input.document.title}|${input.document.content}|${input.exportedAt}`;
      return {
        // 故意给一个危险文件名：用例层必须自己算，不能信导出器这一份
        filename: "../../escape.exe",
        mimeType: EXPORT_MIME[format],
        bytes: new TextEncoder().encode(text),
        containerDescription: "fake",
      };
    },
  };
}

interface Fixture {
  runs: string;
  projects: string;
  deps: {
    projects: FileProjectRepository;
    documents: FileDocumentRepository;
    exports: FileExportRepository;
    artifactStore: ArtifactStore;
    now: () => Date;
  };
  projectId: string;
}

async function fixture(options: { title?: string; content?: string } = {}): Promise<Fixture> {
  const { runs, projects } = roots();
  const deps = {
    projects: new FileProjectRepository(projects),
    documents: new FileDocumentRepository(projects),
    exports: new FileExportRepository(projects),
    artifactStore: new ArtifactStore(runs),
    now: () => new Date(AT),
  };
  const project = await createProject({ name: "要导出的项目" }, { projects: deps.projects });
  await createDocument(
    project.id,
    { title: options.title ?? "夜行列车", content: options.content ?? "她从最后一节车厢走进了雨里。" },
    deps,
  );
  return { runs, projects, deps, projectId: project.id };
}

async function firstDocumentId(f: Fixture): Promise<string> {
  const files = readdirSync(join(f.projects, f.projectId, "documents"));
  return files[0].replace(/\.json$/, "");
}

function readIndex(f: Fixture): ExportResult[] {
  const path = join(f.projects, f.projectId, "exports", "index.json");
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")).exports ?? []) as ExportResult[];
}

describe("exportDocument：渲染 → 落盘 → 记账（§22/§24/§28）", () => {
  it("四步都走到：文件在 exports/ 里、账上有一条、字节是渲染出来的", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const seen: ExportInput[] = [];

    const outcome = await exportDocument(
      f.projectId,
      { documentId, format: "docx" },
      { ...f.deps, exporters: { docx: fakeExporter("docx", seen) } },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].document.id).toBe(documentId);
    expect(seen[0].format).toBe("docx");
    expect(seen[0].exportedAt).toBe(AT);

    // 落盘
    const names = readdirSync(join(f.projects, f.projectId, "exports"));
    expect(names.sort()).toEqual(["index.json", outcome.result.filename].sort());
    const onDisk = readFileSync(join(f.projects, f.projectId, "exports", outcome.result.filename));
    expect(new TextDecoder().decode(onDisk)).toBe(`docx|夜行列车|她从最后一节车厢走进了雨里。|${AT}`);

    // 记账
    const history = readIndex(f);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(outcome.result.id);
    expect(history[0].byteSize).toBe(outcome.byteSize);
    expect(outcome.byteSize).toBe(onDisk.byteLength);
  });

  it("源是稿件正文，不是 Run 的 story.md（§22）：编辑之后导出来的是编辑过的内容", async () => {
    const { runs, projects } = roots();
    const deps = {
      projects: new FileProjectRepository(projects),
      documents: new FileDocumentRepository(projects),
      exports: new FileExportRepository(projects),
      artifactStore: new ArtifactStore(runs),
      now: () => new Date(AT),
    };
    const project = await createProject({ name: "改过的稿" }, { projects: deps.projects });
    deps.artifactStore.createRunDirectory("20260927_100000_ab12cd");
    writeFileSync(join(deps.artifactStore.resolveRunDir("20260927_100000_ab12cd"), "story.md"), STORY, "utf8");

    const document = await createDocumentFromRun(project.id, { runId: "20260927_100000_ab12cd" }, deps);
    await saveDocument(project.id, document.id, { content: "我把最后一段整个换掉了。" }, deps);

    const seen: ExportInput[] = [];
    await exportDocument(project.id, { documentId: document.id, format: "docx" }, { ...deps, exporters: { docx: fakeExporter("docx", seen) } });

    expect(seen[0].document.content).toBe("我把最后一段整个换掉了。");
    expect(seen[0].document.content).not.toContain("她从最后一节车厢");
    // 稿件是从 Run 来的，这一条 provenance 必须跟着走（§8/§22）
    expect(seen[0].document.sourceRunId).toBe("20260927_100000_ab12cd");
  });

  it("真实的两种导出器都能跑通：产出的是 ZIP 容器，且带得动中文标题", async () => {
    const f = await fixture({ title: "夜行列车·续" });
    const documentId = await firstDocumentId(f);
    const docx = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    const epub = await exportDocument(f.projectId, { documentId, format: "epub" }, f.deps);

    expect(docx.mimeType).toBe(EXPORT_MIME.docx);
    expect(epub.mimeType).toBe(EXPORT_MIME.epub);
    const docxBytes = readFileSync(join(f.projects, f.projectId, "exports", docx.result.filename));
    const epubBytes = readFileSync(join(f.projects, f.projectId, "exports", epub.result.filename));
    expect(docxBytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(epubBytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(docx.result.filename.endsWith(".docx")).toBe(true);
    expect(epub.result.filename.endsWith(".epub")).toBe(true);
    // 中文标题原样进文件名，不被音译也不被抹掉
    expect(docx.result.filename).toContain("夜行列车·续");
  });

  it("同一个项目导出两次：两个文件都在，互不覆盖，历史两条", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const first = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    const second = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);

    expect(second.result.filename).not.toBe(first.result.filename);
    expect(readIndex(f).map((r) => r.id)).toEqual([first.result.id, second.result.id]);
    expect(readdirSync(join(f.projects, f.projectId, "exports")).sort()).toEqual(
      [first.result.filename, second.result.filename, "index.json"].sort(),
    );
  });

  it("记账记的是导出那一刻的哈希：之后稿件再改，旧记录与旧字节都不变（§28）", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const before = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    const stale = await readExportArtifact(f.projectId, before.result.id, f.deps);
    expect(stale).not.toBeNull();

    await saveDocument(f.projectId, documentId, { content: "新的一版。" }, f.deps);
    const after = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);

    const history = readIndex(f);
    expect(history).toHaveLength(2);
    // 旧记录的内容摘要没跟着新正文走
    expect(history[0].contentHash).toBe(before.result.contentHash);
    expect(history[1].contentHash).toBe(after.result.contentHash);
    expect(history[0].contentHash).not.toBe(history[1].contentHash);
    // 旧记录点的仍旧是旧字节
    expect(stale?.byteSize).toBe(before.byteSize);
    expect(stale?.result).toEqual(before.result);
    const oldBytes = readFileSync(join(f.projects, f.projectId, "exports", before.result.filename));
    expect(oldBytes.toString("utf8")).toContain("她从最后一节车厢走进了雨里。");
  });
});

describe("导出请求的校验（§22/§42）", () => {
  it("白名单之外一律拒绝：runId 不在导出请求里，因为源只能是稿件", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    // 校验在 await 之前就抛，所以这里按 Promise 拒绝来断言
    await expect(
      exportDocument(f.projectId, { documentId, format: "docx", runId: "20260927_100000_ab12cd" }, f.deps),
    ).rejects.toThrow(WorkspaceValidationError);
    await expect(
      exportDocument(f.projectId, { documentId, format: "docx", apiKey: "sk-live-xxx" }, f.deps),
    ).rejects.toThrow(WorkspaceValidationError);
    // 一次都没导出去
    expect(existsSync(join(f.projects, f.projectId, "exports"))).toBe(false);
  });

  it("format 只认 docx / epub；documentId 不能缺", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    for (const format of ["pdf", "md", "", "DOCX", 7, null]) {
      await expect(exportDocument(f.projectId, { documentId, format }, f.deps), String(format)).rejects.toThrow(
        WorkspaceValidationError,
      );
    }
    for (const body of [{ format: "docx" }, { documentId: "", format: "docx" }, null]) {
      await expect(exportDocument(f.projectId, body, f.deps), JSON.stringify(body)).rejects.toThrow(
        WorkspaceValidationError,
      );
    }
  });

  it("别个项目 / 不存在的稿件：404，且一个字节都不落盘", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    await expect(exportDocument(f.projectId, { documentId: "doc_20260927_101500_nosuch", format: "docx" }, f.deps)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    await expect(exportDocument(f.projectId, { documentId: "../escape", format: "docx" }, f.deps)).rejects.toThrow(
      WorkspaceValidationError,
    );
    await expect(exportDocument("prj_20260927_101500_nosuch", { documentId, format: "docx" }, f.deps)).rejects.toThrow(
      WorkspaceNotFoundError,
    );
    await expect(exportDocument("../escape", { documentId, format: "docx" }, f.deps)).rejects.toThrow(
      WorkspaceValidationError,
    );
    expect(existsSync(join(f.projects, f.projectId, "exports"))).toBe(false);
    expect(readIndex(f)).toEqual([]);
  });

  it("没有可用导出器时说清楚，而不是崩成一个空指针", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    // 把 epub 换成一个不存在的实现——Record 上这一格就成了 undefined
    await expect(
      exportDocument(f.projectId, { documentId, format: "epub" }, {
        ...f.deps,
        exporters: { epub: undefined as unknown as DocumentExporter },
      }),
    ).rejects.toThrow(WorkspaceValidationError);
  });
});

describe("文件名敢用用户标题，但跑不出 exports/（§25/§42/§52）", () => {
  it("标题里带 ../ 与控制字符：文件名仍是单段，落在 exports/ 里", async () => {
    const f = await fixture({ title: "../../etc/passwd" });
    const documentId = await firstDocumentId(f);
    const outcome = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);

    expect(outcome.result.filename).not.toMatch(/[\\/]|\.\./);
    expect(outcome.result.filename.endsWith(".docx")).toBe(true);
    expect(readdirSync(join(f.projects, f.projectId, "exports"))).toContain(outcome.result.filename);
    // 目录外面什么都没长出来
    expect(existsSync(join(f.projects, "etc"))).toBe(false);
    expect(existsSync(join(f.projects, "passwd"))).toBe(false);
    // 记账里的路径是项目内相对路径
    expect(outcome.result.artifactPath).toBe(`exports/${outcome.result.filename}`);
  });

  it("导出器递来的危险文件名被忽略：用例层自己算名字", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const outcome = await exportDocument(
      f.projectId,
      { documentId, format: "docx" },
      { ...f.deps, exporters: { docx: fakeExporter("docx", []) } },
    );
    expect(outcome.result.filename).not.toContain("../");
    expect(outcome.result.filename.endsWith(".docx")).toBe(true);
    expect(existsSync(join(f.projects, f.projectId, "exports", outcome.result.filename))).toBe(true);
  });

  it("下载头同时给 ASCII 兜底与 RFC 5987 双轨，中文标题不带乱码", async () => {
    const f = await fixture({ title: "夜行列车" });
    const documentId = await firstDocumentId(f);
    const outcome = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    expect(outcome.download.startsWith("attachment;")).toBe(true);
    expect(outcome.download).toContain("filename*=UTF-8''");
    expect(outcome.download).toContain(encodeURIComponent(`${outcome.result.filename}`));
  });
});

describe("列历史与下载（§24）", () => {
  it("按时间正序；一个都没导出过 → 空数组", async () => {
    const f = await fixture();
    expect(await listProjectExports(f.projectId, f.deps)).toEqual([]);
    const documentId = await firstDocumentId(f);
    await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    await exportDocument(f.projectId, { documentId, format: "epub" }, f.deps);
    const history = await listProjectExports(f.projectId, f.deps);
    expect(history.map((r) => r.format)).toEqual(["docx", "epub"]);
    expect(history[0].createdAt <= history[1].createdAt).toBe(true);
  });

  it("按 id 读回：MIME、字节、下载头都跟导出那一刻一致", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const created = await exportDocument(f.projectId, { documentId, format: "epub" }, f.deps);
    const found = await readExportArtifact(f.projectId, created.result.id, f.deps);
    expect(found).not.toBeNull();
    expect((found as NonNullable<typeof found>).mimeType).toBe(EXPORT_MIME.epub);
    expect((found as NonNullable<typeof found>).byteSize).toBe(created.byteSize);
    expect((found as NonNullable<typeof found>).download).toBe(created.download);
    expect((found as NonNullable<typeof found>).result).toEqual(created.result);
  });

  it("id 不存在 / 文件被人删了：返回 null，不抛错", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const created = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    expect(await readExportArtifact(f.projectId, "out_20260927_101500_zz9999", f.deps)).toBeNull();
    rmSync(join(f.projects, f.projectId, "exports", created.result.filename));
    expect(await readExportArtifact(f.projectId, created.result.id, f.deps)).toBeNull();
  });

  it("id 不合法：400，与 404 分清", async () => {
    const f = await fixture();
    await expect(readExportArtifact("../escape", "out_20260927_101500_aa11bb", f.deps)).rejects.toThrow(
      WorkspaceValidationError,
    );
    await expect(readExportArtifact(f.projectId, "../escape", f.deps)).rejects.toThrow(WorkspaceValidationError);
    await expect(listProjectExports("../escape", f.deps)).rejects.toThrow(WorkspaceValidationError);
  });

  it("两个真实的导出器各导一次，读回来都还是能用的 ZIP", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    expect(docxExporter.format).toBe("docx");
    expect(epubExporter.format).toBe("epub");
    for (const format of ["docx", "epub"] as const) {
      const created = await exportDocument(f.projectId, { documentId, format }, f.deps);
      const found = await readExportArtifact(f.projectId, created.result.id, f.deps);
      expect((found as NonNullable<typeof found>).byteSize).toBeGreaterThan(0);
      expect(created.result.byteSize).toBe((found as NonNullable<typeof found>).byteSize);
    }
    expect(readIndex(f)).toHaveLength(2);
  });
});

describe("响应体里没有绝对路径（§67）", () => {
  it("导出结果与下载结果都只带项目内相对路径", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    const created = await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    const found = await readExportArtifact(f.projectId, created.result.id, f.deps);
    for (const payload of [created, found] as unknown as Array<Record<string, unknown>>) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(f.projects);
      expect(text).not.toContain(f.runs);
      expect(text).not.toContain(tmp as string);
    }
    expect(created.result.artifactPath).toBe(`exports/${created.result.filename}`);
  });

  it("真实导出器产出的 index.json 里也不出现项目根路径", async () => {
    const f = await fixture();
    const documentId = await firstDocumentId(f);
    await exportDocument(f.projectId, { documentId, format: "docx" }, f.deps);
    const text = readFileSync(join(f.projects, f.projectId, "exports", "index.json"), "utf8");
    expect(text).not.toContain(f.projects);
  });
});
