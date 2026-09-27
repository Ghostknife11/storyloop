/**
 * v2.3.0 Benchmark 存储（TASK §38/§39）。
 *
 * 目录布局（TASK §38）：
 *   benchmarks/
 *     suites/
 *       <suite_id>/<suite_version>/
 *         suite.json              题库定义（含题目与协议）
 *         cases/<case_id>/beat-plan.json   固定题的骨架（可选）
 *     executions/
 *       <benchmark_id>/
 *         execution.json          执行头：状态 + 跑之前定下的快照
 *         aggregate.json          汇总数字（没跑完就是 null）
 *         samples.json            每条样本一行（只存 runId 引用，不复制正文）
 *
 * 与 ExperimentStore 同一套纪律：原子写入（临时文件 → rename）、路径 containment
 * check、读不回来一律 null、错误消息里只有相对文件名（不带服务器绝对路径）。
 *
 * 两条这里特有的规矩：
 *   1. **执行结果不可变**（TASK §37）。`execution.json` 一旦落到终态
 *      （completed / partial / failed），任何再写入都抛错——历史结果不许被
 *      后续一次运行覆盖。跑的过程中照常更新（否则 partial 进度留不下来）。
 *   2. **Suite 与执行是两份目录**。Suite 是可以入库的原始数据（见
 *      docs/benchmark-data.md），executions/ 是每次测量的产物，不入库。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { validateBeatPlan, type BeatPlan } from "@/domain/beat-plan";
import {
  SUITE_ID_PATTERN,
  SUITE_VERSION_PATTERN,
  benchmarkSuiteOf,
  type BenchmarkSuite,
} from "@/domain/benchmark-suite";
import {
  isBenchmarkId,
  type BenchmarkAggregate,
  type BenchmarkExecution,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import { benchmarkMetricKeys } from "@/domain/benchmark-metric";
import type {
  BenchmarkExecutionRepository,
  BenchmarkSuiteRepository,
  BenchmarkSuiteSummary,
  BenchmarkSuiteVersionSummary,
} from "@/ports/benchmark-store";
import { benchmarkSuiteDigest } from "@/infrastructure/tracking/benchmark-digest";

const SUITE_FILE = "suite.json";
const EXECUTION_FILE = "execution.json";
const AGGREGATE_FILE = "aggregate.json";
const SAMPLES_FILE = "samples.json";

/** 终态：一份执行到了这里就不再接受任何写入（TASK §37）。 */
const TERMINAL_STATUS = new Set(["completed", "partial", "failed"]);

/** 磁盘满 / 权限不足 / 目录被占用。消息只带相对文件名（§67）。 */
export class BenchmarkWriteError extends Error {
  constructor(
    readonly filename: string,
    cause?: unknown,
  ) {
    super(`Benchmark 数据写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "BenchmarkWriteError";
  }
}

function failureCodeOf(cause: unknown): string {
  const detail = (cause ?? {}) as { code?: unknown; syscall?: unknown };
  const parts: string[] = [];
  if (typeof detail.code === "string" && detail.code.trim()) parts.push(detail.code.trim());
  if (typeof detail.syscall === "string" && detail.syscall.trim()) parts.push(detail.syscall.trim());
  return parts.length > 0 ? parts.join(" ") : "未知原因";
}

/** 版本比较：`1.10` 要大于 `1.9`（按数字段比，不按字典序）。 */
function versionRank(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionRank(a);
  const right = versionRank(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class BenchmarkStore implements BenchmarkSuiteRepository, BenchmarkExecutionRepository {
  private suitesRoot: string;
  private executionsRoot: string;

  /**
   * runsRoot：Run 产物根目录（与 ArtifactStore 同一个根）。
   * Benchmark 目录取它的上一级 sibling：`<runs 的父目录>/benchmarks`。
   * 传一个显式路径则视为 benchmarks/ 根本身（测试直接用）。
   */
  constructor(runsRoot?: string) {
    const root = resolve(runsRoot || join(process.cwd(), "runs"));
    const benchmarksRoot = resolve(root, "..", "benchmarks");
    this.suitesRoot = join(benchmarksRoot, "suites");
    this.executionsRoot = join(benchmarksRoot, "executions");
  }

  /** Suite 根目录（API 响应不得返回它）。 */
  get root(): string {
    return this.suitesRoot;
  }

  get executionsDir(): string {
    return this.executionsRoot;
  }

  // -------------------------------------------------------------------------
  // Suite
  // -------------------------------------------------------------------------

  private suiteDir(suiteId: string, version: string): string {
    const dir = resolve(this.suitesRoot, suiteId, version);
    if (dir === this.suitesRoot || !dir.startsWith(this.suitesRoot + sep)) {
      throw new BenchmarkWriteError(SUITE_FILE);
    }
    return dir;
  }

  private suiteEntries(): { suiteId: string; version: string; dir: string }[] {
    let suiteIds: string[] = [];
    try {
      suiteIds = readdirSync(this.suitesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const out: { suiteId: string; version: string; dir: string }[] = [];
    for (const suiteId of suiteIds) {
      if (!SUITE_ID_PATTERN.test(suiteId)) continue;
      let versions: string[] = [];
      try {
        versions = readdirSync(join(this.suitesRoot, suiteId), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const version of versions) {
        if (!SUITE_VERSION_PATTERN.test(version)) continue;
        out.push({ suiteId, version, dir: this.suiteDir(suiteId, version) });
      }
    }
    return out;
  }

  listSuites(): BenchmarkSuiteSummary[] {
    const out: BenchmarkSuiteSummary[] = [];
    for (const entry of this.suiteEntries()) {
      const suite = this.readSuite(entry.suiteId, entry.version);
      if (suite === null) continue;
      out.push({
        id: suite.id,
        version: suite.version,
        name: suite.name,
        ...(suite.description !== undefined && suite.description !== null
          ? { description: suite.description }
          : {}),
        caseCount: suite.cases.length,
        repetitions: suite.protocol.repetitions,
        plannedSamples: suite.cases.length * suite.protocol.repetitions,
        suiteDigest: benchmarkSuiteDigest(suite),
        createdAt: suite.createdAt,
        source: suite.source,
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version));
  }

  readSuite(suiteId: string, suiteVersion?: string): BenchmarkSuite | null {
    if (!SUITE_ID_PATTERN.test(suiteId)) return null;
    let version = suiteVersion;
    if (version === undefined) {
      const versions = this.suiteVersions(suiteId);
      if (versions.length === 0) return null;
      version = versions[versions.length - 1].version;
    }
    if (version === undefined || !SUITE_VERSION_PATTERN.test(version)) return null;
    const raw = this.readJson(this.suiteDir(suiteId, version), SUITE_FILE);
    if (raw === null) return null;
    return benchmarkSuiteOf(raw, benchmarkMetricKeys());
  }

  suiteVersions(suiteId: string): BenchmarkSuiteVersionSummary[] {
    const out: BenchmarkSuiteVersionSummary[] = [];
    for (const entry of this.suiteEntries()) {
      if (entry.suiteId !== suiteId) continue;
      const suite = this.readSuite(entry.suiteId, entry.version);
      if (suite === null) continue;
      out.push({
        version: suite.version,
        caseCount: suite.cases.length,
        suiteDigest: benchmarkSuiteDigest(suite),
        createdAt: suite.createdAt,
      });
    }
    return out.sort((a, b) => compareVersions(a.version, b.version));
  }

  suiteDigestOf(suite: BenchmarkSuite): string {
    return benchmarkSuiteDigest(suite);
  }

  readBeatPlan(suiteId: string, suiteVersion: string, ref: string): BeatPlan | null {
    if (!SUITE_ID_PATTERN.test(suiteId) || !SUITE_VERSION_PATTERN.test(suiteVersion)) return null;
    const dir = this.suiteDir(suiteId, suiteVersion);
    const path = resolve(dir, ref);
    // §40 固定骨架必须真的在 Suite 目录里：越界引用一律当作不存在
    if (path !== dir && !path.startsWith(dir + sep)) return null;
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    try {
      return validateBeatPlan(parsed);
    } catch {
      return null;
    }
  }

  putSuite(suite: BenchmarkSuite): void {
    const dir = this.suiteDir(suite.id, suite.version);
    this.putJson(dir, SUITE_FILE, suite);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private executionDir(benchmarkId: string): string {
    const dir = resolve(this.executionsRoot, benchmarkId);
    if (dir === this.executionsRoot || !dir.startsWith(this.executionsRoot + sep)) {
      throw new BenchmarkWriteError(benchmarkId);
    }
    return dir;
  }

  /**
   * §37 不可变守护：一份执行落到终态之后，任何写入都拒绝。
   * 跑的过程中（pending / running）照常更新——否则 partial 的进度留不下来。
   */
  private assertMutable(benchmarkId: string): void {
    const raw = this.readJson(this.executionDir(benchmarkId), EXECUTION_FILE);
    const status = raw?.status;
    if (typeof status === "string" && TERMINAL_STATUS.has(status)) {
      throw new BenchmarkWriteError(EXECUTION_FILE);
    }
  }

  /**
   * 只写头：samples 与 aggregate 是另外两个文件，readExecution 时再合回来。
   * 于是「历史样本」和「当前执行头」不会因为一次写盘互相覆盖（§37）。
   */
  putExecution(execution: BenchmarkExecution): void {
    this.assertMutable(execution.id);
    const head: Omit<BenchmarkExecution, "samples" | "aggregate"> = {
      schemaVersion: execution.schemaVersion,
      id: execution.id,
      suiteId: execution.suiteId,
      suiteVersion: execution.suiteVersion,
      status: execution.status,
      snapshot: execution.snapshot,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    };
    this.putJson(this.executionDir(execution.id), EXECUTION_FILE, head);
  }

  putSamples(benchmarkId: string, samples: BenchmarkSampleResult[]): void {
    this.assertMutable(benchmarkId);
    this.putJson(this.executionDir(benchmarkId), SAMPLES_FILE, samples);
  }

  putAggregate(benchmarkId: string, aggregate: BenchmarkAggregate): void {
    this.assertMutable(benchmarkId);
    this.putJson(this.executionDir(benchmarkId), AGGREGATE_FILE, aggregate);
  }

  readExecution(benchmarkId: string): BenchmarkExecution | null {
    if (!isBenchmarkId(benchmarkId)) return null;
    const dir = this.executionDir(benchmarkId);
    const head = this.readJson(dir, EXECUTION_FILE);
    if (head === null) return null;
    if (
      typeof head.schemaVersion !== "string" ||
      typeof head.id !== "string" ||
      typeof head.status !== "string" ||
      typeof head.startedAt !== "string"
    ) {
      return null;
    }
    const samples = this.readJson(dir, SAMPLES_FILE);
    const aggregate = this.readJson(dir, AGGREGATE_FILE);
    return {
      ...(head as unknown as BenchmarkExecution),
      samples: Array.isArray(samples) ? (samples as unknown as BenchmarkSampleResult[]) : [],
      aggregate: (aggregate as unknown as BenchmarkAggregate) ?? null,
    };
  }

  readSamples(benchmarkId: string): BenchmarkSampleResult[] | null {
    if (!isBenchmarkId(benchmarkId)) return null;
    const samples = this.readJson(this.executionDir(benchmarkId), SAMPLES_FILE);
    return Array.isArray(samples) ? (samples as unknown as BenchmarkSampleResult[]) : null;
  }

  readAggregate(benchmarkId: string): BenchmarkAggregate | null {
    if (!isBenchmarkId(benchmarkId)) return null;
    return (this.readJson(this.executionDir(benchmarkId), AGGREGATE_FILE) as unknown as BenchmarkAggregate) ?? null;
  }

  exists(benchmarkId: string): boolean {
    if (!isBenchmarkId(benchmarkId)) return false;
    try {
      return existsSync(resolve(this.executionDir(benchmarkId), EXECUTION_FILE));
    } catch {
      return false;
    }
  }

  listExecutionIds(): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.executionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return names.filter((name) => isBenchmarkId(name) && this.exists(name)).sort();
  }

  // -------------------------------------------------------------------------
  // 内部：JSON 读写
  // -------------------------------------------------------------------------

  private putJson(dir: string, filename: string, data: unknown): void {
    const finalPath = resolve(dir, filename);
    const tmpPath = join(join(finalPath, ".."), `.${basename(finalPath)}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new BenchmarkWriteError(filename, e);
    }
  }

  private readJson(dir: string, filename: string): Record<string, unknown> | null {
    const path = resolve(dir, filename);
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
