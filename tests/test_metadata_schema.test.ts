import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import { repoVersion } from "./helpers/fixtures";

/**
 * §23/§24/§25 Metadata Schema 收口：run / attempt / repair 三层 metadata 的必备字段、
 * project_version 单一来源，以及「绝不能包含 Secrets」。
 * 全部用 Fake 组件 + Fixture，绝不打真实付费 API（§66）。
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
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
});

/** 远超长度下限、含主角名、以句号结尾：可通过全部硬规则。 */
const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

const PASSED: ValidationResult = { passed: true, issues: [] };
const MISSING_ENDING: ValidationResult = {
  passed: false,
  issues: [{ code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" }],
};

function review(score: number): ReviewResult {
  return { score, summary: "总结。", strengths: ["强"], problems: ["中段线索重复"] };
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-metadata-"));
  process.chdir(tmp);
  return tmp;
}

/** 每次 validate / review 返回下一条结论，越界复用最后一条。 */
function scriptedValidator(results: ValidationResult[]) {
  let i = 0;
  return { validate: async () => results[Math.min(i++, results.length - 1)] };
}

function scriptedReviewer(results: ReviewResult[]) {
  let i = 0;
  return { review: async () => results[Math.min(i++, results.length - 1)] };
}

/** 假 Repairer：返回修订后的正文（保持可过验证的形态）。 */
function scriptedRepairer(story: string) {
  return {
    repair: async (request: { issue_type: string }) => ({
      repaired_story: story,
      issue_type: request.issue_type,
      success: true,
      notes: null,
    }),
  };
}

/** 组装 Pipeline：runsRoot 缺省 <cwd>/runs，与 appSettings().runsDir 一致。 */
function pipeline(
  val: ReturnType<typeof scriptedValidator>,
  rev: ReturnType<typeof scriptedReviewer>,
  rep?: ReturnType<typeof scriptedRepairer>,
  policy = DEFAULT_RETRY_POLICY,
  generate: () => Promise<string> = async () => STORY,
) {
  return new GenerationPipeline(
    { plan: async () => plan } as never,
    { generate } as never,
    val as never,
    rev as never,
    new ArtifactStore(),
    policy,
    rep as never,
  );
}

function readJson(dir: string, runId: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "runs", runId, rel), "utf8")) as Record<string, unknown>;
}

function hasArtifact(dir: string, runId: string, rel: string): boolean {
  return existsSync(join(dir, "runs", runId, rel));
}

/** runs/<run_id>/ 下唯一一个 run 目录名（失败场景拿不到返回值时用）。 */
function firstRunId(dir: string): string {
  return (readdirSync(join(dir, "runs")) as string[])[0];
}

/**
 * §23 绝不能包含 Secrets：密钥形态的值必须被打码。
 * 只查「值」的形态，不查字段名——"Authorization" 这种头部名本身不是秘密，
 * 脱敏后剩下的应该是 "Authorization: Bearer ***" 这种可读但无值的形态。
 */
function expectNoSecrets(meta: Record<string, unknown>): void {
  const text = JSON.stringify(meta).toLowerCase();
  expect(text).not.toMatch(/sk-[a-z0-9_-]{8,}/);
  expect(text).not.toMatch(/"(?:api[_-]?key|password|secret|token|authorization)"\s*:\s*"[^"]{4,}"/);
  expect(text).not.toMatch(/bearer\s+[a-z0-9._~+/-]{8,}/);
  expect(text).not.toContain("0123456789abcdef");
}

describe("§23 Run Metadata", () => {
  it("成功 Run 的 metadata 带齐必备字段，project_version 来自 VERSION 文件", async () => {
    const dir = withTmpDir();
    const result = await pipeline(scriptedValidator([PASSED]), scriptedReviewer([review(82)])).run(
      config,
      { model: "story-model" },
    );
    const meta = readJson(dir, result.run_id, "metadata.json");

    for (const key of [
      "run_id",
      "project_version",
      "status",
      "quality_status",
      "started_at",
      "finished_at",
      "model",
      "attempt_count",
      "selected_attempt",
      "review_status",
      "validation_status",
      "repair_count",
      "artifacts",
    ]) {
      expect(meta, `metadata.json 缺少字段 ${key}`).toHaveProperty(key);
    }
    expect(meta.run_id).toBe(result.run_id);
    // §42：版本号唯一真源是 VERSION 文件
    expect(meta.project_version).toBe(repoVersion());
    expect(meta.status).toBe("completed");
    expect(meta.quality_status).toBe("accepted");
    expect(meta.model).toBe("story-model");
    expect(meta.attempt_count).toBe(1);
    expect(meta.selected_attempt).toBe(1);
    expect(meta.review_status).toBe("completed");
    expect(meta.validation_status).toBe("completed");
    expect(meta.repair_count).toBe(0);
    // artifacts 是「名字 → 文件名」的清单，成功 Run 七项齐全
    expect(meta.artifacts).toEqual({
      config: "config.json",
      beat_plan: "beats.json",
      story: "story.md",
      validation: "validation.json",
      review: "review.json",
      metadata: "metadata.json",
      quality: "quality.json",
    });
    expect(typeof meta.started_at).toBe("string");
    expect(typeof meta.finished_at).toBe("string");
    expectNoSecrets(meta);
  });

  it("失败 Run 的 metadata 仍带 run_id / status / current_stage / error，不带堆栈与密钥", async () => {
    const dir = withTmpDir();
    const fakeKey = "sk-" + "0123456789abcdef";
    const failing = async (): Promise<string> => {
      throw new Error(`LLM API 返回 401：Authorization: Bearer ${fakeKey}`);
    };
    await expect(
      pipeline(
        scriptedValidator([PASSED]),
        scriptedReviewer([review(82)]),
        undefined,
        DEFAULT_RETRY_POLICY,
        failing,
      ).run(config),
    ).rejects.toThrow();

    const runId = firstRunId(dir);
    const meta = readJson(dir, runId, "metadata.json");
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("generating");
    expect(String(meta.error)).toContain("401");
    expect(meta.project_version).toBe(repoVersion());
    // §27/§67：堆栈与凭据都不进产物
    expect(JSON.stringify(meta)).not.toMatch(/at\s+[\w$.<>/\\-]+:\d+:\d+/);
    expect(String(meta.error)).not.toContain("\n");
    expectNoSecrets(meta);
  });

  it("发生过修订时 repair_count 是各 Attempt 之和，并带上策略参数", async () => {
    const dir = withTmpDir();
    const result = await pipeline(
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(61), review(82)]),
      scriptedRepairer(STORY),
    ).run(config, { model: "story-model" });

    const meta = readJson(dir, result.run_id, "metadata.json");
    expect(meta.repair_count).toBe(1);
    expect(meta.quality_status).toBe("accepted");
    expect(meta.selected_attempt).toBe(1);
    expect(meta.enable_repair).toBe(DEFAULT_RETRY_POLICY.enable_repair);
    expect(meta.max_repairs_per_attempt).toBe(DEFAULT_RETRY_POLICY.max_repairs_per_attempt);
    expect(meta.max_attempts).toBe(DEFAULT_RETRY_POLICY.max_attempts);
    expectNoSecrets(meta);
  });

  it("用尽 Attempt 仍未满足时 quality_status=exhausted，且不再谎报 accepted", async () => {
    const dir = withTmpDir();
    const result = await pipeline(
      scriptedValidator([MISSING_ENDING, MISSING_ENDING]),
      scriptedReviewer([review(61), review(61)]),
      undefined,
      { ...DEFAULT_RETRY_POLICY, enable_repair: false },
    ).run(config);

    expect(result.quality_status).toBe("exhausted");
    const meta = readJson(dir, result.run_id, "metadata.json");
    expect(meta.quality_status).toBe("exhausted");
    expect(meta.attempt_count).toBe(2);
    expect(meta.selected_attempt).toBe(2);
    expect(meta.repair_count).toBe(0);
    expectNoSecrets(meta);
  });
});

describe("§24 Attempt Metadata", () => {
  it("通过的 attempt metadata 带齐必备字段", async () => {
    const dir = withTmpDir();
    const result = await pipeline(scriptedValidator([PASSED]), scriptedReviewer([review(82)])).run(
      config,
      { model: "story-model" },
    );
    const meta = readJson(dir, result.run_id, "attempts/01/metadata.json");

    for (const key of [
      "attempt_number",
      "accepted",
      "retry_reason",
      "validation_passed",
      "review_score",
      "repair_count",
    ]) {
      expect(meta, `attempt metadata 缺少字段 ${key}`).toHaveProperty(key);
    }
    expect(meta.attempt_number).toBe(1);
    expect(meta.accepted).toBe(true);
    expect(meta.retry_reason).toBeNull();
    expect(meta.validation_passed).toBe(true);
    expect(meta.review_score).toBe(82);
    expect(meta.repair_count).toBe(0);
    expectNoSecrets(meta);
  });

  it("未通过的 attempt：accepted=false 且带 retry_reason", async () => {
    const dir = withTmpDir();
    const result = await pipeline(
      scriptedValidator([MISSING_ENDING, MISSING_ENDING]),
      scriptedReviewer([review(61), review(61)]),
      undefined,
      { ...DEFAULT_RETRY_POLICY, enable_repair: false },
    ).run(config);

    expect(result.quality_status).toBe("exhausted");
    const meta = readJson(dir, result.run_id, "attempts/01/metadata.json");
    expect(meta.attempt_number).toBe(1);
    expect(meta.accepted).toBe(false);
    expect(meta.retry_reason).toBe("validation_failed");
    expect(meta.validation_passed).toBe(false);
    expect(meta.review_score).toBe(61);
    expect(meta.repair_count).toBe(0);
    expectNoSecrets(meta);
  });

  it("生成失败的 attempt metadata 落盘，且 error 不带密钥", async () => {
    const dir = withTmpDir();
    const fakeKey = "sk-" + "0123456789abcdef";
    const failing = async (): Promise<string> => {
      throw new Error(`LLM API 返回 401：Bearer ${fakeKey}`);
    };
    const result = await pipeline(
      scriptedValidator([PASSED]),
      scriptedReviewer([review(82)]),
      undefined,
      DEFAULT_RETRY_POLICY,
      failing,
    ).run(config).catch((e: Error) => e);

    // 生成彻底失败时 Run 抛错，但第一个 attempt 的 metadata 已经落盘
    const runId = firstRunId(dir);
    const meta = readJson(dir, runId, "attempts/01/metadata.json");
    expect(meta.attempt_number).toBe(1);
    expect(meta.accepted).toBe(false);
    expect(String(meta.error)).toContain("401");
    expectNoSecrets(meta);
    void result;
  });
});

describe("§25 Repair Metadata", () => {
  it("repair metadata 带齐前后对比字段，且不做历史 Repair Analytics", async () => {
    const dir = withTmpDir();
    const result = await pipeline(
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(61), review(82)]),
      scriptedRepairer(STORY),
    ).run(config);

    const meta = readJson(dir, result.run_id, "attempts/01/repairs/01/metadata.json");
    for (const key of [
      "repair_number",
      "issue_type",
      "success",
      "before_validation_passed",
      "after_validation_passed",
      "before_review_score",
      "after_review_score",
    ]) {
      expect(meta, `repair metadata 缺少字段 ${key}`).toHaveProperty(key);
    }
    expect(meta.repair_number).toBe(1);
    expect(meta.issue_type).toBe("ending");
    expect(meta.success).toBe(true);
    expect(meta.before_validation_passed).toBe(false);
    expect(meta.after_validation_passed).toBe(true);
    expect(meta.before_review_score).toBe(61);
    expect(meta.after_review_score).toBe(82);
    // §32：只记录前后对比，不记因果 / 策略 / 评分模型
    for (const forbidden of ["root_cause", "causal_diagnosis", "strategy_score", "policy_id", "confidence"]) {
      expect(meta).not.toHaveProperty(forbidden);
    }
    expectNoSecrets(meta);
  });
});

describe("§23 metadata 与磁盘产物一致", () => {
  it("metadata.artifacts 与 runs/<run_id>/ 下真实存在的文件对得上", async () => {
    const dir = withTmpDir();
    const result = await pipeline(scriptedValidator([PASSED]), scriptedReviewer([review(82)])).run(
      config,
    );
    for (const name of [
      "config.json",
      "beats.json",
      "story.md",
      "validation.json",
      "review.json",
      "metadata.json",
      // v1.2.0 §20：统一质量快照同样落在 Run 根目录，artifacts 索引里有它
      "quality.json",
    ]) {
      expect(hasArtifact(dir, result.run_id, name), `缺少产物 ${name}`).toBe(true);
    }
    expect(hasArtifact(dir, result.run_id, "attempts/01/story.md")).toBe(true);
    expect(hasArtifact(dir, result.run_id, "attempts/01/metadata.json")).toBe(true);
    // v1.2.0 §21：Attempt 级也各有一份快照
    expect(hasArtifact(dir, result.run_id, "attempts/01/quality.json")).toBe(true);
  });
});
