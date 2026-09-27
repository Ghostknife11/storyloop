/**
 * v2.3.0 Ports：Benchmark 的两个仓储端口（TASK §20/§38/§39）。
 *
 * Analysis（Runner / 聚合 / 用例）只认这两个接口：Suite 从哪儿读、执行结果写到哪儿，
 * 它一概不知道。换存储（换目录、换对象存储、换成内存实现供测试）不必碰分析层一行代码。
 *
 * 两条纪律写在这里，实现必须遵守：
 *   1. **只存引用，不复制正文**（TASK §39）。一个 Sample 只留 runId，Run 本体
 *      仍在 runs/ 下由 ArtifactStore 管。Benchmark 仓储里不该出现 story.md 的副本。
 *   2. **写出去的东西不能带密钥**（TASK §68）。Suite / 执行 / 聚合都是纯 JSON，
 *      模型快照只记模型名与地址类别，不记 baseUrl 原文、不记任何凭据。
 */

import type { BeatPlan } from "@/domain/beat-plan";
import type { BenchmarkProvenanceNote, BenchmarkSuite } from "@/domain/benchmark-suite";
import type { BenchmarkAggregate, BenchmarkExecution, BenchmarkSampleResult } from "@/domain/benchmark-result";

/** 列表用的 Suite 摘要：够判断「要不要点进去」，不带题目本体。 */
export interface BenchmarkSuiteSummary {
  id: string;
  version: string;
  name: string;
  description?: string;
  caseCount: number;
  repetitions: number;
  plannedSamples: number;
  suiteDigest: string;
  createdAt: string;
  source: BenchmarkProvenanceNote;
}

/** 一个已存版本：同一 suiteId 下可能有多个版本，历史图与列表都要用到。 */
export interface BenchmarkSuiteVersionSummary {
  version: string;
  caseCount: number;
  suiteDigest: string;
  createdAt: string;
}

export interface BenchmarkSuiteRepository {
  /** 测试与调试用：Suite 根目录的绝对路径（API 响应不得返回它）。 */
  readonly root: string;

  /** 全部已存版本（一个 Suite 有多个版本就出现多行），按 id + version 排序。 */
  listSuites(): BenchmarkSuiteSummary[];

  /** 某一份 Suite 的详情；version 省略时取版本号最大的那一版。读不到返回 null。 */
  readSuite(suiteId: string, suiteVersion?: string): BenchmarkSuite | null;

  /** 这个 suiteId 下已存的所有版本摘要。 */
  suiteVersions(suiteId: string): BenchmarkSuiteVersionSummary[];

  /** §69 Suite 内容摘要（规范化后哈希）。 */
  suiteDigestOf(suite: BenchmarkSuite): string;

  /** §40 固定骨架：按题目给的相对路径读回来并校验。路径越界 / 文件不在 → null。 */
  readBeatPlan(suiteId: string, suiteVersion: string, ref: string): BeatPlan | null;

  /** 落一份 Suite（种子数据与测试用）。 */
  putSuite(suite: BenchmarkSuite): void;
}

export interface BenchmarkExecutionRepository {
  /** 测试与调试用：执行根目录的绝对路径（API 响应不得返回它）。 */
  readonly root: string;

  /**
   * 写执行头。同一个 id 先写 running，终态最后写一次。
   * 一旦执行是终态（completed / partial / failed），任何再写都抛错。
   */
  putExecution(execution: BenchmarkExecution): void;

  /**
   * §37 执行中的进度快照：同一个 id 执行期反复写（每跑完一条样本写一次），
   * 于是中途被杀也能从盘上看出跑到哪儿、跑出了哪些 runId。
   * 执行进终态之后这份历史就冻结，再写抛错——历史结果不许改。
   */
  putSamples(benchmarkId: string, samples: BenchmarkSampleResult[]): void;

  /** 聚合结果；同样只在执行期可写。 */
  putAggregate(benchmarkId: string, aggregate: BenchmarkAggregate): void;

  readExecution(benchmarkId: string): BenchmarkExecution | null;

  readSamples(benchmarkId: string): BenchmarkSampleResult[] | null;

  readAggregate(benchmarkId: string): BenchmarkAggregate | null;

  exists(benchmarkId: string): boolean;

  /** 全部执行 id，按字典序（时间戳在前，所以也就是时间正序）。 */
  listExecutionIds(): string[];
}
