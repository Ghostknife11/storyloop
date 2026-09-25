/**
 * v1.6.0 RunManifest：一次 Run 的**出身记录**。
 *
 * 它回答的是一个问题：这篇故事是哪一版代码、哪一个模型、哪一组参数、哪几份提示词、
 * 第几次 Attempt、哪一轮 Repair 一起产出的。因此它只是把已经发生的事实收敛成一份结构化
 * 清单，与 `metadata.json` 并列存放，不替代它、不改写它。
 *
 * 明确不做的事（与 1.x 的一贯边界一致）：
 *   - 不是实验框架：没有 ExperimentRunner、没有 A/B 分组、没有对照组；
 *   - 不是基准测试：没有 BenchmarkRunner、没有评分回归集、没有排行榜；
 *   - 不是可观测性平台：没有 Metrics / Trace / Dashboard，也没有失败归因与因果推断。
 * 这份文件只记录「当时是什么」，不回答「为什么失败」，也不比较两次 Run。
 *
 * 命名说明：`metadata.json` 的三层字段集是 v1.0.0 冻结的 snake_case 契约，一个字都不能改；
 * `run-manifest.json` 是 v1.6.0 新增的独立文件，自带 `schemaVersion`，用 camelCase 记字段，
 * 与冻结契约物理隔离——改它不需要动任何既有字段的语义。
 *
 * 实现：`src/lib/tracking/manifest-builder.ts`（装配）、`src/core/pipeline.ts`（落盘时机）
 * 契约测试：`tests/test_run_manifest_models.test.ts`、
 *           `tests/test_contract_docs_sync.test.ts`（文档字段表 ↔ 真实产物双向比对）
 */

/** 当前 Manifest 的 schema 版本；字段语义变化时递增，旧文件按同一版本号读取。 */
export const RUN_MANIFEST_SCHEMA_VERSION = "1";

/**
 * v1.6.0 提示词角色清单：与 `prompts/*.txt` 一一对应的**六个真实阶段**。
 * StoryValidator 是纯规则（不调模型、没有提示词），所以这里没有它；
 * QualityAssembler 同样不调模型（只做确定性装配），也没有提示词。
 * 不为了凑数发明不存在的角色。
 */
export const PROMPT_ROLES = [
  "planner",
  "generator",
  "beat-validator",
  "reviewer",
  "commercial-reviewer",
  "repairer",
] as const;

export type PromptRole = (typeof PROMPT_ROLES)[number];

/** 一次 Run 跑在哪个版本上；commit 只在运行环境真的提供时才出现。 */
export interface ProjectSnapshot {
  /** 与 `VERSION` 文件、`/api/version`、metadata 的 `project_version` 同一个来源。 */
  version: string;
  /** 构建 / 部署环境注入的 commit short sha（7~40 位十六进制）；拿不到时整个键不出现。 */
  commit?: string;
}

/**
 * baseUrl 的来源类别。刻意不记 baseUrl 本身：那可能是内网地址或带鉴权的地址，
 * 而 Manifest 是可能被读接口返回给前端的东西（§67：不带凭据、不带密钥）。
 */
export type BaseUrlClass = "server-configured" | "request-public-override";

/** 一个模型快照。 */
export interface ModelSnapshot {
  /** 能从 PROVIDERS 的默认地址反推出提供商名时有；自定义中转站 / 未知地址时整个键不出现。 */
  provider?: string;
  /** 本次真正生效的模型名，与 metadata 的 `model` 同一个解析结果。 */
  model: string;
  baseUrlClass: BaseUrlClass;
}

/** 一份提示词的登记项：角色 + 版本号 + 原文摘要。 */
export interface PromptSnapshot {
  role: PromptRole;
  /** 手维护的提示词版本，见 `src/lib/tracking/prompt-registry.ts`。 */
  version: string;
  /** 提示词原文（UTF-8）的 SHA-256 十六进制摘要；文件读不到时整个键不出现。 */
  digest?: string;
}

/**
 * 本次 Run 实际生效的参数。只记当前系统**真实支持**的字段——
 * `topP` / `maxTokens` 是调用形态里的占位：`LLMClient` 的请求体只发 `model` /
 * `messages` / `temperature`，所以这两个键始终不出现，不为 Manifest 发明参数。
 *
 * 五个阶段各有一个温度，因为它们的温度本来就不是同一个来源：规划与生成跟着请求的
 * `temperature` 覆盖走（缺省值分别是 0.7 与 0.8），审阅 / 商业可读性审阅 / Beat 结构校验 /
 * 定点修订是写死的固定值，不接受覆盖。记的是**真正发给模型的那个数**。
 */
export interface ParameterSnapshot {
  generation: {
    temperature: number;
    topP?: number;
    maxTokens?: number;
  };
  planning: { temperature: number };
  review: { temperature: number };
  commercialReview: { temperature: number };
  beatValidation: { temperature: number };
  repair: { temperature: number };
  retry: {
    maxAttempts: number;
    minReviewScore: number;
    retryOnValidationFailure: boolean;
    enableRepair: boolean;
    maxRepairsPerAttempt: number;
  };
}

/** 一次 Attempt 在 Manifest 里的状态：只有「满足策略」与「没满足」两种。 */
export type AttemptManifestStatus = "accepted" | "not_accepted";

/** 一次 Attempt 的出身条目。id 与目录名同形（两位数字）。 */
export interface AttemptManifestEntry {
  /** 与 `attempts/<id>/` 目录名同形，例如 `"01"`。 */
  attemptId: string;
  /** 从 1 开始的序号，与 attemptId 数值相同（便于排序与展示）。 */
  index: number;
  status: AttemptManifestStatus;
  /** 未满足策略时的原因（稳定三值之一）；accepted 时是 `null`。 */
  retryReason: string | null;
  /** 产物指向 Run 目录内的相对路径；对应文件没落盘时该键不出现。 */
  storyArtifact?: string;
  validationArtifact?: string;
  reviewArtifact?: string;
  commercialReviewArtifact?: string;
  qualityArtifact?: string;
  /** 这一次 Attempt 里发生过的 Repair id，按发生顺序排列。 */
  repairIds: string[];
}

/** 一轮 Repair 的出身条目：修的是什么、吃进哪份正文、吐出哪份正文。 */
export interface RepairManifestEntry {
  /** 与 `repairs/<id>/` 目录名同形，例如 `"01"`。 */
  repairId: string;
  /** 属于哪个 Attempt。 */
  attemptId: string;
  index: number;
  /** 这次修订针对的问题类型，取 RepairStrategy 选出的 issue_type。 */
  category?: string;
  /** 修订后重新校验 + 审阅是否满足策略；修订调用本身没跑通也是 `false`。 */
  succeeded: boolean;
  /** 修订前的正文（第一次修订是 `initial_story.md`，之后是上一轮的 story.md）。 */
  inputStoryArtifact: string;
  /** 这一轮产出的正文。 */
  outputStoryArtifact: string;
}

/** 一个产物的登记项：是什么、在哪、内容摘要是什么。 */
export interface ArtifactManifestEntry {
  /** 稳定类型名，例如 `story` / `validation` / `repairStory`。 */
  type: string;
  /** 相对 Run 目录的路径（可含 `attempts/NN/` 前缀），与磁盘上的文件名逐字一致。 */
  path: string;
  /** 文件内容的 SHA-256 十六进制摘要；文件读不到时整个键不出现。 */
  sha256?: string;
  /** 这份产物属于哪个 Attempt（attempt 级 / repair 级产物才有）。 */
  sourceAttemptId?: string;
  /** 这份产物属于哪一轮 Repair（只有 repair 级产物才有）。 */
  sourceRepairId?: string;
}

/** Run 级 Manifest。 */
export interface RunManifest {
  schemaVersion: string;
  runId: string;
  project: ProjectSnapshot;
  /** 模型快照，键是模型槽位名。当前实现只有一个 LLMClient，六个阶段共用，所以只有一个键。 */
  models: Record<string, ModelSnapshot>;
  /** 六个阶段的提示词登记项，顺序固定为 PROMPT_ROLES。 */
  prompts: PromptSnapshot[];
  parameters: ParameterSnapshot;
  /** StoryConfig 产物路径（始终存在）。 */
  storyConfigRef: string;
  /** BeatPlan 产物路径；BeatPlan 没落盘时（Beat 结构校验硬失败）整个键不出现。 */
  beatPlanRef?: string;
  attempts: AttemptManifestEntry[];
  /** 入选 Attempt 的 id；一个 Attempt 都没跑起来时整个键不出现。 */
  selectedAttemptId?: string;
  /** 全部 Repair 的出身条目，按 Attempt 再按发生顺序排列。 */
  repairs: RepairManifestEntry[];
  /**
   * 入选 Attempt 最终留下的那一版正文来自哪一轮 Repair（该 Attempt 里最后一次真正修成的）。
   * 入选 Attempt 一次都没修成时整个键不出现——那时最终正文就是初始生成的那一版。
   */
  selectedRepairId?: string;
  artifacts: ArtifactManifestEntry[];
  startedAt: string;
  /** Manifest 写入时刻（Run 已完成或已失败）；与 metadata 的 finished_at 同一口径。 */
  completedAt: string;
}

/**
 * 读取时归一化：磁盘上的 `run-manifest.json` 被手改坏、或来自未来版本时返回 `null`，
 * 由调用方按「没有 Manifest」处理——绝不让坏数据一路带进 API 响应，也不让读接口 500
 * （与 `qualityResultOf` / `beatValidationResultOf` 同一套容错约定）。
 */
export class RunManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunManifestError";
  }
}

function strOf(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RunManifestError(`${field} 必须是非空字符串`);
  }
  return raw;
}

function optStrOf(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return strOf(raw, field);
}

function numOf(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new RunManifestError(`${field} 必须是数字`);
  }
  return raw;
}

function optNumOf(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  return numOf(raw, field);
}

function strArrayOf(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new RunManifestError(`${field} 必须是数组`);
  return raw.map((item) => strOf(item, `${field}[]`));
}

function promptRoleOf(raw: unknown): PromptRole {
  const role = strOf(raw, "prompts[].role");
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) {
    throw new RunManifestError(`prompts[].role 非法：${role}`);
  }
  return role as PromptRole;
}

function projectSnapshotOf(raw: unknown): ProjectSnapshot {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("project 必须是对象");
  const r = raw as Record<string, unknown>;
  const snapshot: ProjectSnapshot = { version: strOf(r.version, "project.version") };
  const commit = optStrOf(r.commit, "project.commit");
  if (commit !== undefined) snapshot.commit = commit;
  return snapshot;
}

function modelSnapshotOf(raw: unknown, key: string): ModelSnapshot {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError(`models.${key} 必须是对象`);
  const r = raw as Record<string, unknown>;
  const snapshot: ModelSnapshot = {
    model: strOf(r.model, `models.${key}.model`),
    baseUrlClass: strOf(r.baseUrlClass, `models.${key}.baseUrlClass`) as BaseUrlClass,
  };
  const provider = optStrOf(r.provider, `models.${key}.provider`);
  if (provider !== undefined) snapshot.provider = provider;
  if (snapshot.baseUrlClass !== "server-configured" && snapshot.baseUrlClass !== "request-public-override") {
    throw new RunManifestError(`models.${key}.baseUrlClass 非法：${snapshot.baseUrlClass}`);
  }
  return snapshot;
}

function promptSnapshotOf(raw: unknown): PromptSnapshot {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("prompts[] 必须是对象");
  const r = raw as Record<string, unknown>;
  const snapshot: PromptSnapshot = {
    role: promptRoleOf(r.role),
    version: strOf(r.version, "prompts[].version"),
  };
  const digest = optStrOf(r.digest, "prompts[].digest");
  if (digest !== undefined) snapshot.digest = digest;
  return snapshot;
}

function temperatureOf(raw: unknown, field: string): number {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError(`${field} 必须是对象`);
  return numOf((raw as Record<string, unknown>).temperature, `${field}.temperature`);
}

function parameterSnapshotOf(raw: unknown): ParameterSnapshot {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("parameters 必须是对象");
  const r = raw as Record<string, unknown>;
  const g = r.generation;
  if (typeof g !== "object" || g === null) {
    throw new RunManifestError("parameters.generation 必须是对象");
  }
  const gen = g as Record<string, unknown>;
  const retry = r.retry;
  if (typeof retry !== "object" || retry === null) {
    throw new RunManifestError("parameters.retry 必须是对象");
  }
  const rp = retry as Record<string, unknown>;
  const params: ParameterSnapshot = {
    generation: { temperature: numOf(gen.temperature, "parameters.generation.temperature") },
    planning: { temperature: temperatureOf(r.planning, "parameters.planning") },
    review: { temperature: temperatureOf(r.review, "parameters.review") },
    commercialReview: { temperature: temperatureOf(r.commercialReview, "parameters.commercialReview") },
    beatValidation: { temperature: temperatureOf(r.beatValidation, "parameters.beatValidation") },
    repair: { temperature: temperatureOf(r.repair, "parameters.repair") },
    retry: {
      maxAttempts: numOf(rp.maxAttempts, "parameters.retry.maxAttempts"),
      minReviewScore: numOf(rp.minReviewScore, "parameters.retry.minReviewScore"),
      retryOnValidationFailure: rp.retryOnValidationFailure === true,
      enableRepair: rp.enableRepair === true,
      maxRepairsPerAttempt: numOf(rp.maxRepairsPerAttempt, "parameters.retry.maxRepairsPerAttempt"),
    },
  };
  const topP = optNumOf(gen.topP, "parameters.generation.topP");
  if (topP !== undefined) params.generation.topP = topP;
  const maxTokens = optNumOf(gen.maxTokens, "parameters.generation.maxTokens");
  if (maxTokens !== undefined) params.generation.maxTokens = maxTokens;
  return params;
}

function attemptEntryOf(raw: unknown): AttemptManifestEntry {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("attempts[] 必须是对象");
  const r = raw as Record<string, unknown>;
  const status = strOf(r.status, "attempts[].status");
  if (status !== "accepted" && status !== "not_accepted") {
    throw new RunManifestError(`attempts[].status 非法：${status}`);
  }
  const entry: AttemptManifestEntry = {
    attemptId: strOf(r.attemptId, "attempts[].attemptId"),
    index: numOf(r.index, "attempts[].index"),
    status,
    retryReason: r.retryReason === undefined || r.retryReason === null ? null : strOf(r.retryReason, "attempts[].retryReason"),
    repairIds: strArrayOf(r.repairIds ?? [], "attempts[].repairIds"),
  };
  for (const key of [
    "storyArtifact",
    "validationArtifact",
    "reviewArtifact",
    "commercialReviewArtifact",
    "qualityArtifact",
  ] as const) {
    const value = optStrOf(r[key], `attempts[].${key}`);
    if (value !== undefined) entry[key] = value;
  }
  return entry;
}

function repairEntryOf(raw: unknown): RepairManifestEntry {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("repairs[] 必须是对象");
  const r = raw as Record<string, unknown>;
  const entry: RepairManifestEntry = {
    repairId: strOf(r.repairId, "repairs[].repairId"),
    attemptId: strOf(r.attemptId, "repairs[].attemptId"),
    index: numOf(r.index, "repairs[].index"),
    succeeded: r.succeeded === true,
    inputStoryArtifact: strOf(r.inputStoryArtifact, "repairs[].inputStoryArtifact"),
    outputStoryArtifact: strOf(r.outputStoryArtifact, "repairs[].outputStoryArtifact"),
  };
  const category = optStrOf(r.category, "repairs[].category");
  if (category !== undefined) entry.category = category;
  return entry;
}

function artifactEntryOf(raw: unknown): ArtifactManifestEntry {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("artifacts[] 必须是对象");
  const r = raw as Record<string, unknown>;
  const entry: ArtifactManifestEntry = {
    type: strOf(r.type, "artifacts[].type"),
    path: strOf(r.path, "artifacts[].path"),
  };
  const sha256 = optStrOf(r.sha256, "artifacts[].sha256");
  if (sha256 !== undefined) entry.sha256 = sha256;
  const sourceAttemptId = optStrOf(r.sourceAttemptId, "artifacts[].sourceAttemptId");
  if (sourceAttemptId !== undefined) entry.sourceAttemptId = sourceAttemptId;
  const sourceRepairId = optStrOf(r.sourceRepairId, "artifacts[].sourceRepairId");
  if (sourceRepairId !== undefined) entry.sourceRepairId = sourceRepairId;
  return entry;
}

/** 结构校验：形状不对就抛 RunManifestError（写盘前自查用）。 */
export function validateRunManifest(raw: unknown): RunManifest {
  if (typeof raw !== "object" || raw === null) throw new RunManifestError("manifest 必须是对象");
  const r = raw as Record<string, unknown>;
  if (strOf(r.schemaVersion, "schemaVersion") !== RUN_MANIFEST_SCHEMA_VERSION) {
    throw new RunManifestError(`schemaVersion 只支持 ${RUN_MANIFEST_SCHEMA_VERSION}`);
  }
  const modelsRaw = r.models;
  if (typeof modelsRaw !== "object" || modelsRaw === null) throw new RunManifestError("models 必须是对象");
  const models: Record<string, ModelSnapshot> = {};
  for (const [key, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
    models[key] = modelSnapshotOf(value, key);
  }
  const promptsRaw = r.prompts;
  if (!Array.isArray(promptsRaw)) throw new RunManifestError("prompts 必须是数组");
  const attemptsRaw = r.attempts;
  if (!Array.isArray(attemptsRaw)) throw new RunManifestError("attempts 必须是数组");
  const repairsRaw = r.repairs;
  if (repairsRaw !== undefined && repairsRaw !== null && !Array.isArray(repairsRaw)) {
    throw new RunManifestError("repairs 必须是数组");
  }
  const artifactsRaw = r.artifacts;
  if (artifactsRaw !== undefined && artifactsRaw !== null && !Array.isArray(artifactsRaw)) {
    throw new RunManifestError("artifacts 必须是数组");
  }
  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: strOf(r.runId, "runId"),
    project: projectSnapshotOf(r.project),
    models,
    prompts: promptsRaw.map(promptSnapshotOf),
    parameters: parameterSnapshotOf(r.parameters),
    storyConfigRef: strOf(r.storyConfigRef, "storyConfigRef"),
    ...(optStrOf(r.beatPlanRef, "beatPlanRef") !== undefined
      ? { beatPlanRef: optStrOf(r.beatPlanRef, "beatPlanRef") }
      : {}),
    attempts: attemptsRaw.map(attemptEntryOf),
    ...(optStrOf(r.selectedAttemptId, "selectedAttemptId") !== undefined
      ? { selectedAttemptId: optStrOf(r.selectedAttemptId, "selectedAttemptId") }
      : {}),
    repairs: (repairsRaw ?? []).map(repairEntryOf),
    ...(optStrOf(r.selectedRepairId, "selectedRepairId") !== undefined
      ? { selectedRepairId: optStrOf(r.selectedRepairId, "selectedRepairId") }
      : {}),
    artifacts: (artifactsRaw ?? []).map(artifactEntryOf),
    startedAt: strOf(r.startedAt, "startedAt"),
    completedAt: strOf(r.completedAt, "completedAt"),
  };
}

/** 读取时归一化：任何形状问题都归一成 `null`，不抛给调用方。 */
export function runManifestOf(raw: unknown): RunManifest | null {
  try {
    return validateRunManifest(raw);
  } catch {
    return null;
  }
}
