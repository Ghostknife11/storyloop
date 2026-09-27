/**
 * v2.3.0 Benchmark 执行 id 生成（Infrastructure）。
 *
 * 与 run_id 同一套形态（时间戳 + 短随机）——Benchmark 执行 id 在磁盘上就是
 * 一个目录名（benchmarks/executions/<id>/），所以「怎么给一次执行命名」和
 * 「怎么给一次 Run 命名」是同一种基础设施策略：唯一、文件系统安全、不依赖
 * 用户输入。刻意不引入第二套 id 方案：两套方案就要有两处唯一性论证。
 *
 * 单独放一个文件而不是塞在存储实现里，是因为环境装配（BenchmarkEnvironment
 * 的 newBenchmarkId）也要用它，而让装配代码反过来 import 存储实现会把依赖
 * 方向搅乱。
 */

import { generateRunId } from "@/infrastructure/id/run-id";

export function generateBenchmarkId(now: Date = new Date()): string {
  return generateRunId(now);
}
