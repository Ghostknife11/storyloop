import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_CONTENT_MAX,
  documentListItemOf,
  documentSourceOf,
  storyDocumentOf,
  validateDocumentPatch,
  validateStoryDocument,
  withDocumentPatch,
  wordCountOf,
  type StoryDocument,
} from "@/domain/story-document";
import { DocumentHashError, FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { sha256Hex } from "@/infrastructure/tracking/digest";

/**
 * v2.2.0 稿件生命周期（TASK §47）。
 *
 * 覆盖建空白稿、从 Run 建稿、保存、改标题、标记 final、正文一变哈希就变、
 * sourceRunId 一路保留。存储侧额外守住两条：contentHash 与正文对不上不许落盘，
 * 不合法 id 一律抛错（拼不出路径）。
 */

let tmp: string | null = null;

afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function projectsRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-docs-"));
  return tmp as string;
}

const PROJECT_ID = "prj_20260927_101500_ab12cd";
const DOC_ID = "doc_20260927_101600_cd34ef";

function documentOf(overrides: Record<string, unknown> = {}): StoryDocument {
  const content = typeof overrides.content === "string" ? overrides.content : "夜行列车进站时，站台上只剩下她一个人。";
  return validateStoryDocument({
    schemaVersion: "1",
    id: DOC_ID,
    projectId: PROJECT_ID,
    title: "夜行列车",
    status: "draft",
    source: "edited",
    content,
    sourceRunId: null,
    contentHash: sha256Hex(content),
    createdAt: "2026-09-27T10:16:00.000Z",
    updatedAt: "2026-09-27T10:16:00.000Z",
    isFavorite: false,
    ...overrides,
  });
}

describe("StoryDocument 领域模型（§7/§47）", () => {
  it("空白稿件：正文为空、来源是 edited、draft 状态", () => {
    const doc = documentOf({ content: "", title: "未命名" });
    expect(doc.content).toBe("");
    expect(doc.source).toBe("edited");
    expect(doc.status).toBe("draft");
    expect(doc.sourceRunId).toBeNull();
    expect(doc.contentHash).toBe(sha256Hex(""));
  });

  it("从 Run 建稿：sourceRunId 记下来，整份正文被复制进来", () => {
    const runStory = "她看见车窗上自己的倒影先一步点了头。";
    const doc = documentOf({ source: "generated", sourceRunId: "20260927_090000_zz99yy", content: runStory });
    expect(doc.source).toBe("generated");
    expect(doc.sourceRunId).toBe("20260927_090000_zz99yy");
    expect(doc.content).toBe(runStory);
    expect(documentSourceOf({ sourceRunId: "x" })).toBe("generated");
  });

  it("来源判定：Run → generated；带了正文 → imported；空白 → edited", () => {
    expect(documentSourceOf({})).toBe("edited");
    expect(documentSourceOf({ content: "   " })).toBe("edited");
    expect(documentSourceOf({ content: "粘贴进来的一段" })).toBe("imported");
    expect(documentSourceOf({ sourceRunId: "20260927_090000_zz99yy", content: "" })).toBe("generated");
  });

  it("保存：正文一变哈希就变，标题与来源可以一起改", () => {
    const base = documentOf();
    const next = withDocumentPatch(
      base,
      { title: "夜行列车（改）", content: "她最终还是上了车。" },
      sha256Hex("她最终还是上了车。"),
      "2026-09-27T11:00:00.000Z",
    );
    expect(next.contentHash).not.toBe(base.contentHash);
    expect(next.contentHash).toBe(sha256Hex(next.content));
    expect(next.title).toBe("夜行列车（改）");
    expect(next.updatedAt).toBe("2026-09-27T11:00:00.000Z");
    // id / 项目 / 创建时间 / 来源 Run 一律不动
    expect(next.id).toBe(base.id);
    expect(next.projectId).toBe(base.projectId);
    expect(next.createdAt).toBe(base.createdAt);
    expect(next.sourceRunId).toBe(base.sourceRunId);
  });

  it("标记 final 只是改状态，不锁正文（TASK §11）", () => {
    const base = documentOf();
    const final = withDocumentPatch(base, { status: "final" }, base.contentHash, "2026-09-27T11:00:00.000Z");
    expect(final.status).toBe("final");
    const edited = withDocumentPatch(final, { content: "结尾重写。" }, sha256Hex("结尾重写。"), "2026-09-27T11:30:00.000Z");
    expect(edited.status).toBe("final");
    expect(edited.content).toBe("结尾重写。");
  });

  it("sourceRunId 一路保留，保存请求里也改不了它", () => {
    const fromRun = documentOf({ source: "generated", sourceRunId: "20260927_090000_zz99yy" });
    const saved = withDocumentPatch(fromRun, { content: "改一句。" }, sha256Hex("改一句。"), "2026-09-27T11:00:00.000Z");
    expect(saved.sourceRunId).toBe("20260927_090000_zz99yy");
    expect(() => validateDocumentPatch({ sourceRunId: "另一条 Run" })).toThrow(/不支持字段 sourceRunId/);
  });

  it("contentHash 不接受请求体直接给——只能由正文算出来", () => {
    expect(() => validateDocumentPatch({ content: "x", contentHash: sha256Hex("x") })).toThrow(/不支持字段 contentHash/);
  });

  it("contentHash 必须是 SHA-256 十六进制", () => {
    expect(() => documentOf({ content: "x" })).not.toThrow(); // documentOf 会自己算
    expect(() => validateStoryDocument({ ...documentOf(), contentHash: "abc" })).toThrow(/SHA-256/);
  });

  it("正文有上限，标题不可为空", () => {
    expect(() => documentOf({ content: "x".repeat(DOCUMENT_CONTENT_MAX + 1) })).toThrow(/不能超过/);
    expect(() => documentOf({ title: "  " })).toThrow(/必须是非空字符串/);
  });

  it("字数统计：汉字逐字，拉丁按词", () => {
    expect(wordCountOf("")).toBe(0);
    expect(wordCountOf("夜行列车")).toBe(4);
    expect(wordCountOf("the night train arrived")).toBe(4);
    expect(wordCountOf("她在 night train 上")).toBe(3 + 2);
  });

  it("列表项带字数，不带正文", () => {
    const item = documentListItemOf(documentOf());
    expect(item.wordCount).toBeGreaterThan(0);
    expect(Object.keys(item)).not.toContain("content");
  });

  it("坏数据读回来是 null，不抛", () => {
    expect(storyDocumentOf(null)).toBeNull();
    expect(storyDocumentOf({ schemaVersion: "1" })).toBeNull();
    expect(storyDocumentOf({ ...documentOf(), contentHash: "不是哈希" })).toBeNull();
  });
});

describe("FileDocumentRepository（§5/§47）", () => {
  it("写、读、列三件事闭环", () => {
    const root = projectsRoot();
    const store = new FileDocumentRepository(root);
    const doc = documentOf();
    store.putDocument(doc);
    const other = documentOf({ id: "doc_20260927_101700_ef56ab", title: "第二篇" });
    store.putDocument(other);

    expect(store.listDocumentIds(PROJECT_ID)).toEqual([DOC_ID, other.id]);
    expect(store.readDocument(PROJECT_ID, DOC_ID)?.title).toBe("夜行列车");
    expect(store.exists(PROJECT_ID, DOC_ID)).toBe(true);
    expect(store.exists(PROJECT_ID, "doc_nope")).toBe(false);
  });

  it("项目还没建过 documents/ 时列空数组，不抛", () => {
    const store = new FileDocumentRepository(projectsRoot());
    expect(store.listDocumentIds("prj_empty")).toEqual([]);
    expect(store.readDocument("prj_empty", DOC_ID)).toBeNull();
  });

  it("contentHash 与正文对不上：拒绝落盘，盘上什么都不多", () => {
    const root = projectsRoot();
    const store = new FileDocumentRepository(root);
    const doc = documentOf({ contentHash: sha256Hex("别的内容") });
    expect(() => store.putDocument(doc)).toThrow(DocumentHashError);
    expect(store.readDocument(PROJECT_ID, DOC_ID)).toBeNull();
  });

  it("改过的正文必须配新哈希才写得进去", () => {
    const root = projectsRoot();
    const store = new FileDocumentRepository(root);
    store.putDocument(documentOf());
    const edited = "她看见车窗上自己的倒影先一步点了头，然后 second thought。";
    store.putDocument(withDocumentPatch(
      store.readDocument(PROJECT_ID, DOC_ID)!,
      { content: edited },
      sha256Hex(edited),
      "2026-09-27T11:00:00.000Z",
    ));
    const read = store.readDocument(PROJECT_ID, DOC_ID)!;
    expect(read.content).toBe(edited);
    expect(read.contentHash).toBe(sha256Hex(edited));
  });

  it("稿件 json 被手改坏时按不存在处理", () => {
    const root = projectsRoot();
    const store = new FileDocumentRepository(root);
    store.putDocument(documentOf());
    writeFileSync(join(store.resolveDocumentsDir(PROJECT_ID), `${DOC_ID}.json`), "{ 坏", "utf8");
    expect(store.readDocument(PROJECT_ID, DOC_ID)).toBeNull();
    expect(store.listDocumentIds(PROJECT_ID)).toEqual([]);
  });

  it("不合法 id 一律抛错，拼不出路径（§42）", () => {
    const store = new FileDocumentRepository(projectsRoot());
    for (const bad of ["../escape", "a/b", ".", "..", ""]) {
      expect(() => store.readDocument(bad, DOC_ID), bad).toThrow();
      expect(() => store.readDocument(PROJECT_ID, bad), bad).toThrow();
      expect(() => store.resolveDocumentsDir(bad), bad).toThrow();
      expect(store.exists(bad, DOC_ID), bad).toBe(false);
    }
  });

  it("稿件写进它自己声明的项目目录，按别的项目 id 读不到（§42）", () => {
    const store = new FileDocumentRepository(projectsRoot());
    store.putDocument(documentOf({ projectId: "prj_a" }));
    expect(store.listDocumentIds("prj_a")).toEqual([DOC_ID]);
    expect(store.readDocument("prj_b", DOC_ID)).toBeNull();
    expect(store.listDocumentIds("prj_b")).toEqual([]);
  });

  it("删稿件连 revisions/ 一起删，两个 id 都得先过模式（§42）", () => {
    const root = projectsRoot();
    const store = new FileDocumentRepository(root);
    store.putDocument(documentOf());
    const revisions = join(root, PROJECT_ID, "revisions", DOC_ID);
    mkdirSync(revisions, { recursive: true });
    writeFileSync(join(revisions, "index.json"), "{}", "utf8");
    // 上一层放一个同名结构：真把路径拼出去了，删的就是它而不是项目里的那份
    const outside = join(root, "revisions", DOC_ID);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "index.json"), "{}", "utf8");

    store.deleteDocument(PROJECT_ID, DOC_ID);

    expect(store.readDocument(PROJECT_ID, DOC_ID)).toBeNull();
    expect(existsSync(revisions)).toBe(false);
    expect(existsSync(outside)).toBe(true);

    for (const bad of ["../escape", "a/b", "..", ""]) {
      expect(() => store.deleteDocument(PROJECT_ID, bad), bad).toThrow();
      expect(() => store.deleteDocument(bad, DOC_ID), bad).toThrow();
    }
  });
});
