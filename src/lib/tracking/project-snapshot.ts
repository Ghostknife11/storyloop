/**
 * v1.6.0 项目快照：这次 Run 跑在哪个版本、哪个 commit 上。
 *
 * 版本号仍然走 `src/lib/version.ts` 的单一真源（VERSION 文件），与 metadata 的
 * `project_version`、`/api/version`、About 页是同一个数——不为 Manifest 另立一个来源。
 *
 * commit 只从**运行环境已经提供**的变量里取，绝不为了一次 Manifest 去跑 `git rev-parse`：
 * 每个请求都起一个子进程既慢又会在没有 .git 的部署里失败。部署环境没注入时这个键就不出现，
 * Manifest 不会假装知道 commit。
 */

import { projectVersion } from "@/lib/version";
import type { ProjectSnapshot } from "@/types/run-manifest";

/** 常见的构建 / 部署注入变量；第一个取到合法值的生效。 */
const COMMIT_ENV_KEYS = [
  "STORYLOOP_GIT_COMMIT",
  "GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

/** git commit sha 的合法形态：7~40 位十六进制。别的形态一律当没有，原样记下来风险太大。 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** 从环境里取 commit short sha；没有或形态不对时返回 null。 */
export function commitShaFromEnv(): string | null {
  for (const key of COMMIT_ENV_KEYS) {
    const raw = process.env[key]?.trim();
    if (raw && COMMIT_PATTERN.test(raw)) return raw.toLowerCase();
  }
  return null;
}

/** 项目快照：版本必有，commit 可选。 */
export function projectSnapshot(): ProjectSnapshot {
  const snapshot: ProjectSnapshot = { version: projectVersion() };
  const commit = commitShaFromEnv();
  if (commit !== null) snapshot.commit = commit;
  return snapshot;
}
