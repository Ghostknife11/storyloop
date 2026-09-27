/**
 * v2.0.0 Ports：Run 产物存储端口（§13/§22/§43）。
 *
 * 这是 Engine / Application / Analysis 眼中「一次 Run 的产物」的唯一形状。
 * 它们只看得见这里声明的方法，看不见文件系统、看不见原子写、看不见路径拼接。
 *
 * 实现：FileArtifactStore（src/infrastructure/storage/artifact-store.ts）。
 * 测试替身：内存实现或直接传一个只读副本。
 *
 * 读写语义与 v1.x 完全一致（§20/§21）：v1.9.0 及更早写下的 Run 目录
 * 必须能被这个端口原样读出来，反之亦然——所以端口的方法名一个都没改，
 * 只改了它所属的位置。
 */

import type { StoryConfig } from "@/domain/story-config";
import type { BeatPlan } from "@/domain/beat-plan";
import type { ReviewResult } from "@/domain/review-result";
import type { ValidationResult } from "@/domain/validation-result";
import type { QualityResult } from "@/domain/quality";
import type { BeatValidationResult } from "@/domain/beat-validation";
import type { CommercialReviewResult } from "@/domain/commercial-review";
import type { FailureAnalysisResult } from "@/domain/failure-analysis";
import type { QualityStackResult } from "@/domain/quality-stack";
import type { RunManifest } from "@/domain/run-manifest";
import type { RunTelemetry } from "@/domain/telemetry";
import type { RepairMetadata, RepairRequestRecord } from "@/domain/repair";

export interface ArtifactStore {
  // —— Run 级写入 ——
  createRunDirectory(runId: string): string;
  putConfig(runId: string, config: StoryConfig): string;
  putBeatPlan(runId: string, plan: BeatPlan): string;
  putStory(runId: string, title: string, story: string): string;
  putReview(runId: string, review: ReviewResult): string;
  putValidation(runId: string, validation: ValidationResult): string;
  putQuality(runId: string, quality: QualityResult): string;
  putBeatValidation(runId: string, beatValidation: BeatValidationResult): string;
  putCommercialReview(runId: string, commercialReview: CommercialReviewResult): string;
  putMetadata(runId: string, metadata: Record<string, unknown>): string;
  putFailureAnalysis(runId: string, analysis: FailureAnalysisResult): string;
  putQualityStack(runId: string, stack: QualityStackResult): string;
  putTelemetry(runId: string, telemetry: RunTelemetry): string;
  putManifest(runId: string, manifest: RunManifest): string;

  // —— 存在性 ——
  runExists(runId: string): boolean;
  artifactExists(runId: string, artifactPath: string): boolean;
  attemptExists(runId: string, attemptNumber: number): boolean;

  /**
   * Run 目录的绝对路径，只给测试和调试用（接口层不许把它写进响应体，§67）。
   * 它属于实现细节，所以在端口里排在读写之后——调用方通常不需要它。
   */
  resolveRunDir(runId: string): string;

  // —— Attempt / Repair 写入 ——
  createAttemptDirectory(runId: string, attemptNumber: number): string;
  putAttemptStory(runId: string, attemptNumber: number, title: string, story: string): string;
  putAttemptValidation(runId: string, attemptNumber: number, validation: ValidationResult): string;
  putAttemptReview(runId: string, attemptNumber: number, review: ReviewResult): string;
  putAttemptQuality(runId: string, attemptNumber: number, quality: QualityResult): string;
  putAttemptCommercialReview(
    runId: string,
    attemptNumber: number,
    review: CommercialReviewResult,
  ): string;
  putAttemptMetadata(runId: string, attemptNumber: number, metadata: Record<string, unknown>): string;
  putAttemptInitialStory(runId: string, attemptNumber: number, title: string, story: string): string;
  putRepairRequest(runId: string, attemptNumber: number, request: RepairRequestRecord): string;
  putRepairStory(
    runId: string,
    attemptNumber: number,
    repairNumber: number,
    title: string,
    story: string,
  ): string;
  putRepairValidation(
    runId: string,
    attemptNumber: number,
    repairNumber: number,
    validation: ValidationResult,
  ): string;
  putRepairReview(
    runId: string,
    attemptNumber: number,
    repairNumber: number,
    review: ReviewResult,
  ): string;
  putRepairMetadata(
    runId: string,
    attemptNumber: number,
    repairNumber: number,
    metadata: RepairMetadata,
  ): string;
  promoteAttempt(runId: string, attemptNumber: number): Record<string, string>;

  // —— 枚举 ——
  listAttemptNumbers(runId: string): number[];
  listRepairNumbers(runId: string, attemptNumber: number): number[];

  // —— 读取 ——
  readArtifactText(runId: string, artifactPath: string): string | null;
  readRunMetadata(runId: string): Record<string, unknown> | null;
  readRunManifest(runId: string): RunManifest | null;
  readRunTelemetry(runId: string): RunTelemetry | null;
  readFailureAnalysis(runId: string): FailureAnalysisResult | null;
  readQualityStack(runId: string): QualityStackResult | null;
  readAttemptMetadata(runId: string, attemptNumber: number): Record<string, unknown> | null;
  readAttemptStory(runId: string, attemptNumber: number): string | null;
  readAttemptInitialStory(runId: string, attemptNumber: number): string | null;
  readAttemptValidation(runId: string, attemptNumber: number): ValidationResult | null;
  readAttemptReview(runId: string, attemptNumber: number): ReviewResult | null;
  readAttemptQuality(runId: string, attemptNumber: number): QualityResult | null;
  readAttemptCommercialReview(
    runId: string,
    attemptNumber: number,
  ): CommercialReviewResult | null;
  readRepairValidation(runId: string, attemptNumber: number, repairNumber: number): ValidationResult | null;
  readRepairReview(runId: string, attemptNumber: number, repairNumber: number): ReviewResult | null;
  readFinalStory(runId: string): string | null;
  readFinalValidation(runId: string): ValidationResult | null;
  readFinalReview(runId: string): ReviewResult | null;
  readFinalQuality(runId: string): QualityResult | null;
  readFinalBeatValidation(runId: string): BeatValidationResult | null;
  readFinalCommercialReview(runId: string): CommercialReviewResult | null;
}

/**
 * §43 里与 ExperimentRepository 并列的第三个名字：RunRepository。
 *
 * 它就是上面这个 ArtifactStore，一个名字一副职责：Run 的读写。任务书同时点到了
 * ArtifactStore 与 RunRepository 两处，方法面却一个字都不该有两份——所以这里是
 * 别名而不是新接口。也正因为没有 `GenericRepository<T>`，「Run 仓储」与「实验
 * 仓储」是两个各说各话的小接口，谁也不用泛型把对方套住。
 */
export type RunRepository = ArtifactStore;
