import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { QualityAssembler } from "@/core/quality-assembler";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import { qualityResultOf, type QualityResult } from "@/types/quality";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_STORY,
  FakeLLM,
  repoRoot,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.2.0 §54/§55/§56/§57 质量快照在真实管道里的落点。
 *
 * 只有 LLM、Validator、Reviewer、Repairer 是假的（或编排好的），Pipeline / ArtifactStore
 * 全是真组件，落盘结构与生产一致。重点验证三件事：
 *   1. 快照在 attempt 级与 Run 根目录都有，且内容是修订后那一轮的结论（§56）
 *   2. 重试时每个 attempt 各留一份，根目录取入选那份（§55）
 *   3. 修订目录不写 quality.json——attempt 级那份已经是修订后的快照（§22 的选择）
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify({
  score: 82,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
  suggestions: ["压缩重复线索，让中段事件承担新的推进功能。"],
});
const LOW_REVIEW = JSON.stringify({
  score: 41,
  summary: "高潮冲突没有展开。",
  strengths: ["开篇有画面感"],
  problems: ["高潮缺失"],
});

function pipelineWith(
  llm: FakeLLM,
  store: ArtifactStore,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  validator: unknown = new StoryValidator(),
  reviewer: unknown = new BasicReviewer(llm as never),
) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    validator as never,
    reviewer as never,
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function qualityAt(path: string): QualityResult {
  const parsed = qualityResultOf(readJson(path));
  expect(parsed, `${path} 应是合法的 QualityResult`).not.toBeNull();
  return parsed as QualityResult;
}

describe("§54 Happy Path：一次装配，两份落盘", () => {
  it("Plan → Generate → Validate → Review → Assemble → Persist → Finalize", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    // 内存里的返回值与磁盘一致
    expect(result.quality.overall_score).toBe(82);
    expect(result.quality.accepted).toBe(true);
    expect(qualityAt(join(runDir, "quality.json"))).toEqual(result.quality);
    expect(qualityAt(join(runDir, "attempts", "01", "quality.json"))).toEqual(result.quality);

    // UTF-8 JSON，键集固定（没有维度时与 v1.2.0 逐字一致）；与其它产物同一套两空格缩进
    expect(readFileSync(join(runDir, "quality.json"), "utf8")).toBe(JSON.stringify(result.quality, null, 2));
    expect(Object.keys(result.quality).sort()).toEqual([
      "accepted", "issues", "overall_score", "suggestions", "summary", "validation_passed",
    ]);

    // metadata 与快照同口径（§28/§29：不复用 quality_status）
    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.quality_status).toBe("accepted");
    expect(meta.quality_assembly_status).toBe("completed");
    expect(meta.overall_score).toBe(82);
    expect(meta.quality_issue_count).toBe(0);
    expect(meta.artifacts).toMatchObject({ quality: "quality.json" });
  });

  it("稳定 JSON：同样的输入写出来的文本逐字一致", async () => {
    const first = withTmpDir();
    const a = await pipelineWith(new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]), new ArtifactStore()).run(SAMPLE_CONFIG);
    const aText = readFileSync(join(first, "runs", a.run_id, "quality.json"), "utf8");

    const second = withTmpDir();
    const b = await pipelineWith(new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]), new ArtifactStore()).run(SAMPLE_CONFIG);
    const bText = readFileSync(join(second, "runs", b.run_id, "quality.json"), "utf8");
    expect(aText).toBe(bText);
  });
});

describe("§55 Retry Path：每个 attempt 一份，根目录取入选那份", () => {
  it("Attempt 1 低分、Attempt 2 高分：两份快照各自记录，根目录与 Attempt 2 一致", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(2);

    const first = qualityAt(join(runDir, "attempts", "01", "quality.json"));
    const second = qualityAt(join(runDir, "attempts", "02", "quality.json"));
    expect(first.overall_score).toBe(41);
    expect(first.accepted).toBe(false);
    expect(first.issues).toEqual([
      { id: "review-1", source: "review", category: "review_problem", message: "高潮缺失" },
    ]);
    expect(second.overall_score).toBe(82);
    expect(second.accepted).toBe(true);
    expect(second.issues).toEqual([]);

    // 根目录快照 = 入选 attempt 的快照（§57 promote）
    expect(qualityAt(join(runDir, "quality.json"))).toEqual(second);
    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.overall_score).toBe(82);
  });

  it("用尽 Attempt：根目录是最后一次尝试的快照，accepted=false", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, SAMPLE_STORY, LOW_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.quality_status).toBe("exhausted");
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(qualityAt(join(runDir, "quality.json")).accepted).toBe(false);
    expect(qualityAt(join(runDir, "quality.json")).overall_score).toBe(41);
    expect(readJson(join(runDir, "metadata.json")).quality_issue_count).toBe(1);
  });
});

describe("§56 Repair Path：快照描述修订后的正文", () => {
  it("低分 → 修订 → 重新审阅：快照取修订后的分数，不是修订前那份", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([
      PLAN_REPLY,
      SAMPLE_STORY,
      LOW_REVIEW,
      `修订后的正文，补上了高潮。${SAMPLE_STORY}`,
      GOOD_REVIEW,
    ]);
    const result = await pipelineWith(llm, new ArtifactStore()).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);
    const attemptDir = join(runDir, "attempts", "01");
    const repairDir = join(attemptDir, "repairs", "01");

    expect(result.quality_status).toBe("accepted");
    expect(result.attempts[0].repairs).toHaveLength(1);

    // attempt 级与 Run 根目录的快照都是修订后那一轮（82 分）
    const attemptQuality = qualityAt(join(attemptDir, "quality.json"));
    expect(attemptQuality.overall_score).toBe(82);
    expect(attemptQuality.summary).toBe("节奏紧凑，悬念保持到尾。");
    expect(attemptQuality.accepted).toBe(true);
    expect(qualityAt(join(runDir, "quality.json"))).toEqual(attemptQuality);

    // 首次结论仍然留在 review.json / validation.json（刻意的不对称）
    expect(readJson(join(attemptDir, "review.json")).score).toBe(41);
    expect(readJson(join(repairDir, "review.json")).score).toBe(82);

    // §22：修订目录不写 quality.json——同一份内容写两遍没有读者
    expect(existsSync(join(repairDir, "quality.json"))).toBe(false);

    // metadata 与快照同口径：三个派生字段都取修订后结论
    const attemptMeta = readJson(join(attemptDir, "metadata.json"));
    expect(attemptMeta.overall_score).toBe(82);
    expect(attemptMeta.quality_issue_count).toBe(0);
    expect(attemptMeta.quality_assembly_status).toBe("completed");
    expect(attemptMeta.review_score).toBe(82);
  });
});

describe("§7/§12 组件自身失败时不伪造结论", () => {
  it("Validator 抛异常：validation_passed = null，快照照样落盘", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const broken = { validate: (): ValidationResult => { throw new Error("validator boom"); } };
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }, broken).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.validation_status).toBe("failed");
    expect(result.validation).toBeNull();
    const quality = qualityAt(join(runDir, "quality.json"));
    expect(quality.validation_passed).toBeNull();
    expect(quality.overall_score).toBe(82);
    expect(quality.accepted).toBe(true);
    // 没有校验结论 → 不写 validation.json，但 quality.json 仍然在（§20）
    expect(existsSync(join(runDir, "validation.json"))).toBe(false);
    expect(existsSync(join(runDir, "quality.json"))).toBe(true);
  });

  it("Reviewer 抛异常：overall_score = null、summary = null，Run 仍 completed", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const broken = { review: (): ReviewResult => { throw new Error("reviewer boom"); } };
    const result = await pipelineWith(llm, new ArtifactStore(), {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }, new StoryValidator(), broken).run(SAMPLE_CONFIG);
    const runDir = join(dir, "runs", result.run_id);

    expect(result.status).toBe("completed");
    expect(result.review_status).toBe("failed");
    const quality = qualityAt(join(runDir, "quality.json"));
    expect(quality.overall_score).toBeNull();
    expect(quality.summary).toBeNull();
    expect(quality.suggestions).toEqual([]);
    expect(quality.validation_passed).toBe(true);
    expect(existsSync(join(runDir, "review.json"))).toBe(false);
    expect(existsSync(join(runDir, "quality.json"))).toBe(true);
  });
});

describe("§57 promote：快照跟着入选正文一起晋升", () => {
  it("promoteAttempt 把 quality.json 一并复制到 Run 根目录，漏文件时跳过而不是报错", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const store = new ArtifactStore();
    const result = await pipelineWith(llm, store).run(SAMPLE_CONFIG);

    const promoted = store.promoteAttempt(result.run_id, 1);
    expect(Object.keys(promoted).sort()).toEqual([
      "quality.json", "review.json", "story.md", "validation.json",
    ]);
    expect(readFileSync(join(dir, "runs", result.run_id, "quality.json"), "utf8")).toBe(
      readFileSync(join(dir, "runs", result.run_id, "attempts", "01", "quality.json"), "utf8"),
    );
  });
});

describe("仓库样例与真实管道产出同一形态", () => {
  it("examples/example_run 的 quality.json 能用装配器从修订后产物重算出来", () => {
    const exampleRoot = join(repoRoot(), "examples", "example_run");
    const stored = qualityAt(join(exampleRoot, "quality.json"));
    const assembled = new QualityAssembler().assemble({
      validation: readJson(join(exampleRoot, "attempts", "01", "repairs", "01", "validation.json")) as unknown as ValidationResult,
      review: readJson(join(exampleRoot, "attempts", "01", "repairs", "01", "review.json")) as unknown as ReviewResult,
      accepted: true,
    });
    expect(stored).toEqual(assembled);
    expect(stored.overall_score).toBe(82);
    expect(stored.accepted).toBe(true);
    expect(stored.issues).toHaveLength(1);
    expect(stored.suggestions).toHaveLength(1);
  });
});
