import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryRepairer } from "@/lib/story-repairer";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { LLMClient, MAX_TRANSPORT_RETRIES } from "@/lib/llm";
import { parseStoryConfig } from "@/lib/config-io";
import { ConfigValidationError } from "@/types/story-config";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  repoVersion,
} from "./helpers/fixtures";

/**
 * §48 Full Pipeline Integration Test。
 *
 * 这里只假掉 HTTP 传输层，其余全是真组件：真 BeatPlanner / StoryGenerator /
 * StoryValidator / BasicReviewer / StoryRepairer / GenerationPipeline / ArtifactStore，
 * 连 prompt 模板、parser、transport retry 都是真的。所以每一条路径断言的都是
 * 用户真正会走到的那条链路，而不是测试替身的自洽。
 *
 * 铁律：绝不调用真实收费 API——fetch 被换成固定响应的假传输（§47）。
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW_REPLY = JSON.stringify(SAMPLE_REVIEW);
const LOW_REVIEW_REPLY = JSON.stringify({
  score: 41,
  summary: "正文太短，冲突没有展开。",
  strengths: ["开头有画面"],
  problems: ["长度远低于目标", "高潮缺失"],
});

/** 长度下限（target_words=5000 → max(300, 750) = 750）之下的正文：触发 TOO_SHORT。 */
const SHORT_STORY = "陈岚走进派出所，然后又走了。";

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

interface FakeCall {
  url: string;
  body: { model: string; messages: Array<{ role: string; content: string }>; temperature: number };
}

/**
 * 假传输层：按调用顺序返回 OpenAI 形状的响应，也可以让某一次抛错。
 * 只认 /chat/completions，其它路径直接失败，避免测试悄悄打到别处。
 */
class FakeTransport {
  readonly calls: FakeCall[] = [];

  constructor(private readonly replies: Array<string | Error>) {}

  private index = 0;

  handler = async (url: string, init?: RequestInit): Promise<unknown> => {
    this.calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as FakeCall["body"],
    });
    if (!String(url).endsWith("/chat/completions")) {
      throw new Error(`FakeTransport 不认识的路径：${String(url)}`);
    }
    const reply = this.replies[Math.min(this.index++, this.replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    };
  };
}

/** 让 fetch 抛一个浏览器语义的超时异常（AbortSignal.timeout 的真实形状）。 */
function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function withFakeTransport(replies: Array<string | Error>): FakeTransport {
  const transport = new FakeTransport(replies);
  vi.stubGlobal("fetch", vi.fn(transport.handler));
  return transport;
}

/** 真 LLMClient，但请求全落在假传输层上。 */
function fakeLlm(timeoutMs = 1000): LLMClient {
  return new LLMClient("https://fake.invalid/v1", "sk-fake-key-not-a-secret", "fake-model", {
    timeoutMs,
  });
}

function policy(patch: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...patch };
}

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  vi.unstubAllGlobals();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-integration-"));
  process.chdir(tmp);
  return tmp;
}

/** 落盘的 run metadata 里被这些断言用到的字段。 */
interface RunMeta {
  project_version: string;
  status: string;
  current_stage?: string;
  quality_status?: string;
  selected_attempt?: number;
  repair_count?: number;
  error?: string;
}

interface RepairEntry {
  repair_number: number;
  issue_type: string;
  success: boolean;
}

/** 落盘的 attempt metadata 里被这些断言用到的字段。 */
interface AttemptMeta {
  attempt_number: number;
  accepted: boolean;
  retry_reason: string | null;
  validation_passed?: boolean;
  review_score?: number | null;
  repair_count?: number;
  repairs: RepairEntry[];
}

function readJson<T>(dir: string, runId: string, rel: string): T {
  return JSON.parse(readFileSync(join(dir, "runs", runId, rel), "utf8")) as T;
}

function runMeta(dir: string, runId: string): RunMeta {
  return readJson<RunMeta>(dir, runId, "metadata.json");
}

function attemptMeta(dir: string, runId: string, n: number): AttemptMeta {
  return readJson<AttemptMeta>(dir, runId, `attempts/${String(n).padStart(2, "0")}/metadata.json`);
}

/** 组装一条全真 Pipeline（只有 LLM 传输层是假的）。 */
function fullPipeline(store: ArtifactStore, llm: LLMClient) {
  return new GenerationPipeline(
    new BeatPlanner(llm),
    new StoryGenerator(llm),
    new StoryValidator(),
    new BasicReviewer(llm),
    store,
  );
}

describe("§49 Happy Path：Attempt 1 直接 accepted，产物完整", () => {
  it("Plan → Generate → Validate → Review → Accept，六个产物全部落盘", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY]);
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());

    const result = await pipeline.run(SAMPLE_CONFIG);

    // 一次 Plan + 一次 Generate + 一次 Review：没有任何多余请求
    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[0].body.messages.at(-1)?.content).toContain("核心设定");
    expect(transport.calls[1].body.messages.at(-1)?.content).toContain("Beat 1");
    expect(transport.calls[2].body.messages.at(-1)?.content).toContain(SAMPLE_STORY.slice(0, 20));

    expect(result.run_id).toMatch(RUN_ID);
    expect(result.status).toBe("completed");
    expect(result.quality_status).toBe("accepted");
    expect(result.attempt_count).toBe(1);
    expect(result.selected_attempt).toBe(1);
    expect(result.story).toBe(SAMPLE_STORY);
    expect(result.beat_plan).toEqual(SAMPLE_BEAT_PLAN);
    expect(result.validation).toEqual({ passed: true, issues: [] });
    expect(result.validation_status).toBe("completed");
    expect(result.review?.score).toBe(SAMPLE_REVIEW.score);
    expect(result.review_status).toBe("completed");
    expect(result.attempts[0].repairs).toHaveLength(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].accepted).toBe(true);
    expect(result.attempts[0].retry_reason).toBeNull();

    const runDir = join(dir, "runs", result.run_id);
    expect(readdirSync(runDir).sort()).toEqual([
      "attempts", "beats.json", "config.json", "metadata.json", "review.json", "story.md", "validation.json",
    ]);
    expect(readFileSync(join(runDir, "beats.json"), "utf8")).toContain("证人失踪");
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("# 消失的目击者");
    expect(readFileSync(join(runDir, "story.md"), "utf8")).toContain("陈岚推开派出所的玻璃门");
    expect(readFileSync(join(runDir, "story.md"), "utf8")).not.toContain("sk-fake-key");
    expect(readJson(dir, result.run_id, "review.json")).toEqual(SAMPLE_REVIEW);
    expect(readJson(dir, result.run_id, "validation.json")).toEqual({ passed: true, issues: [] });

    const meta = runMeta(dir, result.run_id);
    expect(meta.project_version).toBe(repoVersion());
    expect(meta.status).toBe("completed");
    expect(meta.quality_status).toBe("accepted");
    expect(meta.selected_attempt).toBe(1);
    expect(meta.repair_count).toBe(0);
    expect(attemptMeta(dir, result.run_id, 1).accepted).toBe(true);
  });

  it("密钥只以 Authorization 头出现，不进入任何产物", async () => {
    withTmpDir();
    const transport = withFakeTransport([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY]);
    const dir = process.cwd();
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());
    const result = await pipeline.run(SAMPLE_CONFIG);

    expect(transport.calls[0].url).toBe("https://fake.invalid/v1/chat/completions");
    const runDir = join(dir, "runs", result.run_id);
    for (const file of ["story.md", "beats.json", "config.json", "metadata.json"]) {
      expect(readFileSync(join(runDir, file), "utf8")).not.toContain("sk-fake-key");
    }
    const serialized = JSON.stringify(runMeta(dir, result.run_id));
    expect(serialized).not.toMatch(/sk-[a-z0-9_-]{8,}/);
  });
});

describe("§50 Retry Path：Attempt 1 失败 → Attempt 2 accepted", () => {
  it("第一次太短触发 TOO_SHORT，第二次达标后 accepted", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([
      PLAN_REPLY,
      SHORT_STORY,
      LOW_REVIEW_REPLY,
      SAMPLE_STORY,
      GOOD_REVIEW_REPLY,
    ]);
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());

    const result = await pipeline.run(SAMPLE_CONFIG, undefined, policy({ enable_repair: false }));

    expect(result.quality_status).toBe("accepted");
    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.story).toBe(SAMPLE_STORY);
    // 两次生成各自请求一次，没有多余调用
    expect(transport.calls).toHaveLength(5);

    expect(result.attempts[0].accepted).toBe(false);
    expect(result.attempts[0].retry_reason).toBe("validation_failed");
    expect(result.attempts[0].validation?.passed).toBe(false);
    expect(result.attempts[0].validation?.issues[0].code).toBe("TOO_SHORT");
    expect(result.attempts[0].repairs).toHaveLength(0);
    expect(result.attempts[1].accepted).toBe(true);
    expect(result.attempts[1].retry_reason).toBeNull();

    const first = attemptMeta(dir, result.run_id, 1);
    expect(first.accepted).toBe(false);
    expect(first.retry_reason).toBe("validation_failed");
    expect(first.validation_passed).toBe(false);
    expect(first.repair_count).toBe(0);
    const second = attemptMeta(dir, result.run_id, 2);
    expect(second.accepted).toBe(true);
    expect(second.review_score).toBe(SAMPLE_REVIEW.score);
    // 第一次的短正文没有被第二次覆盖
    expect(readFileSync(join(dir, "runs", result.run_id, "attempts", "01", "story.md"), "utf8")).toContain(SHORT_STORY);
    expect(readFileSync(join(dir, "runs", result.run_id, "attempts", "02", "story.md"), "utf8")).toContain("陈岚推开派出所的玻璃门");
  });

  it("同一份 StoryConfig / BeatPlan / 温度贯穿两次 Attempt，不偷偷调参", async () => {
    withTmpDir();
    const transport = withFakeTransport([
      PLAN_REPLY, SHORT_STORY, LOW_REVIEW_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY,
    ]);
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());
    await pipeline.run(SAMPLE_CONFIG, { temperature: 0.42 }, policy({ enable_repair: false }));

    const generateCalls = transport.calls.filter((c) => c.body.messages.at(-1)?.content.includes("Beat 1"));
    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[0].body.temperature).toBe(0.42);
    expect(generateCalls[1].body.temperature).toBe(0.42);
    expect(generateCalls[1].body.messages.at(-1)?.content).toBe(generateCalls[0].body.messages.at(-1)?.content);
  });
});

describe("§51 Repair Path：Attempt 1 失败 → Repair → Revalidate → Re-review → accepted", () => {
  it("定点修订修好长度，Accept 仍只由 RetryPolicy 产生", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([
      PLAN_REPLY,
      SHORT_STORY,
      LOW_REVIEW_REPLY,
      SAMPLE_STORY,   // Repair 输出
      GOOD_REVIEW_REPLY, // Re-review
    ]);
    const llm = fakeLlm();
    const pipeline = new GenerationPipeline(
      new BeatPlanner(llm),
      new StoryGenerator(llm),
      new StoryValidator(),
      new BasicReviewer(llm),
      new ArtifactStore(),
      policy({ max_attempts: 1, enable_repair: true, max_repairs_per_attempt: 1 }),
      new StoryRepairer(llm),
    );

    const result = await pipeline.run(SAMPLE_CONFIG);

    // Repair 不新增 Attempt：仍然只有一次 Attempt，且被 accepted
    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(1);
    expect(result.attempts[0].repairs).toHaveLength(1);
    expect(result.story).toBe(SAMPLE_STORY);
    expect(result.validation?.passed).toBe(true);
    expect(result.review?.score).toBe(SAMPLE_REVIEW.score);
    // Plan / Generate / Review / Repair / Re-review，一次不多
    expect(transport.calls).toHaveLength(5);
    expect(transport.calls[3].body.messages.at(-1)?.content).toContain("修订");

    const meta = runMeta(dir, result.run_id);
    expect(meta.repair_count).toBe(1);
    expect(meta.quality_status).toBe("accepted");
    const attempt = attemptMeta(dir, result.run_id, 1);
    expect(attempt.accepted).toBe(true);
    expect(attempt.repair_count).toBe(1);
    expect(attempt.repairs).toHaveLength(1);
    expect(attempt.repairs[0].success).toBe(true);
    expect(attempt.repairs[0].issue_type).toBe("length");
    // 修订产物落在 repairs/01/，初始正文另有其名（§30：attempt 根的 story.md 是最终版）
    const attemptDir = join(dir, "runs", result.run_id, "attempts", "01");
    expect(readFileSync(join(attemptDir, "repairs", "01", "story.md"), "utf8")).toContain("陈岚推开派出所的玻璃门");
    expect(readFileSync(join(attemptDir, "repairs", "01", "validation.json"), "utf8")).toContain('"passed": true');
    expect(readFileSync(join(attemptDir, "repairs", "01", "review.json"), "utf8")).toContain("82");
    expect(readFileSync(join(attemptDir, "initial_story.md"), "utf8")).toContain(SHORT_STORY);
    expect(readFileSync(join(attemptDir, "story.md"), "utf8")).toContain("陈岚推开派出所的玻璃门");
    expect(readFileSync(join(attemptDir, "story.md"), "utf8")).not.toContain(SHORT_STORY);
  });
});

describe("§52 Exhausted Path：所有 Attempt 都失败 → quality_status = exhausted", () => {
  it("两次都太短，用尽 Attempt 后收尾为 exhausted 而不是报错", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([
      PLAN_REPLY, SHORT_STORY, LOW_REVIEW_REPLY, SHORT_STORY, LOW_REVIEW_REPLY,
    ]);
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());

    const result = await pipeline.run(SAMPLE_CONFIG, undefined, policy({ enable_repair: false }));

    expect(result.status).toBe("completed");
    expect(result.quality_status).toBe("exhausted");
    expect(result.attempt_count).toBe(2);
    expect(result.selected_attempt).toBe(2);
    expect(result.attempts.every((a) => !a.accepted)).toBe(true);
    expect(transport.calls).toHaveLength(5);

    const meta = runMeta(dir, result.run_id);
    expect(meta.status).toBe("completed");
    expect(meta.quality_status).toBe("exhausted");
    expect(meta.repair_count).toBe(0);
  });

  it("生成一直失败也不会无限 Attempt：用尽后 Run 清晰失败，已产出的 attempt 产物不删", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([
      PLAN_REPLY,
      new Error("LLM API 返回 500"),
      new Error("LLM API 返回 500"),
    ]);
    const pipeline = fullPipeline(new ArtifactStore(), fakeLlm());

    const err = await pipeline
      .run(SAMPLE_CONFIG, undefined, policy({ max_attempts: 2, enable_repair: false }))
      .catch((e: unknown) => e);

    // 1 次 Plan + 2 次生成尝试（各 1 次请求）：Attempt 数被 max_attempts 硬限住
    expect(transport.calls).toHaveLength(3);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).stage).toBe("generating");
    expect((err as PipelineError).runId).toMatch(RUN_ID);
    expect((err as PipelineError).message).toContain("generating");

    const meta = runMeta(dir, (err as PipelineError).runId);
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("generating");
    expect(meta.error).toContain("500");
    // 磁盘上只有两次 Attempt 的产物： Attempt 数真的被 max_attempts 限住了
    const attemptDirs = readdirSync(join(dir, "runs", (err as PipelineError).runId, "attempts")).sort();
    expect(attemptDirs).toEqual(["01", "02"]);
    expect(attemptMeta(dir, (err as PipelineError).runId, 1).retry_reason).toBe("generation_error");
    expect(attemptMeta(dir, (err as PipelineError).runId, 2).retry_reason).toBe("generation_error");
    expect(JSON.stringify(meta)).not.toMatch(/at\s+[\w$.<>/\\-]+:\d+:\d+/);
    expect(JSON.stringify(meta)).not.toContain("sk-fake-key");
  });
});

describe("§53 Artifact Failure：磁盘写失败必须清晰失败，不死循环", () => {
  it("写 story.md 失败时抛 PipelineError，带 run_id 与 stage，且不泄漏本机路径", async () => {
    const dir = withTmpDir();
    withFakeTransport([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY]);
    const secretPath = join("D:", "secret", "runs", "run", "attempts", "01", "story.md");

    class FailingStore extends ArtifactStore {
      override putAttemptStory(): string {
        throw new Error(`EACCES: permission denied, open '${secretPath}'`);
      }
    }

    const pipeline = fullPipeline(new FailingStore(), fakeLlm());
    const err = await pipeline.run(SAMPLE_CONFIG).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PipelineError);
    const failure = err as PipelineError;
    expect(failure.runId).toMatch(RUN_ID);
    expect(failure.stage).toBe("saving");
    expect(failure.message).toContain("saving");
    // 绝对路径与异常细节都不该出现在用户可见的 message 里
    expect(failure.message).not.toContain("D:\\secret");
    expect(failure.message).not.toContain(secretPath);
    expect(failure.message).toContain("<path>");

    // 失败也落一份 metadata，且带失败原因
    expect(existsSync(join(dir, "runs", failure.runId, "metadata.json"))).toBe(true);
    const meta = runMeta(dir, failure.runId);
    expect(meta.status).toBe("failed");
    expect(meta.current_stage).toBe("saving");
    expect(JSON.stringify(meta)).not.toContain("D:\\secret");
  });
});

describe("§54 Timeout：transport retry 有硬上限，最终错误清晰", () => {
  it("LLM 一直超时：最多 3 次请求，然后给出清晰错误", async () => {
    withTmpDir();
    const transport = withFakeTransport([timeoutError()]);
    const llm = fakeLlm(50);

    const err = await new StoryGenerator(llm)
      .generate(SAMPLE_CONFIG, SAMPLE_BEAT_PLAN)
      .catch((e: unknown) => e);

    expect(transport.calls).toHaveLength(MAX_TRANSPORT_RETRIES + 1);
    expect((err as Error).name).toBe("LLMTimeoutError");
    expect((err as Error).message).toContain("超时");
  });

  it("超时进入 Pipeline 后不会变成无限 GenerationAttempt", async () => {
    const dir = withTmpDir();
    const transport = withFakeTransport([PLAN_REPLY, timeoutError(), timeoutError()]);
    const llm = fakeLlm(50);
    const pipeline = fullPipeline(new ArtifactStore(), llm);

    const err = await pipeline
      .run(SAMPLE_CONFIG, undefined, policy({ max_attempts: 2, enable_repair: false }))
      .catch((e: unknown) => e);

    // Plan 1 次 + 第一次生成 3 次（1 首发 + 2 transport 重试）+ 第二次生成 3 次
    expect(transport.calls).toHaveLength(7);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as PipelineError).stage).toBe("generating");
    expect((err as PipelineError).message).toContain("超时");

    const meta = runMeta(dir, (err as PipelineError).runId);
    expect(meta.status).toBe("failed");
    // 磁盘上只有两次 Attempt 的产物：超时没有变成无限 GenerationAttempt
    const attemptDirs = readdirSync(join(dir, "runs", (err as PipelineError).runId, "attempts")).sort();
    expect(attemptDirs).toEqual(["01", "02"]);
    expect(attemptMeta(dir, (err as PipelineError).runId, 1).retry_reason).toBe("generation_error");
    expect(JSON.stringify(meta)).not.toContain("sk-fake-key");
    expect(JSON.stringify(meta)).not.toMatch(/at\s+[\w$.<>/\\-]+:\d+:\d+/);
  });

  it("一次超时后成功：transport retry 不增加 attempt_number", async () => {
    withTmpDir();
    const transport = withFakeTransport([PLAN_REPLY, timeoutError(), SAMPLE_STORY, GOOD_REVIEW_REPLY]);
    const llm = fakeLlm(50);
    const pipeline = fullPipeline(new ArtifactStore(), llm);

    const result = await pipeline.run(SAMPLE_CONFIG);

    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.story).toBe(SAMPLE_STORY);
    expect(transport.calls).toHaveLength(4);
    expect(result.attempts[0].accepted).toBe(true);
  });
});

describe("§55 Config Validation：非法配置在进 Pipeline 之前就被挡住", () => {
  it("target_words 非法时 parseStoryConfig 直接拒绝，一次 LLM 请求都不发", async () => {
    withTmpDir();
    const transport = withFakeTransport([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY]);

    const err = await (async () =>
      parseStoryConfig(JSON.stringify({ ...SAMPLE_CONFIG, target_words: 10 })))().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigValidationError);
    expect((err as Error).message).toMatch(/target_words|字数/);
    // 配置没进来，Pipeline 没有机会发起任何请求
    expect(transport.calls).toHaveLength(0);
  });

  it("缺题材 / 缺核心设定 / 缺标题同样进不了 Pipeline", () => {
    for (const patch of [{ genre: "" }, { premise: "" }, { title: "" }]) {
      expect(() => parseStoryConfig(JSON.stringify({ ...SAMPLE_CONFIG, ...patch }))).toThrow(ConfigValidationError);
    }
  });
});
