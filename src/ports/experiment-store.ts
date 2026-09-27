/**
 * v2.0.0 Ports：实验仓储端口（§43 ExperimentRepository）。
 *
 * Analysis 的实验执行器只认这个接口：读定义、写格子与结果、列目录。它不知道
 * 文件长什么样、不知道 experiments/ 在哪个盘上——那是 Infrastructure 的事。
 * 于是同一份实验逻辑可以跑在磁盘存储、内存存储或将来的对象存储上。
 *
 * §43 明确不做的两件事：
 *   1. 不搞 `GenericRepository<T>`：每个接口都按自己的领域形状说话；
 *   2. 不给 Benchmark / Dataset / Leaderboard 建仓储（§44：这个版本没有这些能力）。
 */

import type { ExperimentDefinition, ExperimentResult, ExperimentRunIndex } from "@/domain/experiment";

export interface ExperimentRepository {
  /** 测试与调试用：实验目录的绝对路径（API 响应不得返回它）。 */
  readonly root: string;

  /** 目录不存在 / definition.json 读不回来 → false。 */
  exists(experimentId: string): boolean;

  resolveExperimentDir(experimentId: string): string;

  /** 建目录；已存在就复用（是否允许重跑由用例判断，存储层不判断）。 */
  createExperimentDirectory(experimentId: string): string;

  putDefinition(experimentId: string, definition: ExperimentDefinition): void;

  putRuns(experimentId: string, index: ExperimentRunIndex): void;

  putResults(experimentId: string, result: ExperimentResult): void;

  /** 读不回来一律 null（与 runManifestOf 同一约定：不猜）。 */
  readDefinition(experimentId: string): ExperimentDefinition | null;

  readRuns(experimentId: string): ExperimentRunIndex | null;

  readResults(experimentId: string): ExperimentResult | null;

  /** 全部实验 id，按目录名字典序。 */
  listExperimentIds(): string[];
}
