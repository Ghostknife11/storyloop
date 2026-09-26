/**
 * v1.8.0 Run 级可观测性（Observability）的数据契约。
 *
 * 这三个文件各管一件事，互不替代：
 *   metadata.json    = 状态摘要（这次跑到哪、结论是什么）
 *   run-manifest.json = 配置 / 版本 / provenance（这次跑在什么上面）
 *   telemetry.json    = 执行过程（这次跑了多久、调了几次模型、在哪一步失败）
 *
 * 三条不可协商的边界，决定了下面每一个字段为什么长这样：
 *
 * 1. **只观察，不控制**。这里没有一个字段是给 Retry / Repair / 接受判定用的。
 *    TelemetryCollector 读得到流程状态，但它对流程没有任何写入口（§16/§61）。
 * 2. **拿不到就是 null，绝不补 0**。1000 tokens、null、1200 tokens 的均值只能对
 *    已知值求，分母是有值的样本数（§8/§24）。补 0 等于凭空捏造一次「没有 usage」。
 * 3. **不落正文，不落密钥，不落原始异常**。完整 Prompt / 正文 / 用户输入都在别的
 *    产物里，这里只放运行指标；异常只降级成一个稳定 errorCode，异常原文一个字都不进
 *    （§20/§21/§22）——因为「安全文案」这件事上，少写比写错安全。
 */

/** 遥测自身的 schema 版本，与 run-manifest 的 schemaVersion 相互独立（§34）。 */
export const TELEMETRY_SCHEMA_VERSION = "1";

/**
 * 稳定阶段名（§6）——**以真实 Pipeline 的阶段命名为准**，不是另起一套漂亮名字。
 * RunContext 里的 RunStatus 逐个对应，另加一个 artifact_promotion：
 * promote 是真实发生的一步（把入选 Attempt 的产物复制到运行根），值得单独计时，
 * 但它不是 RunStatus，所以它只出现在遥测里，不进 metadata 的 current_stage。
 */
export const STAGE_NAMES = [
  "planning",
  "validating_beat_plan",
  "generating",
  "saving",
  "validating",
  "reviewing",
  "repairing",
  "revalidating",
  "rereviewing",
  "reviewing_commercial",
  "artifact_promotion",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export function isStageName(value: unknown): value is StageName {
  return typeof value === "string" && (STAGE_NAMES as readonly string[]).includes(value);
}

/** §6 阶段状态。skipped 表示「这一步这一版没接 / 没跑到」，与 failed 是两件事。 */
export type StageTelemetryStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** §7 一次逻辑 LLM 调用的结局。transport 重试算在同一次调用里，不拆成多条。 */
export type LLMCallStatus = "completed" | "failed";

/** §9 一次 Attempt 的结局。retried = 没过且后面还有 Attempt；exhausted 由 Run 级表达。 */
export type AttemptTelemetryStatus = "accepted" | "retried" | "failed";

/** §10 一次定点修订的结局。 */
export type RepairTelemetryStatus = "success" | "failed";

/** §5/§14 一次 Run 的进程级结局：与 metadata.status 同一口径。 */
export type RunTelemetryStatus = "completed" | "failed";

/** §7/§8 费用。只有 Provider 真实返回金额与币种时才可能有值，否则整个键不出现。 */
export interface TelemetryCost {
  amount: number;
  currency: string;
}

/**
 * §6 一个阶段的**一次执行**。同一个阶段在一次 Run 里可能跑多次
 * （validating 在每个 Attempt 都出现），所以这里记的是发生次数，不是「这个阶段的平均值」。
 * 聚合（求和 / 计数）是读的一侧的事，采集器不预先汇总——预先汇总就把「跑了三次」
 * 和「跑了一次但很慢」混成一个数了。
 */
export interface StageTelemetry {
  stage: StageName;
  status: StageTelemetryStatus;

  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;

  /** 稳定错误码；失败时必有，成功时这个键不出现。 */
  errorCode?: string | null;

  /** 这一段属于第几次 Attempt（Attempt 之外的阶段没有这个键）。 */
  attemptNumber?: number | null;
}

/** §7 一次逻辑 LLM 调用：阶段 / 模型 / 起止 / 真实 usage / 结局。 */
export interface LLMCallTelemetry {
  id: string;
  stage: StageName;

  model?: string | null;
  /** Provider 归属。这个仓库不在任何地方记录 Provider 名（run-manifest 连 baseUrl 原文都不存），
   *  所以这里同样只有 null——可观测不等于把部署信息抄进产物（§7）。 */
  provider?: string | null;

  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;

  status: LLMCallStatus;

  /** §8 真实返回的 usage；Provider 不给就是 null，不做任何估算。 */
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;

  /** §8 费用：只有 Provider 真给（金额 + 币种都在）才有，否则整个键不出现。 */
  cost?: TelemetryCost | null;

  errorCode?: string | null;
}

/** §9 一次 Attempt 的过程指标。retry 的判定不在这里发生，这里只数数。 */
export interface AttemptTelemetry {
  attemptId: string;
  index: number;
  status: AttemptTelemetryStatus;

  durationMs?: number | null;

  /** 这一次 Attempt 里，各步骤分别调了几次模型。 */
  generationCalls: number;
  reviewCalls: number;
  commercialReviewCalls: number;
  /** §17：Repair 不新增 Attempt，所以它挂在本次 Attempt 名下计数。 */
  repairCount: number;
}

/** §10 一次定点修订的过程指标。 */
export interface RepairTelemetry {
  repairId: string;
  attemptId: string;

  /** 修的是哪一类问题；RepairStrategy 没给出归类时是 null。 */
  category?: string | null;
  status: RepairTelemetryStatus;

  durationMs?: number | null;
  /** 这次修订期间发生的全部模型调用（含修完之后的重新校验 / 重新审阅）。 */
  llmCalls: number;
}

/**
 * §11 Run 级汇总。
 *
 * token 三项与 usageSampleCount 的关系：三个值是「有值的那些调用」之和，
 * usageSampleCount 是「至少有一个 token 字段的调用」数。Provider 一次都没给 usage 时
 * 这三个键整个不出现（写盘时 null 被丢掉，与 llmCalls 里没有 usage 的那次同一种记法），
 * 而 llmCalls 是真实次数——「调了 6 次但一次都没拿到 usage」与
 * 「一次都没调」在读起来必须是两件事。
 */
export interface TelemetryTotals {
  durationMs?: number | null;

  llmCalls: number;

  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** 上面三项的分母：至少带一个 token 字段的调用数。 */
  usageSampleCount: number;

  /** §12：attempts = 3 → retries = 2。一次都没跑成时是 0，不是 -1。 */
  retries: number;
  repairs: number;

  /** status 为 failed 的阶段数。 */
  failedStages: number;
}

/** §5 一条 Run 的完整遥测：telemetry.json 的顶层形状。 */
export interface RunTelemetry {
  schemaVersion: string;
  runId: string;

  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;

  status: RunTelemetryStatus;
  /** §13 失败发生在哪个阶段。不是原因，也不允许从它推断原因（§60）。 */
  failureStage?: string | null;
  failureCode?: string | null;

  stages: StageTelemetry[];
  llmCalls: LLMCallTelemetry[];
  attempts: AttemptTelemetry[];
  repairs: RepairTelemetry[];

  totals: TelemetryTotals;
}

// ---------------------------------------------------------------------------
// 读写两侧共用的错误与归一化
// ---------------------------------------------------------------------------

export class TelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryError";
  }
}

function strOf(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new TelemetryError(`${field} 必须是非空字符串`);
  return raw;
}

function optStrOf(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return strOf(raw, field);
}

/** 可空数字：null / 缺失 → undefined（键不出现），有限数字原样返回。 */
function optNumOf(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new TelemetryError(`${field} 必须是数字`);
  return raw;
}

function numOf(raw: unknown, field: string): number {
  const value = optNumOf(raw, field);
  if (value === undefined) throw new TelemetryError(`${field} 必须存在且是数字`);
  return value;
}

function intOf(raw: unknown, field: string, min = 0): number {
  const value = numOf(raw, field);
  if (!Number.isInteger(value) || value < min) throw new TelemetryError(`${field} 必须是不小于 ${min} 的整数`);
  return value;
}

/**
 * 可选键的统一拼法：有值才带这个键，没值整个键不出现（§24 的 null 语义）。
 *
 * 按**值**判定，不是按包装对象判定：传进来的对象恒为真，早先那版只看对象在不在，
 * 于是 `errorCode: undefined` 也会作为一个键留下——JSON.stringify 会把它丢掉，
 * 可内存里那份对象的 Object.keys 就多出几个不存在的字段，读一侧据此判断
 * 「有没有这个字段」时会读错。
 */
function opt<T extends object>(value: Partial<T> | undefined | null): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value ?? {})) {
    if (v !== undefined) out[key] = v;
  }
  return out as Partial<T>;
}

export function validateStageTelemetry(raw: unknown): StageTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("stage 必须是对象");
  const r = raw as Record<string, unknown>;
  const stage = strOf(r.stage, "stage");
  if (!isStageName(stage)) throw new TelemetryError(`stage 不是已知阶段名：${stage}`);
  const status = strOf(r.status, "status");
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "skipped"
  ) {
    throw new TelemetryError(`stage.status 不合法：${status}`);
  }
  const attempt = optNumOf(r.attemptNumber, "attemptNumber");
  return {
    stage,
    status,
    ...opt<StageTelemetry>({ startedAt: optStrOf(r.startedAt, "startedAt") }),
    ...opt<StageTelemetry>({ completedAt: optStrOf(r.completedAt, "completedAt") }),
    ...opt<StageTelemetry>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    ...opt<StageTelemetry>({ errorCode: optStrOf(r.errorCode, "errorCode") }),
    ...opt<StageTelemetry>({ attemptNumber: attempt !== undefined ? intOf(attempt, "attemptNumber", 1) : undefined }),
  };
}

function callId(raw: unknown, index: number): string {
  const value = optStrOf(raw, "id");
  return value ?? `call-${String(index + 1).padStart(3, "0")}`;
}

export function validateLLMCallTelemetry(raw: unknown, index = 0): LLMCallTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("llmCall 必须是对象");
  const r = raw as Record<string, unknown>;
  const stage = strOf(r.stage, "stage");
  if (!isStageName(stage)) throw new TelemetryError(`llmCall.stage 不是已知阶段名：${stage}`);
  const status = strOf(r.status, "status");
  if (status !== "completed" && status !== "failed") throw new TelemetryError(`llmCall.status 不合法：${status}`);
  const cost = r.cost;
  let costInfo: TelemetryCost | undefined;
  if (cost !== undefined && cost !== null) {
    if (typeof cost !== "object") throw new TelemetryError("llmCall.cost 必须是对象");
    const c = cost as Record<string, unknown>;
    const currency = strOf(c.currency, "cost.currency");
    const amount = numOf(c.amount, "cost.amount");
    // 币种与金额必须同时在：只有一个时无法判断单位，宁可不记
    costInfo = { amount, currency };
  }
  return {
    id: callId(r.id, index),
    stage,
    startedAt: strOf(r.startedAt, "startedAt"),
    status,
    ...opt<LLMCallTelemetry>({ model: optStrOf(r.model, "model") }),
    ...opt<LLMCallTelemetry>({ provider: optStrOf(r.provider, "provider") }),
    ...opt<LLMCallTelemetry>({ completedAt: optStrOf(r.completedAt, "completedAt") }),
    ...opt<LLMCallTelemetry>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    ...opt<LLMCallTelemetry>({ inputTokens: optNumOf(r.inputTokens, "inputTokens") }),
    ...opt<LLMCallTelemetry>({ outputTokens: optNumOf(r.outputTokens, "outputTokens") }),
    ...opt<LLMCallTelemetry>({ totalTokens: optNumOf(r.totalTokens, "totalTokens") }),
    ...opt<LLMCallTelemetry>({ cost: costInfo }),
    ...opt<LLMCallTelemetry>({ errorCode: optStrOf(r.errorCode, "errorCode") }),
  };
}

export function validateAttemptTelemetry(raw: unknown): AttemptTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("attempt 必须是对象");
  const r = raw as Record<string, unknown>;
  const status = strOf(r.status, "status");
  if (status !== "accepted" && status !== "retried" && status !== "failed") {
    throw new TelemetryError(`attempt.status 不合法：${status}`);
  }
  return {
    attemptId: strOf(r.attemptId, "attemptId"),
    index: intOf(r.index, "index", 1),
    status,
    ...opt<AttemptTelemetry>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    generationCalls: intOf(r.generationCalls, "generationCalls"),
    reviewCalls: intOf(r.reviewCalls, "reviewCalls"),
    commercialReviewCalls: intOf(r.commercialReviewCalls, "commercialReviewCalls"),
    repairCount: intOf(r.repairCount, "repairCount"),
  };
}

export function validateRepairTelemetry(raw: unknown): RepairTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("repair 必须是对象");
  const r = raw as Record<string, unknown>;
  const status = strOf(r.status, "status");
  if (status !== "success" && status !== "failed") throw new TelemetryError(`repair.status 不合法：${status}`);
  return {
    repairId: strOf(r.repairId, "repairId"),
    attemptId: strOf(r.attemptId, "attemptId"),
    status,
    ...opt<RepairTelemetry>({ category: optStrOf(r.category, "category") }),
    ...opt<RepairTelemetry>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    llmCalls: intOf(r.llmCalls, "llmCalls"),
  };
}

function validateTotals(raw: unknown): TelemetryTotals {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("totals 必须是对象");
  const r = raw as Record<string, unknown>;
  return {
    ...opt<TelemetryTotals>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    llmCalls: intOf(r.llmCalls, "llmCalls"),
    ...opt<TelemetryTotals>({ inputTokens: optNumOf(r.inputTokens, "inputTokens") }),
    ...opt<TelemetryTotals>({ outputTokens: optNumOf(r.outputTokens, "outputTokens") }),
    ...opt<TelemetryTotals>({ totalTokens: optNumOf(r.totalTokens, "totalTokens") }),
    usageSampleCount: intOf(r.usageSampleCount, "usageSampleCount"),
    retries: intOf(r.retries, "retries"),
    repairs: intOf(r.repairs, "repairs"),
    failedStages: intOf(r.failedStages, "failedStages"),
  };
}

/** 结构校验：形状不对就抛 TelemetryError（写盘前自查用）。 */
export function validateRunTelemetry(raw: unknown): RunTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("telemetry 必须是对象");
  const r = raw as Record<string, unknown>;
  if (strOf(r.schemaVersion, "schemaVersion") !== TELEMETRY_SCHEMA_VERSION) {
    throw new TelemetryError(`schemaVersion 只支持 ${TELEMETRY_SCHEMA_VERSION}`);
  }
  const status = strOf(r.status, "status");
  if (status !== "completed" && status !== "failed") throw new TelemetryError(`status 不合法：${status}`);
  const arrays = ["stages", "llmCalls", "attempts", "repairs"] as const;
  for (const key of arrays) {
    if (!Array.isArray(r[key])) throw new TelemetryError(`${key} 必须是数组`);
  }
  const stages = (r.stages as unknown[]).map(validateStageTelemetry);
  const llmCalls = (r.llmCalls as unknown[]).map((call, i) => validateLLMCallTelemetry(call, i));
  const attempts = (r.attempts as unknown[]).map(validateAttemptTelemetry);
  const repairs = (r.repairs as unknown[]).map(validateRepairTelemetry);
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: strOf(r.runId, "runId"),
    startedAt: strOf(r.startedAt, "startedAt"),
    status,
    ...opt<RunTelemetry>({ completedAt: optStrOf(r.completedAt, "completedAt") }),
    ...opt<RunTelemetry>({ durationMs: optNumOf(r.durationMs, "durationMs") }),
    ...opt<RunTelemetry>({ failureStage: optStrOf(r.failureStage, "failureStage") }),
    ...opt<RunTelemetry>({ failureCode: optStrOf(r.failureCode, "failureCode") }),
    stages,
    llmCalls,
    attempts,
    repairs,
    totals: validateTotals(r.totals),
  };
}

/** 读取时归一化：任何形状问题都归一成 null，不抛给调用方（与 runManifestOf 同一约定）。 */
export function runTelemetryOf(raw: unknown): RunTelemetry | null {
  try {
    return validateRunTelemetry(raw);
  } catch {
    return null;
  }
}
