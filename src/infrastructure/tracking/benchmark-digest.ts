/**
 * v2.3.0 Suite / Protocol 摘要（TASK §69/§71）。
 *
 * 为什么需要它：`suiteVersion` 是**人写的**，`digest` 是**算出来的**。同一版本号下
 * 有人动了一道题，版本号不会变、digest 会变——于是「上个月 74.2、这个月 76.1」
 * 到底是系统变强还是题库变了，在结果里就有答案（TASK §70）。
 *
 * 规范化（stableStringify）是摘要的地基：对象键按字典序输出，于是同一份 Suite
 * 无论键的书写顺序如何、无论 JSON.stringify 的插入顺序如何，摘要都一样。
 * 少了这一步，digest 就只是「这一次序列化的指纹」，没有任何比较意义。
 *
 * 位置在 Infrastructure 而不是 Domain：摘要要用 node:crypto，而 Domain 不许
 * import node: 内置模块（§39 的纯度测试守护）。这里只做哈希，不做任何判断。
 */

import { sha256Hex } from "@/infrastructure/tracking/digest";
import type { BenchmarkProtocol, BenchmarkSuite } from "@/domain/benchmark-suite";

/** 键排序后的稳定 JSON：undefined 值整个丢掉（与 JSON.stringify 一致），null 保留。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * §69 Suite 摘要：覆盖「题库身份」的全部内容——id、版本、题目、协议、来源。
 * 刻意不含 createdAt：建时间不是题库内容，把它算进去会让同一份题每次复制都变 digest。
 */
export function benchmarkSuiteDigest(suite: BenchmarkSuite): string {
  return sha256Hex(
    stableStringify({
      schemaVersion: suite.schemaVersion,
      id: suite.id,
      version: suite.version,
      name: suite.name,
      description: suite.description ?? null,
      cases: suite.cases,
      protocol: suite.protocol,
      source: suite.source,
    }),
  );
}

/** §71 Protocol 摘要： repetitions / plannerMode / acceptedMetrics / failureHandling / passThreshold。 */
export function benchmarkProtocolDigest(protocol: BenchmarkProtocol): string {
  return sha256Hex(
    stableStringify({
      repetitions: protocol.repetitions,
      plannerMode: protocol.plannerMode,
      acceptedMetrics: protocol.acceptedMetrics,
      failureHandling: protocol.failureHandling,
      passThreshold: protocol.passThreshold ?? null,
    }),
  );
}
