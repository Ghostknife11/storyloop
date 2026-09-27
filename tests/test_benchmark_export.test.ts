/**
 * v2.3.0 Benchmark 导出（Analysis；TASK §64/§65/§66/§67）。
 *
 * 这个文件守的是「导出文件里不会流出不该流的东西」：
 *
 *   - **一行一个 Case × Repetition**、指标扁平展开、顺序只由样本数组决定
 *     ——同一份执行导出两次，字节一致（§66 的可复现也包括导出的文件）。
 *   - **没有正文、没有提示词原文、没有 baseUrl、没有凭据**（§67）。这里不是
 *     断言「碰巧没有」：快照样例里塞进真实的 models / prompts / parameters，
 *     看渲染结果里留下什么、又没留下什么。
 *   - **失败原因可以出现**（那是一句稳定错误码 + 阶段），但它也不带异常原文、
 *     不带路径——所以逗号引号照 RFC 4180 转义，别把整列冲掉。
 */

import { describe, expect, it } from "vitest";
import {
  BENCHMARK_EXPORT_CONTENT_NOTE,
  BENCHMARK_EXPORT_FORMATS,
  BENCHMARK_EXPORT_MIME,
  BENCHMARK_EXPORT_SCHEMA_VERSION,
  benchmarkCsvRows,
  benchmarkCsvText,
  benchmarkExportFilename,
  benchmarkJsonExport,
  renderBenchmarkExport,
} from "@/analysis/benchmark-export";
import { BENCHMARK_METRIC_KEYS, emptyMetricValues } from "@/domain/benchmark-metric";
import {
  BENCHMARK_EXECUTION_SCHEMA_VERSION,
  type BenchmarkExecution,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import { benchmarkSuiteOf } from "@/domain/benchmark-suite";
import { benchmarkMetricKeys } from "@/domain/benchmark-metric";
import { SAMPLE_CONFIG } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// 夹具：一份「已经跑完」的执行
// ---------------------------------------------------------------------------

const CSV_IDENTITY_COLUMNS = [
  "benchmark_id",
  "suite_id",
  "suite_version",
  "case_id",
  "repetition",
  "run_id",
  "status",
  "failure",
];

function sampleOf(
  caseId: string,
  repetition: number,
  overall: number | null,
  overrides: Partial<BenchmarkSampleResult> = {},
): BenchmarkSampleResult {
  return {
    caseId,
    repetition,
    runId: `run-${caseId}-${repetition}`,
    status: overall === null ? "failed" : "completed",
    metrics: { ...emptyMetricValues(), overall_quality: overall, duration_ms: 42000 },
    failure: overall === null ? "generating: 上游 502" : null,
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:00:42.000Z",
    ...overrides,
  };
}

function sampleRaw(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    id: "export-suite",
    version: "1.0.0",
    name: "导出测试题库",
    cases: [
      { id: "case-a", title: "题 A", genre: "悬疑", storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", tags: ["短篇"] },
      { id: "case-b", title: "题 B", genre: "豪门", storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", tags: ["长篇"] },
    ],
    protocol: {
      repetitions: 1,
      plannerMode: "normal",
      acceptedMetrics: [...benchmarkMetricKeys()],
      failureHandling: "include",
      passThreshold: 71,
    },
    source: { origin: "original", license: "CC0-1.0", note: "测试代码现场构造。" },
    createdAt: "2026-09-28",
  };
}

function suiteOf() {
  const suite = benchmarkSuiteOf(sampleRaw(), benchmarkMetricKeys());
  expect(suite).not.toBeNull();
  return suite as NonNullable<ReturnType<typeof benchmarkSuiteOf>>;
}

function executionOf(samples: BenchmarkSampleResult[]): BenchmarkExecution {
  return {
    schemaVersion: BENCHMARK_EXECUTION_SCHEMA_VERSION,
    id: "bmk-export-001",
    suiteId: "export-suite",
    suiteVersion: "1.0.0",
    status: "partial",
    // 与跑完第一条样本之后快照该有的样子一致：模型名 + 地址类别 + 提示词摘要 + 参数
    snapshot: {
      suiteId: "export-suite",
      suiteVersion: "1.0.0",
      suiteDigest: "suite-digest-export",
      protocol: suiteOf().protocol,
      protocolDigest: "protocol-digest-export",
      projectVersion: "2.3.0",
      commit: "abc1234",
      models: {
        story: { provider: "minimax", model: "MiniMax-M2", baseUrlClass: "server-configured" },
        review: { model: "some-review-model", baseUrlClass: "request-public-override" },
      },
      prompts: [
        { role: "generator", version: "story-v3", digest: "a".repeat(64) },
        { role: "reviewer", version: "review-v2" },
      ],
      parameters: {
        generation: { temperature: 0.9 },
        planning: { temperature: 0.6 },
        review: { temperature: 0.3 },
        commercialReview: { temperature: 0.4 },
        beatValidation: { temperature: 0.1 },
        repair: { temperature: 0.5 },
        retry: {
          maxAttempts: 2,
          minReviewScore: 70,
          retryOnValidationFailure: true,
          enableRepair: true,
          maxRepairsPerAttempt: 1,
        },
      },
      caseIds: ["case-a", "case-b"],
      repetitions: 1,
      plannedSamples: 2,
      label: "2.3.0 发布前基线",
      startedAt: "2026-09-28T00:00:00.000Z",
    },
    samples,
    aggregate: {
      totalSamples: 3,
      completedSamples: 2,
      failedSamples: 1,
      metrics: { overall_quality: { count: 2, mean: 87.5, min: 85, max: 90 } },
      failureCategories: {},
      failureStages: { generating: 1 },
      pass: { threshold: 71, passed: 2, failed: 0, unmeasured: 1 },
    },
    startedAt: "2026-09-28T00:00:00.000Z",
    completedAt: "2026-09-28T00:03:00.000Z",
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------
// CSV（§66）
// ---------------------------------------------------------------------------

describe("Benchmark 导出 — CSV（§66）", () => {
  const samples = [
    sampleOf("case-a", 1, 85),
    sampleOf("case-a", 2, null),
    sampleOf("case-b", 1, 90, { failure: "生成失败, \"引号\" 也要转义" }),
  ];
  const execution = executionOf(samples);

  it("一列一列列清楚：8 个身份列 + 注册表顺序的 22 个指标列", () => {
    const rows = benchmarkCsvRows(execution);
    expect(rows[0]).toEqual([...CSV_IDENTITY_COLUMNS, ...BENCHMARK_METRIC_KEYS]);
    expect(rows[0]).toHaveLength(8 + BENCHMARK_METRIC_KEYS.length);
  });

  it("一行一个 Case × Repetition，顺序照样本数组", () => {
    const rows = benchmarkCsvRows(execution);
    expect(rows.slice(1).map((row) => `${row[3]}#${row[4]}`)).toEqual([
      "case-a#1",
      "case-a#2",
      "case-b#1",
    ]);
    expect(rows).toHaveLength(1 + samples.length);
  });

  it("指标原样落格：数字照写、没测出来的是空串、失败那格带转义", () => {
    const header = benchmarkCsvRows(execution)[0] as string[];
    const overallIndex = header.indexOf("overall_quality");
    const durationIndex = header.indexOf("duration_ms");
    const lines = benchmarkCsvText(execution).split("\r\n").filter(Boolean);
    // 表头之后第一行：overall_quality = 85
    expect((lines[1] ?? "").split(",")[overallIndex]).toBe("85");
    // 失败样本：整体质量空着，duration_ms 是 42000
    expect((lines[2] ?? "").split(",")[durationIndex]).toBe("42000");
    expect((lines[2] ?? "").split(",")[overallIndex]).toBe("");
    // 逗号让整格被引号包住，格里自己的引号翻倍：一个格子都不能把列冲掉
    expect(lines[3]).toContain('"生成失败, ');
    expect(lines[3]).toContain('""引号""');
  });

  it("CRLF 行尾 + UTF-8 BOM：Excel / WPS 打开不乱码", () => {
    const csv = benchmarkCsvText(execution);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.includes("\n\r")).toBe(false);
    const bytes = renderBenchmarkExport("csv", execution, null).bytes;
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("同一份执行渲染两次，字节一致", () => {
    const a = renderBenchmarkExport("csv", execution, suiteOf());
    const b = renderBenchmarkExport("csv", execution, suiteOf());
    expect([...a.bytes]).toEqual([...b.bytes]);
    expect(a.filename).toBe(b.filename);
  });
});

// ---------------------------------------------------------------------------
// JSON（§65）
// ---------------------------------------------------------------------------

describe("Benchmark 导出 — JSON（§65）", () => {
  const execution = executionOf([sampleOf("case-a", 1, 85), sampleOf("case-b", 1, null)]);

  it("四块齐全：快照 / 汇总 / 样本指标 / runId 引用", () => {
    const json = benchmarkJsonExport(execution, suiteOf());
    expect(json.schemaVersion).toBe(BENCHMARK_EXPORT_SCHEMA_VERSION);
    expect(json.benchmarkId).toBe("bmk-export-001");
    expect(json.executionSnapshot).toMatchObject({ suiteDigest: "suite-digest-export" });
    expect(json.aggregate).toMatchObject({ totalSamples: 3, completedSamples: 2 });
    expect(json.sampleMetrics).toHaveLength(2);
    expect(json.runReferences).toEqual(["run-case-a-1", "run-case-b-1"]);
  });

  it("引用的那份 Suite：给了就带上，没给就不发明", () => {
    expect(benchmarkJsonExport(execution, suiteOf()).suite).toMatchObject({
      id: "export-suite",
      version: "1.0.0",
      caseCount: 2,
    });
    expect(benchmarkJsonExport(execution, null)).not.toHaveProperty("suite");
  });

  it("自带指标口径说明：22 条定义，字段名与单位都在文件里", () => {
    const defs = benchmarkJsonExport(execution, suiteOf()).metricDefinitions as {
      key: string;
      label: string;
      unit: string;
    }[];
    expect(defs).toHaveLength(BENCHMARK_METRIC_KEYS.length);
    expect(defs[0]).toMatchObject({ key: BENCHMARK_METRIC_KEYS[0] });
  });

  it("只有跑成的样本才带指标表；失败样本给一句错误码", () => {
    const rows = benchmarkJsonExport(execution, suiteOf()).sampleMetrics as {
      caseId: string;
      status: string;
      failure?: string;
      metrics: Record<string, number | null>;
    }[];
    expect(rows[0]?.metrics.overall_quality).toBe(85);
    expect(rows[0]?.failure).toBeUndefined();
    expect(rows[1]?.status).toBe("failed");
    expect(rows[1]?.failure).toBe("generating: 上游 502");
  });

  it("runId 去重且保序（§39：导出里是指针，不是正文）", () => {
    const dup = executionOf([
      sampleOf("case-a", 1, 85, { runId: "run-shared" }),
      sampleOf("case-a", 2, 86, { runId: "run-shared" }),
      sampleOf("case-b", 1, 87, { runId: "run-third" }),
    ]);
    expect(benchmarkJsonExport(dup, null).runReferences).toEqual(["run-shared", "run-third"]);
  });

  it("渲染出来的 bytes：json 不带 BOM，结尾一个换行", () => {
    const out = renderBenchmarkExport("json", execution, suiteOf());
    expect(out.mimeType).toBe(BENCHMARK_EXPORT_MIME.json);
    expect(text(out.bytes).endsWith("}\n")).toBe(true);
    expect([...out.bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});

// ---------------------------------------------------------------------------
// §67 导出的内容边界
// ---------------------------------------------------------------------------

describe("Benchmark 导出 — 内容边界（§67）", () => {
  // 这些是「绝对不许出现在导出文件里」的东西：模型地址、密钥、提示词原文、
  // 生成正文、题面、服务器路径。「不含」指的是这个清单里的字符串一个都不出现。
  const EXECUTION = executionOf([sampleOf("case-a", 1, 85)]);
  const SECRETS = [
    "https://api.example.com/v1", // baseUrl
    "sk-", // 任何密钥值的前缀
    "Bearer ",
    "api_key", // 环境变量名也不该跟着出去
    "LLM_API_KEY",
    "你是一个短篇小说创作者", // 提示词原文的开头
    "陈岚", // 样例题面 / 正文里的角色名
    "storyConfig", // 题面配置是 Suite 的事，导出只记协议
    "premise",
    "D:\\", // 服务器绝对路径
    "/tmp/",
  ];
  // 快照里「允许留下」的事实：模型名、地址类别、提示词摘要、commit
  const ALLOWED = ["MiniMax-M2", "server-configured", "request-public-override", "a".repeat(64), "abc1234"];

  it("两种格式里都没有 baseUrl、凭据、提示词原文与正文", () => {
    for (const format of BENCHMARK_EXPORT_FORMATS) {
      const body = text(renderBenchmarkExport(format, EXECUTION, suiteOf()).bytes);
      for (const needle of SECRETS) expect(body).not.toContain(needle);
    }
  });

  it("JSON 里留下的正是快照该留下的四类事实", () => {
    const body = text(renderBenchmarkExport("json", EXECUTION, suiteOf()).bytes);
    for (const needle of ALLOWED) expect(body).toContain(needle);
  });

  it("提示词只留摘要：角色 + 版本号 + digest，没有原文", () => {
    const json = benchmarkJsonExport(EXECUTION, null) as {
      executionSnapshot: { prompts: { role: string; version: string; digest?: string }[] };
    };
    expect(json.executionSnapshot.prompts).toEqual([
      { role: "generator", version: "story-v3", digest: "a".repeat(64) },
      { role: "reviewer", version: "review-v2" },
    ]);
  });

  it("文件名只由执行 id 与格式拼成；id 不合法就拒拼", () => {
    expect(benchmarkExportFilename("bmk-export-001", "csv")).toBe("benchmark-bmk-export-001.csv");
    expect(benchmarkExportFilename("bmk-export-001", "json")).toBe("benchmark-bmk-export-001.json");
    expect(() => benchmarkExportFilename("../../etc/passwd", "json")).toThrow();
    expect(() => benchmarkExportFilename("bad/id", "csv")).toThrow();
  });

  it("对外解释只有一句，并且这句就是内容边界本身", () => {
    expect(BENCHMARK_EXPORT_CONTENT_NOTE).toContain("不含生成正文");
    expect(BENCHMARK_EXPORT_CONTENT_NOTE).toContain("提示词原文");
    expect(BENCHMARK_EXPORT_CONTENT_NOTE).toContain("凭据");
  });
});
