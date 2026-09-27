import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listSuites } from "@/app/api/benchmarks/suites/route";
import { GET as getSuiteById } from "@/app/api/benchmarks/suites/[id]/route";
import { GET as listExecutions } from "@/app/api/benchmarks/executions/route";
import { POST as runExecution } from "@/app/api/benchmarks/executions/route";
import { GET as getExecution } from "@/app/api/benchmarks/executions/[id]/route";
import { GET as exportExecution } from "@/app/api/benchmarks/executions/[id]/export/route";
import { POST as setBaseline } from "@/app/api/benchmarks/executions/[id]/baseline/route";
import { GET as history } from "@/app/api/benchmarks/history/route";
import { BenchmarkStore } from "@/infrastructure/storage/benchmark-store";
import { benchmarkMetricKeys, emptyMetricValues } from "@/domain/benchmark-metric";
import { benchmarkSuiteOf } from "@/domain/benchmark-suite";
import { BENCHMARK_EXECUTION_SCHEMA_VERSION, type BenchmarkSampleResult } from "@/domain/benchmark-result";
import { SAMPLE_CONFIG } from "./helpers/fixtures";

/**
 * v2.3.0 Benchmark 接口：读链路全打通、写链路只打拒绝。
 *
 * 与实验接口同一套纪律：POST 开跑一律不走到 LLM（服务端没配密钥就该在预检
 * 阶段 400 挡下，一次付费调用都不发生）。读链路则要真跑通——一份 Suite、
 * 一次执行、三个接口各自的快照与汇总，都得从盘上原样回到响应体里。
 *
 * 每条响应还顺带查一遍 §67：里面不能有服务器绝对路径。
 */

const METRICS = benchmarkMetricKeys();
const realCwd = process.cwd();
const realKey = process.env.LLM_API_KEY;
let tmp: string | null = null;

beforeEach(() => {
  delete process.env.LLM_API_KEY;
});

afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
  if (realKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = realKey;
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-bench-api-"));
  process.chdir(tmp);
  return tmp;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function get(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function suiteRaw(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "api-suite",
    version: "1.0.0",
    name: "接口测试题库",
    cases: [
      {
        id: "case-a",
        title: "题 A",
        genre: "悬疑",
        storyConfig: SAMPLE_CONFIG,
        beatPlanMode: "regenerate",
        tags: ["短篇"],
      },
    ],
    protocol: {
      repetitions: 2,
      plannerMode: "normal",
      acceptedMetrics: [...METRICS],
      failureHandling: "include",
      passThreshold: 71,
    },
    source: { origin: "original", license: "CC0-1.0", note: "测试代码现场构造。" },
    createdAt: "2026-09-28",
  };
}

/** 铺一份 Suite 与一次「已经跑完」的执行，返回执行 id。 */
function seed(): string {
  const store = new BenchmarkStore("runs");
  const suite = benchmarkSuiteOf(suiteRaw(), METRICS);
  expect(suite).not.toBeNull();
  store.putSuite(suite as never);

  const id = "bmk-api-0001";
  const samples: BenchmarkSampleResult[] = [
    {
      caseId: "case-a",
      repetition: 1,
      runId: "run-case-a-1",
      status: "completed",
      metrics: { ...emptyMetricValues(), overall_quality: 88, commercial_overall: 74, duration_ms: 42000 },
      failure: null,
      startedAt: "2026-09-28T00:00:00.000Z",
      completedAt: "2026-09-28T00:00:42.000Z",
    },
    {
      caseId: "case-a",
      repetition: 2,
      runId: null,
      status: "failed",
      metrics: emptyMetricValues(),
      failure: "generating: 上游 502",
      startedAt: "2026-09-28T00:01:00.000Z",
      completedAt: "2026-09-28T00:01:03.000Z",
    },
  ];
  const snapshot = {
    suiteId: "api-suite",
    suiteVersion: "1.0.0",
    suiteDigest: "digest-api-suite",
    protocol: (suite as never as { protocol: never }).protocol,
    protocolDigest: "protocol-digest",
    projectVersion: "2.3.0",
    commit: null,
    models: null,
    prompts: null,
    parameters: null,
    caseIds: ["case-a"],
    repetitions: 2,
    plannedSamples: 2,
    label: "接口测试执行",
    startedAt: "2026-09-28T00:00:00.000Z",
  };
  const head = (status: "running" | "completed", completedAt: string | null) => ({
    schemaVersion: BENCHMARK_EXECUTION_SCHEMA_VERSION,
    id,
    suiteId: "api-suite",
    suiteVersion: "1.0.0",
    status,
    snapshot,
    samples: [],
    aggregate: null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt,
  });

  // 按真实顺序落盘：头先 running，样本与汇总是跑的过程里一段段写的，
  // 最后才翻到终态（§37 之后一个字都不许改）
  store.putExecution(head("running", null));
  store.putSamples(id, samples);
  store.putAggregate(id, {
    totalSamples: 2,
    completedSamples: 1,
    failedSamples: 1,
    metrics: {
      overall_quality: { count: 1, mean: 88, min: 88, max: 88 },
      commercial_overall: { count: 1, mean: 74, min: 74, max: 74 },
      duration_ms: { count: 1, mean: 42000, min: 42000, max: 42000 },
      failure_rate: { count: 2, mean: 50, min: 50, max: 50 },
    },
    failureCategories: {},
    failureStages: { generating: 1 },
    pass: { threshold: 71, passed: 1, failed: 0, unmeasured: 1 },
  });
  store.putExecution(head("completed", "2026-09-28T00:01:03.000Z"));
  return id;
}

/** §67：响应体里不许出现服务器绝对路径。 */
function expectNoServerPath(body: string): void {
  expect(body).not.toContain(tmp ?? "@@no-tmp@@");
  expect(body).not.toContain("D:\\");
  expect(body).not.toContain("/tmp/");
  expect(body).not.toContain("benchmarks/executions");
}

describe("GET /api/benchmarks/suites", () => {
  it("列出已存 Suite 的摘要：题数、样本数、来源说明", async () => {
    withTmpDir();
    seed();
    const res = await listSuites();
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const suites = json.suites as Record<string, unknown>[];
    expect(suites).toHaveLength(1);
    expect(suites[0]).toMatchObject({
      id: "api-suite",
      version: "1.0.0",
      caseCount: 1,
      repetitions: 2,
      plannedSamples: 2,
    });
    expect((suites[0]?.source as Record<string, unknown>).license).toBe("CC0-1.0");
    // 列表不给题面，也不给路径
    expectNoServerPath(JSON.stringify(json));
    expect(JSON.stringify(json)).not.toContain("storyConfig");
  });

  it("一份 Suite 都没有时也是 200，空数组", async () => {
    withTmpDir();
    const res = await listSuites();
    expect(res.status).toBe(200);
    expect((await readJson(res)).suites).toEqual([]);
  });
});

describe("GET /api/benchmarks/suites/:id", () => {
  it("返回 Suite 全文：题面、协议、来源", async () => {
    withTmpDir();
    seed();
    const res = await getSuiteById(get("http://localhost/api/benchmarks/suites/api-suite"), ctx("api-suite"));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json).toMatchObject({ id: "api-suite", version: "1.0.0" });
    const cases = json.cases as Record<string, unknown>[];
    expect(cases[0]).toMatchObject({ id: "case-a", genre: "悬疑" });
    // 这里是唯一会摊开题面的地方；?version 指定版本
    expectNoServerPath(JSON.stringify(json));
  });

  it("不存在的 Suite / 非法 id → 404 BENCHMARK_NOT_FOUND", async () => {
    withTmpDir();
    const missing = await getSuiteById(get("http://localhost/x"), ctx("nope"));
    expect(missing.status).toBe(404);
    expect((await readJson(missing)).error).toMatchObject({ code: "BENCHMARK_NOT_FOUND" });
    const bad = await getSuiteById(get("http://localhost/x"), ctx("../escape"));
    expect(bad.status).toBe(404);
  });
});

describe("GET /api/benchmarks/executions", () => {
  it("给摘要与聚合结果，不给样本明细", async () => {
    withTmpDir();
    const id = seed();
    const res = await listExecutions(get("http://localhost/api/benchmarks/executions"));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const executions = json.executions as Record<string, unknown>[];
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ id, suiteId: "api-suite", status: "completed", label: "接口测试执行" });
    expect(executions[0]?.samples).toBeUndefined();
    expect(executions[0]?.aggregate).toMatchObject({ totalSamples: 2, completedSamples: 1 });
    expectNoServerPath(JSON.stringify(json));
  });

  it("?suiteId= 只留同一份 Suite 的历史", async () => {
    withTmpDir();
    seed();
    const res = await listExecutions(get("http://localhost/api/benchmarks/executions?suiteId=other"));
    expect((await readJson(res)).executions).toEqual([]);
  });
});

describe("GET /api/benchmarks/executions/:id", () => {
  it("三件套一次给全：执行、引用的 Suite、没有比较时 comparison 是 null", async () => {
    withTmpDir();
    const id = seed();
    const res = await getExecution(get("http://localhost/x"), ctx(id));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.comparison).toBeNull();
    expect(json.suite).toMatchObject({ id: "api-suite" });
    const execution = json.execution as Record<string, unknown>;
    expect(execution.status).toBe("completed");
    expect(execution.samples).toHaveLength(2);
    expectNoServerPath(JSON.stringify(json));
  });

  it("不存在的执行 → 404", async () => {
    withTmpDir();
    const res = await getExecution(get("http://localhost/x"), ctx("bmk-nope"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/benchmarks/executions/:id/export", () => {
  it("csv / json 两种都拿得到，文件名固定", async () => {
    withTmpDir();
    const id = seed();
    const csv = await exportExecution(get(`http://localhost/x?format=csv`), ctx(id));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(csv.headers.get("Content-Disposition")).toContain(`benchmark-${id}.csv`);
    const csvBody = await csv.text();
    expect(csvBody).toContain("case_id");
    expect(csvBody).toContain("overall_quality");
    expectNoServerPath(csvBody);

    const json = await exportExecution(get("http://localhost/x?format=json"), ctx(id));
    expect(json.headers.get("Content-Type")).toContain("application/json");
    expect(json.headers.get("Content-Disposition")).toContain(`benchmark-${id}.json`);
    const parsed = JSON.parse(await json.text()) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe("benchmark-export/1");
    expect(parsed.sampleMetrics).toHaveLength(2);
    expectNoServerPath(JSON.stringify(parsed));
  });

  it("认不出的格式 → 400；执行不存在 → 404；id 不合法 → 404", async () => {
    withTmpDir();
    seed();
    const bad = await exportExecution(get("http://localhost/x?format=xlsx"), ctx("bmk-api-0001"));
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error).toMatchObject({ code: "BENCHMARK_INVALID" });
    const missing = await exportExecution(get("http://localhost/x"), ctx("bmk-nope"));
    expect(missing.status).toBe(404);
    const invalid = await exportExecution(get("http://localhost/x"), ctx("../escape"));
    expect(invalid.status).toBe(404);
  });
});

describe("POST /api/benchmarks/executions", () => {
  it("请求体不是 JSON → 400", async () => {
    withTmpDir();
    const req = new NextRequest("http://localhost/api/benchmarks/executions", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    const res = await runExecution(req);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatchObject({ code: "BENCHMARK_INVALID" });
  });

  it("没配密钥：预检阶段就 400，一次 LLM 请求都不发生", async () => {
    withTmpDir();
    seed();
    const res = await runExecution(
      new NextRequest("http://localhost/api/benchmarks/executions", {
        method: "POST",
        body: JSON.stringify({ suiteId: "api-suite", suiteVersion: "1.0.0" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatchObject({ code: "BENCHMARK_INVALID" });
    // 预检没过就不该多出任何执行目录：原来那一份还在，新的一份没有
    const store = new BenchmarkStore("runs");
    expect(store.listExecutionIds()).toEqual(["bmk-api-0001"]);
  });

  it("Suite 不存在 → 404；请求体里塞凭据字段 → 400", async () => {
    withTmpDir();
    seed();
    const missing = await runExecution(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ suiteId: "nope" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(missing.status).toBe(404);

    const secretish = await runExecution(
      new NextRequest("http://localhost/x", {
        method: "POST",
        // Benchmark 不允许从请求里覆盖模型与凭据：这样的字段整个请求都拒
        body: JSON.stringify({ suiteId: "api-suite", model: "gpt-4o-mini" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(secretish.status).toBe(400);
    expect((await readJson(secretish)).error).toMatchObject({ code: "BENCHMARK_INVALID" });
  });
});

describe("POST /api/benchmarks/executions/:id/baseline", () => {
  it("标上再取消：一个会话期的标签，动不了历史数据", async () => {
    withTmpDir();
    const id = seed();
    const on = await setBaseline(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ isBaseline: true }),
        headers: { "content-type": "application/json" },
      }),
      ctx(id),
    );
    expect(on.status).toBe(200);
    expect(await readJson(on)).toEqual({ benchmarkId: id, isBaseline: true });

    const off = await setBaseline(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ isBaseline: false }),
        headers: { "content-type": "application/json" },
      }),
      ctx(id),
    );
    expect(await readJson(off)).toEqual({ benchmarkId: id, isBaseline: false });
    // 标签在运行期，盘上的执行文件一个字都没动
    expect(existsSync(join(tmp ?? "", "benchmarks", "executions", id, "execution.json"))).toBe(true);
  });

  it("isBaseline 不是布尔 / 不是 JSON → 400", async () => {
    withTmpDir();
    const id = seed();
    const badType = await setBaseline(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ isBaseline: "yes" }),
        headers: { "content-type": "application/json" },
      }),
      ctx(id),
    );
    expect(badType.status).toBe(400);
    const notJson = await setBaseline(
      new NextRequest("http://localhost/x", { method: "POST", body: "nope" }),
      ctx(id),
    );
    expect(notJson.status).toBe(400);
  });
});

describe("GET /api/benchmarks/history", () => {
  it("点从盘上读出来的执行来：四个数一条点，一条都不编", async () => {
    withTmpDir();
    seed();
    const res = await history(get("http://localhost/api/benchmarks/history"));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    const points = json.points as Record<string, unknown>[];
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      id: "bmk-api-0001",
      status: "completed",
      overallQuality: 88,
      commercialOverall: 74,
      failureRate: 50,
      durationMs: 42000,
    });
    expectNoServerPath(JSON.stringify(json));
  });

  it("?suiteId= 只看某一份 Suite 的曲线", async () => {
    withTmpDir();
    seed();
    const res = await history(get("http://localhost/api/benchmarks/history?suiteId=other"));
    expect((await readJson(res)).points).toEqual([]);
  });

  it("没有任何执行时返回空序列，不是伪造的起点", async () => {
    withTmpDir();
    mkdirSync(join(tmp ?? "", "benchmarks"), { recursive: true });
    const res = await history(get("http://localhost/api/benchmarks/history"));
    expect((await readJson(res)).points).toEqual([]);
  });
});
