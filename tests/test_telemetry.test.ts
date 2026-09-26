import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { ExperimentRunner } from "@/core/experiment-runner";
import { ExperimentStore } from "@/storage/experiment-store";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryRepairer } from "@/lib/story-repairer";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { BeatValidator } from "@/lib/beat-validator";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import { TelemetryCollector } from "@/core/telemetry-collector";
import { LLMClient } from "@/lib/llm";
import { summarizeExperiment } from "@/lib/experiment-summary";
import { stageLabel, telemetryPanelState } from "@/lib/telemetry-view";
import type { ExperimentDefinition } from "@/types/experiment";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_COMMERCIAL_REVIEW,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  withTmpDir,
} from "./helpers/fixtures";
import type { RunTelemetry } from "@/types/telemetry";

/**
 * v1.8.0 Observability 的行为测试（TASK §35-§44）。
 *
 * 这里只假掉 HTTP 传输层，其余全是真组件：真 Pipeline、真 BeatValidator、
 * 真 CommercialReviewer、真 StoryRepairer、真 ArtifactStore、真 TelemetryCollector。
 * 所以「调了几次模型」数的是共享客户端上真实发生的那几次调用——把假 LLM 注进来
 * 是数不到的（注入的客户端是调用方自己的，采集器不碰它，见 clientFor）。
 *
 * 铁律同全仓：绝不调用真实收费 API——fetch 被换成固定响应的假传输。
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW_REPLY = JSON.stringify(SAMPLE_REVIEW);
const COMMERCIAL_REPLY = JSON.stringify(SAMPLE_COMMERCIAL_REVIEW);
const BEAT_VALIDATION_REPLY = JSON.stringify({
  passed: true,
  issues: [],
  summary: "骨架结构完整：开场、冲突升级、高潮、收束都有，顺序与状态一致。",
});
const LOW_REVIEW_REPLY = JSON.stringify({
  score: 41,
  summary: "正文太短，冲突没有展开。",
  strengths: ["开头有画面"],
  problems: ["长度远低于目标", "高潮缺失"],
});

/** 长度下限（target_words=5000 → max(300, 750) = 750）之下的正文：触发 TOO_SHORT。 */
const SHORT_STORY = "陈岚走进派出所，然后又走了。";

/** OpenAI 形状的 usage：Provider 报多少就落多少，一个数都不改。 */
const USAGE_REPLY = {
  prompt_tokens: 11120,
  completion_tokens: 5930,
  total_tokens: 17050,
};

interface FakeReply {
  content: string;
  usage?: Record<string, number>;
  cost?: { amount: number; currency?: string };
}

/**
 * 假传输层：按调用顺序返回 OpenAI 形状的响应，某一次也可以是异常。
 * 只认 /chat/completions，别的路径直接失败，避免测试悄悄打到别处。
 */
class FakeTransport {
  readonly calls: Array<{ url: string; body: unknown }> = [];

  constructor(private readonly replies: Array<string | Error | FakeReply>) {}

  private index = 0;

  handler = async (url: string, init?: RequestInit): Promise<unknown> => {
    this.calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    if (!String(url).endsWith("/chat/completions")) {
      throw new Error(`FakeTransport 不认识的路径：${String(url)}`);
    }
    const reply = this.replies[Math.min(this.index++, this.replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string") {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: reply.content } }],
        ...(reply.usage ? { usage: reply.usage } : {}),
        ...(reply.cost ? { cost: reply.cost } : {}),
      }),
    };
  };
}

function withFakeTransport(replies: Array<string | Error | FakeReply>): FakeTransport {
  const transport = new FakeTransport(replies);
  vi.stubGlobal("fetch", vi.fn(transport.handler));
  return transport;
}

function policy(patch: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...patch };
}

/** 真 LLMClient，请求全落在假传输层上；采集器接在客户端与 Pipeline 两端（同 buildPipeline）。 */
function fullPipeline(
  store: ArtifactStore,
  telemetry: TelemetryCollector,
  p: RetryPolicy,
  repairer?: StoryRepairer,
) {
  const llm = new LLMClient("https://fake.invalid/v1", "sk-fake-key-not-a-secret", "fake-model", {
    timeoutMs: 1000,
    telemetry,
  });
  return new GenerationPipeline(
    new BeatPlanner(llm),
    new StoryGenerator(llm),
    new StoryValidator(),
    new BasicReviewer(llm),
    store,
    p,
    repairer ?? (p.enable_repair ? new StoryRepairer(llm) : undefined),
    undefined,
    undefined,
    undefined,
    new BeatValidator(llm),
    new CommercialReviewer(llm),
    telemetry,
  );
}

/** 一次顺利跑完的五次调用：Plan → 骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
function happyScript(patch: Partial<FakeReply> = {}): FakeReply[] {
  return [PLAN_REPLY, BEAT_VALIDATION_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY, COMMERCIAL_REPLY].map(
    (content) => ({ content, ...patch }),
  );
}

/**
 * fixed 模式下一次样本的四次调用：骨架已给定，Planner 不参与。
 * 与 happyScript 只差第一格——用错会让后面的回复整体错位，测的就不是想测的那件事了。
 */
function fixedScript(patch: Partial<FakeReply> = {}): FakeReply[] {
  return [BEAT_VALIDATION_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY, COMMERCIAL_REPLY].map((content) => ({
    content,
    ...patch,
  }));
}

function telemetryOf(runId: string): RunTelemetry {
  return JSON.parse(readFileSync(join("runs", runId, "telemetry.json"), "utf8")) as RunTelemetry;
}

/** 落盘的 telemetry.json 原文——安全断言读的是它，不是内存里的对象。 */
function telemetryText(runId: string): string {
  return readFileSync(join("runs", runId, "telemetry.json"), "utf8");
}

function stageOf(telemetry: RunTelemetry, stage: string) {
  return telemetry.stages.find((s) => s.stage === stage);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// §35 / §36 阶段计时
// ---------------------------------------------------------------------------

describe("§35/§36 阶段计时：每一条阶段都有真实的起止与时长", () => {
  it("跑完的每一条 durationMs >= 0，且起止时间成对出现", async () => {
    withTmpDir();
    withFakeTransport(happyScript());
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    expect(telemetry.status).toBe("completed");
    expect(telemetry.runId).toBe(result.run_id);
    expect(telemetry.schemaVersion).toBe("1");
    expect(telemetry.durationMs).toBeGreaterThanOrEqual(0);

    // 一条阶段都不缺，顺序就是真实发生的顺序
    expect(telemetry.stages.map((s) => s.stage)).toEqual([
      "planning",
      "validating_beat_plan",
      "generating",
      "saving",
      "validating",
      "reviewing",
      "reviewing_commercial",
      "artifact_promotion",
    ]);
    for (const stage of telemetry.stages) {
      expect(stage.durationMs, stage.stage).toBeGreaterThanOrEqual(0);
      expect(stage.status, stage.stage).toBe("completed");
      expect(typeof stage.startedAt, stage.stage).toBe("string");
      expect(typeof stage.completedAt, stage.stage).toBe("string");
      // 成功阶段上没有错误码：这个键只在失败时出现
      expect(Object.keys(stage)).not.toContain("errorCode");
      // 结束不可能早于开始
      expect(Date.parse(String(stage.completedAt))).toBeGreaterThanOrEqual(Date.parse(String(stage.startedAt)));
    }
    // 起止时间是单调推进的：总时长不小于任何单条阶段
    for (const stage of telemetry.stages) {
      expect(telemetry.durationMs!).toBeGreaterThanOrEqual(stage.durationMs!);
    }
  });

  it("失败阶段带 status = failed 与稳定 errorCode，且不带异常原文（§36/§42）", async () => {
    withTmpDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed: https://user:pass@example.com/v1/chat?token=abc")),
    );
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy({ max_attempts: 1 }));

    const err = await pipeline.run(SAMPLE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);

    const telemetry = telemetryOf((err as PipelineError).runId);
    expect(telemetry.status).toBe("failed");
    expect(telemetry.failureStage).toBe("planning");
    expect(telemetry.failureCode).toBe("LLM_REQUEST_FAILED");

    const planning = stageOf(telemetry, "planning");
    expect(planning?.status).toBe("failed");
    expect(planning?.errorCode).toBe("LLM_REQUEST_FAILED");
    // 没跑到的阶段不补 skipped——采集器不替流程说话
    expect(stageOf(telemetry, "reviewing")).toBeUndefined();
    // 这一次 Attempt 连正文都没跑出来（Plan 就断了，一个 Attempt 都没起）
    expect(telemetry.attempts).toHaveLength(0);
    expect(telemetry.totals.failedStages).toBe(1);
  });

  it("没接某一步时如实记 skipped，与 failed 是两件事（§6）", async () => {
    withTmpDir();
    withFakeTransport([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW_REPLY]);
    const telemetry = new TelemetryCollector();
    const llm = new LLMClient("https://fake.invalid/v1", "sk-fake-key-not-a-secret", "fake-model", {
      timeoutMs: 1000,
      telemetry,
    });
    // 不注入 BeatValidator / CommercialReviewer / Repairer：这三步这一版不存在
    const pipeline = new GenerationPipeline(
      new BeatPlanner(llm),
      new StoryGenerator(llm),
      new StoryValidator(),
      new BasicReviewer(llm),
      new ArtifactStore(),
      policy(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      telemetry,
    );

    const result = await pipeline.run(SAMPLE_CONFIG);
    const stored = telemetryOf(result.run_id);

    // 「这一步没接」与「这一步坏了」在读出来必须是两件事
    expect(stageOf(stored, "validating_beat_plan")?.status).toBe("skipped");
    expect(stageOf(stored, "reviewing_commercial")?.status).toBe("skipped");
    expect(stageOf(stored, "generating")?.status).toBe("completed");
    // skipped 不带起止时间：它没跑过，没什么可计的
    expect(Object.keys(stageOf(stored, "validating_beat_plan")!)).not.toContain("durationMs");
    expect(stored.totals.failedStages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §37 重试与修订计数
// ---------------------------------------------------------------------------

describe("§37 重试与修订：3 次 Attempt = 2 次重试，两次修订 = repairs 2", () => {
  it("三次 Attempt 用尽 → retries = 2", async () => {
    withTmpDir();
    // 每个没过的 Attempt 都会走 正文 + 结构审阅 + 商业审阅 三次调用
    withFakeTransport([
      PLAN_REPLY,
      BEAT_VALIDATION_REPLY,
      ...Array.from({ length: 3 }).flatMap<string>(() => [SHORT_STORY, LOW_REVIEW_REPLY, COMMERCIAL_REPLY]),
    ]);
    const pipeline = fullPipeline(
      new ArtifactStore(),
      new TelemetryCollector(),
      policy({ max_attempts: 3, enable_repair: false }),
    );

    const result = await pipeline.run(SAMPLE_CONFIG);
    expect(result.attempt_count).toBe(3);

    const telemetry = telemetryOf(result.run_id);
    expect(telemetry.attempts).toHaveLength(3);
    // §12：重试次数 = Attempt 数 - 1。一次都没跑出来时是 0，不是 -1
    expect(telemetry.totals.retries).toBe(2);
    // 三次都没过：每一次都记 retried；「次数用尽」是 Run 级的结论，不由单次 Attempt 替它说
    expect(telemetry.attempts.map((a) => a.status)).toEqual(["retried", "retried", "retried"]);
    for (const attempt of telemetry.attempts) {
      expect(attempt.generationCalls).toBe(1);
      expect(attempt.reviewCalls).toBe(1);
      expect(attempt.commercialReviewCalls).toBe(1);
      expect(attempt.repairCount).toBe(0);
    }
    // 同一个阶段在一次 Run 里跑几次就记几条：validating 出现三次
    expect(telemetry.stages.filter((s) => s.stage === "validating")).toHaveLength(3);
    expect(telemetry.repairs).toHaveLength(0);
  });

  it("两轮修订 → repairs = 2，且都记在被修的 Attempt 名下", async () => {
    withTmpDir();
    withFakeTransport([
      PLAN_REPLY,
      BEAT_VALIDATION_REPLY,
      SHORT_STORY, // attempt-01 generating
      LOW_REVIEW_REPLY, // attempt-01 reviewing
      SHORT_STORY, // repair-01 repairing（修出来还是短）
      LOW_REVIEW_REPLY, // repair-01 rereviewing
      SHORT_STORY, // repair-02 repairing
      LOW_REVIEW_REPLY, // repair-02 rereviewing
      COMMERCIAL_REPLY, // reviewing_commercial
    ]);
    const pipeline = fullPipeline(
      new ArtifactStore(),
      new TelemetryCollector(),
      policy({ max_attempts: 1, enable_repair: true, max_repairs_per_attempt: 2 }),
    );

    const result = await pipeline.run(SAMPLE_CONFIG);

    const telemetry = telemetryOf(result.run_id);
    expect(telemetry.repairs).toHaveLength(2);
    expect(telemetry.totals.repairs).toBe(2);
    expect(telemetry.repairs.map((r) => r.attemptId)).toEqual(["attempt-01", "attempt-01"]);
    // 修订不新增 Attempt
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0].repairCount).toBe(2);
    expect(telemetry.attempts[0].status).toBe("retried");
    // 每一轮修订各自记了自己期间发生的调用（修 + 重新审阅），不只是修正文那一次
    for (const repair of telemetry.repairs) {
      expect(repair.llmCalls).toBe(2);
      expect(repair.durationMs).toBeGreaterThanOrEqual(0);
      // 修出来也没过：修订的结局是 failed，与 repairs/01/metadata.json 的 success=false 同口径
      expect(repair.status).toBe("failed");
    }
    // 修订之后重新走的校验 / 审阅是真实发生的阶段，缺了就是漏记
    expect(stageOf(telemetry, "revalidating")).toBeDefined();
    expect(stageOf(telemetry, "rereviewing")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §38 模型调用计数：六个组件一个都漏不掉
// ---------------------------------------------------------------------------

describe("§38 模型调用计数：统一入口数的是真实发生的那几次", () => {
  it("Planner / BeatValidator / Generator / Reviewer / Repairer / CommercialReviewer 各归各的阶段", async () => {
    withTmpDir();
    withFakeTransport([
      PLAN_REPLY, // planning
      BEAT_VALIDATION_REPLY, // validating_beat_plan
      SHORT_STORY, // generating
      LOW_REVIEW_REPLY, // reviewing
      SHORT_STORY, // repairing
      LOW_REVIEW_REPLY, // rereviewing（重新审阅）
      COMMERCIAL_REPLY, // reviewing_commercial
    ]);
    const pipeline = fullPipeline(
      new ArtifactStore(),
      new TelemetryCollector(),
      policy({ max_attempts: 1, enable_repair: true, max_repairs_per_attempt: 1 }),
    );

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    // 七次逻辑调用，一条不多一条不少；阶段归属取「调用发生时正在哪个阶段」
    expect(telemetry.llmCalls.map((c) => c.stage)).toEqual([
      "planning",
      "validating_beat_plan",
      "generating",
      "reviewing",
      "repairing",
      "rereviewing",
      "reviewing_commercial",
    ]);
    expect(telemetry.totals.llmCalls).toBe(7);
    // 每次调用都带上真实模型名、起止与结局
    for (const call of telemetry.llmCalls) {
      expect(call.model).toBe("fake-model");
      expect(call.status).toBe("completed");
      expect(typeof call.startedAt).toBe("string");
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
      // Provider 归属刻意不记：可观测不等于把部署信息抄进产物
      expect(Object.keys(call)).not.toContain("provider");
    }
    // 一次调用一个 id，顺序即发生顺序
    expect(telemetry.llmCalls.map((c) => c.id)).toEqual([
      "call-001",
      "call-002",
      "call-003",
      "call-004",
      "call-005",
      "call-006",
      "call-007",
    ]);
  });

  it("transport 重试仍然算同一次逻辑调用，不拆成多条（§7）", async () => {
    withTmpDir();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: PLAN_REPLY } }] }),
        }),
    );
    const collector = new TelemetryCollector("run-x");
    const llm = new LLMClient("https://fake.invalid/v1", "sk-fake-key-not-a-secret", "fake-model", {
      timeoutMs: 1000,
      telemetry: collector,
    });
    collector.enter("planning");

    expect(await llm.generate("hi")).toBe(PLAN_REPLY);

    // 两次 HTTP 请求，一条遥测记录：拆开报会让「调用次数」这个数虚高
    const telemetry = collector.finish("completed");
    expect(telemetry.llmCalls).toHaveLength(1);
    expect(telemetry.llmCalls[0].status).toBe("completed");
    expect(telemetry.totals.llmCalls).toBe(1);
  });

  it("失败的调用也记：带稳定错误码，不带响应体", async () => {
    withTmpDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }),
    );
    const collector = new TelemetryCollector("run-y");
    const llm = new LLMClient("https://fake.invalid/v1", "sk-fake-key-not-a-secret", "fake-model", {
      timeoutMs: 1000,
      telemetry: collector,
    });
    collector.enter("generating");
    await expect(llm.generate("hi")).rejects.toThrow();

    const telemetry = collector.finish("failed", { stage: "generating", code: "LLM_REQUEST_FAILED" });
    expect(telemetry.llmCalls).toHaveLength(1);
    expect(telemetry.llmCalls[0].status).toBe("failed");
    expect(telemetry.llmCalls[0].errorCode).toBe("LLM_REQUEST_FAILED");
    // 401 的响应体一个字都不进遥测
    expect(JSON.stringify(telemetry)).not.toContain("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// §39 / §40 usage 与 cost
// ---------------------------------------------------------------------------

describe("§39/§40 usage 与 cost：Provider 给了才落，没给就是 null", () => {
  it("返回 usage 时逐项落盘，token 三项与样本数一致", async () => {
    withTmpDir();
    withFakeTransport(happyScript({ usage: USAGE_REPLY }));
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    expect(telemetry.llmCalls).toHaveLength(5);
    expect(telemetry.totals.inputTokens).toBe(11120 * 5);
    expect(telemetry.totals.outputTokens).toBe(5930 * 5);
    expect(telemetry.totals.totalTokens).toBe(17050 * 5);
    expect(telemetry.totals.usageSampleCount).toBe(5);
    for (const call of telemetry.llmCalls) {
      expect(call.inputTokens).toBe(11120);
      expect(call.outputTokens).toBe(5930);
      expect(call.totalTokens).toBe(17050);
      // 没有价格信息时整个 cost 键都不出现（§8）
      expect(Object.keys(call)).not.toContain("cost");
    }
  });

  it("一次给一次不给：只对有值的那些求和，分母照实（§24）", async () => {
    withTmpDir();
    const script = happyScript({ usage: USAGE_REPLY });
    script[2] = { content: SAMPLE_STORY }; // 生成这一次 Provider 没给 usage
    withFakeTransport(script);
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    // 5 次调用、4 次有 usage：合计按 4 次算，分母也是 4
    expect(telemetry.totals.llmCalls).toBe(5);
    expect(telemetry.totals.usageSampleCount).toBe(4);
    expect(telemetry.totals.inputTokens).toBe(11120 * 4);
    // 没给 usage 的那一次三个字段都不在，绝不补 0
    const withoutUsage = telemetry.llmCalls[2];
    expect(Object.keys(withoutUsage)).not.toContain("inputTokens");
    expect(Object.keys(withoutUsage)).not.toContain("outputTokens");
    expect(Object.keys(withoutUsage)).not.toContain("totalTokens");
  });

  it("Provider 一次都没给 usage：三个键不出现，调用次数照实（§24）", async () => {
    withTmpDir();
    withFakeTransport(happyScript());
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    // 「调了 5 次但一次都没拿到 usage」与「一次都没调」在读起来是两件事
    expect(telemetry.totals.llmCalls).toBe(5);
    expect(telemetry.totals.usageSampleCount).toBe(0);
    // 三个键整个不出现：既不是 0，也不是一个装出来的 null
    expect(Object.keys(telemetry.totals)).not.toContain("inputTokens");
    expect(Object.keys(telemetry.totals)).not.toContain("outputTokens");
    expect(Object.keys(telemetry.totals)).not.toContain("totalTokens");
  });

  it("Provider 给了金额与币种才落 cost；缺一个都不记（§8）", async () => {
    withTmpDir();
    const script = happyScript();
    script[0] = { content: PLAN_REPLY, cost: { amount: 0.0021, currency: "USD" } };
    script[1] = { content: BEAT_VALIDATION_REPLY, cost: { amount: 0.0042 } }; // 缺币种
    script[2] = { content: SAMPLE_STORY };
    withFakeTransport(script);
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const telemetry = telemetryOf(result.run_id);

    expect(telemetry.llmCalls[0].cost).toEqual({ amount: 0.0021, currency: "USD" });
    expect(Object.keys(telemetry.llmCalls[1])).not.toContain("cost");
    expect(Object.keys(telemetry.llmCalls[2])).not.toContain("cost");
  });
});

// ---------------------------------------------------------------------------
// §41 / §42 Secret 与异常安全
// ---------------------------------------------------------------------------

describe("§41/§42 telemetry.json 不落密钥，也不落异常原文", () => {
  it("密钥与 Authorization 一个字都不进 telemetry.json", async () => {
    withTmpDir();
    withFakeTransport(happyScript({ usage: USAGE_REPLY }));
    vi.stubEnv("LLM_API_KEY", "super-secret");
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());

    const result = await pipeline.run(SAMPLE_CONFIG);
    const text = telemetryText(result.run_id);

    // 环境里的密钥与请求头都不在产物里——客户端只把它们放进 Authorization 头
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("Authorization");
    // 客户端自己的假密钥与 baseUrl 同样一个字符都不出现
    expect(text).not.toContain("sk-fake-key");
    expect(text).not.toContain("fake.invalid");
  });

  it("异常里的地址与 token 不原样落盘，只留稳定错误码（§42）", async () => {
    withTmpDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed: https://user:pass@example.com/v1/chat?token=abc")),
    );
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy({ max_attempts: 1 }));

    const err = await pipeline.run(SAMPLE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineError);

    const runId = (err as PipelineError).runId;
    const text = telemetryText(runId);
    expect(text).not.toContain("user:pass");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("example.com");
    // 丢掉的只是上下文，错误码照实
    const telemetry = telemetryOf(runId);
    expect(telemetry.failureCode).toBe("LLM_REQUEST_FAILED");
    expect(stageOf(telemetry, "planning")?.errorCode).toBe("LLM_REQUEST_FAILED");
  });

  it("超时归 LLM_TIMEOUT，不是笼统的失败（§22）", async () => {
    withTmpDir();
    // 浏览器语义的超时异常：AbortSignal.timeout 的真实形状
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy({ max_attempts: 1 }));

    const err = await pipeline.run(SAMPLE_CONFIG).catch((e: unknown) => e);
    const telemetry = telemetryOf((err as PipelineError).runId);
    expect(telemetry.failureCode).toBe("LLM_TIMEOUT");
    expect(stageOf(telemetry, "planning")?.errorCode).toBe("LLM_TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// §43 旧 Run
// ---------------------------------------------------------------------------

describe("§43 旧 Run：没有 telemetry.json 也照常读", () => {
  it("读接口三层降级：缺文件 / JSON 坏 / 形状不对都是 null，不 500", () => {
    const store = new ArtifactStore();
    // 第一层：这个 run 根本不存在
    expect(store.readRunTelemetry("no-such-run")).toBeNull();
  });

  it("Run Detail 给旧 Run 一个 telemetry: null，其余字段一个不少", async () => {
    withTmpDir();
    withFakeTransport(happyScript());
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());
    const result = await pipeline.run(SAMPLE_CONFIG);

    const store = new ArtifactStore();
    // 手工模拟「1.8.0 之前生成的 Run」：把 telemetry.json 拿走
    rmSync(join("runs", result.run_id, "telemetry.json"));
    expect(store.readRunTelemetry(result.run_id)).toBeNull();
    // 别的产物一点没受影响
    expect(store.readRunManifest(result.run_id)).not.toBeNull();
    expect(store.readFinalStory(result.run_id)).toContain("陈岚推开派出所的玻璃门");
  });

  it("被手改坏的遥测归一成 null，不把坏形状当数据摆出去", async () => {
    withTmpDir();
    withFakeTransport(happyScript());
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());
    const result = await pipeline.run(SAMPLE_CONFIG);

    // 第二层：JSON 本身坏了
    writeFileSync(join("runs", result.run_id, "telemetry.json"), "{ 不是 JSON");
    expect(new ArtifactStore().readRunTelemetry(result.run_id)).toBeNull();
    // 第三层：JSON 好好的但形状不对（schemaVersion 不是这一版的）
    writeFileSync(
      join("runs", result.run_id, "telemetry.json"),
      JSON.stringify({ schemaVersion: "99", runId: "x", status: "completed", stages: [], llmCalls: [], attempts: [], repairs: [], totals: {} }),
    );
    expect(new ArtifactStore().readRunTelemetry(result.run_id)).toBeNull();
    // 归一成 null 之后，界面整段不展示，而不是摆一排 0
    expect(telemetryPanelState(new ArtifactStore().readRunTelemetry(result.run_id)).kind).toBe("hidden");
  });

  it("界面把「没有遥测」显示成不展示，而不是一排 0", () => {
    expect(telemetryPanelState(null).kind).toBe("hidden");
    expect(telemetryPanelState(undefined).kind).toBe("hidden");
    // runId 都读不到的也不展示
    expect(telemetryPanelState({ runId: "" } as never).kind).toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
// §44 实验样本
// ---------------------------------------------------------------------------

describe("§44 实验样本：每个子 Run 都有自己的 telemetry.json", () => {
  it("两个变体各跑一条，每条都有自己的遥测，实验状态不受影响", async () => {
    withTmpDir();
    // 不注入 llm：让 buildPipeline 把这一条样本的采集器接到真客户端上，
    // 于是「调了几次模型」数的是真实调用。baseUrl 来自受信配置，不走请求体那道关卡。
    vi.stubEnv("LLM_BASE_URL", "https://fake.invalid/v1");
    vi.stubEnv("LLM_API_KEY", "sk-fake-key-not-a-secret");
    withFakeTransport([...fixedScript(), ...fixedScript()]);

    const store = new ExperimentStore("runs");
    const definition = {
      schemaVersion: "1",
      experimentId: "exp-telemetry",
      name: "遥测落盘",
      base: {
        storyConfig: SAMPLE_CONFIG,
        beatPlanMode: "fixed",
        beatPlan: SAMPLE_BEAT_PLAN,
      },
      variants: [
        { id: "v-base", name: "基准" },
        { id: "v-hot", name: "高温", overrides: { generation: { temperature: 1.4 } } },
      ],
      repetitions: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
    };
    store.createExperimentDirectory("exp-telemetry");
    store.putDefinition("exp-telemetry", definition as unknown as ExperimentDefinition);

    const result = await new ExperimentRunner({ artifactStore: new ArtifactStore("runs") }).run(
      store.readDefinition("exp-telemetry") as ExperimentDefinition,
    );

    expect(result.status).toBe("completed");
    expect(result.runs).toHaveLength(2);

    for (const reference of result.runs) {
      const telemetry = new ArtifactStore("runs").readRunTelemetry(reference.runId);
      expect(telemetry, reference.runId).not.toBeNull();
      expect(telemetry?.status).toBe("completed");
      expect(telemetry?.runId).toBe(reference.runId);
      expect(telemetry?.totals.llmCalls).toBe(4); // 骨架校验 + 正文 + 结构审阅 + 商业审阅
      expect(telemetry?.stages.map((s) => s.stage)).toContain("generating");
      expect(telemetry?.llmCalls.map((c) => c.stage)).toContain("validating_beat_plan");
      // 实验出身不改变遥测内容：只记执行过程，不记这一格是哪个变体
      expect(JSON.stringify(telemetry)).not.toContain("exp-telemetry");
    }
    // 两个变体各自的 runId 不重复
    expect(new Set(result.runs.map((r) => r.runId)).size).toBe(2);
  });

  it("一条样本失败了，实验是 partial，那条的遥测只记失败发生在哪一步", async () => {
    withTmpDir();
    vi.stubEnv("LLM_BASE_URL", "https://fake.invalid/v1");
    vi.stubEnv("LLM_API_KEY", "sk-fake-key-not-a-secret");
    // 第一条顺利，第二条连骨架校验都调不动（脚本用完重复最后一格，后面全失败）
    withFakeTransport([...fixedScript(), new Error("boom")]);

    const store = new ExperimentStore("runs");
    const definition = {
      schemaVersion: "1",
      experimentId: "exp-telemetry-fail",
      name: "有一条挂了",
      base: {
        storyConfig: SAMPLE_CONFIG,
        beatPlanMode: "fixed",
        beatPlan: SAMPLE_BEAT_PLAN,
      },
      variants: [
        { id: "v-ok", name: "没事" },
        { id: "v-bad", name: "有事" },
      ],
      repetitions: 1,
      createdAt: "2026-09-26T00:00:00.000Z",
    };
    store.createExperimentDirectory("exp-telemetry-fail");
    store.putDefinition("exp-telemetry-fail", definition as unknown as ExperimentDefinition);

    const result = await new ExperimentRunner({ artifactStore: new ArtifactStore("runs") }).run(
      store.readDefinition("exp-telemetry-fail") as ExperimentDefinition,
    );

    expect(result.status).toBe("partial");
    expect(result.runs).toHaveLength(2);
    const failed = result.runs.find((r) => r.status === "failed");
    expect(failed).toBeDefined();
    const telemetry = new ArtifactStore("runs").readRunTelemetry(failed!.runId);
    expect(telemetry?.status).toBe("failed");
    // 失败定位到步骤，不定位到原因：Plan 之后一步都没走出去
    expect(telemetry?.failureStage).toBe("generating");
    expect(telemetry?.failureCode).toBe("LLM_REQUEST_FAILED");
    // 前面那条样本的遥测没被这次失败污染
    const ok = result.runs.find((r) => r.status === "completed");
    expect(new ArtifactStore("runs").readRunTelemetry(ok!.runId)?.status).toBe("completed");
  });

  it("一条样本的遥测缺了，只影响那一条的分母，不当 0", () => {
    const store = new ArtifactStore();
    const withTelemetry: RunTelemetry = {
      schemaVersion: "1",
      runId: "run-with",
      startedAt: "2026-09-26T00:00:00.000Z",
      completedAt: "2026-09-26T00:01:00.000Z",
      durationMs: 60000,
      status: "completed",
      stages: [],
      llmCalls: [],
      attempts: [],
      repairs: [],
      totals: {
        durationMs: 60000,
        llmCalls: 3,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageSampleCount: 0,
        retries: 1,
        repairs: 0,
        failedStages: 0,
      },
    };
    const readSpy = vi.spyOn(store, "readRunTelemetry");
    readSpy.mockImplementation((runId: string) => (runId === "run-with" ? withTelemetry : null));

    const rows = summarizeExperiment(
      {
        schemaVersion: "1",
        experimentId: "exp",
        name: "n",
        base: {
          storyConfig: SAMPLE_CONFIG,
          beatPlanMode: "fixed",
          beatPlan: SAMPLE_BEAT_PLAN,
        },
        variants: [{ id: "v", name: "基准" }],
        repetitions: 2,
        createdAt: "2026-09-26T00:00:00.000Z",
      } as unknown as ExperimentDefinition,
      [
        { variantId: "v", repetition: 1, runId: "run-with", status: "completed" },
        { variantId: "v", repetition: 2, runId: "run-legacy", status: "completed" },
      ],
      store,
    );
    readSpy.mockRestore();

    const efficiency = rows[0].efficiency;
    // 分母是 1 而不是 2：那条没有遥测的样本不进平均值，也不当 0
    expect(efficiency.durationMs).toEqual({ mean: 60000, sampleCount: 1 });
    expect(efficiency.llmCalls).toEqual({ mean: 3, sampleCount: 1 });
    expect(efficiency.retries).toEqual({ mean: 1, sampleCount: 1 });
    // 一项 usage 都没有的样本：token 均值是 null、样本数 0
    expect(efficiency.totalTokens).toEqual({ mean: null, sampleCount: 0 });
    // 没有赢家字段：分组行里只有计数、均值、效率、失败类别分布与 id
    expect(Object.keys(rows[0]).sort()).toEqual([
      "efficiency",
      "failureCount",
      "failures",
      "meanCausality",
      "meanCharacter",
      "meanCoherence",
      "meanCommercialScore",
      "meanEngagement",
      "meanHook",
      "meanNarrative",
      "meanOverallScore",
      "meanPacing",
      "meanPayoff",
      "runCount",
      "successCount",
      "variantId",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 采集器自身的行为
// ---------------------------------------------------------------------------

describe("TelemetryCollector 自身", () => {
  it("没有开着的阶段时不给调用编一个阶段名", () => {
    const collector = new TelemetryCollector("run-1");
    collector.recordLLMCall({
      model: "m",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      status: "completed",
    });
    const telemetry = collector.finish("completed");
    // 宁可少记一条，也不编一个阶段归属
    expect(telemetry.llmCalls).toHaveLength(0);
    expect(telemetry.status).toBe("completed");
    expect(telemetry.totals.retries).toBe(0);
  });

  it("收尾之后不再接收任何记录", () => {
    const collector = new TelemetryCollector("run-2");
    collector.enter("planning");
    const telemetry = collector.finish("completed");
    collector.enter("reviewing");
    collector.skip("reviewing");
    collector.beginAttempt(2);
    collector.recordLLMCall({
      model: "m",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      status: "completed",
    });
    expect(collector.currentStage()).toBeNull();
    // 已经交出去的那一份不受后续影响
    expect(telemetry.stages.map((s) => s.stage)).toEqual(["planning"]);
    expect(telemetry.llmCalls).toHaveLength(0);
    expect(telemetry.attempts).toHaveLength(0);
  });

  it("错误码之外的失败信息一个字都不收", () => {
    const collector = new TelemetryCollector("run-3");
    collector.enter("generating");
    collector.failOpen("GENERATION_FAILED");
    const telemetry = collector.finish("failed", { stage: "generating", code: "GENERATION_FAILED" });
    const stage = telemetry.stages[0];
    expect(stage.status).toBe("failed");
    expect(stage.errorCode).toBe("GENERATION_FAILED");
    expect(Object.keys(stage).sort()).toEqual([
      "completedAt",
      "durationMs",
      "errorCode",
      "stage",
      "startedAt",
      "status",
    ]);
  });

  it("阶段名不认识时记不进去", () => {
    const collector = new TelemetryCollector("run-4");
    collector.enter("completed" as never);
    const telemetry = collector.finish("completed");
    expect(telemetry.stages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 界面推导
// ---------------------------------------------------------------------------

describe("遥测界面推导", () => {
  const telemetry: RunTelemetry = {
    schemaVersion: "1",
    runId: "run-ui",
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:01:00.000Z",
    durationMs: 42400,
    status: "failed",
    failureStage: "generating",
    failureCode: "LLM_TIMEOUT",
    stages: [
      {
        stage: "planning",
        status: "completed",
        startedAt: "2026-09-26T00:00:00.000Z",
        completedAt: "2026-09-26T00:00:10.000Z",
        durationMs: 10000,
      },
      {
        stage: "generating",
        status: "failed",
        startedAt: "2026-09-26T00:00:10.000Z",
        completedAt: "2026-09-26T00:00:54.000Z",
        durationMs: 44000,
        errorCode: "LLM_TIMEOUT",
      },
      { stage: "reviewing", status: "skipped", attemptNumber: 1 },
    ],
    llmCalls: [
      {
        id: "call-001",
        stage: "planning",
        model: "m",
        status: "completed",
        startedAt: "2026-09-26T00:00:00.000Z",
        durationMs: 10000,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      {
        id: "call-002",
        stage: "generating",
        model: "m",
        status: "failed",
        startedAt: "2026-09-26T00:00:10.000Z",
        durationMs: 44000,
        errorCode: "LLM_TIMEOUT",
      },
    ],
    attempts: [
      {
        attemptId: "attempt-01",
        index: 1,
        status: "retried",
        durationMs: 30000,
        generationCalls: 1,
        reviewCalls: 1,
        commercialReviewCalls: 0,
        repairCount: 2,
      },
    ],
    repairs: [],
    totals: {
      durationMs: 42400,
      llmCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      usageSampleCount: 1,
      retries: 0,
      repairs: 0,
      failedStages: 1,
    },
  };

  it("七个总量齐了，取不到的显示 — 而不是 0", () => {
    const state = telemetryPanelState(telemetry);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    const byKey = new Map(state.summary.map((row) => [row.key, row.value]));
    expect(byKey.get("duration")).toBe("42.4 s");
    expect(byKey.get("llm_calls")).toBe("2");
    expect(byKey.get("retries")).toBe("0");
    // token 行带上分母：2 次调用里只有 1 次拿到 usage
    expect(byKey.get("tokens")).toBe("in 100 · out 50 · total 150 · 样本 1/2");
    // 没有价格信息时成本这一行整个不出现
    expect(byKey.has("cost")).toBe(false);
  });

  it("usage 一次都没拿到时 token 行说清楚是没数据，不是 0", () => {
    const state = telemetryPanelState({
      ...telemetry,
      status: "completed",
      totals: {
        ...telemetry.totals,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageSampleCount: 0,
      },
    });
    if (state.kind !== "ready") throw new Error("unreachable");
    const tokens = state.summary.find((row) => row.key === "tokens");
    expect(tokens?.value).toBe("—（Provider 未返回 usage）");
    expect(tokens?.unknown).toBe(true);
    // 调用次数照实：没有 usage 不代表没有调用
    expect(state.summary.find((row) => row.key === "llm_calls")?.value).toBe("2");  });

  it("失败 Run 摆出失败阶段，成功 Run 整段不渲染", () => {
    const failed = telemetryPanelState(telemetry);
    expect(failed.kind === "ready" && failed.failure).toEqual({
      stageText: "Writing",
      codeText: "模型调用超时",
    });
    const ok = telemetryPanelState({
      ...telemetry,
      status: "completed",
      failureStage: undefined,
      failureCode: undefined,
    });
    expect(ok.kind === "ready" && ok.failure).toBeNull();
  });

  it("阶段时间线按发生顺序，条宽相对最慢的那一条", () => {
    const state = telemetryPanelState(telemetry);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.stages.map((s) => s.stage)).toEqual(["planning", "generating", "reviewing"]);
    expect(state.stages.map((s) => s.percent)).toEqual([23, 100, 0]);
    expect(state.stages[0].statusText).toBe("completed");
    expect(state.stages[1].statusText).toBe("failed");
    expect(state.stages[1].errorText).toBe("模型调用超时");
    expect(state.stages[1].errorCode).toBe("LLM_TIMEOUT");
    expect(state.stages[1].durationText).toBe("44.0 s");
    // skipped 与 failed 是两件事
    expect(state.stages[2].statusText).toBe("skipped");
    expect(state.stages[2].durationText).toBe("—");
    expect(state.stages[2].attemptLabel).toBe("Attempt 1");
  });

  it("模型调用表里没有 usage 的那次显示 —", () => {
    const state = telemetryPanelState(telemetry);
    if (state.kind !== "ready") throw new Error("unreachable");
    expect(state.calls[0].inputText).toBe("100");
    expect(state.calls[0].outputText).toBe("50");
    expect(state.calls[0].stageLabel).toBe("Planning");
    expect(state.calls[1].inputText).toBe("—");
    expect(state.calls[1].status).toBe("failed");
    expect(state.calls[1].hasCost).toBe(false);
  });

  it("阶段名有固定展示名", () => {
    expect(stageLabel("planning")).toBe("Planning");
    expect(stageLabel("reviewing_commercial")).toBe("Commercial review");
    expect(stageLabel("artifact_promotion")).toBe("Artifact promotion");
  });
});

// ---------------------------------------------------------------------------
// 落盘后的自洽
// ---------------------------------------------------------------------------

describe("落盘的遥测与 metadata 摘要同源", () => {
  it("metadata 的两个摘要数就是 telemetry.totals 的转述", async () => {
    withTmpDir();
    withFakeTransport(happyScript({ usage: USAGE_REPLY }));
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy());
    const result = await pipeline.run(SAMPLE_CONFIG);

    const meta = JSON.parse(
      readFileSync(join("runs", result.run_id, "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    const telemetry = telemetryOf(result.run_id);
    expect(meta.duration_ms).toBe(telemetry.totals.durationMs);
    expect(meta.llm_call_count).toBe(telemetry.totals.llmCalls);
  });

  it("失败的 Run 也写遥测，metadata 摘要照样有数", async () => {
    withTmpDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const pipeline = fullPipeline(new ArtifactStore(), new TelemetryCollector(), policy({ max_attempts: 1 }));

    const err = await pipeline.run(SAMPLE_CONFIG).catch((e: unknown) => e);
    const runId = (err as PipelineError).runId;
    const meta = JSON.parse(readFileSync(join("runs", runId, "metadata.json"), "utf8")) as Record<string, unknown>;
    expect(meta.status).toBe("failed");
    // 跑了一次 Plan 就挂了：调用数是 1，不是 0，也不是 null
    expect(meta.llm_call_count).toBe(1);
    expect(typeof meta.duration_ms).toBe("number");
    // 遥测文件本身在失败路径上就已经写好了
    expect(telemetryOf(runId).status).toBe("failed");
  });
});
