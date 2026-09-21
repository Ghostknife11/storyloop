import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

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

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速", "主角目标明确"],
  problems: ["中段线索重复", "高潮转折略突然"],
};

const passed: ValidationResult = { passed: true, issues: [] };

const failed: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度 12 低于下限 750。" }],
};

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
    const meta = JSON.parse(readFileSync(runDir(root, RUN_ID) + "/metadata.json", "utf8"));
    expect(meta.run_id).toBe(RUN_ID);
    expect(meta.status).toBe("completed");
  });

  it("§22 saves review JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putReview(RUN_ID, review);
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "review.json"), "utf8")) as ReviewResult;
    expect(saved).toEqual(review);
    expect(saved.score).toBe(74);
    expect(saved.strengths).toHaveLength(2);
    expect(saved.problems).toHaveLength(2);
  });

  it("§30 re-review 覆盖 review.json，不产生 review_v1 / review_history", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putReview(RUN_ID, review);
    store.putReview(RUN_ID, { ...review, score: 88, summary: "重审后的总结。" });
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "review.json"), "utf8")) as ReviewResult;
    expect(saved.score).toBe(88);
    expect(readdirSync(runDir(root, RUN_ID))).toEqual(["review.json"]);
  });

  it("§21/§22 saves validation JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putValidation(RUN_ID, passed);
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "validation.json"), "utf8")) as ValidationResult;
    expect(saved).toEqual(passed);
    expect(saved.passed).toBe(true);
    expect(saved.issues).toEqual([]);
  });

  it("§22 失败的 ValidationResult 同样原样落盘（passed=false + issues）", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putValidation(RUN_ID, failed);
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "validation.json"), "utf8")) as ValidationResult;
    expect(saved.passed).toBe(false);
    expect(saved.issues).toEqual(failed.issues);
    expect(saved.issues[0]?.code).toBe("TOO_SHORT");
    expect(saved.issues[0]?.severity).toBe("error");
  });

  it("§27 re-validate 覆盖 validation.json，不产生 validation_v1 / validation_history", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putValidation(RUN_ID, passed);
    store.putValidation(RUN_ID, failed);
    const saved = JSON.parse(readFileSync(join(runDir(root, RUN_ID), "validation.json"), "utf8")) as ValidationResult;
    expect(saved).toEqual(failed);
    // §27：同一份 validation.json 被覆盖，不建历史
    expect(readdirSync(runDir(root, RUN_ID))).toEqual(["validation.json"]);
  });

  it("§41 validation JSON 为 UTF-8 中文且是合法 JSON", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putValidation(RUN_ID, {
      passed: false,
      issues: [{ code: "MISSING_PROTAGONIST", severity: "error", message: "正文中未找到主角「陈岚」。" }],
    });
    const raw = readFileSync(join(runDir(root, RUN_ID), "validation.json"), "utf8");
    expect(raw).toContain("陈岚");
    const saved = JSON.parse(raw) as ValidationResult;
    expect(saved.issues[0]?.message).toContain("陈岚");
  });

  it("§41 putValidation 与其它产物共用同一套越界防护", () => {
    const { store, root } = withStore();
    expect(() => store.putValidation("../escape", passed)).toThrow(/越界/);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
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
    store.putValidation(RUN_ID, passed);
    store.putReview(RUN_ID, review);
    store.putMetadata(RUN_ID, { run_id: RUN_ID });
    const files = readdirSync(runDir(root, RUN_ID)).sort();
    expect(files).toEqual([
      "beats.json", "config.json", "metadata.json", "review.json", "story.md", "validation.json",
    ]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("§22 成功 Run 的目录就是 config / beats / story / validation / review / metadata", () => {
    const { store, root } = withStore();
    store.createRunDirectory(RUN_ID);
    store.putConfig(RUN_ID, config);
    store.putBeatPlan(RUN_ID, plan);
    store.putStory(RUN_ID, config.title, "正文");
    store.putValidation(RUN_ID, passed);
    store.putReview(RUN_ID, review);
    store.putMetadata(RUN_ID, { run_id: RUN_ID });
    expect(readdirSync(runDir(root, RUN_ID)).sort()).toEqual([
      "beats.json", "config.json", "metadata.json", "review.json", "story.md", "validation.json",
    ]);
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
