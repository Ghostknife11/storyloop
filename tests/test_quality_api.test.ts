import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRunDetail } from "@/app/api/runs/[run_id]/route";
import { GET as getRunAttemptDetail } from "@/app/api/runs/[run_id]/attempts/[attempt_number]/route";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { QualityResult } from "@/types/quality";
import { SAMPLE_BEAT_VALIDATION, SAMPLE_COMMERCIAL_REVIEW, commercialReviewerOf } from "./helpers/fixtures";

/**
 * v1.2.0 §51/§52 质量 API 契约：quality 是纯新增字段。
 *
 * 断言三件事：原有字段一个不少、quality 的值来自旧结论、旧 Run 与坏文件都不 500。
 * 全部用假组件注入服务层，绝不调用真实付费 API（§66）。
 */

const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;
const PASSED: ValidationResult = { passed: true, issues: [] };
const FAILED: ValidationResult = {
  passed: false,
  issues: [{ code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" }],
};

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚，但中段推进略重复。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
  suggestions: ["压缩重复线索，让中段事件承担新的推进功能。"],
};

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
  tmp = mkdtempSync(join(tmpdir(), "storyloop-quality-api-"));
  process.chdir(tmp);
  return tmp;
}

/** 依次返回的假组件：与 test_retry_api 同一套编排方式。 */
function scripted<T>(items: T[]) {
  let i = 0;
  return { call: async (): Promise<T> => items[Math.min(i++, items.length - 1)] };
}

const plan = {
  beat_plan_version: "1",
  beats: [{ id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] }],
};

const config = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

async function start(overrides: {
  validations?: ValidationResult[];
  reviews?: ReviewResult[];
  stories?: string[];
} = {}) {
  const { startRun } = await import("@/lib/generate-service");
  const validator = scripted(overrides.validations ?? [PASSED]);
  const reviewer = scripted(overrides.reviews ?? [review]);
  const generator = scripted(overrides.stories ?? [STORY]);
  return startRun({ config, retry_policy: { max_attempts: 2, min_review_score: 70 } }, {
    planner: { plan: async () => plan } as never,
    generator: { generate: generator.call } as never,
    validator: { validate: validator.call } as never,
    reviewer: { review: reviewer.call } as never,
    repairer: {
      repair: async () => ({ repaired_story: "", issue_type: "general", success: false, notes: "测试用假 Repairer" }),
    } as never,
    // v1.4.0：这条用例只关心质量层，骨架结构校验给一份固定合格结论
    beatValidator: { validate: async () => SAMPLE_BEAT_VALIDATION } as never,
    // v1.5.0：商业可读性审阅同样给假件，否则 buildPipeline 会造一个真客户端（§47）
    commercialReviewer: commercialReviewerOf(),
  } as never);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function get(url: string) {
  return new NextRequest(`http://localhost${url}`);
}

describe("§51 POST /api/runs： quality 是 additive 字段", () => {
  it("原有字段一个不少，quality 与原 review / validation 对齐", async () => {
    withTmpDir();
    const res = await start();
    expect(res.status).toBe(200);
    const body = res.json as unknown as Record<string, unknown>;

    // §52：原有字段语义不变（validation_error / review_error 只在对应阶段失败时出现）
    expect(Object.keys(body).sort()).toEqual([
      "artifacts", "attempt_count", "attempts", "beat_plan",
      "beat_validation", "beat_validation_status",
      // v1.5.0：商业可读性结论同样是纯追加字段
      "commercial_review", "commercial_review_status",
      "quality", "quality_status",
      "repair_count", "review", "review_status", "run_id", "selected_attempt", "status",
      "story", "validation", "validation_status",
    ]);
    expect(body.story).toBe(STORY);
    expect(body.review).toEqual(review);
    expect(body.validation).toEqual(PASSED);
    expect(body.artifacts).toMatchObject({ story: "story.md", quality: "quality.json" });
    // v1.5.0 §26/§28：商业结论独立存在，QualityResult 仍只有 Co/N/C/Ca 四个维度
    expect(body.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(body.commercial_review_status).toBe("completed");
    expect(body.artifacts).toMatchObject({ commercial_review: "commercial-review.json" });

    // §25：quality 与旧结论一致——分数就是 review.score，不自己打分
    const quality = body.quality as QualityResult;
    expect(quality.overall_score).toBe(74);
    expect(quality.validation_passed).toBe(true);
    expect(quality.accepted).toBe(true);
    expect(quality.summary).toBe(review.summary);
    expect(quality.issues).toEqual([
      { id: "review-1", source: "review", category: "review_problem", message: "中段线索重复" },
    ]);
    expect(quality.suggestions).toEqual([
      { id: "review-suggestion-1", source: "review", message: "压缩重复线索，让中段事件承担新的推进功能。" },
    ]);
  });

  it("§51 validation 映射：校验失败时 issues 带上校验项", async () => {
    withTmpDir();
    const res = await start({ validations: [FAILED] });
    const quality = (res.json as unknown as Record<string, unknown>).quality as QualityResult;
    expect(quality.validation_passed).toBe(false);
    expect(quality.issues).toEqual([
      { id: "validation-1", source: "validation", category: "MISSING_ENDING", message: "故事缺少明确结局。", severity: "error" },
      { id: "review-1", source: "review", category: "review_problem", message: "中段线索重复" },
    ]);
  });

  it("§47 Case C：Reviewer 失败时 overall_score = null，Run 仍然成功", async () => {
    withTmpDir();
    // Reviewer 直接抛异常：Pipeline 走 review_status=failed 分支
    const { startRun } = await import("@/lib/generate-service");
    const res = await startRun({ config, retry_policy: { max_attempts: 1, min_review_score: 70 } }, {
      planner: { plan: async () => plan } as never,
      generator: { generate: async () => STORY } as never,
      validator: { validate: async () => PASSED } as never,
      reviewer: { review: async () => { throw new Error("Reviewer boom"); } } as never,
      repairer: {
        repair: async () => ({ repaired_story: "", issue_type: "general", success: false, notes: "x" }),
      } as never,
    } as never);
    const body = res.json as unknown as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(body.review).toBeNull();
    expect(body.review_status).toBe("failed");
    const quality = body.quality as QualityResult;
    expect(quality.overall_score).toBeNull();
    expect(quality.summary).toBeNull();
    expect(quality.suggestions).toEqual([]);
    expect(quality.validation_passed).toBe(true);
  });
});

describe("§25/§26 读回：quality.json 与内存装配一致", () => {
  it("Run 详情与 Attempt 详情读到的 quality 与 POST 响应相同", async () => {
    const dir = withTmpDir();
    const res = await start();
    const body = res.json as unknown as Record<string, unknown>;
    const posted = body.quality as QualityResult;
    const runId = String(body.run_id);
    expect(runId).not.toBe("");

    const detail = await readJson(await getRunDetail(
      get(`api/runs/${runId}`),
      { params: Promise.resolve({ run_id: runId }) } as never,
    ));
    expect(detail.quality).toEqual(posted);

    const attempt = await readJson(await getRunAttemptDetail(
      get(`api/runs/${runId}/attempts/1`),
      { params: Promise.resolve({ run_id: runId, attempt_number: "1" }) } as never,
    ));
    expect(attempt.quality).toEqual(posted);

    // 磁盘上落的就是这份快照，UTF-8 JSON
    const onDisk = JSON.parse(readFileSync(join(dir, "runs", runId, "quality.json"), "utf8")) as QualityResult;
    expect(onDisk).toEqual(posted);
  });

  it("quality.json 被手改坏 → 退回内存装配，仍然 200", async () => {
    const dir = withTmpDir();
    const res = await start();
    const runId = String((res.json as unknown as Record<string, unknown>).run_id);

    writeFileSync(
      join(dir, "runs", runId, "quality.json"),
      JSON.stringify({ overall_score: "不是数字", issues: "坏数据" }),
    );
    const detail = await readJson(await getRunDetail(
      get(`api/runs/${runId}`),
      { params: Promise.resolve({ run_id: runId }) } as never,
    ));
    const quality = detail.quality as QualityResult;
    expect(quality.overall_score).toBe(74);
    expect(quality.validation_passed).toBe(true);
    expect(quality.accepted).toBe(true);
    expect(quality.issues).toEqual([
      { id: "review-1", source: "review", category: "review_problem", message: "中段线索重复" },
    ]);
  });

  it("attempt 级 quality.json 被删 → 该 attempt 临时装配，其余 attempt 不受影响", async () => {
    const dir = withTmpDir();
    const res = await start({
      reviews: [{ ...review, score: 50 }, { ...review, score: 88 }],
    });
    const runId = String((res.json as unknown as Record<string, unknown>).run_id);
    rmSync(join(dir, "runs", runId, "attempts", "01", "quality.json"));

    const first = await readJson(await getRunAttemptDetail(
      get(`api/runs/${runId}/attempts/1`),
      { params: Promise.resolve({ run_id: runId, attempt_number: "1" }) } as never,
    ));
    expect((first.quality as QualityResult).overall_score).toBe(50);
    expect((first.quality as QualityResult).accepted).toBe(false);

    const second = await readJson(await getRunAttemptDetail(
      get(`api/runs/${runId}/attempts/2`),
      { params: Promise.resolve({ run_id: runId, attempt_number: "2" }) } as never,
    ));
    expect((second.quality as QualityResult).overall_score).toBe(88);
    expect((second.quality as QualityResult).accepted).toBe(true);
  });
});

describe("§44 URL Gate 没有被质量工程绕过", () => {
  it("请求体 baseUrl 指向 localhost / 私网仍然 400，一个字节都没发出去", async () => {
    withTmpDir();
    const { startRun } = await import("@/lib/generate-service");
    for (const baseUrl of ["http://127.0.0.1:8080/v1", "http://localhost:11434/v1", "http://192.168.1.10/v1"]) {
      const res = await startRun({ config, baseUrl }, {
        planner: { plan: async () => plan } as never,
        generator: { generate: async () => STORY } as never,
        validator: { validate: async () => PASSED } as never,
        reviewer: { review: async () => review } as never,
        repairer: {
          repair: async () => ({ repaired_story: "", issue_type: "general", success: false, notes: "x" }),
        } as never,
      } as never);
      expect(res.status).toBe(400);
    }
  });
});
