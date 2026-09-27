/**
 * v2.3.0 BenchmarkRunner（TASK §40/§41/§44/§45/§46）。
 *
 * 这个文件盯四件事：
 *   1. **预检在第一个 LLM 请求之前**：Suite 不合法、骨架不存在、提示词缺、模型没配、
 *      样本数超线——每一种都让执行在花钱之前就失败（§40/§46）。
 *   2. **每个样本都是普通 Run**：cases × repetitions 次展开，每条样本有自己的 runId
 *      与产物目录，出处写进自己的 run-manifest.json（§22）。
 *   3. **一条样本失败不拖垮其余样本**：partial 而不是 failed，失败样本的指标是 null
 *      而不是 0（§45/§30）。
 *   4. **跑完之后什么都不改**：终态执行在存储层就不可变（§37），默认模型、提示词、
 *      温度一个都没动（§81）。
 *
 * 与实验执行器测试同一条铁律：只注入假 LLM，绝不调用真实付费端点。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  type BenchmarkEnvironment,
  type BenchmarkRunnerDeps,
} from "@/analysis/benchmark-runner";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { BenchmarkStore, BenchmarkWriteError } from "@/infrastructure/storage/benchmark-store";
import { LLMError } from "@/infrastructure/llm/openai-compatible-llm-client";
import {
  BENCHMARK_RUN_LIMIT,
  BenchmarkStateError,
  BenchmarkValidationError,
  benchmarkSampleCount,
  benchmarkSuiteOf,
  validateBenchmarkSuite,
  type BenchmarkSuite,
} from "@/domain/benchmark-suite";
import { benchmarkMetricKeys, type BenchmarkMetricKey } from "@/domain/benchmark-metric";
import type { BenchmarkAggregate, BenchmarkExecution } from "@/domain/benchmark-result";
import { buildPipeline } from "@/application/generate-service";
import { repoRoot, repoVersion, SAMPLE_BEAT_PLAN, SAMPLE_CONFIG, withTmpDir } from "./helpers/fixtures";
import type { Logger } from "@/ports/logger";
import type { LLMClient } from "@/ports/llm-client";

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

const SILENT_LOGGER: Logger = { debug: () => {}, info: () => {}, warning: () => {}, error: () => {} };

/** 全 22 个指标都参与：这张表与注册表同源，测试不自己列一遍。 */
const METRICS = benchmarkMetricKeys();
const METRIC_KEYS = [...METRICS] as BenchmarkMetricKey[];

/** 四条样本的审阅分：全部高于 min_review_score(70)，不触发重试与修订。 */
const SCORES = [90, 84, 78, 76];

/** 远超长度下限、带主角名、以句号结尾，可通过全部硬规则。 */
function storyOf(protagonist: string): string {
  return `${protagonist}推开那扇门，${"雨水顺着屋檐砸在台阶上。".repeat(120)}`;
}
const STORY = storyOf("陈岚");

const BEAT_VALIDATION = JSON.stringify({
  passed: true,
  diagnostics: [],
  summary: "骨架结构完整：开场、高潮都有。",
});

/** 结构审阅：四维同分，确定性均分正好等于 score。 */
function review(score: number): string {
  const dimensions: Record<string, unknown> = {};
  for (const key of ["coherence", "narrative", "character", "causality"]) {
    dimensions[key] = { score, summary: "总结。", strengths: ["强"], problems: [] };
  }
  return JSON.stringify({ dimensions, diagnostics: [], summary: "总结。" });
}

/** 商业可读性：四个维度同分，score > min_review_score(70)，不触发重试。 */
function commercial(score: number): string {
  const dimensions: Record<string, unknown> = {};
  for (const key of ["hook", "pacing", "engagement", "payoff"]) {
    dimensions[key] = { score, summary: "一句。", strengths: [], problems: [] };
  }
  return JSON.stringify({ score, summary: "开篇即冲突。", dimensions });
}

/** 一条样本的剧本：骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
function sampleScript(story: string, score: number): string[] {
  return [BEAT_VALIDATION, story, review(score), commercial(score)];
}

function fixedScript(score: number): string[] {
  return sampleScript(STORY, score);
}

/**
 * 顺序假模型：脚本用完重复最后一格。
 * 同时记下每次请求——预检测试要断言「一个请求都没发生」，靠的就是这个。
 */
function scriptedLLM(script: Array<string | Error>) {
  const seen: Array<{ prompt: string; temperature: number }> = [];
  let index = 0;
  return {
    seen,
    get calls(): number {
      return seen.length;
    },
    async generate(prompt: string, temperature = 0.8): Promise<string> {
      seen.push({ prompt, temperature });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

/** 确定性执行 id：测试要知道 benchmarkId 是什么，才能比对 Manifest 里的出处。 */
function testEnvironment(): BenchmarkEnvironment {
  let count = 0;
  return {
    newBenchmarkId: () => `bmk-test-${String((count += 1)).padStart(4, "0")}`,
    suiteDigest: () => "suite-digest-0123456789abcdef",
    protocolDigest: () => "protocol-digest-0123456789abcdef",
    projectVersion: () => "9.9.9",
    commit: () => null,
  };
}

/** 预检用的占位模型：它一次都不该被调用（真被调用直接抛，测试当场就能发现）。 */
const STUB_LLM: LLMClient = {
  async generate(): Promise<string> {
    throw new Error("预检阶段不该发生任何 LLM 请求");
  },
};

interface DepsOverrides {
  /** 不注入 llm 时就按「服务端没配」处理，方便测 §46 的 fail-closed。 */
  llm?: LLMClient;
  providerProbe?: () => boolean;
  promptProbe?: () => string[];
}

function benchmarkDeps(overrides: DepsOverrides = {}): BenchmarkRunnerDeps {
  // `in` 而不是 `??`：显式传 undefined 表示「服务端没配模型」，不能回退到占位模型
  const llm: LLMClient | undefined = "llm" in overrides ? overrides.llm : STUB_LLM;
  return {
    artifactStore: new ArtifactStore("runs"),
    benchmarkStore: new BenchmarkStore("runs"),
    environment: testEnvironment(),
    providerProbe: overrides.providerProbe ?? (() => true),
    promptProbe: overrides.promptProbe ?? (() => []),
    logger: SILENT_LOGGER,
    generate: buildPipeline,
    llm,
  };
}

// ---------------------------------------------------------------------------
// Suite 构造（不入库，只活在测试里）
// ---------------------------------------------------------------------------

function caseOf(id: string, genre: string, mode: "fixed" | "regenerate" = "fixed", tags?: string[]) {
  return {
    id,
    title: `题 ${id}`,
    genre,
    storyConfig: SAMPLE_CONFIG,
    beatPlanMode: mode,
    ...(mode === "fixed" ? { beatPlanRef: `cases/${id}/beat-plan.json` } : {}),
    ...(tags ? { tags } : {}),
  };
}

/** 一份最小可用题库：两道固定骨架题，协议跑 2 次。 */
function suiteRaw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "runner-suite",
    version: "1.0.0",
    name: "Runner 测试题库",
    description: "只在测试里存在的题库，不入库。",
    cases: [
      caseOf("case-a", "悬疑", "fixed", ["悬疑", "短篇"]),
      caseOf("case-b", "豪门", "fixed", ["豪门"]),
    ],
    protocol: {
      repetitions: 2,
      plannerMode: "normal",
      acceptedMetrics: [...METRICS],
      failureHandling: "include",
      passThreshold: 71,
    },
    source: { origin: "original", license: "CC0-1.0", note: "测试代码现场构造，不入库。" },
    createdAt: "2026-09-28",
    ...patch,
  };
}

/** 把题库与固定骨架写进临时目录的 benchmarks/，再原样读回来（读回来的才是 Runner 用的）。 */
function seedSuite(dir: string, raw: Record<string, unknown>): BenchmarkSuite {
  const suite = validateBenchmarkSuite(raw, METRICS);
  const valid = suite as BenchmarkSuite;
  const store = new BenchmarkStore("runs");
  store.putSuite(valid);
  for (const item of valid.cases) {
    if (item.beatPlanMode !== "fixed" || !item.beatPlanRef) continue;
    const path = join(dir, "benchmarks", "suites", valid.id, valid.version, item.beatPlanRef);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(SAMPLE_BEAT_PLAN, null, 2), "utf8");
  }
  const read = store.readSuite(valid.id, valid.version);
  expect(read, "写进去的题库要能读回来").not.toBeNull();
  return read as BenchmarkSuite;
}

function readJsonArray(dir: string, path: string): unknown[] {
  return JSON.parse(readFileSync(join(dir, path), "utf8")) as unknown[];
}

// ---------------------------------------------------------------------------
// 预检（§40/§46）
// ---------------------------------------------------------------------------

describe("BenchmarkRunner — 预检在第一个请求之前", () => {
  it("模型没配：一次 LLM 请求都不发生，执行目录也不建", async () => {
    const dir = withTmpDir();
    const suite = seedSuite(dir, suiteRaw());
    const runner = new BenchmarkRunner(benchmarkDeps({ llm: undefined, providerProbe: () => false }));

    const err = await runner.run(suite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkValidationError);
    expect((err as Error).message).toContain("LLM_API_KEY");
    // 一次付费调用都没发生：连执行目录都没建出来
    expect(existsSync(join(dir, "benchmarks", "executions"))).toBe(false);
  });

  it("服务端探针说配了：没注入客户端也放行（预检返回样本数）", () => {
    const dir = withTmpDir();
    const suite = seedSuite(dir, suiteRaw());
    const runner = new BenchmarkRunner(benchmarkDeps({ llm: undefined, providerProbe: () => true }));
    expect(runner.preflight(suite, {})).toEqual({ plannedSamples: 4 });
  });

  it("Suite 读回来校验不过：拒绝执行（磁盘上的文件可能被手改坏）", async () => {
    withTmpDir();
    const broken = suiteRaw();
    const first = (broken.cases as Array<Record<string, unknown>>)[0];
    // 克隆一份再改：SAMPLE_CONFIG 是共享的测试夹具，改了会污染后面的测试
    first.storyConfig = { ...SAMPLE_CONFIG };
    delete (first.storyConfig as Record<string, unknown>).premise;
    const runner = new BenchmarkRunner(benchmarkDeps());

    const err = await runner.run(broken as unknown as BenchmarkSuite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkValidationError);
    expect((err as Error).message).toContain("校验不过");
  });

  it("重复 case id：Suite 校验阶段就挡住，一次执行都不落下", async () => {
    withTmpDir();
    const raw = suiteRaw();
    raw.cases = [caseOf("dup", "悬疑"), caseOf("dup", "豪门")];
    // §10：case id 必须稳定且唯一——校验器先说话，Runner 里那道显式检查是防并发改文件的第二道
    expect(() => validateBenchmarkSuite(raw, METRICS)).toThrow(/重复/);
    const runner = new BenchmarkRunner(benchmarkDeps());

    const err = await runner.run(raw as unknown as BenchmarkSuite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkValidationError);
    expect(existsSync(join(process.cwd(), "benchmarks", "executions"))).toBe(false);
  });

  it("固定骨架不在盘上：拒绝执行，消息说得出是哪道题", async () => {
    const dir = withTmpDir();
    const suite = seedSuite(dir, suiteRaw());
    const store = new BenchmarkStore("runs");
    const broken = {
      ...suite,
      cases: suite.cases.map((item, index) =>
        index === 0 ? { ...item, beatPlanRef: "cases/case-a/not-here.json" } : item,
      ),
    } as BenchmarkSuite;
    const runner = new BenchmarkRunner(benchmarkDeps());
    const err = await runner.run(broken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkValidationError);
    expect((err as Error).message).toContain("case-a");
    // 真正的那份骨架在盘上：拒绝的是坏引用，不是存储坏了
    expect(store.readBeatPlan(suite.id, suite.version, "cases/case-a/beat-plan.json")).not.toBeNull();
  });

  it("提示词登记不全：拒绝执行，消息列出缺的角色", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const runner = new BenchmarkRunner(benchmarkDeps({ promptProbe: () => ["beat_planner", "story"] }));
    const err = await runner.run(suite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkValidationError);
    expect((err as Error).message).toContain("beat_planner");
  });

  it("样本数超过确认线又不给确认：一次调用都不发生", async () => {
    withTmpDir();
    // 16 题 × 2 次 = 32 > 30
    const raw = suiteRaw();
    raw.cases = Array.from({ length: BENCHMARK_RUN_LIMIT.confirmAbove / 2 + 1 }, (_, i) =>
      caseOf(`bulk-${String(i + 1).padStart(2, "0")}`, "悬疑", "regenerate"),
    );
    const suite = benchmarkSuiteOf(raw, METRICS) as BenchmarkSuite;
    expect(benchmarkSampleCount(suite)).toBeGreaterThan(BENCHMARK_RUN_LIMIT.confirmAbove);
    const llm = scriptedLLM(fixedScript(90));
    const runner = new BenchmarkRunner(benchmarkDeps({ llm }));

    const err = await runner.run(suite).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkStateError);
    expect((err as Error).message).toContain("allowLargeBenchmark");
    expect(llm.calls).toBe(0);
  });

  it("样本数超过硬上限：给了确认也拒绝", async () => {
    withTmpDir();
    // 41 题 × 5 次 = 205 > 200
    const raw = suiteRaw();
    raw.cases = Array.from({ length: 41 }, (_, i) =>
      caseOf(`hard-${String(i + 1).padStart(2, "0")}`, "悬疑", "regenerate"),
    );
    (raw.protocol as Record<string, unknown>).repetitions = 5;
    const suite = benchmarkSuiteOf(raw, METRICS) as BenchmarkSuite;
    expect(benchmarkSampleCount(suite)).toBeGreaterThan(BENCHMARK_RUN_LIMIT.hard);
    const llm = scriptedLLM(fixedScript(90));
    const runner = new BenchmarkRunner(benchmarkDeps({ llm }));

    const err = await runner.run(suite, { allowLargeBenchmark: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkStateError);
    expect((err as Error).message).toContain(String(BENCHMARK_RUN_LIMIT.hard));
    expect(llm.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 完整执行（§41/§44）
// ---------------------------------------------------------------------------

describe("BenchmarkRunner — 完整执行", () => {
  it("2 题 × 2 次 = 4 个样本，status=completed，顺序恒定", async () => {
    const dir = withTmpDir();
    const suite = seedSuite(dir, suiteRaw());
    const llm = scriptedLLM(SCORES.flatMap((score) => fixedScript(score)));
    const runner = new BenchmarkRunner(benchmarkDeps({ llm }));

    const execution = await runner.run(suite, { label: "  2.3.0 发布前基线  " });
    expect(execution.status).toBe("completed");
    // 展开顺序恒定：Suite 声明顺序 × repetition 升序（§104）
    expect(execution.samples.map((s) => `${s.caseId}#${s.repetition}`)).toEqual([
      "case-a#1",
      "case-a#2",
      "case-b#1",
      "case-b#2",
    ]);
    // 每个样本是独立 Run：四个 runId 两两不同
    expect(new Set(execution.samples.map((s) => s.runId)).size).toBe(4);
    // 每个样本四次请求，共十六次
    expect(llm.calls).toBe(16);

    // 三件套都在，且 aggregate 的数字与样本一一对应
    for (const file of ["execution.json", "samples.json", "aggregate.json"]) {
      expect(existsSync(join(dir, "benchmarks", "executions", execution.id, file))).toBe(true);
    }
    const aggregate = execution.aggregate;
    expect(aggregate?.totalSamples).toBe(4);
    expect(aggregate?.completedSamples).toBe(4);
    expect(aggregate?.failedSamples).toBe(0);
    expect(aggregate?.metrics.overall_quality.mean).toBe(82);
    expect(aggregate?.metrics.overall_quality.min).toBe(76);
    expect(aggregate?.metrics.overall_quality.max).toBe(90);
    // §95 PASS 切线从 Suite 里读，不在代码里硬编码 71
    expect(aggregate?.pass).toEqual({ threshold: 71, passed: 4, failed: 0, unmeasured: 0 });
    // label 只是标签：去掉首尾空白照记，不参与任何判定（§94）
    expect(execution.snapshot.label).toBe("2.3.0 发布前基线");
  });

  it("每条样本把 benchmark 出身写进自己的 run-manifest.json", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const llm = scriptedLLM(SCORES.flatMap((score) => fixedScript(score)));
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);

    const store = new ArtifactStore("runs");
    const provenanceOf = (sample: { runId: string | null }) =>
      store.readRunManifest(sample.runId as string)?.benchmark ?? null;
    const expected = {
      benchmarkId: execution.id,
      suiteId: "runner-suite",
      suiteVersion: "1.0.0",
      suiteDigest: "suite-digest-0123456789abcdef",
    };
    expect(execution.samples.map(provenanceOf)).toEqual([
      { ...expected, caseId: "case-a", repetition: 1 },
      { ...expected, caseId: "case-a", repetition: 2 },
      { ...expected, caseId: "case-b", repetition: 1 },
      { ...expected, caseId: "case-b", repetition: 2 },
    ]);
    // Manifest 上没有别的出处块：Benchmark 样本不是实验样本，也不属于任何项目
    const manifest = store.readRunManifest(execution.samples[0].runId as string);
    expect(manifest?.experiment).toBeUndefined();
    expect(manifest?.workspace).toBeUndefined();
  });

  it("快照记的是第一条样本 Manifest 里的事实，不是服务端当前设置", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const llm = scriptedLLM(SCORES.flatMap((score) => fixedScript(score)));
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);

    const snapshot = execution.snapshot;
    expect(snapshot.models).not.toBeNull();
    expect(snapshot.prompts).not.toBeNull();
    expect(snapshot.parameters).not.toBeNull();
    expect(snapshot.caseIds).toEqual(["case-a", "case-b"]);
    expect(snapshot.repetitions).toBe(2);
    expect(snapshot.plannedSamples).toBe(4);
    expect(snapshot.suiteDigest).toBe("suite-digest-0123456789abcdef");
    expect(snapshot.protocolDigest).toBe("protocol-digest-0123456789abcdef");
    // §19：版本取的是那次运行 Manifest 里写下的，不是 environment 现报的 9.9.9
    expect(snapshot.projectVersion).toBe(repoVersion());
  });

  it("假模型不给 usage：token 与成本是 null，聚合里 count=0、mean=null，不是 0", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const llm = scriptedLLM(SCORES.flatMap((score) => fixedScript(score)));
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);

    for (const sample of execution.samples) {
      expect(sample.metrics.input_tokens).toBeNull();
      expect(sample.metrics.output_tokens).toBeNull();
      expect(sample.metrics.total_tokens).toBeNull();
      expect(sample.metrics.cost_amount).toBeNull();
    }
    expect(execution.aggregate?.metrics.total_tokens).toEqual({ count: 0, mean: null, min: null, max: null });
    expect(execution.aggregate?.metrics.cost_amount.mean).toBeNull();
    // §30 每个键都在：缺值与缺键是两种写法，读的人只有一种理解
    expect(Object.keys(execution.samples[0].metrics).sort()).toEqual([...METRIC_KEYS].sort());
  });
});

/** 临时目录（withTmpDir 已 chdir 进去）的绝对路径：写骨架文件要用。 */
function cwdBenchmarks(): string {
  return process.cwd();
}

// ---------------------------------------------------------------------------
// 部分失败（§45）
// ---------------------------------------------------------------------------

describe("BenchmarkRunner — 部分失败", () => {
  it("一个样本失败：status=partial，失败样本的 22 个指标全是 null", async () => {
    const dir = withTmpDir();
    const suite = seedSuite(dir, suiteRaw());
    // 脚本最后一格是错误：跑完之后每次调用都抛——这条样本的每一次正文生成都失败，
    // 于是 max_attempts 用完只能以 generating 阶段失败收尾（与实验执行器同一条造法）
    const llm = scriptedLLM([
      ...fixedScript(90),
      ...fixedScript(84),
      ...fixedScript(76),
      BEAT_VALIDATION,
      new LLMError("上游 502"),
    ]);
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);

    expect(execution.status).toBe("partial");
    expect(execution.samples.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "failed",
    ]);
    // 失败的样本没有指标体系被补 0：22 个键全是 null
    for (const key of METRIC_KEYS) {
      expect(execution.samples[3].metrics[key], key).toBeNull();
    }
    // 失败原因带阶段：定位到生成这一步，而不是一句「出错了」
    expect(String(execution.samples[3].failure)).toContain("generating");
    // 失败样本仍然建出了自己的 Run（产物没被删），失败分析在它自己的目录里
    expect(typeof execution.samples[3].runId).toBe("string");

    const aggregate = execution.aggregate;
    expect(aggregate?.completedSamples).toBe(3);
    expect(aggregate?.failedSamples).toBe(1);
    // failureHandling=include：失败样本的 0 进分母，(100+100+100+0)/4 = 75
    expect(aggregate?.metrics.failure_rate.mean).toBe(75);
    expect(aggregate?.pass).toEqual({ threshold: 71, passed: 3, failed: 0, unmeasured: 1 });
    // 跑一部分就在盘上留一部分：samples.json 记着四条，不是空白
    const samples = readJsonArray(dir, `benchmarks/executions/${execution.id}/samples.json`);
    expect(samples).toHaveLength(4);
  });

  it("一条都没跑成：status=failed", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const llm = scriptedLLM([BEAT_VALIDATION, new LLMError("上游 502")]);
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);

    expect(execution.status).toBe("failed");
    expect(execution.samples.every((s) => s.status === "failed")).toBe(true);
    expect(execution.aggregate?.completedSamples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 跑完之后什么都不改（§37/§81）
// ---------------------------------------------------------------------------

describe("BenchmarkRunner — 跑完之后什么都不改", () => {
  it("终态执行不可变：再写头 / 样本 / 汇总都拒绝", async () => {
    withTmpDir();
    const suite = seedSuite(cwdBenchmarks(), suiteRaw());
    const llm = scriptedLLM(SCORES.flatMap((score) => fixedScript(score)));
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(suite);
    expect(execution.status).toBe("completed");

    const store = new BenchmarkStore("runs");
    const rewritten: BenchmarkExecution = {
      ...execution,
      status: "partial",
      samples: [],
      aggregate: null,
    };
    const aggregate = execution.aggregate as BenchmarkAggregate;
    expect(() => store.putExecution(rewritten)).toThrow(BenchmarkWriteError);
    expect(() => store.putSamples(execution.id, [])).toThrow(BenchmarkWriteError);
    expect(() => store.putAggregate(execution.id, aggregate)).toThrow(BenchmarkWriteError);
    // 盘上那份没被改写：读回来还是 completed、四条样本、汇总还在
    const stored = store.readExecution(execution.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.samples).toHaveLength(4);
    expect(stored?.aggregate).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 入库的那一份种子 Suite 真的跑得动
// ---------------------------------------------------------------------------

describe("BenchmarkRunner — 仓库里那一份种子 Suite", () => {
  it("storyloop-core 1.0.0：3 题 × 2 次 = 6 个样本，分组来自题面元数据", async () => {
    const dir = withTmpDir();
    const suiteDir = join(repoRoot(), "benchmarks", "suites", "storyloop-core", "1.0.0");
    const target = join(dir, "benchmarks", "suites", "storyloop-core", "1.0.0");
    mkdirSync(join(target, ".."), { recursive: true });
    // 连同固定骨架一起复制过来：Runner 从盘上读它，不从仓库目录读
    cpSync(suiteDir, target, { recursive: true });

    const suite = benchmarkSuiteOf(
      JSON.parse(readFileSync(join(target, "suite.json"), "utf8")),
      METRICS,
    );
    expect(suite).not.toBeNull();
    const valid = suite as BenchmarkSuite;
    expect(benchmarkSampleCount(valid)).toBe(6);

    // 剧本按 Runner 的展开顺序排：先按题、再按重复（§104：case-a#1、case-a#2、case-b#1…）。
    // 顺序错一位，后面的样本就会拿别人的剧本，跑出来的数字全是假的。
    // regenerate 的题多一次 Planner 调用，fixed 的题直接用盘上那份骨架。
    const script: Array<string | Error> = [];
    for (const item of valid.cases) {
      const story = storyOf(item.storyConfig.protagonist?.name ?? "陈岚");
      for (let repetition = 1; repetition <= valid.protocol.repetitions; repetition += 1) {
        if (item.beatPlanMode === "regenerate") script.push(JSON.stringify(SAMPLE_BEAT_PLAN));
        script.push(...sampleScript(story, 80));
      }
    }
    const llm = scriptedLLM(script);
    const execution = await new BenchmarkRunner(benchmarkDeps({ llm })).run(valid);

    expect(execution.samples.map((s) => s.caseId)).toEqual([
      "suspense-001",
      "suspense-001",
      "rich-family-001",
      "rich-family-001",
      "reborn-fixed-001",
      "reborn-fixed-001",
    ]);
    expect(execution.samples.every((s) => s.status === "completed")).toBe(true);
    expect(new Set(execution.samples.map((s) => s.runId)).size).toBe(6);
    expect(execution.aggregate?.totalSamples).toBe(6);
    // §97/§98：分组键来自题面自己的 genre / tags，与成绩无关
    const byGenre = execution.aggregate?.byGenre ?? {};
    const byTag = execution.aggregate?.byTag ?? {};
    expect(Object.keys(byGenre).sort()).toEqual(["悬疑", "豪门", "重生"]);
    expect(byGenre["悬疑"]?.sampleCount).toBe(2);
    expect(byTag["短篇"]?.sampleCount).toBe(6);
    expect(byTag["固定骨架"]?.sampleCount).toBe(2);
    // 入库 Suite 的来源与许可原样读得回来（§112/§114）
    expect(new BenchmarkStore("runs").readSuite("storyloop-core", "1.0.0")?.source.license).toBe("CC0-1.0");
  });
});
