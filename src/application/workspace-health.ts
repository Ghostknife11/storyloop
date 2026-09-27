/**
 * v2.2.0 Creator Health 用例（Application）：把可观测量收成一份观察结果，
 * 交给 Domain 里那个纯函数判（TASK §16/§18/§39）。
 *
 * 分工是这个文件存在的全部理由：
 *   - domain/project-health.ts 只回答「看到这些事实该说什么」，不读磁盘、不认时间；
 *   - 这个文件只负责**把事实凑齐**，一句判断都不下。
 * 于是「健康」可以在测试里逐条穷举（喂一份观察结果看一句结论），
 * 也可以在生产里被真实数据喂到（这个文件），两边不会 diverged。
 *
 * 不调 LLM、不建议换模型（§19）。这里读的每一样都是已经存在的事实：
 * Manifest（归属、Attempt、Repair）、quality.json（问题条数与严重度）、
 * 稿件（有没有、正文摘要还与 Run 对不对得上）、exports/index.json（导出历史）。
 */

import {
  assessProjectHealth,
  countQualityIssues,
  type HealthObservation,
  type LatestRunOutcome,
  type ProjectHealthResult,
} from "@/domain/project-health";
import { WorkspaceNotFoundError, WorkspaceValidationError, isWorkspaceId } from "@/domain/workspace";
import { groupRunsByProject } from "@/application/workspace-projects";
import type { DocumentRepository } from "@/ports/document-store";
import type { ExportRepository } from "@/ports/export-store";
import type { ProjectRepository } from "@/ports/project-store";
import { FileDocumentRepository } from "@/infrastructure/storage/document-store";
import { FileExportRepository } from "@/infrastructure/storage/export-store";
import { FileProjectRepository } from "@/infrastructure/storage/project-store";
import { documentContentOf } from "@/domain/story-document";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { sha256Hex } from "@/infrastructure/tracking/digest";

export interface HealthCaseDeps {
  projects?: ProjectRepository;
  documents?: DocumentRepository;
  exports?: ExportRepository;
  artifactStore?: ArtifactStore;
  now?: () => Date;
}

/**
 * 一次 Run 的结局。
 *
 * 只看 Manifest 的 selectedAttemptId 与 attempts：产出了入选正文 = accepted；
 * 一次都没入选 = exhausted（重试预算用尽或全部落选）。读不到 Manifest 时给 null——
 * 「没有清单」不等于「失败」，这条界线一松就会把删除过目录的 Run 全画成红的。
 */
function outcomeOf(manifest: { selectedAttemptId?: string } | null): LatestRunOutcome | null {
  if (!manifest) return null;
  return manifest.selectedAttemptId !== undefined && manifest.selectedAttemptId !== null ? "accepted" : "exhausted";
}

export async function assessProjectHealthUseCase(
  projectId: string,
  deps: HealthCaseDeps = {},
): Promise<ProjectHealthResult> {
  const projects = deps.projects ?? new FileProjectRepository();
  const documents = deps.documents ?? new FileDocumentRepository();
  const exports_ = deps.exports ?? new FileExportRepository();
  const artifactStore = deps.artifactStore ?? new ArtifactStore();
  const now = deps.now ?? (() => new Date());

  if (!isWorkspaceId(projectId)) throw new WorkspaceValidationError("项目 id 不合法：只能是单个目录名");
  const project = projects.readProject(projectId);
  if (!project) throw new WorkspaceNotFoundError(projectId);

  // 归属靠扫 Manifest 归纳（§19）：一次遍历拿到这个项目名下的全部 Run，新的在前
  const runIds = groupRunsByProject(artifactStore.listRunIds(), (runId) => artifactStore.readRunManifest(runId)).get(
    projectId,
  ) ?? [];

  let retried = 0;
  for (const runId of runIds) {
    const manifest = artifactStore.readRunManifest(runId);
    // 重试 / 修订发生过没：Attempt 超过一次，或者这个 Run 里有 Repair 记录
    const attempts = manifest?.attempts?.length ?? 0;
    const repairs = manifest?.repairs?.length ?? 0;
    if (attempts > 1 || repairs > 0) retried += 1;
  }

  const latestRunId = runIds[0];
  const latestManifest = latestRunId === undefined ? null : artifactStore.readRunManifest(latestRunId);
  const latestQuality = latestRunId === undefined ? null : artifactStore.readFinalQuality(latestRunId);
  // 分桶判据在 Domain（countQualityIssues）：这里只负责把那次运行的问题原样递过去
  const qualityCounts = latestQuality ? countQualityIssues(latestQuality.issues) : { errors: 0, warnings: 0 };

  // 当前稿件（项目指针指着的那一篇），没有就是没有
  const document = project.currentDocumentId === null
    ? null
    : documents.readDocument(projectId, project.currentDocumentId);

  /**
   * 质量结论还对不对得上当前正文（§20）。
   *
   * null 的三种情形都表示「无从比较」，而不是「没问题」：没有当前稿件、
   * 稿件不是从 Run 来的、来源那次 Run 已经不在了。把这三者画成绿色等于撒谎。
   */
  let qualityCurrent: boolean | null = null;
  if (document !== null && document.sourceRunId !== null) {
    const story = artifactStore.readFinalStory(document.sourceRunId);
    if (story !== null) {
      qualityCurrent = sha256Hex(documentContentOf(story)) === document.contentHash;
    }
  }

  const observation: HealthObservation = {
    runCount: runIds.length,
    retriedShare: runIds.length === 0 ? null : retried / runIds.length,
    latestRunOutcome: latestRunId === undefined ? null : outcomeOf(latestManifest),
    // 没有质量结论时给 null（「不知道」），不是 0（「一条问题都没有」）
    qualityErrorCount: latestQuality === null ? null : qualityCounts.errors,
    qualityWarningCount: latestQuality === null ? null : qualityCounts.warnings,
    qualityCurrent,
    hasCurrentDocument: document !== null,
    exportCount: exports_.listExports(projectId).length,
    archived: project.status === "archived",
    ...(latestRunId !== undefined ? { latestRunId } : {}),
    ...(document !== null ? { documentId: document.id } : {}),
  };

  return assessProjectHealth(observation, now().toISOString());
}
