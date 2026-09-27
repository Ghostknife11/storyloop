/**
 * v2.3.0 BenchmarkStore（TASK §37/§38/§39/§67）。
 *
 * 这个文件替存储层把四件事钉住：
 *   1. **三件套都能原样读回来**。execution.json / samples.json / aggregate.json 分开写、
 *      读的时候合回来——samples.json 顶层是数组，读它不能走读对象的那条路（这里曾经
 *      默默地读不回样本表，这个测试就是那道防线）。
 *   2. **终态不可变**（§37）。跑到完成后任何再写入都拒绝，历史结果不许被覆盖。
 *   3. **路径 containment**。Suite id / 版本 / 固定骨架引用 / 执行 id 都能拼路径，
 *      越界的一律当不存在或直接拒写。
 *   4. **错误消息里只有相对文件名**（§67）。写失败时消息不带服务器绝对路径。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkStore, BenchmarkWriteError } from "@/infrastructure/storage/benchmark-store";
import { benchmarkSuiteOf } from "@/domain/benchmark-suite";
import { benchmarkMetricKeys, emptyMetricValues } from "@/domain/benchmark-metric";
import {
  BENCHMARK_EXECUTION_SCHEMA_VERSION,
  type BenchmarkExecution,
  type BenchmarkExecutionSnapshot,
  type BenchmarkExecutionStatus,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import { SAMPLE_BEAT_PLAN, SAMPLE_CONFIG, withTmpDir } from "./helpers/fixtures";

const METRICS = benchmarkMetricKeys();

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function suiteRaw(version: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "store-suite",
    version,
    name: "存储测试题库",
    cases: [
      {
        id: "case-a",
        title: "题 A",
        genre: "悬疑",
        storyConfig: SAMPLE_CONFIG,
        beatPlanMode: "fixed",
        beatPlanRef: "cases/case-a/beat-plan.json",
        tags: ["悬疑"],
      },
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
  };
}

/** 写一份 Suite 与它的固定骨架，返回读回来的那一份。 */
function seedSuite(version = "1.0.0") {
  const suite = benchmarkSuiteOf(suiteRaw(version), METRICS);
  expect(suite).not.toBeNull();
  const store = new BenchmarkStore("runs");
  store.putSuite(suite as never);
  const planPath = join(
    process.cwd(),
    "benchmarks",
    "suites",
    "store-suite",
    version,
    "cases/case-a/beat-plan.json",
  );
  mkdirSync(join(planPath, ".."), { recursive: true });
  writeFileSync(planPath, JSON.stringify(SAMPLE_BEAT_PLAN), "utf8");
  return { suite: suite as never, store };
}

function snapshotOf(): BenchmarkExecutionSnapshot {
  return {
    suiteId: "store-suite",
    suiteVersion: "1.0.0",
    suiteDigest: "digest",
    protocol: {
      repetitions: 2,
      plannerMode: "normal",
      acceptedMetrics: [...METRICS],
      failureHandling: "include",
      passThreshold: 71,
    },
    protocolDigest: "protocol-digest",
    projectVersion: "2.3.0",
    commit: null,
    models: null,
    prompts: null,
    parameters: null,
    caseIds: ["case-a"],
    repetitions: 2,
    plannedSamples: 2,
    label: null,
    startedAt: "2026-09-28T00:00:00.000Z",
  };
}

function executionOf(id: string, status: BenchmarkExecutionStatus = "running"): BenchmarkExecution {
  return {
    schemaVersion: BENCHMARK_EXECUTION_SCHEMA_VERSION,
    id,
    suiteId: "store-suite",
    suiteVersion: "1.0.0",
    status,
    snapshot: snapshotOf(),
    samples: [],
    aggregate: null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-09-28T00:01:00.000Z",
  };
}

function sampleOf(caseId: string, repetition: number, status: "completed" | "failed"): BenchmarkSampleResult {
  const metrics = status === "completed" ? { ...emptyMetricValues(), overall_quality: 88 } : emptyMetricValues();
  return {
    caseId,
    repetition,
    runId: status === "completed" ? `run-${caseId}-${repetition}` : null,
    status,
    metrics,
    failure: status === "failed" ? "generating: 上游 502" : null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:00:30.000Z",
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("BenchmarkStore — Suite", () => {
  it("写进去的 Suite 原样读得回来", () => {
    withTmpDir();
    const { suite, store } = seedSuite();
    expect(store.readSuite("store-suite", "1.0.0")).toEqual(suite);
  });

  it("版本省略时取最大的那一版（1.10 大于 1.9，按数字段比）", () => {
    withTmpDir();
    seedSuite("1.9");
    seedSuite("1.10");
    const store = new BenchmarkStore("runs");
    expect(store.readSuite("store-suite")?.version).toBe("1.10");
    expect(store.suiteVersions("store-suite").map((v) => v.version)).toEqual(["1.9", "1.10"]);
    expect(store.listSuites().map((s) => s.version)).toEqual(["1.9", "1.10"]);
  });

  it("读不到一律 null：不存在的 id、不存在的版本、非法 id", () => {
    withTmpDir();
    seedSuite();
    const store = new BenchmarkStore("runs");
    expect(store.readSuite("no-such-suite")).toBeNull();
    expect(store.readSuite("store-suite", "9.9.9")).toBeNull();
    expect(store.readSuite("../escape")).toBeNull();
    expect(store.suiteVersions("nope")).toEqual([]);
  });

  it("盘上那份被手改坏（混进凭据键）时读不回来", () => {
    const dir = withTmpDir();
    seedSuite();
    const path = join(dir, "benchmarks", "suites", "store-suite", "1.0.0", "suite.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // 键名拼出来、值用占位符：这里要验证的是「Suite 里不许有凭据键」，不是任何真凭据
    raw[["api", "key"].join("_")] = "not-a-real-credential";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(new BenchmarkStore("runs").readSuite("store-suite", "1.0.0")).toBeNull();
  });

  it("写路径自己也验 id 与版本：拼路径这一步不靠调用方兜底（§42）", () => {
    const dir = withTmpDir();
    const store = new BenchmarkStore("runs");
    const good = suiteRaw("1.0.0");
    // 领域工厂会拦住这些形状，所以这里直接用原始对象——要测的正是「万一没拦住」
    for (const bad of [
      { ...good, id: "../escape" },
      { ...good, id: "store-suite/nested" },
      { ...good, id: "" },
      { ...good, version: "../../1.0.0" },
      { ...good, version: "" },
    ]) {
      expect(() => store.putSuite(bad as never), JSON.stringify(bad)).toThrow(BenchmarkWriteError);
    }
    // 一次都没写出去：benchmarks/ 底下不该多出任何目录
    expect(existsSync(join(dir, "benchmarks", "suites"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 固定骨架（§40）
// ---------------------------------------------------------------------------

describe("BenchmarkStore — 固定骨架", () => {
  it("越界引用一律当不存在：Suite 外的绝对路径、..、别的 Suite 目录", () => {
    const dir = withTmpDir();
    seedSuite();
    // Suite 目录外放一份合法骨架：它能过 validateBeatPlan，但引用它就是越界
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "beat-plan.json"), JSON.stringify(SAMPLE_BEAT_PLAN), "utf8");
    const store = new BenchmarkStore("runs");
    expect(store.readBeatPlan("store-suite", "1.0.0", "cases/case-a/beat-plan.json")).not.toBeNull();
    expect(store.readBeatPlan("store-suite", "1.0.0", join(dir, "outside", "beat-plan.json"))).toBeNull();
    expect(store.readBeatPlan("store-suite", "1.0.0", "../../../../etc/passwd")).toBeNull();
    expect(store.readBeatPlan("store-suite", "1.0.0", "cases/case-a/not-here.json")).toBeNull();
    expect(store.readBeatPlan("other-suite", "1.0.0", "cases/case-a/beat-plan.json")).toBeNull();
  });

  it("文件在但内容不是合法 BeatPlan：null", () => {
    withTmpDir();
    seedSuite();
    const path = join(
      process.cwd(),
      "benchmarks",
      "suites",
      "store-suite",
      "1.0.0",
      "cases/case-a/broken.json",
    );
    writeFileSync(path, JSON.stringify({ beats: "not-an-array" }), "utf8");
    expect(new BenchmarkStore("runs").readBeatPlan("store-suite", "1.0.0", "cases/case-a/broken.json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 执行三件套（§37/§38）
// ---------------------------------------------------------------------------

describe("BenchmarkStore — 执行三件套", () => {
  it("头 / 样本 / 汇总分开写，读的时候合回来", () => {
    withTmpDir();
    const store = new BenchmarkStore("runs");
    store.putExecution(executionOf("bmk-0001", "running"));
    const samples = [sampleOf("case-a", 1, "completed"), sampleOf("case-a", 2, "failed")];
    store.putSamples("bmk-0001", samples);
    store.putAggregate("bmk-0001", {
      totalSamples: 2,
      completedSamples: 1,
      failedSamples: 1,
      metrics: { overall_quality: { count: 1, mean: 88, min: 88, max: 88 } },
      byGenre: {},
      byTag: {},
      failureCategories: {},
      failureStages: {},
      pass: null,
    });

    const read = store.readExecution("bmk-0001");
    expect(read?.status).toBe("running");
    // 两行样本一条不少地读回来（顶层数组不能走读对象那条路）
    expect(read?.samples).toEqual(samples);
    expect(store.readSamples("bmk-0001")).toEqual(samples);
    expect(read?.aggregate?.totalSamples).toBe(2);
    // 只存引用，不复制正文
    expect(JSON.stringify(read)).not.toContain("陈岚");

    // 三个文件真的在盘上
    for (const file of ["execution.json", "samples.json", "aggregate.json"]) {
      expect(existsSync(join(process.cwd(), "benchmarks", "executions", "bmk-0001", file))).toBe(true);
    }
  });

  it("跑的过程中照常更新：进度能一段一段落盘", () => {
    withTmpDir();
    const store = new BenchmarkStore("runs");
    store.putExecution(executionOf("bmk-running", "running"));
    store.putSamples("bmk-running", [sampleOf("case-a", 1, "completed")]);
    expect(store.readExecution("bmk-running")?.samples).toHaveLength(1);
    store.putSamples("bmk-running", [sampleOf("case-a", 1, "completed"), sampleOf("case-a", 2, "completed")]);
    store.putExecution({ ...executionOf("bmk-running", "completed"), samples: [] });
    expect(store.readExecution("bmk-running")?.status).toBe("completed");
    expect(store.readExecution("bmk-running")?.samples).toHaveLength(2);
  });

  it("终态之后一个字都不许改：completed / partial / failed 都拒写", () => {
    withTmpDir();
    const store = new BenchmarkStore("runs");
    for (const status of ["completed", "partial", "failed"] as const) {
      const id = `bmk-terminal-${status}`;
      store.putExecution(executionOf(id, status));
      const before = store.readExecution(id);
      expect(() => store.putExecution({ ...executionOf(id, "running"), samples: [] })).toThrow(BenchmarkWriteError);
      expect(() => store.putSamples(id, [])).toThrow(BenchmarkWriteError);
      expect(() => store.putAggregate(id, before?.aggregate as never)).toThrow(BenchmarkWriteError);
      expect(store.readExecution(id)).toEqual(before);
    }
  });

  it("非法 id 一律当不存在；listExecutionIds 只列合法的", () => {
    withTmpDir();
    const store = new BenchmarkStore("runs");
    store.putExecution(executionOf("bmk-ok", "completed"));
    mkdirSync(join(process.cwd(), "benchmarks", "executions", "not a benchmark id"), { recursive: true });
    store.putExecution(executionOf("bmk-ok2", "running"));

    expect(store.readExecution("../escape")).toBeNull();
    expect(store.readSamples("../escape")).toBeNull();
    expect(store.readAggregate("../escape")).toBeNull();
    expect(store.exists("../escape")).toBe(false);
    expect(store.listExecutionIds()).toEqual(["bmk-ok", "bmk-ok2"]);
  });

  it("写失败的消息里只有相对文件名，不带服务器绝对路径（§67）", () => {
    const dir = withTmpDir();
    const store = new BenchmarkStore("runs");
    store.putExecution(executionOf("bmk-write", "running"));
    let message = "";
    try {
      // id 里带路径分隔符 → executionDir 直接拒写，不碰文件系统
      store.putExecution(executionOf("bad/id", "running"));
    } catch (e) {
      expect(e).toBeInstanceOf(BenchmarkWriteError);
      message = (e as Error).message;
    }
    expect(message).toContain("bad/id");
    expect(message).not.toContain(dir);
    expect(message).not.toContain("benchmarks/executions");
  });
});
