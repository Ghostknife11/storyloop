/**
 * v1.7.0 受控实验：一次人为定义的、变量明确的重复运行。
 *
 * 它回答一个问题：「只改一个变量，结果会怎样」——固定一份 Base Input，定义若干个 Variant，
 * 每个 Variant 跑若干次，把结果按 Variant 分组汇总。样本全部走 v1.6.0 就已经存在的
 * 正式 Pipeline，因此每个样本都是带完整出身的普通 Run。
 *
 * 明确不做（与 1.x 的一贯边界一致）：
 *   - 不是基准测试：没有固定数据集、没有跨实验协议、不积累历史成绩；
 *   - 不是排行榜 / 排名系统：不排序、不宣布赢家、不推荐 Variant；
 *   - 不做统计推断：没有 p 值、置信区间、效应显著性、贝叶斯排名；
 *   - 不做自动寻优：不搜超参、不改提示词、不把结论反写进生成策略。
 * 这个文件只定义「计划跑什么」与「跑出来是什么」，不回答「哪个更好」。
 *
 * 与 `run-manifest.json` 的分工（TASK §48）：definition 记的是**计划改什么**，
 * Manifest 记的是**实际用了什么**。两者都保留，互不复述。
 *
 * 命名沿用 v1.6.0 的 manifest 约定：自带 schemaVersion、字段用 camelCase，
 * 与 v1.0.0 冻结的 snake_case metadata 契约不混用。
 */

import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import { validateRetryPolicy, type RetryPolicy } from "@/core/retry-policy";
import type { ExperimentProvenance } from "@/types/run-manifest";

export type { ExperimentProvenance };

/** 当前 ExperimentDefinition 的 schema 版本；字段语义变化时递增。 */
export const EXPERIMENT_SCHEMA_VERSION = "1";

/** §15 单个 Variant 的重复次数：1 ~ 5。默认 1。 */
export const REPETITIONS_LIMIT = { min: 1, max: 5 } as const;
export const DEFAULT_REPETITIONS = 1;

/** §15/§16 规模上限：一次实验最多几个 Variant、最多几条样本 Run。 */
export const VARIANTS_LIMIT = { min: 1, max: 4 } as const;
export const TOTAL_RUNS_LIMIT = 12;

/** §15 温度区间：与主流 OpenAI 兼容接口一致，越界一律拒绝。 */
export const TEMPERATURE_LIMIT = { min: 0, max: 2 } as const;

/** 实验状态（TASK §23/§28）。 */
export type ExperimentStatus = "pending" | "running" | "completed" | "partial" | "failed";

/**
 * BeatPlan 的两种模式（TASK §5）：
 *   fixed       —— 所有 Variant 与所有 repetition 用同一份骨架，比较的是模型 / 提示词 / 参数；
 *   regenerate  —— 每个样本自己走 Planner，比较的是整条 Pipeline。
 */
export type BeatPlanMode = "fixed" | "regenerate";

/** TASK §12 推荐里的 ModelSelection：本仓库只有 `model` 一项是真实的。
 *  baseUrl 刻意缺席——见 §62，实验不接受地址覆盖，地址只由服务端 LLM_BASE_URL 决定，
 *  这样请求体 baseUrl 的 SSRF 关卡（v1.1.0）连被绕过的机会都没有。 */
export interface ModelSelection {
  model: string;
}

/** TASK §12 推荐里的 GenerationParameters。只有 temperature 真的会发给模型。
 *  topP / maxTokens 不在这里：LLMClient 的请求体只发 model / messages / temperature，
 *  允许它们当变量等于制造一个什么都不改的「变量」（见 validateGenerationOverrides）。 */
export interface GenerationParameters {
  temperature?: number;
}

/** TASK §12 Base 配置：这次实验固定不变的那一部分。 */
export interface ExperimentBaseConfig {
  storyConfig: StoryConfig;
  beatPlanMode: BeatPlanMode;
  /** fixed 模式必填：整份骨架随定义一起落盘，实验因此自包含、不依赖某个 Run 还在不在。 */
  beatPlan?: BeatPlan;
  modelConfig?: ModelSelection;
  generationParameters?: GenerationParameters;
  retryPolicy?: RetryPolicy;
}

/**
 * TASK §14 Variant 覆盖：强类型白名单。
 *
 * 白名单里只有四项真的会改变一次生成：model、temperature、retry.maxAttempts、
 * retry.minReviewScore。别的键一律在预检时拒绝，不静默忽略——静默忽略会让一份定义
 * 声称自己改了某个变量，而样本其实什么都没改。已知「改了但没用」的键：
 *   - topP / maxTokens：LLMClient 的请求体只发 model / messages / temperature；
 *   - prompts.<role>：六个阶段各读一个固定提示词文件，登记表里每个角色只有一版，
 *     没有第二个版本可选（提示词差异由 Manifest 的 prompts 块如实记录）；
 *   - baseUrl：地址只由服务端 LLM_BASE_URL 决定，见 ModelSelection 的说明。
 */
export interface ExperimentOverrides {
  model?: string;
  generation?: { temperature?: number };
  retry?: { maxAttempts?: number; minReviewScore?: number };
}

/** TASK §13 一个 Variant：相对 Base 的一组明确修改。id 稳定，不依赖数组下标。 */
export interface ExperimentVariant {
  id: string;
  name: string;
  overrides: ExperimentOverrides;
}

/** TASK §11 一份实验定义。落盘后即不可变快照（TASK §34）：要改就复制成新实验。 */
export interface ExperimentDefinition {
  schemaVersion: string;
  experimentId: string;
  name: string;
  description?: string;
  base: ExperimentBaseConfig;
  variants: ExperimentVariant[];
  repetitions: number;
  createdAt: string;
}

/** TASK §24 一条样本 Run 的引用：哪个 Variant、第几次 repetition、跑出哪个 runId。 */
export interface ExperimentRunReference {
  variantId: string;
  repetition: number;
  runId: string;
  /** 这条样本自己的结局：completed = Run 跑完；failed = 它失败了（兄弟样本继续跑，§29）。 */
  status: "completed" | "failed";
  overallScore?: number | null;
  commercialScore?: number | null;
}

/** §25 第一版汇总：只做计数与均值。没有排序、没有赢家、没有显著性。 */
export interface ExperimentVariantSummary {
  variantId: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  /** 有分数的样本才进均值；一个都没有时是 null，不补 0。 */
  meanOverallScore: number | null;
  meanCommercialScore: number | null;
  /** Co/N/C/Ca（质量四维）均值；同样按「有值的样本」计数。 */
  meanCoherence: number | null;
  meanNarrative: number | null;
  meanCharacter: number | null;
  meanCausality: number | null;
  /** H/P/E/Pf（商业四维）均值。 */
  meanHook: number | null;
  meanPacing: number | null;
  meanEngagement: number | null;
  meanPayoff: number | null;
}

/** §25 整个实验的基础聚合。 */
export interface ExperimentSummary {
  runCount: number;
  successCount: number;
  failureCount: number;
  /** 顺序与 definition.variants 一致（不按分数重排——重排就是排名）。 */
  variants: ExperimentVariantSummary[];
}

/** TASK §23 ExperimentResult：实验跑完之后落在 experiments/<id>/results.json 里的东西。 */
export interface ExperimentResult {
  experimentId: string;
  status: ExperimentStatus;
  runs: ExperimentRunReference[];
  summary: ExperimentSummary;
  startedAt: string;
  completedAt?: string | null;
}

/** §22 experiments/<id>/runs.json：展开后的格子 → 跑出来的 runId。 */
export interface ExperimentRunIndexEntry {
  variantId: string;
  repetition: number;
  /** 这一格还没跑、或还没跑完时是 null。 */
  runId: string | null;
  status: "pending" | "completed" | "failed";
  /** 失败时的安全摘要（阶段 + 一句话）；没有失败时整个键不出现。 */
  failure?: string;
}

/** §22 runs.json 的内容。 */
export interface ExperimentRunIndex {
  experimentId: string;
  totalRuns: number;
  entries: ExperimentRunIndexEntry[];
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** §51 定义不合法（结构、越界、白名单、重复 id、提示词版本不存在）。 */
export class ExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentValidationError";
  }
}

/** 实验不存在（GET / POST run 一个没建过的 id）。 */
export class ExperimentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentNotFoundError";
  }
}

/** §34 实验已经跑过：定义不可变，要改条件就复制成一个新实验。 */
export class ExperimentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentStateError";
  }
}

/**
 * §61 凭据形状的键名：定义里出现任何一个都直接拒绝。
 * 这是结构检查，不是内容猜测——定义本来就不该有这些键，出现了只可能是想夹带。
 */
const FORBIDDEN_KEYS = new Set([
  "baseurl",
  "api_key",
  "apikey",
  "llm_api_key",
  "authorization",
  "auth",
  "cookie",
  "headers",
  "env",
  "environment",
  "token",
  "secret",
  "credentials",
  "prompt",
  "systemprompt",
  "system_prompt",
]);

/** 递归扫一遍原始请求体：命中凭据形状的键名就拒绝（§61），并报出完整路径。 */
function rejectSecretBearingKeys(raw: unknown, path = "experiment"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, i) => rejectSecretBearingKeys(item, `${path}[${i}]`));
    return;
  }
  if (typeof raw !== "object" || raw === null) return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new ExperimentValidationError(
        `${path}.${key} 不允许出现在实验定义里（凭据 / 地址 / 原始提示词都不进定义，§61）`,
      );
    }
    rejectSecretBearingKeys(value, `${path}.${key}`);
  }
}

function objOf(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ExperimentValidationError(`${field} 必须是对象`);
  }
  return raw as Record<string, unknown>;
}

function strOf(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ExperimentValidationError(`${field} 必须是非空字符串`);
  }
  const value = raw.trim();
  if (value.length > max) throw new ExperimentValidationError(`${field} 不能超过 ${max} 个字符`);
  return value;
}

function optStrOf(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return strOf(raw, field, max);
}

function numInRange(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ExperimentValidationError(`${field} 必须是数字`);
  }
  if (raw < min || raw > max) {
    throw new ExperimentValidationError(`${field} 必须在 ${min} ~ ${max} 之间（实际 ${raw}）`);
  }
  return raw;
}

/** §35：id 只允许单个目录名（实验目录就用它），不接受用户输入里带路径或遍历。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 这一个 id 能不能当目录名用：单段、以字母或数字开头、不含路径分隔符，
 * 也不是 "." / ".."（落到实验根目录本身等于把根当成一个实验）。
 *
 * POST 用 `idOf` 校验（错误信息细，直接告诉用户错在哪）；
 * 读与跑的路由用这个判定——不合法一律当「不存在」，404，
 * 免得把 URL 里的原句喂给路径解析（v1.7.1：`exp/../../x` 曾走到 500）。
 */
export function isExperimentId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && ID_PATTERN.test(value);
}

function idOf(raw: unknown, field: string): string {
  const value = strOf(raw, field, 64);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new ExperimentValidationError(`${field} 不能包含路径分隔符`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new ExperimentValidationError(`${field} 只能包含字母、数字、点、下划线与连字符，且以字母或数字开头`);
  }
  return value;
}

function unknownKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ExperimentValidationError(`${field} 不支持字段 ${key}（白名单：${allowed.join(" / ")}）`);
    }
  }
}

/**
 * 改了也不会生效的键：单独一条分支把理由说清楚。
 * 它们不是「暂时没接上」，而是当前版本里确实没有任何一行代码会因为它们而不同。
 * baseUrl 不在这张表里——它在更早的凭据形状键名扫描就被拦下了（见 FORBIDDEN_KEYS），
 * 这条路上到不了这里。
 */
const NO_EFFECT_OVERRIDE_REASONS: Record<string, string> = {
  prompts:
    "提示词差异不是实验变量：六个阶段各读一个固定提示词文件，登记表里每个角色只有一版，" +
    "没有第二个版本可选；真实用到的提示词由每个 Run 的 Manifest prompts 块如实记录",
  topP: "LLMClient 的请求体只发送 model / messages / temperature，topP 不会出现在任何一次请求里",
  maxTokens: "LLMClient 的请求体只发送 model / messages / temperature，maxTokens 不会出现在任何一次请求里",
};

/**
 * 白名单判定之前先跑这一遍：先把「改了也没用」的键拦下来，报出它为什么没用。
 * 顺序很重要——先答「为什么不行」，再答「白名单是什么」，用户才知道该删哪个键。
 */
function rejectNoEffectKeys(raw: Record<string, unknown>, field: string): void {
  for (const key of Object.keys(raw)) {
    const reason = NO_EFFECT_OVERRIDE_REASONS[key];
    if (reason) throw new ExperimentValidationError(`${field}.${key} 不允许作为实验变量：${reason}`);
  }
}

/** §14 生成参数覆盖：只认 temperature。topP / maxTokens 明确拒绝，并说明原因。 */
function generationOverridesOf(raw: unknown): ExperimentOverrides["generation"] {
  const r = objOf(raw, "overrides.generation");
  rejectNoEffectKeys(r, "overrides.generation");
  unknownKeys(r, ["temperature"], "overrides.generation");
  const out: { temperature?: number } = {};
  for (const [key, value] of Object.entries(r)) {
    if (value === undefined || value === null) continue;
    if (key === "temperature") {
      out.temperature = numInRange(value, "overrides.generation.temperature", TEMPERATURE_LIMIT.min, TEMPERATURE_LIMIT.max);
    }
  }
  return out;
}

/** §14 重试策略覆盖：只有两个字段可改，其余（开关类）沿用 Base。 */
function retryOverridesOf(raw: unknown): ExperimentOverrides["retry"] {
  const r = objOf(raw, "overrides.retry");
  rejectNoEffectKeys(r, "overrides.retry");
  unknownKeys(r, ["maxAttempts", "minReviewScore"], "overrides.retry");
  const out: { maxAttempts?: number; minReviewScore?: number } = {};
  for (const [key, value] of Object.entries(r)) {
    if (value === undefined || value === null) continue;
    if (key === "maxAttempts") {
      out.maxAttempts = numInRange(value, "overrides.retry.maxAttempts", 1, 5);
    } else if (key === "minReviewScore") {
      out.minReviewScore = numInRange(value, "overrides.retry.minReviewScore", 0, 100);
    }
  }
  return out;
}

function overridesOf(raw: unknown, field: string): ExperimentOverrides {
  const r = objOf(raw, field);
  // 先解释「这个键改了也没用」，再报白名单
  rejectNoEffectKeys(r, field);
  unknownKeys(r, ["model", "generation", "retry"], field);
  const out: ExperimentOverrides = {};
  const model = optStrOf(r.model, `${field}.model`, 120);
  if (model !== undefined) out.model = model;
  if (r.generation !== undefined && r.generation !== null) {
    out.generation = generationOverridesOf(r.generation);
  }
  if (r.retry !== undefined && r.retry !== null) out.retry = retryOverridesOf(r.retry);
  return out;
}

function variantOf(raw: unknown, index: number): ExperimentVariant {
  const r = objOf(raw, `variants[${index}]`);
  unknownKeys(r, ["id", "name", "overrides"], `variants[${index}]`);
  return {
    id: idOf(r.id, `variants[${index}].id`),
    name: strOf(r.name, `variants[${index}].name`, 120),
    overrides: overridesOf(r.overrides ?? {}, `variants[${index}].overrides`),
  };
}

function baseConfigOf(raw: unknown): ExperimentBaseConfig {
  const r = objOf(raw, "base");
  unknownKeys(r, ["storyConfig", "beatPlanMode", "beatPlan", "modelConfig", "generationParameters", "retryPolicy"], "base");

  const storyConfig = validateStoryConfig(r.storyConfig);
  const mode = r.beatPlanMode;
  if (mode !== "fixed" && mode !== "regenerate") {
    throw new ExperimentValidationError(`base.beatPlanMode 只能是 fixed 或 regenerate（实际 ${String(mode)}）`);
  }

  const base: ExperimentBaseConfig = { storyConfig, beatPlanMode: mode };
  if (mode === "fixed") {
    if (r.beatPlan === undefined || r.beatPlan === null) {
      throw new ExperimentValidationError("base.beatPlanMode 是 fixed 时必须带上 base.beatPlan（四拍结构那份骨架）");
    }
    base.beatPlan = validateBeatPlan(r.beatPlan);
  } else if (r.beatPlan !== undefined && r.beatPlan !== null) {
    // regenerate 模式下带固定骨架是自相矛盾的输入：宁可拒绝，不猜用户想怎样
    throw new ExperimentValidationError("base.beatPlanMode 是 regenerate 时不能再带 base.beatPlan（每个样本自己走 Planner）");
  }

  if (r.modelConfig !== undefined && r.modelConfig !== null) {
    const m = objOf(r.modelConfig, "base.modelConfig");
    unknownKeys(m, ["model"], "base.modelConfig");
    base.modelConfig = { model: strOf(m.model, "base.modelConfig.model", 120) };
  }
  if (r.generationParameters !== undefined && r.generationParameters !== null) {
    const g = objOf(r.generationParameters, "base.generationParameters");
    unknownKeys(g, ["temperature"], "base.generationParameters");
    const params: GenerationParameters = {};
    if (g.temperature !== undefined && g.temperature !== null) {
      params.temperature = numInRange(
        g.temperature, "base.generationParameters.temperature", TEMPERATURE_LIMIT.min, TEMPERATURE_LIMIT.max,
      );
    }
    base.generationParameters = params;
  }
  if (r.retryPolicy !== undefined && r.retryPolicy !== null) {
    base.retryPolicy = validateRetryPolicy(r.retryPolicy);
  }
  return base;
}

/**
 * §51 结构校验：形状不对就抛 ExperimentValidationError。
 * 调用方（服务层）在**任何 LLM 请求之前**调用它——无效定义一个样本都不跑（§31）。
 */
export function validateExperimentDefinition(raw: unknown): ExperimentDefinition {
  rejectSecretBearingKeys(raw);
  const r = objOf(raw, "experiment");

  const schemaVersion = strOf(r.schemaVersion, "schemaVersion", 16);
  if (schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new ExperimentValidationError(`schemaVersion 只支持 ${EXPERIMENT_SCHEMA_VERSION}（实际 ${schemaVersion}）`);
  }

  const base = baseConfigOf(r.base);
  const variantsRaw = r.variants;
  if (!Array.isArray(variantsRaw)) {
    throw new ExperimentValidationError("variants 必须是数组");
  }
  if (variantsRaw.length === 0) {
    throw new ExperimentValidationError("variants 不能为空：至少定义一个 Variant（基准本身也是一个 Variant）");
  }
  if (variantsRaw.length > VARIANTS_LIMIT.max) {
    throw new ExperimentValidationError(`variants 最多 ${VARIANTS_LIMIT.max} 个（实际 ${variantsRaw.length}）`);
  }
  const variants = variantsRaw.map(variantOf);
  const ids = variants.map((v) => v.id);
  if (new Set(ids).size !== ids.length) {
    throw new ExperimentValidationError(`variants 的 id 存在重复：${ids.join(" / ")}`);
  }

  const repetitions = typeof r.repetitions === "number" || r.repetitions === undefined
    ? (r.repetitions ?? DEFAULT_REPETITIONS)
    : NaN;
  if (!Number.isInteger(repetitions) || repetitions < REPETITIONS_LIMIT.min || repetitions > REPETITIONS_LIMIT.max) {
    throw new ExperimentValidationError(
      `repetitions 必须是 ${REPETITIONS_LIMIT.min} ~ ${REPETITIONS_LIMIT.max} 之间的整数（实际 ${String(r.repetitions ?? DEFAULT_REPETITIONS)}）`,
    );
  }

  // §16：总样本数 = Variant 数 × repetition 数，超过上限直接拒绝，避免误触大量付费请求
  const totalRuns = variants.length * repetitions;
  if (totalRuns > TOTAL_RUNS_LIMIT) {
    throw new ExperimentValidationError(
      `总样本数 ${totalRuns}（${variants.length} 个 Variant × ${repetitions} 次 repetition）超过上限 ${TOTAL_RUNS_LIMIT}`,
    );
  }

  const createdAt = optStrOf(r.createdAt, "createdAt", 40) ?? new Date().toISOString();

  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: idOf(r.experimentId, "experimentId"),
    name: strOf(r.name, "name", 120),
    ...(optStrOf(r.description, "description", 500) !== undefined
      ? { description: optStrOf(r.description, "description", 500) }
      : {}),
    base,
    variants,
    repetitions,
    createdAt,
  };
}

/** 读回时归一化：磁盘上的 definition.json 被手改坏时返回 null，由调用方按「不存在」处理。 */
export function experimentDefinitionOf(raw: unknown): ExperimentDefinition | null {
  try {
    return validateExperimentDefinition(raw);
  } catch {
    return null;
  }
}

/** §16 总样本数：Variants × repetitions。 */
export function totalRunCount(definition: ExperimentDefinition): number {
  return definition.variants.length * definition.repetitions;
}
