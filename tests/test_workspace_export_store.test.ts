import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportWriteError, FileExportRepository } from "@/infrastructure/storage/export-store";
import { validateExportResult } from "@/domain/export-artifact";
import { sha256Hex } from "@/infrastructure/tracking/digest";

/**
 * v2.2.0 导出存储（TASK §5/§31/§42/§67）。
 *
 * 这一层的手册很短，但每一条都是别人踩过的：
 *   1. **不许覆盖**。用户手里那份 docx 不会因为又点了一次导出就变成另一版内容，
 *      所以同名即抛错，由上层用 id 尾巴保证不重名。
 *   2. **原子写**。先写临时文件再 rename；半份文件出现在 exports/ 里比写不进去更糟。
 *   3. **错误里只有文件名**（§67）。绝对路径进错误消息，就等于进日志、进响应体。
 *   4. **文件名是不可信输入**（§42）。写盘的函数不知道调用方是谁，`../` 要在这里被挡住，
 *      而不是指望上层一定乖。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function root(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-export-store-"));
  return join(tmp, "projects");
}

const PROJECT = "prj_20260927_101500_a1b2c3";
const OTHER = "prj_20260927_101500_d4e5f6";

function record(overrides: Partial<Parameters<typeof validateExportResult>[0]> = {}): ReturnType<typeof validateExportResult> {
  return validateExportResult({
    schemaVersion: "1",
    id: "out_20260927_101500_aa11bb",
    projectId: PROJECT,
    documentId: "doc_20260927_101500_j442h6",
    format: "docx",
    artifactPath: "exports/夜行列车_aa11bb.docx",
    contentHash: sha256Hex("她从最后一节车厢走进了雨里。"),
    filename: "夜行列车_aa11bb.docx",
    byteSize: 2048,
    createdAt: "2026-09-27T10:15:00.000Z",
    ...overrides,
  });
}

describe("FileExportRepository：目录与路径（§5/§42）", () => {
  it("root 指向 projects/ 根，缺省路径不是当前目录下的裸 projects", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    expect(repo.root).toBe(projects);
    // 构造时不建目录：一个还没有导出的项目不该在磁盘上留下空 exports/
    expect(existsSync(repo.resolveExportsDir(PROJECT))).toBe(false);
  });

  it("拿不到合法项目 id 就抛 ExportWriteError，且不吐绝对路径", () => {
    const repo = new FileExportRepository(root());
    for (const bad of ["../escape", ".", "..", "", "a/b"]) {
      let caught: unknown;
      try {
        repo.resolveExportsDir(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toBeInstanceOf(ExportWriteError);
      expect((caught as Error).message).not.toContain(tmp as string);
      expect((caught as Error).message).not.toMatch(/[A-Za-z]:\\|\/(Users|home|tmp)\//);
    }
  });

  it("写与读的路径都在 <project>/exports/ 里，落不出这个目录", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "a.docx", new Uint8Array([1, 2, 3]));
    expect(existsSync(join(projects, PROJECT, "exports", "a.docx"))).toBe(true);
    expect([...repo.listExportFilenames(PROJECT)]).toEqual(["a.docx"]);
  });

  it("认不出的文件名一律拒绝：分隔符、点开头、空、超长", () => {
    const repo = new FileExportRepository(root());
    const bad = ["", ".", "..", ".hidden.docx", "a/b.docx", "a\\b.docx", "x".repeat(129) + ".docx"];
    for (const filename of bad) {
      expect(() => repo.putArtifact(PROJECT, filename, new Uint8Array([1])), filename).toThrow(ExportWriteError);
      expect(repo.exists(PROJECT, filename), filename).toBe(false);
      expect(repo.readArtifact(PROJECT, filename), filename).toBeNull();
    }
  });

  it("两个项目各写各的，互不串门", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "same.docx", new Uint8Array([1]));
    repo.putArtifact(OTHER, "same.docx", new Uint8Array([2, 2]));
    expect([...repo.readArtifact(PROJECT, "same.docx") as Uint8Array]).toEqual([1]);
    expect([...repo.readArtifact(OTHER, "same.docx") as Uint8Array]).toEqual([2, 2]);
    expect(repo.listExportFilenames(OTHER)).toEqual(["same.docx"]);
  });
});

describe("FileExportRepository：字节的落盘（原子写 + 不覆盖）", () => {
  it("写进去的字节原样读回来", () => {
    const repo = new FileExportRepository(root());
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255]);
    repo.putArtifact(PROJECT, "pkg.docx", bytes);
    expect([...(repo.readArtifact(PROJECT, "pkg.docx") as Uint8Array)]).toEqual([...bytes]);
  });

  it("同名再写即抛错：已经导出过的文件不许被悄悄换掉", () => {
    const repo = new FileExportRepository(root());
    repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([1, 2, 3]));
    let caught: unknown;
    try {
      repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([9, 9, 9]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExportWriteError);
    // 内容没被动过
    expect([...(repo.readArtifact(PROJECT, "pkg.docx") as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("写失败的消息里只有文件名，没有项目根路径（§67）", () => {
    const repo = new FileExportRepository(root());
    let caught: unknown;
    try {
      repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([1]));
      repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([1]));
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("pkg.docx");
    expect((caught as Error).message).not.toContain(tmp as string);
  });

  it("临时文件不会留在目录里", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([1, 2, 3, 4]));
    const names = readdirSync(join(projects, PROJECT, "exports"));
    expect(names).toEqual(["pkg.docx"]);
  });

  it("读不存在的文件返回 null，不抛错", () => {
    const repo = new FileExportRepository(root());
    expect(repo.readArtifact(PROJECT, "nope.docx")).toBeNull();
    expect(repo.exists(PROJECT, "nope.docx")).toBe(false);
  });

  it("目录被外部清空之后，exists 与 listExportFilenames 都变成空", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "pkg.docx", new Uint8Array([1]));
    rmSync(join(projects, PROJECT), { recursive: true, force: true });
    expect(repo.listExportFilenames(PROJECT)).toEqual([]);
    expect(repo.exists(PROJECT, "pkg.docx")).toBe(false);
  });
});

describe("FileExportRepository：导出史（只增不改）", () => {
  it("没有导出过的项目：空数组，不是抛错", () => {
    const repo = new FileExportRepository(root());
    expect(repo.listExports(PROJECT)).toEqual([]);
  });

  it("追加保持顺序，index.json 自己不出现在文件列表里", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "one.docx", new Uint8Array([1]));
    repo.putArtifact(PROJECT, "two.docx", new Uint8Array([2]));
    repo.recordExport(PROJECT, record({ id: "out_20260927_101500_aa11bb", filename: "one.docx", artifactPath: "exports/one.docx" }));
    repo.recordExport(PROJECT, record({ id: "out_20260927_101500_cc33dd", filename: "two.docx", artifactPath: "exports/two.docx" }));

    const history = repo.listExports(PROJECT);
    expect(history.map((r) => r.filename)).toEqual(["one.docx", "two.docx"]);
    expect(repo.listExportFilenames(PROJECT)).toEqual(["one.docx", "two.docx"]);
  });

  it("读回来的每一条都是校验过的（坏字段进不了内存对象）", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.recordExport(PROJECT, record());
    const onDisk = JSON.parse(readFileSync(join(projects, PROJECT, "exports", "index.json"), "utf8"));
    expect(onDisk.exports).toHaveLength(1);
    expect(onDisk.exports[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.listExports(PROJECT)[0]).toEqual(record());
  });

  it("index.json 被手改坏了：整份读不出来，但目录里的文件还在", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.putArtifact(PROJECT, "one.docx", new Uint8Array([1]));
    repo.recordExport(PROJECT, record());
    writeFileSync(join(projects, PROJECT, "exports", "index.json"), "{ 这不是 JSON", "utf8");
    expect(repo.listExports(PROJECT)).toEqual([]);
    expect(repo.listExportFilenames(PROJECT)).toEqual(["one.docx"]);
  });

  it("数组里坏掉的那一条整条丢掉，不影响其它条", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.recordExport(PROJECT, record());
    mkdirSync(join(projects, PROJECT, "exports"), { recursive: true });
    const good = JSON.parse(readFileSync(join(projects, PROJECT, "exports", "index.json"), "utf8"));
    writeFileSync(
      join(projects, PROJECT, "exports", "index.json"),
      JSON.stringify({ exports: [{ ...good.exports[0], id: "out_20260927_101500_ee55ff" }, { id: "坏号" }, null, good.exports[0]] }, null, 2),
      "utf8",
    );
    expect(repo.listExports(PROJECT).map((r) => r.id)).toEqual(["out_20260927_101500_ee55ff", "out_20260927_101500_aa11bb"]);
  });

  it("记录里不含绝对路径：写进 index.json 的 artifactPath 是项目内相对路径（§67）", () => {
    const projects = root();
    const repo = new FileExportRepository(projects);
    repo.recordExport(PROJECT, record());
    const text = readFileSync(join(projects, PROJECT, "exports", "index.json"), "utf8");
    expect(text).not.toContain(projects);
    expect(JSON.parse(text).exports[0].artifactPath).toBe("exports/夜行列车_aa11bb.docx");
  });
});
