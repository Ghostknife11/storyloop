/**
 * v2.3.0 Benchmark 导出渲染（Analysis；TASK §64/§65/§66/§67）。
 *
 * 两种格式都从同一份 `BenchmarkExecution` 出发，纯函数、不碰磁盘、不问时间——
 * 「导出」在这里的意思是「换成另一种形状」，落不落盘、走不走 HTTP，
 * 是上层用例与路由决定的。
 *
 * §67 是硬约束，写在这个文件里比写在任何文档里都牢靠：默认导出里
 * **没有生成正文、没有提示词原文、没有 baseUrl、没有任何凭据**。
 * CSV 一列一列列出来，所以只有 runId / caseId / 扁平指标；
 * JSON 里的快照块直接搬 RunManifest 里那份只记事实的快照
 * （模型名 + 地址类别 + 提示词摘要 + 参数），不存在第二份可能泄底的拷贝。
 *
 * 反面教材：把 story.md 一起塞进 CSV。那样导出的「结果」会带着正文四处流传，
 * 而 Benchmark 要答的问题只是「这次跑成什么样」。
 */

import { BENCHMARK_METRIC_DEFINITIONS, BENCHMARK_METRIC_KEYS } from "@/domain/benchmark-metric";
import {
  isBenchmarkId,
  type BenchmarkExecution,
  type BenchmarkSampleResult,
} from "@/domain/benchmark-result";
import type { BenchmarkSuite } from "@/domain/benchmark-suite";

/** §64 两种导出格式。 */
export type BenchmarkExportFormat = "json" | "csv";

export const BENCHMARK_EXPORT_FORMATS = ["json", "csv"] as const;

export const BENCHMARK_EXPORT_MIME: Record<BenchmarkExportFormat, string> = {
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

/** 导出文件自己的 schema 版本（与执行 schema 分开管，导出形状变了不动历史数据）。 */
export const BENCHMARK_EXPORT_SCHEMA_VERSION = "benchmark-export/1";

/**
 * CSV 单格转义（RFC 4180）。
 *
 * 指标值全是数字或空，看着像不需要转义；但 caseId / status / failure 是
 * 人写或程序拼出来的字符串，一个逗号就能把整列冲掉。这里按规矩来，不赌输入。
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV 头：执行与样本的身份列 + 注册表顺序的 22 个指标列。
 */
const CSV_COLUMNS = [
  "benchmark_id",
  "suite_id",
  "suite_version",
  "case_id",
  "repetition",
  "run_id",
  "status",
  "failure",
  ...BENCHMARK_METRIC_KEYS,
];

/**
 * §66 CSV：每行一个 Case × Repetition，指标扁平展开。返回的还是**原始值**
 * （数字、null、字符串），交给 `benchmarkCsvRows` 的调用方决定怎么落格。
 *
 * 顺序直接照样本数组的顺序（caseId 声明序 × repetition 升序），所以同一份执行
 * 导出两次，字节一致——可复现也包括「导出来的文件」。
 */
export function benchmarkCsvRows(execution: BenchmarkExecution): unknown[][] {
  const rows: unknown[][] = [CSV_COLUMNS];
  for (const sample of execution.samples) {
    rows.push([
      execution.id,
      execution.suiteId,
      execution.suiteVersion,
      sample.caseId,
      sample.repetition,
      sample.runId,
      sample.status,
      sample.failure,
      ...BENCHMARK_METRIC_KEYS.map((key) => sample.metrics[key]),
    ]);
  }
  return rows;
}

/** CSV 文本（CRLF 行尾：Excel 与 WPS 都对它比对 LF 老实）。 */
export function benchmarkCsvText(execution: BenchmarkExecution): string {
  return `${benchmarkCsvRows(execution)
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

/**
 * §65 JSON：snapshot / aggregate / sample metrics / run references 四块，
 * 顺序固定，便于 diff。
 */
export function benchmarkJsonExport(
  execution: BenchmarkExecution,
  suite: BenchmarkSuite | null,
): Record<string, unknown> {
  return {
    schemaVersion: BENCHMARK_EXPORT_SCHEMA_VERSION,
    benchmarkId: execution.id,
    suiteId: execution.suiteId,
    suiteVersion: execution.suiteVersion,
    status: execution.status,
    // 一次执行的四个部分（§65）
    executionSnapshot: execution.snapshot,
    aggregate: execution.aggregate,
    sampleMetrics: execution.samples.map(sampleMetricsOf),
    runReferences: runReferencesOf(execution),
    // 引用的那份 Suite：导出的数据要能对上是哪套题测出来的。
    // Suite 后来被改过也没关系——snapshot.suiteDigest 记的是这次跑的那一版。
    ...(suite !== null
      ? {
          suite: {
            id: suite.id,
            version: suite.version,
            name: suite.name,
            caseCount: suite.cases.length,
            source: suite.source,
            protocol: suite.protocol,
          },
        }
      : {}),
    // 指标口径：导出文件自带一份字段说明，看数的人不必回头翻文档。
    metricDefinitions: BENCHMARK_METRIC_DEFINITIONS.map((entry) => ({
      key: entry.key,
      label: entry.label,
      unit: entry.unit,
      aggregation: entry.aggregation,
      source: entry.source,
      definition: entry.definition,
    })),
  };
}

/** 一条样本导出的样子：身份 + 指标 + 失败原因，没有正文、没有提示词。 */
function sampleMetricsOf(sample: BenchmarkSampleResult): Record<string, unknown> {
  return {
    caseId: sample.caseId,
    repetition: sample.repetition,
    runId: sample.runId,
    status: sample.status,
    ...(sample.failure !== null ? { failure: sample.failure } : {}),
    metrics: BENCHMARK_METRIC_KEYS.reduce<Record<string, number | null>>((out, key) => {
      out[key] = sample.metrics[key];
      return out;
    }, {}),
  };
}

/** 只引 runId（去重、保序）：正文留在 runs/ 下，导出文件里只有指针（§39）。 */
function runReferencesOf(execution: BenchmarkExecution): string[] {
  const out: string[] = [];
  for (const sample of execution.samples) {
    if (sample.runId !== null && !out.includes(sample.runId)) out.push(sample.runId);
  }
  return out;
}

/**
 * 渲染成最终 bytes。
 *
 * 走 UTF-8 编码（带 BOM 的 CSV 才不会在 Excel 里变乱码），format 不合法直接抛——
 * 路由层负责把它翻成 400，这里不放任「认不出的格式给个默认值」。
 */
export function renderBenchmarkExport(
  format: BenchmarkExportFormat,
  execution: BenchmarkExecution,
  suite: BenchmarkSuite | null,
): { mimeType: string; filename: string; bytes: Uint8Array } {
  if (format === "csv") {
    return {
      mimeType: BENCHMARK_EXPORT_MIME.csv,
      filename: benchmarkExportFilename(execution.id, "csv"),
      bytes: encodeUtf8WithBom(benchmarkCsvText(execution)),
    };
  }
  const json = JSON.stringify(benchmarkJsonExport(execution, suite), null, 2);
  return {
    mimeType: BENCHMARK_EXPORT_MIME.json,
    filename: benchmarkExportFilename(execution.id, "json"),
    bytes: encodeUtf8(`${json}\n`),
  };
}

/** 文件名只由已校验过的执行 id 与格式拼成，所以这里拼出来的一定是安全文件名。 */
export function benchmarkExportFilename(benchmarkId: string, format: BenchmarkExportFormat): string {
  if (!isBenchmarkId(benchmarkId)) throw new Error("执行 id 不合法，拒绝拼文件名");
  return `benchmark-${benchmarkId}.${format}`;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function encodeUtf8WithBom(text: string): Uint8Array {
  return new Uint8Array([0xef, 0xbb, 0xbf, ...encodeUtf8(text)]);
}

/** 路由与用例共用的一句解释：导出里没有正文、没有提示词、没有凭据。 */
export const BENCHMARK_EXPORT_CONTENT_NOTE =
  "导出只包含执行身份、快照、样本指标与 runId 引用；不含生成正文、提示词原文与任何凭据。";

