/**
 * v1.8.0 TelemetryCollector：把一次 Run 的执行过程记成结构化数据。
 *
 * 这个类只有写入口，没有读流程的入口：它拿不到 RetryPolicy、不知道阈值、
 * 不接触 decideRetry，也不改任何生成参数（TASK §16/§61）。Pipeline 往这儿报数，
 * 报完照旧按原逻辑往下走——采集器坏了最多是 telemetry.json 缺一块，
 * 不可能把一次成功的 Run 变成失败，也不可能改变任何一次重试决策。
 *
 * 三个实现上的选择：
 *
 * 1. **阶段是顺序推进的**，所以「进入下一个阶段」就等于「上一个阶段结束」。
 *    这样 Pipeline 只需要在既有的 transitionStage 旁边多喊一声，
 *    不需要给每一步都补一个 try/finally（TASK §17 低侵入）。
 * 2. **时长用单调时钟**（performance.now），不受系统时间调整影响；
 *    startedAt / completedAt 是 ISO 8601 UTC，给人读的（TASK §18）。
 * 3. **LLM 调用由共享客户端往这儿报**，阶段归属取「调用发生时正处于哪个阶段」，
 *    而不是组件自称的阶段——于是重新校验 / 重新审阅会被如实记在 revalidating /
 *    rereviewing 上，六个组件一个都不用改（TASK §19）。
 */

import type {
  AttemptTelemetry,
  AttemptTelemetryStatus,
  LLMCallTelemetry,
  LLMCallStatus,
  RepairTelemetry,
  RepairTelemetryStatus,
  RunTelemetry,
  RunTelemetryStatus,
  StageName,
  StageTelemetry,
  StageTelemetryStatus,
  TelemetryCost,
} from "@/types/telemetry";
import { isStageName } from "@/types/telemetry";

/** 共享 LLM 客户端只依赖这一小块：报一次调用 + 问现在在哪个阶段。 */
export interface LLMTelemetrySink {
  currentStage(): StageName | null;
  recordLLMCall(call: LLMCallReport): void;
}

/** 客户端报上来的一次逻辑调用（不含 id / provider 这类由采集器补的字段）。 */
export interface LLMCallReport {
  model: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: LLMCallStatus;
  /** Provider 真实返回的 usage；没有就是 null，客户端不做估算。 */
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** 只有金额与币种同时真实可得时才带；否则整个键不出现。 */
  cost?: TelemetryCost | null;
  /** 稳定错误码；异常原文不进这里。 */
  errorCode?: string | null;
}

/** §22 错误只降级成稳定码：原文一个字都不落盘。 */
export type TelemetryErrorCode =
  | "LLM_TIMEOUT"
  | "LLM_REQUEST_FAILED"
  | "LLM_EMPTY_RESPONSE"
  | "VALIDATION_COMPONENT_FAILED"
  | "REVIEW_COMPONENT_FAILED"
  | "BEAT_VALIDATION_COMPONENT_FAILED"
  | "COMMERCIAL_REVIEW_COMPONENT_FAILED"
  | "GENERATION_FAILED"
  | "BEAT_PLAN_REJECTED"
  | "ARTIFACT_WRITE_FAILED"
  | "RUN_FAILED";

/** 错误码 → 固定文案。写死在这里，就不可能把异常里的路径 / 凭据带进产物。 */
const ERROR_MESSAGES: Record<TelemetryErrorCode, string> = {
  LLM_TIMEOUT: "模型调用超时",
  LLM_REQUEST_FAILED: "模型调用失败（网络或服务端返回错误）",
  LLM_EMPTY_RESPONSE: "模型返回内容为空",
  VALIDATION_COMPONENT_FAILED: "正文校验组件自身失败",
  REVIEW_COMPONENT_FAILED: "质量审阅组件自身失败",
  BEAT_VALIDATION_COMPONENT_FAILED: "骨架校验组件自身失败",
  COMMERCIAL_REVIEW_COMPONENT_FAILED: "商业可读性审阅组件自身失败",
  GENERATION_FAILED: "正文生成失败",
  BEAT_PLAN_REJECTED: "骨架结构校验未通过",
  ARTIFACT_WRITE_FAILED: "产物写入失败",
  RUN_FAILED: "Run 失败（未归类）",
};

export function telemetryErrorMessage(code: string): string {
  return ERROR_MESSAGES[code as TelemetryErrorCode] ?? "发生了未记录原因的失败";
}

export function isTelemetryErrorCode(value: unknown): value is TelemetryErrorCode {
  return typeof value === "string" && value in ERROR_MESSAGES;
}

/**
 * 单调时钟（毫秒）：只用于算差值，不用于生成时间戳。
 * 用 performance.now 而不是 process.hrtime.bigint()：target 是 ES2017，
 * BigInt 字面量用不了；也不用 Date.now()，它受系统时间调整影响。
 */
function hrtimeMs(): number {
  return performance.now();
}

function isoNow(): string {
  return new Date().toISOString();
}

/** 进行中的阶段 / Attempt / Repair 的内部形态（落盘前统一收敛成对外类型）。 */
interface OpenStage {
  stage: StageName;
  attemptNumber: number | null;
  startedAt: string;
  startedMono: number;
}

interface OpenAttempt {
  attemptId: string;
  index: number;
  startedAt: string;
  startedMono: number;
  generationCalls: number;
  reviewCalls: number;
  commercialReviewCalls: number;
  repairCount: number;
  callsAtStart: number;
}

interface OpenRepair {
  repairId: string;
  attemptId: string;
  category: string | null;
  startedAt: string;
  startedMono: number;
  callsAtStart: number;
}

/**
 * 采集器。一个实例对应一次 Run，构造时报 runId（Run id 生成之前造的实例留空，
 * 由 Pipeline 在 enter 之前补上）。
 */
export class TelemetryCollector implements LLMTelemetrySink {
  private runId: string;
  private readonly startedAt: string;
  private readonly startedMono = hrtimeMs();

  private openStage: OpenStage | null = null;
  private openAttempt: OpenAttempt | null = null;
  private openRepair: OpenRepair | null = null;

  /** 阶段出现顺序（含 skipped）；同一阶段跑几次就出现几次。 */
  private stages: StageTelemetry[] = [];
  private llmCalls: LLMCallTelemetry[] = [];
  private attempts: AttemptTelemetry[] = [];
  private repairs: RepairTelemetry[] = [];

  /** 每个 attempt / repair 作用域开始时已经累计的调用数，用于给它们算增量。 */
  private totalCalls = 0;

  private closed = false;

  constructor(runId = "") {
    this.runId = runId;
    this.startedAt = isoNow();
  }

  /** Pipeline 生成 run_id 之后补上（构造时还不知道）。 */
  bindRun(runId: string): void {
    if (!this.runId) this.runId = runId;
  }

  // ---------------------------------------------------------------------------
  // 阶段
  // ---------------------------------------------------------------------------

  /**
   * 进入一个阶段：先把上一个开着的阶段按 completed 收尾，再开新的。
   * 这一步不判断该不该进入——流程归 Pipeline 管，采集器只记时（§16）。
   */
  enter(stage: StageName, attemptNumber?: number | null): void {
    if (this.closed) return;
    if (!isStageName(stage)) return;
    this.closeStage("completed", null);
    this.openStage = {
      stage,
      attemptNumber: attemptNumber ?? null,
      startedAt: isoNow(),
      startedMono: hrtimeMs(),
    };
  }

  /**
   * 这一步这一版没接 / 没跑到：如实记 skipped。
   * skipped 与 failed 是两件事——没接商业审阅不等于商业审阅坏了（§6）。
   */
  skip(stage: StageName, attemptNumber?: number | null): void {
    if (this.closed) return;
    if (!isStageName(stage)) return;
    this.stages.push({ stage, status: "skipped", attemptNumber: attemptNumber ?? null });
  }

  /** 开着的阶段以失败收尾。失败码由调用方给稳定码，异常原文不得传进来。 */
  failOpen(code: string): void {
    if (this.closed) return;
    this.closeStage("failed", code);
  }

  private closeStage(status: StageTelemetryStatus, code: string | null): void {
    const open = this.openStage;
    if (open === null) return;
    this.openStage = null;
    const completedAt = isoNow();
    const durationMs = Math.round(Math.max(0, hrtimeMs() - open.startedMono));
    this.stages.push({
      stage: open.stage,
      status,
      startedAt: open.startedAt,
      completedAt,
      durationMs,
      ...(code !== null ? { errorCode: code } : {}),
      ...(open.attemptNumber !== null ? { attemptNumber: open.attemptNumber } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // LLM 调用
  // ---------------------------------------------------------------------------

  currentStage(): StageName | null {
    return this.openStage?.stage ?? null;
  }

  /**
   * 客户端报一次逻辑调用。调用发生时正处于的阶段由这里定，
   * 客户端只负责把数说清楚（§19 统一 wrapper）。
   */
  recordLLMCall(report: LLMCallReport): void {
    if (this.closed) return;
    const stage = this.currentStage();
    // 没有开着的阶段（例如计划阶段之前的调用）也记，但阶段归属为空时无法安放——
    // 采集器不用假阶段补位，直接不记比编一个阶段名诚实
    if (stage === null) return;
    // 修订作用域内的调用数在 endRepair 时按 totalCalls 的差值算，
    // 这里只把这一次数记进去（含它自己）
    this.totalCalls += 1;
    const attempt = this.openAttempt;
    if (attempt !== null) {
      if (stage === "generating") attempt.generationCalls += 1;
      if (stage === "reviewing" || stage === "rereviewing") attempt.reviewCalls += 1;
      if (stage === "reviewing_commercial") attempt.commercialReviewCalls += 1;
    }
    this.llmCalls.push({
      id: `call-${String(this.llmCalls.length + 1).padStart(3, "0")}`,
      stage,
      startedAt: report.startedAt,
      status: report.status,
      completedAt: report.completedAt,
      durationMs: report.durationMs,
      ...(report.model != null ? { model: report.model } : {}),
      ...(report.inputTokens != null ? { inputTokens: report.inputTokens } : {}),
      ...(report.outputTokens != null ? { outputTokens: report.outputTokens } : {}),
      ...(report.totalTokens != null ? { totalTokens: report.totalTokens } : {}),
      ...(report.cost != null ? { cost: report.cost } : {}),
      ...(report.errorCode != null ? { errorCode: report.errorCode } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Attempt / Repair 作用域
  // ---------------------------------------------------------------------------

  /** 开一次 Attempt 的作用域：从这一刻起的调用都记在它名下。 */
  beginAttempt(index: number): void {
    if (this.openAttempt !== null) this.endAttempt("retried");
    const attemptId = `attempt-${String(index).padStart(2, "0")}`;
    this.openAttempt = {
      attemptId,
      index,
      startedAt: isoNow(),
      startedMono: hrtimeMs(),
      generationCalls: 0,
      reviewCalls: 0,
      commercialReviewCalls: 0,
      repairCount: 0,
      callsAtStart: this.totalCalls,
    };
  }

  endAttempt(status: AttemptTelemetryStatus): void {
    const open = this.openAttempt;
    if (open === null) return;
    this.openAttempt = null;
    this.attempts.push({
      attemptId: open.attemptId,
      index: open.index,
      status,
      durationMs: Math.round(Math.max(0, hrtimeMs() - open.startedMono)),
      generationCalls: open.generationCalls,
      reviewCalls: open.reviewCalls,
      commercialReviewCalls: open.commercialReviewCalls,
      repairCount: open.repairCount,
    });
  }

  beginRepair(category: string | null): void {
    if (this.openAttempt === null) return;
    if (this.openRepair !== null) this.endRepair("failed");
    const repairIndex = this.repairs.length + 1;
    const repairId = `repair-${String(repairIndex).padStart(2, "0")}`;
    this.openRepair = {
      repairId,
      attemptId: this.openAttempt.attemptId,
      category,
      startedAt: isoNow(),
      startedMono: hrtimeMs(),
      callsAtStart: this.totalCalls,
    };
  }

  endRepair(status: RepairTelemetryStatus): void {
    const open = this.openRepair;
    if (open === null) return;
    this.openRepair = null;
    if (this.openAttempt !== null) this.openAttempt.repairCount += 1;
    this.repairs.push({
      repairId: open.repairId,
      attemptId: open.attemptId,
      status,
      ...(open.category !== null ? { category: open.category } : { category: null }),
      durationMs: Math.round(Math.max(0, hrtimeMs() - open.startedMono)),
      llmCalls: Math.max(0, this.totalCalls - open.callsAtStart),
    });
  }

  // ---------------------------------------------------------------------------
  // 收尾
  // ---------------------------------------------------------------------------

  /**
   * 收敛成可落盘的 RunTelemetry。
   *
   * 失败 Run 也照样出数据：已经开着的阶段按 failed 收尾，已经跑完的部分原样保留
   * （TASK §15）。没有跑到的阶段**不补 skipped**——采集器不知道流程打算去哪，
   * 事后替它补一个「跳过」就是在替流程说话。
   */
  finish(
    status: RunTelemetryStatus,
    failure?: { stage?: string | null; code?: string | null },
  ): RunTelemetry {
    if (status === "failed") {
      if (this.openRepair !== null) this.endRepair("failed");
      if (this.openAttempt !== null) this.endAttempt("failed");
      this.failOpen(failure?.code ?? "RUN_FAILED");
    } else {
      if (this.openRepair !== null) this.endRepair("failed");
      if (this.openAttempt !== null) this.endAttempt("retried");
      this.closeStage("completed", null);
    }
    const completedAt = isoNow();
    this.closed = true;
    // 与每条阶段的 durationMs 同一个口径：单调时钟差值取整到毫秒
    const durationMs = Math.round(Math.max(0, hrtimeMs() - this.startedMono));
    return {
      schemaVersion: "1",
      runId: this.runId,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      status,
      ...(status === "failed" ? { failureStage: failure?.stage ?? null, failureCode: failure?.code ?? null } : {}),
      stages: this.stages,
      llmCalls: this.llmCalls,
      attempts: this.attempts,
      repairs: this.repairs,
      totals: this.totals(durationMs),
    };
  }

  private totals(durationMs: number): RunTelemetry["totals"] {
    const withInput = this.llmCalls.filter((c) => typeof c.inputTokens === "number");
    const withOutput = this.llmCalls.filter((c) => typeof c.outputTokens === "number");
    const withTotal = this.llmCalls.filter((c) => typeof c.totalTokens === "number");
    const sampled = this.llmCalls.filter(
      (c) =>
        typeof c.inputTokens === "number" ||
        typeof c.outputTokens === "number" ||
        typeof c.totalTokens === "number",
    );
    return {
      durationMs,
      llmCalls: this.llmCalls.length,
      // 一次 usage 都没有时三项都是 null，绝不出现 0——「没有数据」不是「零消耗」
      inputTokens: sumOf(withInput.map((c) => c.inputTokens)),
      outputTokens: sumOf(withOutput.map((c) => c.outputTokens)),
      totalTokens: sumOf(withTotal.map((c) => c.totalTokens)),
      usageSampleCount: sampled.length,
      // §12：3 次 Attempt = 2 次重试；一次都没跑出来是 0，不是 -1
      retries: Math.max(0, this.attempts.length - 1),
      repairs: this.repairs.length,
      failedStages: this.stages.filter((s) => s.status === "failed").length,
    };
  }
}

function sumOf(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0);
}
