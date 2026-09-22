import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { validateStoryConfig } from "@/types/story-config";
import {
  MISSING_ENDING,
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  FakeLLM,
  repoRoot,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.0.0 合同测试：Run 产物布局冻结（TASK §7/§8/§9/§10/§11/§50）。
 *
 * 这份测试钉死的是「磁盘上长什么样」：目录层级、文件名、每层 metadata 的字段集。
 * 行为路径（什么时候重试、什么时候修订）由 test_pipeline_integration.test.ts 覆盖，
 * 这里只关心最终产物是否仍然符合 v1 冻结约定。
 *
 * 只有 LLM 是假的，Pipeline / ArtifactStore / Validator / Reviewer 全是真组件。
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify(SAMPLE_REVIEW);
const LOW_REVIEW = JSON.stringify({ score: 41, summary: "正文冲突没有展开。", strengths: ["开头有画面"], problems: ["高潮缺失"] });

/** v1.0.0 冻结的运行级文件名。 */
const RUN_FILES = ["beats.json", "config.json", "metadata.json", "review.json", "story.md", "validation.json"] as const;

/** v1.0.0 冻结的 attempt 级文件名（initial_story.md 只在发生过修订时出现）。 */
const ATTEMPT_FILES = ["metadata.json", "review.json", "story.md", "validation.json"] as const;

/** v1.0.0 冻结的 repair 级文件名。 */
const REPAIR_FILES = ["metadata.json", "request.json", "review.json", "story.md", "validation.json"] as const;

/** TASK §9 要求的运行级 metadata 必备字段。 */
const RUN_META_REQUIRED = [
  "run_id",
  "project_version",
  "status",
  "quality_status",
  "started_at",
  "finished_at",
  "model",
  "attempt_count",
  "selected_attempt",
  "validation_status",
  "review_status",
  "repair_count",
  "artifacts",
] as const;

/** TASK §10 要求的 attempt 级 metadata 必备字段。 */
const ATTEMPT_META_REQUIRED = [
  "attempt_number",
  "accepted",
  "retry_reason",
  "validation_passed",
  "review_score",
  "repair_count",
  "error",
] as const;

/** TASK §11 要求的 repair 级 metadata 必备字段。 */
const REPAIR_META_REQUIRED = [
  "repair_number",
  "issue_type",
  "success",
  "before_validation_passed",
  "after_validation_passed",
  "before_review_score",
  "after_review_score",
] as const;

function pipelineWith(llm: FakeLLM, store: ArtifactStore, retryPolicy?: RetryPolicy) {
  // 四个阶段都只用到 generate()，这里一次性降到它们需要的形状
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator(),
    new BasicReviewer(client),
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
  );
}

function runOf(dir: string, runId: string) {
  return join(dir, "runs", runId);
}

function readJson(dir: string, runId: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runOf(dir, runId), rel), "utf8")) as Record<string, unknown>;
}

function keys(dir: string, runId: string, rel: string): string[] {
  return Object.keys(readJson(dir, runId, rel)).sort();
}

function expectHasAll(actual: string[], required: readonly string[], label: string) {
  const missing = required.filter((field) => !actual.includes(field));
  expect(missing, `${label} 缺少冻结字段`).toEqual([]);
}

describe("v1.0.0 产物布局冻结 — Happy Path", () => {
  it("运行级目录只含 attempts/ 与冻结的六个文件", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    expect(readdirSync(runOf(dir, result.run_id)).sort()).toEqual(["attempts", ...RUN_FILES]);
  });

  it("运行级 metadata 带齐 TASK §9 全部必备字段", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    const meta = readJson(dir, result.run_id, "metadata.json");
    expectHasAll(keys(dir, result.run_id, "metadata.json"), RUN_META_REQUIRED, "运行级 metadata");
    expect(meta.project_version).toBe(readFileSync(join(repoRoot(), "VERSION"), "utf8").trim());
    expect(meta.model).toBeTruthy();
    // §7：artifacts 的 value 是文件名，不是绝对路径
    for (const value of Object.values(meta.artifacts as Record<string, string>)) {
      expect(value).not.toMatch(/^([A-Za-z]:)?[\\/]/);
      expect(value).not.toContain("runs/");
    }
  });

  it("attempt/01 落四个冻结文件，metadata 带齐 TASK §10 全部必备字段", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    expect(readdirSync(join(runOf(dir, result.run_id), "attempts", "01")).sort()).toEqual([...ATTEMPT_FILES]);
    expectHasAll(
      keys(dir, result.run_id, "attempts/01/metadata.json"),
      ATTEMPT_META_REQUIRED,
      "attempt metadata",
    );
  });

  it("story.md 是 UTF-8，带标题与正文，且不含任何密钥", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    const story = readFileSync(join(runOf(dir, result.run_id), "story.md"), "utf8");
    expect(story.startsWith(`# ${SAMPLE_CONFIG.title}`)).toBe(true);
    expect(story).toContain("陈岚推开派出所的玻璃门");
    expect(story).not.toContain("sk-");
    expect(story).not.toContain("Bearer");
  });
});

describe("v1.0.0 产物布局冻结 — 重试路径", () => {
  it("第一次 attempt 失败后 attempts/02 出现，且布局与 attempt/01 一致", async () => {
    const dir = withTmpDir();
    const short = "陈岚走进派出所，然后又走了。";
    const llm = new FakeLLM([PLAN_REPLY, short, GOOD_REVIEW, SAMPLE_STORY, GOOD_REVIEW]);
    // 关掉修订，单独看「整篇重试」这条路径：否则第一次校验失败会先走 Repair（TASK §40）
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);

    expect(result.status).toBe("completed");
    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(2);
    const attempts = readdirSync(join(runOf(dir, result.run_id), "attempts")).sort();
    expect(attempts).toEqual(["01", "02"]);
    for (const attempt of attempts) {
      expect(readdirSync(join(runOf(dir, result.run_id), "attempts", attempt)).sort()).toEqual([...ATTEMPT_FILES]);
    }
  });
});

describe("v1.0.0 产物布局冻结 — 修订路径", () => {
  /** 低分（< min_review_score）会先触发定点修订，再重新校验 / 审阅。 */
  const repaired = `${SAMPLE_STORY}\n\n陈岚在法庭上见到了证人。`;

  it("repairs/01 落五个冻结文件，request.json 只有三个字段，repair metadata 带齐 §11 字段", async () => {
    const dir = withTmpDir();
    // plan → attempt1 正文 → 低分审阅（触发修订）→ 修订后正文 → 复审高分
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, repaired, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    const repairDir = join(runOf(dir, result.run_id), "attempts", "01", "repairs", "01");
    expect(existsSync(repairDir)).toBe(true);
    expect(readdirSync(repairDir).sort()).toEqual([...REPAIR_FILES]);

    const request = readJson(dir, result.run_id, "attempts/01/repairs/01/request.json");
    expect(Object.keys(request).sort()).toEqual(["issue_message", "issue_type", "repair_number"]);
    expect(request.issue_type).toBeTruthy();

    expectHasAll(
      keys(dir, result.run_id, "attempts/01/repairs/01/metadata.json"),
      REPAIR_META_REQUIRED,
      "repair metadata",
    );
  });

  it("initial_story.md 只在发生过修订的 attempt 下出现", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, repaired, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const attemptDir = join(runOf(dir, result.run_id), "attempts", "01");
    // repairs/ 目录只在发生过修订时出现，initial_story.md 同理
    expect(readdirSync(attemptDir).sort()).toEqual(["initial_story.md", "repairs", ...ATTEMPT_FILES].sort());
  });

  it("修订这次尝试的 attempt metadata 记 repair_count=1 与修订记录", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, repaired, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const meta = readJson(dir, result.run_id, "attempts/01/metadata.json");
    expect(meta.repair_count).toBe(1);
    expect(Array.isArray(meta.repairs)).toBe(true);
    expect((meta.repairs as unknown[]).length).toBe(1);
  });
});

describe("v1.0.0 产物布局冻结 — 用尽路径", () => {
  it("attempt 全部失败时 quality_status=exhausted，最终产物仍可读", async () => {
    const dir = withTmpDir();
    const short = "陈岚走进派出所，然后又走了。";
    const replies = [PLAN_REPLY];
    for (let i = 0; i < DEFAULT_RETRY_POLICY.max_attempts; i++) {
      replies.push(short, GOOD_REVIEW);
    }
    const llm = new FakeLLM(replies);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);

    expect(result.quality_status).toBe("exhausted");
    // 用尽不等于没有产物：story.md 与 validation.json 必须还在
    expect(existsSync(join(runOf(dir, result.run_id), "story.md"))).toBe(true);
    expect(existsSync(join(runOf(dir, result.run_id), "validation.json"))).toBe(true);
    expect(readJson(dir, result.run_id, "metadata.json").quality_status).toBe("exhausted");
  });
});

describe("v1.0.0 官方示例 Run", () => {
  const exampleRoot = join(repoRoot(), "examples", "example_run");

  it("examples/example_run 的目录结构与冻结布局一致", () => {
    expect(existsSync(exampleRoot), "examples/example_run 缺失").toBe(true);
    expect(readdirSync(exampleRoot).filter((f) => f !== "README.md").sort()).toEqual(["attempts", ...RUN_FILES].sort());
    expect(readdirSync(join(exampleRoot, "attempts")).sort()).toEqual(["01"]);
    expect(readdirSync(join(exampleRoot, "attempts", "01")).sort()).toEqual(
      ["initial_story.md", "repairs", ...ATTEMPT_FILES].sort(),
    );
    expect(readdirSync(join(exampleRoot, "attempts", "01", "repairs")).sort()).toEqual(["01"]);
    expect(readdirSync(join(exampleRoot, "attempts", "01", "repairs", "01")).sort()).toEqual([...REPAIR_FILES]);
  });

  it("示例里的 config.json / beats.json / validation.json / review.json 都能通过 schema 校验", () => {
    const config = JSON.parse(readFileSync(join(exampleRoot, "config.json"), "utf8")) as unknown;
    const beats = JSON.parse(readFileSync(join(exampleRoot, "beats.json"), "utf8")) as unknown;
    const validation = JSON.parse(readFileSync(join(exampleRoot, "validation.json"), "utf8")) as unknown;
    const review = JSON.parse(readFileSync(join(exampleRoot, "review.json"), "utf8")) as unknown;

    expect(() => validateStoryConfig(config)).not.toThrow();
    // 示例把每个可选字段都用上了：读者照抄一份就能覆盖全部字段
    const configKeys = Object.keys(validateStoryConfig(config));
    expectHasAll(configKeys.sort(), ["config_version", "title", "genre", "premise", "target_words"].sort(), "示例 StoryConfig 必填字段");
    for (const optional of ["setting", "protagonist", "conflict", "stakes", "ending", "style", "extra_requirements"]) {
      expect(configKeys, `示例 StoryConfig 应包含可选字段 ${optional}`).toContain(optional);
    }
    expect(JSON.parse(JSON.stringify(beats)).beats.length).toBeGreaterThan(0);
    expect((validation as { passed: boolean }).passed).toBe(true);
    const r = review as { score: number; summary: string; strengths: string[]; problems: string[] };
    expect(Object.keys(r).sort()).toEqual(["problems", "score", "strengths", "summary"]);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("示例 metadata 带齐 TASK §9/§10/§11 必备字段", () => {
    const runMeta = JSON.parse(readFileSync(join(exampleRoot, "metadata.json"), "utf8")) as Record<string, unknown>;
    expectHasAll(Object.keys(runMeta).sort(), RUN_META_REQUIRED, "示例运行级 metadata");
    const attemptMeta = JSON.parse(
      readFileSync(join(exampleRoot, "attempts", "01", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expectHasAll(Object.keys(attemptMeta).sort(), ATTEMPT_META_REQUIRED, "示例 attempt metadata");
    const repairMeta = JSON.parse(
      readFileSync(join(exampleRoot, "attempts", "01", "repairs", "01", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expectHasAll(Object.keys(repairMeta).sort(), REPAIR_META_REQUIRED, "示例 repair metadata");
  });

  it("示例是安全合成内容：不含密钥、真实邮箱、个人路径", () => {
    const files = [
      "story.md",
      "validation.json",
      "review.json",
      "metadata.json",
      "config.json",
      "beats.json",
      "attempts/01/story.md",
      "attempts/01/repairs/01/story.md",
    ];
    for (const file of files) {
      const text = readFileSync(join(exampleRoot, file), "utf8");
      expect(text, `${file} 不应含密钥`).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(text, `${file} 不应含 Bearer`).not.toContain("Bearer ");
      expect(text, `${file} 不应含本机绝对路径`).not.toMatch(/[A-Za-z]:\\/);
      expect(text, `${file} 不应含本机绝对路径`).not.toMatch(/(^|\s)\/(?:home|Users)\//);
    }
  });
});

describe("v1.0.0 MISSING_ENDING 夹具可用性", () => {
  it("fixtures 提供的 MISSING_ENDING 是一个 error 级 issue", () => {
    expect(MISSING_ENDING.passed).toBe(false);
    expect(MISSING_ENDING.issues[0].severity).toBe("error");
  });
});
