import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";

/**
 * §13/§14/§21/§22/§50/§63 ArtifactStore：只负责落盘，
 * 不调用 LLM、不分析内容、不决定流程。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  summary: "从失踪到真相",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚", "周衡"] },
  ],
});

const RUN_ID = "20260920_101500_ab12cd";

let tmp: string | null = null;
const realCwd = process.cwd();
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withStore() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-store-"));
  // runsRoot 直接指向临时目录：Run 目录就是 <tmp>/<run_id>
  return { store: new ArtifactStore(tmp as string), root: tmp as string };
}

function runDir(root: string, runId: string) {
  return join(root, runId);
}

describe("ArtifactStore（§13/§14/§63）", () => {
  it("creates run directory", () => {
    const { store, root } = withStore();
    const dir = store.createRunDirectory(RUN_ID);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(runDir(root, RUN_ID));
    expect(store.runExists(RUN_ID)).toBe(true);
    expect(store.runExists("20260920_101500_zzzzzz")).toBe(false);
  });

  it("saves config JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putConfig(RUN_ID, config);
    expect(JSON.parse(readFileSync(runDir(root, RUN_ID) + "/config.json", "utf8"))).toEqual(config);
  });

  it("saves BeatPlan JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putBeatPlan(RUN_ID, plan);
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "beats.json"), "utf8")) as BeatPlan;
    expect(saved.beats).toHaveLength(2);
    expect(saved.beat_plan_version).toBe("1");
  });

  it("saves story Markdown（标题作为 H1）", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putStory(RUN_ID, config.title, "正文第一段。");
    const md = readFileSync(join(runDir(root, RUN_ID), "story.md"), "utf8");
    expect(md.startsWith("# 消失的目击者\n\n")).toBe(true);
    expect(md).toContain("正文第一段。");
  });

  it("saves metadata JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putMetadata(RUN_ID, { run_id: RUN_ID, status: "completed" });
    const meta = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "metadata.json"), "utf8"));
    expect(meta.run_id).toBe(RUN_ID);
    expect(meta.status).toBe("completed");
  });

  it("UTF-8 Chinese works", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putStory(RUN_ID, "中文标题：消失的目击者", "中文正文——陈岚走进雨夜。");
    const md = readFileSync(join(runDir(root, RUN_ID), "story.md"), "utf8");
    expect(md).toContain("# 中文标题：消失的目击者");
    expect(md).toContain("中文正文——陈岚走进雨夜。");
  });

  it("§21 原子写入：不残留 .tmp 文件", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putConfig(RUN_ID, config);
    store.putBeatPlan(RUN_ID, plan);
    store.putStory(RUN_ID, config.title, "正文");
    store.putMetadata(RUN_ID, { run_id: RUN_ID });
    const files = readdirSync(runDir(root, RUN_ID)).sort();
    expect(files).toEqual(["beats.json", "config.json", "metadata.json", "story.md"]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("§21 原子写入：覆盖旧文件不留中间态", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putMetadata(RUN_ID, { status: "planning" });
    store.putMetadata(RUN_ID, { status: "completed" });
    const meta = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "metadata.json"), "utf8"));
    expect(meta.status).toBe("completed");
    expect(readdirSync(runDir(root, RUN_ID))).toEqual(["metadata.json"]);
  });

  it("默认根目录为 <cwd>/runs", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-cwd-"));
    process.chdir(tmp as string);
    const store = new ArtifactStore();
    const dir = store.createRunDirectory(RUN_ID);
    expect(dir).toBe(join(tmp as string, "runs", RUN_ID));
    expect(existsSync(dir)).toBe(true);
  });
});

describe("ArtifactStore — path traversal（§50）", () => {
  it("run_id 含 .. 无法越出 runs 根目录", () => {
    const { store } = withStore();
    expect(() => store.resolveRunDir("../evil")).toThrow(/越界/);
    expect(() => store.resolveRunDir("../../etc")).toThrow(/越界/);
    expect(() => store.resolveRunDir("a/../../b")).toThrow(/越界/);
  });

  it("绝对路径无法越出 runs 根目录", () => {
    const { store } = withStore();
    expect(() => store.resolveRunDir("C:/Windows/System32")).toThrow(/越界/);
    expect(() => store.resolveRunDir("C:\\Windows")).toThrow(/越界/);
  });

  it("越界 run_id 连写入也做不了", () => {
    const { store, root } = withStore();
    expect(() => store.putConfig("../escape", config)).toThrow(/越界/);
    expect(() => store.putStory("..", "t", "s")).toThrow(/越界/);
    expect(existsSync(join(root, ".."))).toBe(true);
  });

  it("合法 run_id 正常放行（不误伤）", () => {
    const { store, root } = withStore();
    expect(store.resolveRunDir("20260920_101500_ab12cd")).toBe(runDir(root, "20260920_101500_ab12cd"));
  });

  it("runs 根目录本身被占用时报错清晰", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-blocked-"));
    writeFileSync(join(tmp as string, "runs"), "not a directory", "utf8");
    const store = new ArtifactStore(join(tmp as string, "runs"));
    expect(() => store.createRunDirectory(RUN_ID)).toThrow();
  });
});
