/**
 * v2.3.0 Benchmark 环境装配（Infrastructure）。
 *
 * `BenchmarkEnvironment` 是 Runner 唯一的环境来源：新执行 id、Suite / Protocol
 * 摘要、项目版本、部署 commit。Analysis 层不读盘、不读环境变量、不 new 存储
 * （§72 依赖方向测试守护这条线），所以这几件只能在基础设施里备好再交进去。
 *
 * 四件事为什么非要在这一层：
 *   - id 生成要 node:crypto（随机后缀）；Domain 不许碰它。
 *   - 摘要要 node:crypto 做 SHA-256；同样不许在 Domain 里出现。
 *   - 版本与 commit 是「部署环境说了算」的事实，版本号唯一真源是 VERSION 文件，
 *     commit 只从 CI 注入的环境变量里取（`commitShaFromEnv`）。Runner 不承认
 *     任何请求参数覆盖它们——否则「哪一版代码测出来的」就能被人随手改写。
 */

import type { BenchmarkEnvironment } from "@/analysis/benchmark-runner";
import { generateBenchmarkId } from "@/infrastructure/id/benchmark-id";
import { projectVersion } from "@/infrastructure/config/version";
import { commitShaFromEnv } from "@/infrastructure/tracking/project-snapshot";
import {
  benchmarkProtocolDigest,
  benchmarkSuiteDigest,
} from "@/infrastructure/tracking/benchmark-digest";
import type { BenchmarkProtocol, BenchmarkSuite } from "@/domain/benchmark-suite";

/** 生产环境：四项事实各取它唯一的真源。 */
export function benchmarkEnvironment(): BenchmarkEnvironment {
  return {
    newBenchmarkId: () => generateBenchmarkId(),
    suiteDigest: (suite: BenchmarkSuite) => benchmarkSuiteDigest(suite),
    protocolDigest: (protocol: BenchmarkProtocol) => benchmarkProtocolDigest(protocol),
    projectVersion: () => projectVersion(),
    commit: () => commitShaFromEnv(),
  };
}
