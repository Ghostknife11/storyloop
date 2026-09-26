/**
 * v1.9.0 失败分析的读取与装配：把磁盘上已经存在的那些文件收成一个
 * FailureAnalysisInput，交给 FailureAnalyzer 分类。
 *
 * §3/§35 为什么读盘而不是从内存里搬：分析结论必须和读者能打开的文件
 * 逐字对得上——证据指向 validation.json，那读者就得真在 Run 目录里看见
 * validation.json。Pipeline 收尾时也是走这条路径（写完 metadata 之后），
 * 于是存下来的分析永远对应落盘后的那一份事实。
 *
 * §35 旧 Run：没有 telemetry.json / run-manifest.json / failure-analysis.json
 * 都照样能读——缺的那些项就是 null 或 unknown，分析器按「证据不足」
 * 处理，不补默认值，也不回填历史 Run。
 */

import { ArtifactStore } from "@/storage/artifact-store";
import { FailureAnalyzer } from "@/core/failure-analyzer";
import type {
  FailureAnalysisAttempt,
  FailureAnalysisInput,
  FailureAnalysisResult,
  FailureArtifactPresence,
} from "@/types/failure-analysis";
import type { RunManifest } from "@/types/run-manifest";

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** §3/§42 产物存在性：只报「文件在不在」，不判断内容对不对。 */
function presenceOf(runId: string, store: ArtifactStore): FailureArtifactPresence {
  return {
    story: store.readFinalStory(runId) !== null,
    beatValidation: store.readFinalBeatValidation(runId) !== null,
    validation: store.readFinalValidation(runId) !== null,
    review: store.readFinalReview(runId) !== null,
    commercialReview: store.readFinalCommercialReview(runId) !== null,
    quality: store.readFinalQuality(runId) !== null,
    manifest: store.readRunManifest(runId) !== null,
    telemetry: store.readRunTelemetry(runId) !== null,
  };
}

/**
 * §38/§39 各 Attempt 的采纳结论与修订记录：出身清单是最完整的来源。
 * v1.6.0 之前的 Run 没有清单，就只报「跑了几次」——采纳状态读不到时
 * 分析器不会声称重试耗尽（那需要 accepted 为假的证据）。
 */
function attemptsOf(manifest: RunManifest | null, runId: string, store: ArtifactStore): FailureAnalysisAttempt[] {
  if (manifest && manifest.attempts.length > 0) {
    const repairsByAttempt = new Map<string, { repairNumber: number; issueType: string; success: boolean }[]>();
    for (const repair of manifest.repairs) {
      const list = repairsByAttempt.get(repair.attemptId) ?? [];
      list.push({
        repairNumber: repair.index,
        issueType: repair.category ?? "general",
        success: repair.succeeded,
      });
      repairsByAttempt.set(repair.attemptId, list);
    }
    return manifest.attempts.map((attempt) => ({
      attemptNumber: attempt.index,
      accepted: attempt.status === "accepted" ? true : false,
      retryReason: strOf(attempt.retryReason),
      validationPassed: null,
      repairCount: attempt.repairIds.length,
      repairs: repairsByAttempt.get(attempt.attemptId) ?? [],
    }));
  }
  return store.listAttemptNumbers(runId).map((n) => ({
    attemptNumber: n,
    accepted: null,
    retryReason: null,
    validationPassed: null,
    repairCount: 0,
    repairs: [],
  }));
}

/**
 * §40 状态型事实 → 错误码。这里只做「哪一步自身失败了」的直译，
 * 不解释为什么失败；真正的原因码由 Pipeline 在异常链那一侧给出。
 */
function codesOfState(input: {
  status: string | null;
  telemetryFailureCode: string | null;
  beatValidationStatus: string | null;
  validationStatus: string | null;
  reviewStatus: string | null;
  commercialReviewStatus: string | null;
}): string[] {
  const codes: string[] = [];
  if (input.telemetryFailureCode) codes.push(input.telemetryFailureCode);
  // 旧 Run 没有遥测又确实失败了：留一个明说的「未归类」码，不猜
  if (input.status === "failed" && input.telemetryFailureCode === null) codes.push("RUN_FAILED");
  if (input.beatValidationStatus === "failed") codes.push("BEAT_VALIDATION_COMPONENT_FAILED");
  if (input.validationStatus === "failed") codes.push("VALIDATION_COMPONENT_FAILED");
  if (input.reviewStatus === "failed") codes.push("REVIEW_COMPONENT_FAILED");
  if (input.commercialReviewStatus === "failed") codes.push("COMMERCIAL_REVIEW_COMPONENT_FAILED");
  return [...new Set(codes)];
}

/** §3：从磁盘装配一次完整输入。extraCodes 给 Pipeline 传异常链上的真实错误码。 */
export function failureAnalysisInputOf(
  runId: string,
  store: ArtifactStore,
  extraCodes: readonly string[] = [],
): FailureAnalysisInput {
  const meta = store.readRunMetadata(runId);
  const manifest = store.readRunManifest(runId);
  const telemetry = store.readRunTelemetry(runId);
  const status = strOf(meta?.status);
  const beatValidationStatus = strOf(meta?.beat_validation_status) ?? "not_started";
  const validationStatus = strOf(meta?.validation_status) ?? "not_started";
  const reviewStatus = strOf(meta?.review_status) ?? "not_started";
  const commercialReviewStatus = strOf(meta?.commercial_review_status) ?? "not_started";
  const retry = manifest?.parameters?.retry;

  return {
    runId,
    status,
    qualityStatus: strOf(meta?.quality_status),
    attemptCount: intOf(meta?.attempt_count) ?? (manifest ? manifest.attempts.length : null),
    selectedAttempt: intOf(meta?.selected_attempt) ?? null,
    maxAttempts: intOf(meta?.max_attempts) ?? (retry ? retry.maxAttempts : null),
    minReviewScore: intOf(meta?.min_review_score) ?? (retry ? retry.minReviewScore : null),
    enableRepair: boolOf(meta?.enable_repair) ?? (retry ? retry.enableRepair : null),
    maxRepairsPerAttempt:
      intOf(meta?.max_repairs_per_attempt) ?? (retry ? retry.maxRepairsPerAttempt : null),
    repairCount: intOf(meta?.repair_count) ?? (manifest ? manifest.repairs.length : null),
    telemetry,
    beatValidation: store.readFinalBeatValidation(runId),
    beatValidationStatus,
    validation: store.readFinalValidation(runId),
    validationStatus,
    review: store.readFinalReview(runId),
    reviewStatus,
    commercialReview: store.readFinalCommercialReview(runId),
    commercialReviewStatus,
    quality: store.readFinalQuality(runId),
    attempts: attemptsOf(manifest, runId, store),
    errorCodes: [
      ...codesOfState({
        status,
        telemetryFailureCode: strOf(telemetry?.failureCode),
        beatValidationStatus,
        validationStatus,
        reviewStatus,
        commercialReviewStatus,
      }),
      ...extraCodes,
    ],
    artifactPresence: presenceOf(runId, store),
  };
}

/** §23：读盘 → 分类。不写任何文件（写盘是 ArtifactStore 的事）。 */
export function analyzeStoredRun(
  runId: string,
  store: ArtifactStore,
  extraCodes: readonly string[] = [],
): FailureAnalysisResult {
  return new FailureAnalyzer().analyze(failureAnalysisInputOf(runId, store, extraCodes));
}

/**
 * §30 metadata 的两个 additive 摘要字段。
 *
 * 只有两个数：这次分析跑没跑成（failure_analysis_status）与主要失败类别
 * （primary_failure_category）。分析器自己出错时不写这两个键——
 * 「没分析」和「分析出来是某类」是两件事，不能拿一个假类别占位。
 */
export function failureAnalysisMetadataPatch(analysis: FailureAnalysisResult | null): {
  failure_analysis_status: string;
  primary_failure_category?: string;
} {
  if (analysis === null) return { failure_analysis_status: "unavailable" };
  const patch: { failure_analysis_status: string; primary_failure_category?: string } = {
    failure_analysis_status: analysis.status,
  };
  if (analysis.primaryCategory) patch.primary_failure_category = analysis.primaryCategory;
  return patch;
}
