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

/** 修订目录里的一轮：给结论就写，不给就只留 request（模拟这次修订根本没跑通）。 */
interface RepairRound {
  validation?: unknown;
  review?: unknown;
  afterReviewScore?: number | null;
  success: boolean;
}

/**
 * v1.1.1 形状、发生过修订的 Run：attempt 目录下是**首次**结论（审阅 41），
 * 修订目录里才是修订后的结论。没有 quality.json，metadata 的 review_score 记的是修订后的 82——
 * 正是 run-artifacts.md 里那条「刻意的不对称」。
 */
function writeOldRunWithRepairs(runId: string, rounds: RepairRound[]): string {
  const dir = withTmpDir();
  const runDir = join(dir, "runs", runId);
  const attemptDir = join(runDir, "attempts", "01");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(runDir, "config.json"), JSON.stringify({ title: "消失的目击者" }));
  writeFileSync(join(runDir, "story.md"), "# 消失的目击者\n\n修订后的正文。\n");
  writeFileSync(join(runDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
  writeFileSync(join(runDir, "review.json"), OLD_REVIEW_JSON + "\n");
  writeFileSync(
    join(runDir, "metadata.json"),
    JSON.stringify({
      run_id: runId,
      project_version: "1.1.1",
      status: "completed",
      quality_status: "accepted",
      attempt_count: 1,
      selected_attempt: 1,
      validation_status: "completed",
      review_status: "completed",
      review_score: 82,
      validation_passed: true,
      repair_count: rounds.length,
    }),
  );
  writeFileSync(join(attemptDir, "story.md"), "# 消失的目击者\n\n修订后的正文。\n");
  writeFileSync(join(attemptDir, "initial_story.md"), "# 消失的目击者\n\n修订前的正文。\n");
  writeFileSync(join(attemptDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }));
  writeFileSync(join(attemptDir, "review.json"), OLD_REVIEW_JSON + "\n");
  writeFileSync(
    join(attemptDir, "metadata.json"),
    JSON.stringify({
      attempt_number: 1,
      accepted: true,
      retry_reason: null,
      review_score: 82,
      validation_passed: true,
      repair_count: rounds.length,
      repairs: rounds.map((r, i) => ({
        repair_number: i + 1,
        issue_type: "general",
        issue_message: "高潮缺失",
        success: r.success,
        before_review_score: 41,
        after_review_score: r.afterReviewScore ?? null,
      })),
      error: null,
    }),
  );
  rounds.forEach((round, i) => {
    const repairDir = join(attemptDir, "repairs", String(i + 1).padStart(2, "0"));
    mkdirSync(repairDir, { recursive: true });
    writeFileSync(
      join(repairDir, "request.json"),
      JSON.stringify({ repair_number: i + 1, issue_type: "general", issue_message: "高潮缺失" }),
    );
    if (round.review !== undefined) writeFileSync(join(repairDir, "review.json"), JSON.stringify(round.review));
    if (round.validation !== undefined) {
      writeFileSync(join(repairDir, "validation.json"), JSON.stringify(round.validation));
    }
  });
  return dir;
}

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

/**
 * v1.2.1 回归：旧 Run（没有 quality.json）的兜底装配必须与 v1.2.0 落盘的 quality.json
 * 同一口径——取这次尝试**最终留下的那一版**结论，也就是修订后那一轮。
 * v1.2.0 直接读了 attempt 目录下的首次结论，于是装配出的分数描述的是修订前那版正文，
 * 与同一次尝试的 metadata.review_score / repairs[].after_review_score 对不上。
 */
describe("§27 旧 Run 兜底装配取修订后的结论", () => {
  const POST_REPAIR_REVIEW = {
    score: 82,
    summary: "节奏紧凑。",
    strengths: ["开场干净"],
    problems: [],
    suggestions: ["压缩重复线索。"],
  };

  it("修订后那一轮的结论被用来装配：分数与 metadata.review_score / repairs[].after_review_score 一致", async () => {
    const runId = "20260101_120000_oldfix";
    const dir = writeOldRunWithRepairs(runId, [
      { review: POST_REPAIR_REVIEW, validation: { passed: true, issues: [] }, afterReviewScore: 82, success: true },
    ]);
    const store = new ArtifactStore(join(dir, "runs"));

    const run = await getRun(runId, store);
    if (run.status !== 200) throw new Error("Run 详情应 200");
    expect(run.json.quality?.overall_score).toBe(82);
    expect(run.json.quality?.validation_passed).toBe(true);
    expect(run.json.quality?.accepted).toBe(true);
    expect(run.json.quality?.summary).toBe("节奏紧凑。");
    expect(run.json.quality?.suggestions).toEqual([
      { id: "review-suggestion-1", source: "review", message: "压缩重复线索。" },
    ]);
    // 修订后的审阅没有问题、校验也没有命中项
    expect(run.json.quality?.issues).toEqual([]);
    // §52：旁边这些原有字段一个没动——review 仍是首次那份
    expect(run.json.review?.score).toBe(41);

    const attempt = await getRunAttempt(runId, 1, store);
    if (attempt.status !== 200) throw new Error("Attempt 详情应 200");
    expect(attempt.json.quality?.overall_score).toBe(82);
    expect(attempt.json.repairs[0]?.after_review_score).toBe(82);
    expect(attempt.json.quality?.accepted).toBe(true);
  });

  it("多轮修订：取最后一次真正跑过校验 / 审阅的那一轮", async () => {
    const runId = "20260101_120000_oldfix2";
    const dir = writeOldRunWithRepairs(runId, [
      { review: { ...POST_REPAIR_REVIEW, score: 60 }, validation: { passed: true, issues: [] }, afterReviewScore: 60, success: false },
      { review: POST_REPAIR_REVIEW, validation: { passed: true, issues: [] }, afterReviewScore: 82, success: true },
      { afterReviewScore: null, success: false },
    ]);
    const store = new ArtifactStore(join(dir, "runs"));

    const attempt = await getRunAttempt(runId, 1, store);
    if (attempt.status !== 200) throw new Error("Attempt 详情应 200");
    expect(attempt.json.quality?.overall_score).toBe(82);
  });

  it("修订彻底失败（修订目录里没有结论文件）：回落到首次结论", async () => {
    const runId = "20260101_120000_oldfix3";
    const dir = writeOldRunWithRepairs(runId, [{ afterReviewScore: null, success: false }]);
    const store = new ArtifactStore(join(dir, "runs"));

    const attempt = await getRunAttempt(runId, 1, store);
    if (attempt.status !== 200) throw new Error("Attempt 详情应 200");
    expect(attempt.json.quality?.overall_score).toBe(41);
    expect(attempt.json.quality?.summary).toBe("高潮冲突没有展开。");
    expect(attempt.json.repairs[0]?.success).toBe(false);
  });

  it("运行根的 quality.json 丢了但 attempt 那份还在：Run 详情与 Attempt 详情一致", async () => {
    const runId = "20260101_120000_oldfix4";
    const dir = writeOldRunWithRepairs(runId, [
      { review: POST_REPAIR_REVIEW, validation: { passed: true, issues: [] }, afterReviewScore: 82, success: true },
    ]);
    // 只补 attempt 级那份（模拟 promote 之后根目录文件被删）
    const attemptQuality = {
      overall_score: 82,
      validation_passed: true,
      accepted: true,
      issues: [],
      suggestions: [{ id: "review-suggestion-1", source: "review", message: "压缩重复线索。" }],
      summary: "节奏紧凑。",
    };
    writeFileSync(join(dir, "runs", runId, "attempts", "01", "quality.json"), JSON.stringify(attemptQuality));
    const store = new ArtifactStore(join(dir, "runs"));

    const run = await getRun(runId, store);
    const attempt = await getRunAttempt(runId, 1, store);
    if (run.status !== 200 || attempt.status !== 200) throw new Error("两个详情都应 200");
    expect(run.json.quality).toEqual(attempt.json.quality);
    expect(run.json.quality?.overall_score).toBe(82);
    // 仍然不会往根目录补写
    expect(readdirSync(join(dir, "runs", runId))).not.toContain("quality.json");
  });

  it("v1.2.0 落的 quality.json 与这套兜底装配结果逐字节同构", async () => {
    const runId = "20260101_120000_oldfix5";
    const dir = writeOldRunWithRepairs(runId, [
      { review: POST_REPAIR_REVIEW, validation: { passed: true, issues: [] }, afterReviewScore: 82, success: true },
    ]);
    const store = new ArtifactStore(join(dir, "runs"));

    const attempt = await getRunAttempt(runId, 1, store);
    if (attempt.status !== 200) throw new Error("Attempt 详情应 200");
    const assembled = new QualityAssembler().assemble({
      validation: JSON.parse(
        readFileSync(join(dir, "runs", runId, "attempts", "01", "repairs", "01", "validation.json"), "utf8"),
      ),
      review: validateReviewResult(
        JSON.parse(readFileSync(join(dir, "runs", runId, "attempts", "01", "repairs", "01", "review.json"), "utf8")),
      ),
      accepted: true,
    });
    expect(attempt.json.quality).toEqual(assembled);
  });
});

/**
 * v1.2.1：quality.json 被手改坏 / 被删 / 形状不认识时，读接口必须退回到同一套兜底装配，
 * 响应 200、其余字段照常，磁盘上也不补写。与上面同一口径：取修订后的那一版结论。
 */
describe("§28 quality.json 损坏或缺失时退回归底装配", () => {
  function repairedRunAt(runId: string): { dir: string; store: ArtifactStore } {
    const dir = writeOldRunWithRepairs(runId, [
      {
        review: { score: 82, summary: "节奏紧凑。", strengths: [], problems: [], suggestions: [] },
        validation: { passed: true, issues: [] },
        afterReviewScore: 82,
        success: true,
      },
    ]);
    return { dir, store: new ArtifactStore(join(dir, "runs")) };
  }

  it("JSON 语法坏了：整体作废，回落到装配结果", async () => {
    const { dir, store } = repairedRunAt("20260101_120000_oldbad1");
    writeFileSync(join(dir, "runs", "20260101_120000_oldbad1", "quality.json"), "{ 这不是 JSON");
    writeFileSync(join(dir, "runs", "20260101_120000_oldbad1", "attempts", "01", "quality.json"), "{ 也不是");

    const run = await getRun("20260101_120000_oldbad1", store);
    if (run.status !== 200) throw new Error("Run 详情应 200");
    expect(run.json.quality?.overall_score).toBe(82);
    expect(run.json.review?.score).toBe(41);
    // 其余字段照常，整个响应不 500
    expect(run.json.status).toBe("completed");
    expect(run.json.attempts).toHaveLength(1);
  });

  it("分数越界 / 顶层是数组：形状不认识，同样回落到装配结果", async () => {
    const runId = "20260101_120000_oldbad2";
    const { dir, store } = repairedRunAt(runId);
    writeFileSync(
      join(dir, "runs", runId, "quality.json"),
      JSON.stringify({ overall_score: 999, validation_passed: true, accepted: true, issues: [], suggestions: [], summary: "x" }),
    );
    const attempt = await getRunAttempt(runId, 1, store);
    if (attempt.status !== 200) throw new Error("Attempt 详情应 200");
    expect(attempt.json.quality?.overall_score).toBe(82);
    expect(attempt.json.quality?.summary).toBe("节奏紧凑。");
  });

  it("读接口不把服务器路径带进响应，也不会往磁盘补写任何文件", async () => {
    const runId = "20260101_120000_oldbad3";
    const { dir, store } = repairedRunAt(runId);
    const before = readdirSync(join(dir, "runs", runId)).sort();

    const run = await getRun(runId, store);
    if (run.status !== 200) throw new Error("Run 详情应 200");
    expect(JSON.stringify(run.json).includes(dir)).toBe(false);
    expect(readdirSync(join(dir, "runs", runId)).sort()).toEqual(before);
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
