import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
import type { RepairRequest, RepairResult } from "@/types/repair";

/**
 * §45~§48/§51 Pipeline Repair-before-Retry：Retry 与 Repair 分开（§2）。
 * Repair 不改写正文以外的一切，也不新增 GenerationAttempt（§17）。
 * 全部用 Fake 组件 + Fixture，绝不打真实付费 API。
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
const REPAIRED = `修订后：陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;
const RETRIED = `重生：陈岚拐进巷口，${"霓虹在水洼里碎成两半。".repeat(80)}`;

const PASSED: ValidationResult = { passed: true, issues: [] };
const MISSING_ENDING: ValidationResult = {
  passed: false,
  issues: [{ code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" }],
};
const EMPTY: ValidationResult = {
  passed: false,
  issues: [{ code: "EMPTY_CONTENT", severity: "error", message: "正文为空，没有可校验的内容。" }],
};

function review(score: number, problems: string[] = ["中段线索重复"]): ReviewResult {
  return { score, summary: "总结。", strengths: ["强"], problems };
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
  tmp = mkdtempSync(join(tmpdir(), "storyloop-repair-pipeline-"));
  process.chdir(tmp);
  return tmp;
}

/** 每次 generate 返回下一段正文，越界复用最后一段。 */
function scriptedGenerator(stories: string[]) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    generate: async () => {
      const story = stories[Math.min(i++, stories.length - 1)];
      calls.push(story);
      return story;
    },
  };
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

/** 假 Repairer：记录收到的 RepairRequest，返回编排好的正文（null = 修不好）。 */
function scriptedRepairer(replies: Array<string | null>) {
  const requests: RepairRequest[] = [];
  let i = 0;
  return {
    requests,
    repair: async (request: RepairRequest): Promise<RepairResult> => {
      requests.push(request);
      const reply = replies[Math.min(i++, replies.length - 1)];
      if (reply === null) {
        return {
          repaired_story: "",
          issue_type: request.issue_type,
          success: false,
          notes: "修订失败：LLM 502",
        };
      }
      return { repaired_story: reply, issue_type: request.issue_type, success: true, notes: null };
    },
  };
}

/** 组装一条带 Repairer 的 Pipeline。 */
function pipeline(
  gen: ReturnType<typeof scriptedGenerator>,
  val: ReturnType<typeof scriptedValidator>,
  rev: ReturnType<typeof scriptedReviewer>,
  rep: ReturnType<typeof scriptedRepairer>,
  policy = DEFAULT_RETRY_POLICY,
) {
  return new GenerationPipeline(
    { plan: async () => plan } as never,
    gen as never,
    val as never,
    rev as never,
    new ArtifactStore(),
    policy,
    rep as never,
  );
}

// --- 产物读取：所有路径都从一个 tmp run 根出发，rel 只是目录内的相对位置。 ---

function artifactOf(dir: string, runId: string, rel: string): string {
  return join(dir, "runs", runId, rel);
}

function readArtifact(dir: string, runId: string, rel: string): string {
  return readFileSync(artifactOf(dir, runId, rel), "utf8");
}

function readArtifactJson(dir: string, runId: string, rel: string): unknown {
  return JSON.parse(readArtifact(dir, runId, rel));
}

function hasArtifact(dir: string, runId: string, rel: string): boolean {
  return existsSync(artifactOf(dir, runId, rel));
}

function listArtifacts(dir: string, runId: string, rel: string): string[] {
  return readdirSync(artifactOf(dir, runId, rel)).sort();
}

describe("§45 Pipeline Test — Repair Success", () => {
  it("修订后通过：Attempt 1 accepted，不生成 Attempt 2", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const val = scriptedValidator([MISSING_ENDING, PASSED]);
    const rev = scriptedReviewer([review(63), review(74)]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(gen, val, rev, rep).run(config);

    expect(result.attempt_count).toBe(1);
    expect(result.selected_attempt).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.attempts[0].accepted).toBe(true);
    expect(result.attempts[0].retry_reason).toBeNull();
    // §17：修订不新增 Attempt；§2：修订与整篇重生是两件事
    expect(gen.calls).toEqual([STORY]);
    // §15/§16：修订后重新校验 + 重新审阅
    expect(result.attempts[0].validation).toEqual(PASSED);
    expect(result.attempts[0].review?.score).toBe(74);
    expect(result.story).toBe(REPAIRED);
    // §32：修订记录留下前后对比（63 → 74，未通过 → 通过）
    expect(result.attempts[0].repairs).toEqual([
      {
        repair_number: 1,
        issue_type: "ending",
        issue_message: "故事缺少明确结局。",
        before_validation: MISSING_ENDING,
        after_validation: PASSED,
        before_review_score: 63,
        after_review_score: 74,
        success: true,
      },
    ]);
    // 修订请求带上完整上下文（§3）
    expect(rep.requests[0].story).toBe(STORY);
    expect(rep.requests[0].issue_type).toBe("ending");
    expect(rep.requests[0].config).toBe(config);
    expect(rep.requests[0].beat_plan).toBe(plan);

    // §30：attempt 根目录 story.md 是最终版，initial_story.md 是修订前的版本
    expect(readArtifact(dir, result.run_id, "attempts/01/story.md")).toBe(
      `# ${config.title}\n\n${REPAIRED}\n`,
    );
    expect(readArtifact(dir, result.run_id, "attempts/01/initial_story.md")).toBe(
      `# ${config.title}\n\n${STORY}\n`,
    );
    // 修订后的校验 / 审阅结论写进 repairs/01，attempt 根目录的是修订前的
    expect(readArtifactJson(dir, result.run_id, "attempts/01/validation.json")).toEqual(
      MISSING_ENDING,
    );
    expect(readArtifactJson(dir, result.run_id, "attempts/01/review.json")).toEqual(review(63));
    expect(readArtifactJson(dir, result.run_id, "attempts/01/repairs/01/validation.json")).toEqual(
      PASSED,
    );
    expect(readArtifactJson(dir, result.run_id, "attempts/01/repairs/01/review.json")).toEqual(
      review(74),
    );
    expect(readArtifactJson(dir, result.run_id, "attempts/01/repairs/01/request.json")).toEqual({
      repair_number: 1,
      issue_type: "ending",
      issue_message: "故事缺少明确结局。",
    });
    expect(readArtifact(dir, result.run_id, "attempts/01/repairs/01/story.md")).toBe(
      `# ${config.title}\n\n${REPAIRED}\n`,
    );
    expect(readArtifactJson(dir, result.run_id, "attempts/01/repairs/01/metadata.json")).toEqual({
      repair_number: 1,
      issue_type: "ending",
      success: true,
      before_review_score: 63,
      after_review_score: 74,
      before_validation_passed: false,
      after_validation_passed: true,
    });
  });

  it("§51-A 结局问题修订：达到阈值后不再整篇重生", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(58), review(81)]),
      rep,
    ).run(config);

    expect(result.quality_status).toBe("accepted");
    expect(gen.calls).toEqual([STORY]);
    expect(rep.requests).toHaveLength(1);
    expect(rep.requests[0].issue_type).toBe("ending");
    expect(dir).toBeTruthy();
  });

  it("§51-B 篇幅不足修订：TOO_SHORT → length", async () => {
    withTmpDir();
    const tooShort: ValidationResult = {
      passed: false,
      issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度 12 明显短于目标字数。" }],
    };
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([tooShort, PASSED]),
      scriptedReviewer([review(60), review(72)]),
      rep,
    ).run(config);

    expect(rep.requests[0].issue_type).toBe("length");
    expect(rep.requests[0].issue_message).toContain("正文长度");
    expect(result.quality_status).toBe("accepted");
    expect(gen.calls).toEqual([STORY]);
  });

  it("§66 修订不改写 StoryConfig 与 BeatPlan：config.json / beats.json 与输入逐字一致", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(74)]),
      rep,
    ).run(config);

    // 修订请求带的是同一份对象（§65），落盘的产物也没有被修订过程写回任何字段
    expect(rep.requests[0].config).toBe(config);
    expect(rep.requests[0].beat_plan).toBe(plan);
    expect(JSON.parse(readArtifact(dir, result.run_id, "config.json"))).toEqual(
      JSON.parse(JSON.stringify(config)),
    );
    expect(JSON.parse(readArtifact(dir, result.run_id, "beats.json"))).toEqual(
      JSON.parse(JSON.stringify(plan)),
    );
  });
});

describe("§46 Pipeline Test — Repair Fails Then Retry", () => {
  it("修订后仍不合格：还有 Attempt 就整篇重生", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(63), review(80)]),
      rep,
    ).run(config);

    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.quality_status).toBe("accepted");
    expect(gen.calls).toEqual([STORY, RETRIED]);
    // §17：第一次修订挂在 Attempt 1 上，第二次 Attempt 没有修订
    expect(result.attempts[0].repairs).toHaveLength(1);
    expect(result.attempts[0].repairs[0].success).toBe(false);
    expect(result.attempts[1].repairs).toEqual([]);
    // 修订后的那一版正文被保留到 attempt 根目录（比初始版更接近可接受）
    expect(readArtifact(dir, result.run_id, "attempts/01/story.md")).toContain("修订后：");
  });

  it("§51-D 修订彻底失败（LLM 异常）：保留初始正文，直接整篇重生", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([null]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(80)]),
      rep,
    ).run(config);

    expect(result.attempt_count).toBe(2);
    expect(result.quality_status).toBe("accepted");
    expect(gen.calls).toEqual([STORY, RETRIED]);
    const record = result.attempts[0].repairs[0];
    expect(record.success).toBe(false);
    expect(record.after_validation).toBeNull();
    expect(record.after_review_score).toBeNull();
    expect(record.before_review_score).toBe(63);
    // 没修好就不覆盖 attempt 正文
    expect(readArtifact(dir, result.run_id, "attempts/01/story.md")).toContain(
      "陈岚推开派出所的玻璃门",
    );
    // §32：失败的修订也留下 metadata，after_* 是 null
    expect(readArtifactJson(dir, result.run_id, "attempts/01/repairs/01/metadata.json")).toEqual({
      repair_number: 1,
      issue_type: "ending",
      success: false,
      before_review_score: 63,
      after_review_score: null,
      before_validation_passed: false,
      after_validation_passed: null,
    });
  });
});

describe("§47 Pipeline Test — Non-repairable", () => {
  it("§51-C EMPTY_CONTENT：不调用 StoryRepairer，直接整篇重生", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([EMPTY, PASSED]),
      scriptedReviewer([review(80)]),
      rep,
    ).run(config);

    expect(rep.requests).toHaveLength(0);
    expect(result.attempt_count).toBe(2);
    expect(gen.calls).toEqual([STORY, RETRIED]);
    expect(result.attempts[0].repairs).toEqual([]);
    // §18：EMPTY_CONTENT 时连 Review 都跳过，attempt 目录里没有任何修订产物
    expect(hasArtifact(dir, result.run_id, "attempts/01/review.json")).toBe(false);
    expect(hasArtifact(dir, result.run_id, "attempts/01/repairs")).toBe(false);
    expect(hasArtifact(dir, result.run_id, "attempts/01/initial_story.md")).toBe(false);
  });

  it("§22 生成失败：没有正文可修，直接 Full Retry", async () => {
    withTmpDir();
    let i = 0;
    const gen = {
      calls: [] as string[],
      generate: async () => {
        i += 1;
        if (i === 1) throw new Error("LLM API 返回 500");
        gen.calls.push(STORY);
        return STORY;
      },
    };
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen as never,
      scriptedValidator([PASSED]),
      scriptedReviewer([review(80)]),
      rep,
    ).run(config);

    expect(rep.requests).toHaveLength(0);
    expect(result.attempts[0].repairs).toEqual([]);
    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(2);
  });
});

describe("§48 Pipeline Test — Repair Limit", () => {
  it("max_repairs_per_attempt=1：同一个 Attempt 最多调用一次", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(63), review(80)]),
      rep,
      { ...DEFAULT_RETRY_POLICY, max_repairs_per_attempt: 1 },
    ).run(config);

    // Attempt 1 修一次仍不过 → 整篇重生；Attempt 2 直接通过，不需要再修
    expect(rep.requests).toHaveLength(1);
    expect(result.attempts.map((a) => a.repairs.length)).toEqual([1, 0]);
    // 修订编号从 1 开始（§17：按 Attempt 单独计数）
    expect(result.attempts[0].repairs[0].repair_number).toBe(1);
    // §19：一个 Attempt 里只会有 01 这一个修订目录
    expect(listArtifacts(dir, result.run_id, "attempts/01/repairs")).toEqual(["01"]);
    expect(hasArtifact(dir, result.run_id, "attempts/02/repairs")).toBe(false);
  });

  it("max_repairs_per_attempt=0：等价于关闭 Repair，一次都不调", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(80)]),
      rep,
      { ...DEFAULT_RETRY_POLICY, max_repairs_per_attempt: 0 },
    ).run(config);

    expect(rep.requests).toHaveLength(0);
    expect(result.attempts.every((a) => a.repairs.length === 0)).toBe(true);
    expect(hasArtifact(dir, result.run_id, "attempts/01/initial_story.md")).toBe(false);
    expect(result.attempt_count).toBe(2);
  });

  it("§14 一次只修一个主要问题：多问题时只发一次修订请求", async () => {
    withTmpDir();
    const gen = scriptedGenerator([STORY]);
    const rep = scriptedRepairer([REPAIRED]);
    const twoIssues: ValidationResult = {
      passed: false,
      issues: [
        { code: "MISSING_ENDING", severity: "error", message: "故事缺少明确结局。" },
        { code: "TOO_SHORT", severity: "error", message: "正文长度明显不足。" },
        { code: "MISSING_PROTAGONIST", severity: "error", message: "主角没有出场。" },
      ],
    };
    await pipeline(
      gen,
      scriptedValidator([twoIssues, twoIssues]),
      scriptedReviewer([review(63), review(63)]),
      rep,
      { ...DEFAULT_RETRY_POLICY, max_attempts: 1 },
    ).run(config);

    expect(rep.requests).toHaveLength(1);
    // §13：MISSING_ENDING 优先级最高
    expect(rep.requests[0].issue_type).toBe("ending");
  });
});

describe("§51-E Repair Disabled", () => {
  it("enable_repair=false：链路与 v0.7.0 完全一致", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(80)]),
      rep,
      { ...DEFAULT_RETRY_POLICY, enable_repair: false },
    ).run(config);

    expect(rep.requests).toHaveLength(0);
    expect(result.attempts.every((a) => a.repairs.length === 0)).toBe(true);
    expect(result.attempt_count).toBe(2);
    expect(listArtifacts(dir, result.run_id, "attempts/01")).toEqual([
      "metadata.json",
      "quality.json",
      "review.json",
      "story.md",
      "validation.json",
    ]);
  });

  it("不注入 Repairer：同样没有 Repair 能力", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const result = await new GenerationPipeline(
      { plan: async () => plan } as never,
      gen as never,
      scriptedValidator([MISSING_ENDING, PASSED]) as never,
      scriptedReviewer([review(63), review(80)]) as never,
      new ArtifactStore(),
    ).run(config);

    expect(result.attempts.every((a) => a.repairs.length === 0)).toBe(true);
    expect(result.attempt_count).toBe(2);
    expect(hasArtifact(dir, result.run_id, "attempts/01/repairs")).toBe(false);
  });
});

describe("§17 Run 级汇总", () => {
  it("repair_count 累加各 Attempt 的修订次数，attempt_count 不变", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY, RETRIED]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      // 每个 Attempt 都是「首检不过 → 修订 → 复检通过」：两次校验、两次审阅。
      scriptedValidator([MISSING_ENDING, MISSING_ENDING, MISSING_ENDING, PASSED]),
      scriptedReviewer([review(63), review(63), review(63), review(80)]),
      rep,
    ).run(config);

    const total = result.attempts.reduce((sum, a) => sum + a.repairs.length, 0);
    expect(total).toBe(2);
    expect(result.attempt_count).toBe(2);
    const meta = readArtifactJson(dir, result.run_id, "metadata.json") as Record<string, unknown>;
    expect(meta.repair_count).toBe(2);
    expect(meta.enable_repair).toBe(true);
    expect(meta.max_repairs_per_attempt).toBe(1);
    // §40：根目录产物仍然是 selected attempt 的最终版本 = attempt 2 修订后的正文
    expect(readArtifact(dir, result.run_id, "story.md")).toBe(`# ${config.title}\n\n${REPAIRED}\n`);
  });

  it("§35 修订阶段写进 metadata，能看出当时修到第几轮", async () => {
    const dir = withTmpDir();
    const gen = scriptedGenerator([STORY]);
    const rep = scriptedRepairer([REPAIRED]);
    const result = await pipeline(
      gen,
      scriptedValidator([MISSING_ENDING, MISSING_ENDING]),
      scriptedReviewer([review(63), review(63)]),
      rep,
      { ...DEFAULT_RETRY_POLICY, max_attempts: 1 },
    ).run(config);

    const meta = readArtifactJson(dir, result.run_id, "metadata.json") as Record<string, unknown>;
    expect(meta.status).toBe("completed");
    expect(meta.repair_count).toBe(1);
    expect(result.attempts[0].repairs).toHaveLength(1);
    expect(result.attempts[0].repairs[0].success).toBe(false);
  });
});
