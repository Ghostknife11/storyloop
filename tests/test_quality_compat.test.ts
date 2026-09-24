import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QualityAssembler } from "@/core/quality-assembler";
import { validateReviewResult } from "@/types/review-result";
import type { ReviewResult } from "@/types/review-result";
import { getRun, getRunAttempt } from "@/lib/generate-service";
import { ArtifactStore } from "@/storage/artifact-store";
import { qualityResultOf } from "@/types/quality";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.2.0 §48/§50 向后兼容测试：v1.2.0 只能是 additive。
 *
 * 三类旧资产都必须能原样读：
 *   1. 没有 suggestions 字段的旧 review.json（v1.0 / v1.1 落盘形状）
 *   2. 没有 quality.json 的旧 Run（读接口临时装配，不 500、不要求迁移）
 *   3. 仓库里的 examples/example_run：落盘的 quality.json 必须是 assemble() 的结果
 */

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-quality-compat-"));
  process.chdir(tmp);
  return tmp;
}

/** v1.0.0 形状的审阅结论：四个字段，没有 suggestions。 */
const OLD_REVIEW_JSON = JSON.stringify({
  score: 41,
  summary: "高潮冲突没有展开。",
  strengths: ["开篇有画面感"],
  problems: ["高潮缺失"],
});

const NEW_REVIEW_JSON = JSON.stringify({
  score: 82,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
  suggestions: ["压缩重复线索，让中段事件承担新的推进功能。"],
});

describe("§48 旧 ReviewResult JSON 仍然解析成功", () => {
  it("没有 suggestions 的旧 JSON：四个字段原样通过，键不多出来", () => {
    const review: ReviewResult = validateReviewResult(JSON.parse(OLD_REVIEW_JSON));
    expect(review).toEqual({
      score: 41,
      summary: "高潮冲突没有展开。",
      strengths: ["开篇有画面感"],
      problems: ["高潮缺失"],
    });
    expect("suggestions" in review).toBe(false);
  });

  it("suggestions 显式为 null 时也按旧结构处理", () => {
    const review = validateReviewResult({ ...JSON.parse(OLD_REVIEW_JSON), suggestions: null });
    expect("suggestions" in review).toBe(false);
  });

  it("带 suggestions 的新 JSON：五个字段，建议原文保留", () => {
    const review = validateReviewResult(JSON.parse(NEW_REVIEW_JSON));
    expect(review.suggestions).toEqual(["压缩重复线索，让中段事件承担新的推进功能。"]);
  });
});

describe("§50 v1.0 / v1.1 风格的 Run（没有 quality.json）", () => {
  /** 按 v1.0.0 的产物形状手写一个 Run：没有 quality.json，metadata 也没有 v1.2.0 的新字段。 */
  function writeOldRun(runId: string): string {
    const dir = withTmpDir();
    const runDir = join(dir, "runs", runId);
    const attemptDir = join(runDir, "attempts", "01");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(runDir, "config.json"), JSON.stringify({ title: "消失的目击者" }));
    writeFileSync(join(runDir, "story.md"), "# 消失的目击者\n\n陈岚推开派出所的玻璃门。\n");
    writeFileSync(join(runDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
    writeFileSync(join(runDir, "review.json"), OLD_REVIEW_JSON + "\n");
    writeFileSync(
      join(runDir, "metadata.json"),
      JSON.stringify({
        run_id: runId,
        project_version: "1.1.1",
        status: "completed",
        quality_status: "exhausted",
        attempt_count: 1,
        selected_attempt: 1,
        validation_status: "completed",
        review_status: "completed",
      }),
    );
    writeFileSync(join(attemptDir, "story.md"), "# 消失的目击者\n\n陈岚推开派出所的玻璃门。\n");
    writeFileSync(join(attemptDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
    writeFileSync(join(attemptDir, "review.json"), OLD_REVIEW_JSON + "\n");
    writeFileSync(
      join(attemptDir, "metadata.json"),
      JSON.stringify({
        attempt_number: 1,
        accepted: false,
        retry_reason: "review_score_below_threshold",
        review_score: 41,
        validation_passed: true,
        repair_count: 0,
        repairs: [],
        error: null,
      }),
    );
    return dir;
  }

  it("Run 详情仍 200，quality 由旧结论临时装配出来", async () => {
    const runId = "20260101_120000_oldrun";
    const dir = writeOldRun(runId);
    const store = new ArtifactStore(join(dir, "runs"));

    const result = await getRun(runId, store);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const body = result.json;

    // §52：原有字段一个没少、语义没变
    expect(body.status).toBe("completed");
    expect(body.quality_status).toBe("exhausted");
    expect(body.review?.score).toBe(41);
    expect(body.validation?.passed).toBe(true);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0].review_score).toBe(41);

    // §25/§26：新增的 quality 字段照样可用，分数与旧 review.json 一致
    expect(body.quality).not.toBeNull();
    expect(body.quality?.overall_score).toBe(41);
    expect(body.quality?.validation_passed).toBe(true);
    // §8：采纳结论沿用 Run 级 quality_status
    expect(body.quality?.accepted).toBe(false);
    expect(body.quality?.issues).toEqual([
      { id: "review-1", source: "review", category: "review_problem", message: "高潮缺失" },
    ]);
    expect(body.quality?.suggestions).toEqual([]);
    expect(body.quality?.summary).toBe("高潮冲突没有展开。");
  });

  it("Attempt 详情同样能装配，没有 quality.json 也不 500", async () => {
    const runId = "20260101_120000_oldrun";
    const dir = writeOldRun(runId);
    const store = new ArtifactStore(join(dir, "runs"));

    const result = await getRunAttempt(runId, 1, store);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.json.attempt_number).toBe(1);
    expect(result.json.quality?.overall_score).toBe(41);
    expect(result.json.quality?.accepted).toBe(false);
    expect(result.json.quality?.issues).toHaveLength(1);
  });

  it("磁盘上不会被补写 quality.json（读旧 Run 不做迁移）", async () => {
    const runId = "20260101_120000_oldrun";
    const dir = writeOldRun(runId);
    const store = new ArtifactStore(join(dir, "runs"));
    await getRun(runId, store);
    const files = readdirSync(join(dir, "runs", runId));
    expect(files).not.toContain("quality.json");
    expect(readdirSync(join(dir, "runs", runId, "attempts", "01"))).not.toContain("quality.json");
  });
});

describe("examples/example_run 的快照与装配结果一致（§49）", () => {
  const exampleRoot = join(repoRoot(), "examples", "example_run");

  it("运行级 quality.json == assemble(修订后 validation + 修订后 review, accepted)", () => {
    const stored = qualityResultOf(
      JSON.parse(readFileSync(join(exampleRoot, "quality.json"), "utf8")),
    );
    expect(stored, "仓库样例的 quality.json 形状必须合法").not.toBeNull();

    const assembled = new QualityAssembler().assemble({
      validation: JSON.parse(
        readFileSync(join(exampleRoot, "attempts", "01", "repairs", "01", "validation.json"), "utf8"),
      ),
      review: validateReviewResult(
        JSON.parse(readFileSync(join(exampleRoot, "attempts", "01", "repairs", "01", "review.json"), "utf8")),
      ),
      accepted: true,
    });
    expect(stored).toEqual(assembled);
  });

  it("attempt 级 quality.json 与运行级逐字一致（promote 就是复制）", () => {
    const runLevel = readFileSync(join(exampleRoot, "quality.json"), "utf8");
    const attemptLevel = readFileSync(join(exampleRoot, "attempts", "01", "quality.json"), "utf8");
    expect(attemptLevel).toBe(runLevel);
  });

  it("快照分数与 metadata 的 overall_score / review_score 对齐（修订后那一个）", () => {
    const meta = JSON.parse(readFileSync(join(exampleRoot, "metadata.json"), "utf8")) as {
      overall_score: number;
      review_score: number;
      quality_issue_count: number;
    };
    const quality = qualityResultOf(JSON.parse(readFileSync(join(exampleRoot, "quality.json"), "utf8")));
    expect(quality?.overall_score).toBe(meta.overall_score);
    expect(meta.overall_score).toBe(meta.review_score);
    expect(quality?.issues).toHaveLength(meta.quality_issue_count);
  });
});
