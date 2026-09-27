/**
 * v2.3.0 Benchmark Suite / Case / Protocol 领域模型（TASK §6/§9/§16）。
 *
 * 三件事必须一次说清楚，否则数字会被读错：
 *
 * 1. **Suite 是数据集身份**。suiteId + suiteVersion + suiteDigest 三者一起才说得出
 *    「这次测的是哪份题」——只写一个版本号不够：同一版本号下偷偷改一道题，
 *    版本号不会变，digest 会变（TASK §70）。
 * 2. **Protocol 是测量方式**。repetitions / plannerMode / acceptedMetrics /
 *    failureHandling 一次执行内不可更改（TASK §17）。执行过程中改协议等于
 *    把两次不同的测量写成一条曲线。
 * 3. **Benchmark 只是测量，不是策略**。这里没有任何字段能被读回去改生成行为：
 *    没有 recommendedModel、没有 adaptive 开关、没有阈值自动应用（TASK §2/§82）。
 *
 * 命名沿用仓库现状：领域模型内部用 snake_case（与 experiment.ts / story-config.ts
 * 一致），于是模型、suite.json、API 响应、CSV 表头五处同名。
 */

import { validateBeatPlan, type BeatPlan } from "@/domain/beat-plan";
import { validateStoryConfig, type StoryConfig } from "@/domain/story-config";

/** suite.json 自己的 schema 版本，与 story-config / beat-plan 的各管各的。 */
export const BENCHMARK_SUITE_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// 错误：三类判定，与实验那三个同构（400 / 404 / 409）
// ---------------------------------------------------------------------------

export class BenchmarkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkValidationError";
  }
}

export class BenchmarkNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkNotFoundError";
  }
}

export class BenchmarkStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkStateError";
  }
}

// ---------------------------------------------------------------------------
// 标识与上限
// ---------------------------------------------------------------------------

/**
 * Suite id：单个目录名（存储布局就是 `suites/<suiteId>/<version>/`）。
 * 刻意比 Case id 更严：一个平台里 suite 数量很少，值得一个干净的名字。
 */
export const SUITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Case id：稳定、不复用数组下标（TASK §10）。允许 `suspense-001` 这种形态。 */
export const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Suite 版本：独立于 StoryLoop 的版本号（TASK §7）。
 * 刻意不用 `2.3.0` 这类项目版本做数据集版本——「换了道题」与「升了一次系统」
 * 是两件事，共用一个号就分不开了（TASK §8）。
 */
export const SUITE_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

/** 一份 Suite 至少一道题、至多两百道（存储与一次执行的运行数都要能兜住）。 */
export const SUITE_CASE_LIMIT = { min: 1, max: 200 } as const;

/** repetitions 与 v1.7.0 实验同一条上限：重复次数是乘数，不是自由参数。 */
export const BENCHMARK_REPETITIONS_LIMIT = { min: 1, max: 5 } as const;

/**
 * 一次 Benchmark 的样本数安全线（TASK §41/§42）。
 *
 * cases × repetitions 是**可能非常昂贵的操作**，所以分两道：
 *   confirmAbove —— 超过它要求请求里显式 acknowledgeLargeBenchmark，防止点错；
 *   hard        —— 超过它直接拒绝，给多少确认都不跑（一次误操作不该烧掉整月额度）。
 */
export const BENCHMARK_RUN_LIMIT = { confirmAbove: 30, hard: 200 } as const;

/** 可选 PASS 切线的取值范围（TASK §95）；协议不给就没有切线，平台不替他定。 */
export const BENCHMARK_PASS_THRESHOLD_LIMIT = { min: 0, max: 100 } as const;

// ---------------------------------------------------------------------------
// 数据来源与许可（TASK §11/§12/§13）
// ---------------------------------------------------------------------------

/**
 * §13/§114 一道题（或一份 Suite）的来源说明。
 *
 * `license` 必填：没有许可信息的题目不进 Suite——这不是洁癖，而是让「这份数据集
 * 能不能再分发」在结构上就有答案（TASK §13）。
 */
export interface BenchmarkProvenanceNote {
  origin: "original" | "public-domain" | "licensed" | "user-provided";
  /** 许可标识或一句话许可状态，例如 `CC0-1.0` / `MIT` / `internal-not-redistributable`。 */
  license: string;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Case（TASK §9）
// ---------------------------------------------------------------------------

/**
 * 一道题与 v1.7.0 实验的 Base 配置同源：就是一份普通 StoryConfig。
 * Benchmark 不发明第二种配置格式——多一种格式就多一处会悄悄跑偏的地方。
 */
export interface BenchmarkCase {
  id: string;
  title: string;
  /** 题材。自由字符串（与 StoryConfig.genre 同一口径），聚合时按它分组（TASK §97）。 */
  genre: string;
  storyConfig: StoryConfig;
  /**
   * 这道题走哪条规划路：
   *   regenerate —— 每个样本自己过 Planner，测的是整条流水线；
   *   fixed      —— 用 beatPlanRef 指向的那份骨架，测的是模型与参数本身。
   */
  beatPlanMode: "regenerate" | "fixed";
  /** fixed 时的骨架引用：Suite 目录内的相对路径，如 `cases/suspense-001/beat-plan.json`。 */
  beatPlanRef?: string | null;
  tags?: string[];
  /** §13 这道题自己的来源说明；缺省表示与 Suite 同源。 */
  source?: BenchmarkProvenanceNote;
}

// ---------------------------------------------------------------------------
// Protocol（TASK §16/§17）
// ---------------------------------------------------------------------------

/**
 * 协议的规划模式：
 *   normal     —— 不额外约束规划；带固定骨架的题仍然用它自己那一份；
 *   fixed-plan —— 每道题都必须带固定骨架，整个执行一次 Planner 都不调。
 * 后者是复现性最强的设置，代价是测不到规划环节本身。
 */
export type BenchmarkPlannerMode = "normal" | "fixed-plan";

/**
 * §44 失败样本怎么参与聚合：
 *   include           —— 失败样本也进聚合（它的指标照实记，缺的就是 null）；
 *   exclude-with-count —— 失败样本不进任何指标聚合，但完成数 / 失败数照实给出。
 * 两种都如实报数，差别只在失败样本的 null 会不会稀释均值。
 */
export type BenchmarkFailureHandling = "include" | "exclude-with-count";

export interface BenchmarkProtocol {
  repetitions: number;
  plannerMode: BenchmarkPlannerMode;
  /** 这次执行计算并对外暴露哪些指标（TASK §29 注册表的键）。 */
  acceptedMetrics: string[];
  failureHandling: BenchmarkFailureHandling;
  /** §95 可选的 PASS 切线，只对 overall_quality 生效；不配就没有切线，也不默认 71。 */
  passThreshold?: number | null;
}

// ---------------------------------------------------------------------------
// Suite（TASK §6）
// ---------------------------------------------------------------------------

export interface BenchmarkSuite {
  schemaVersion: string;
  id: string;
  version: string;
  name: string;
  description?: string | null;
  cases: BenchmarkCase[];
  protocol: BenchmarkProtocol;
  /** §13/§114 Suite 级来源说明：必填，缺失的 Suite 读不进来。 */
  source: BenchmarkProvenanceNote;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * §61 凭据形状的键名：Suite 里出现任何一个都直接拒绝。
 * 与实验定义同一张表、同一条理由——定义本来就不该有这些键。
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

/** 递归扫一遍原始请求体：命中凭据形状的键名就拒绝，并报出完整路径。 */
function rejectSecretBearingKeys(raw: unknown, path = "suite"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, i) => rejectSecretBearingKeys(item, `${path}[${i}]`));
    return;
  }
  if (typeof raw !== "object" || raw === null) return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new BenchmarkValidationError(
        `${path}.${key} 不允许出现在 Benchmark Suite 里（凭据 / 地址 / 原始提示词都不进数据集，§61）`,
      );
    }
    rejectSecretBearingKeys(value, `${path}.${key}`);
  }
}

function objOf(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BenchmarkValidationError(`${field} 必须是对象`);
  }
  return raw as Record<string, unknown>;
}

function strOf(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new BenchmarkValidationError(`${field} 必须是非空字符串`);
  }
  const value = raw.trim();
  if (value.length > max) throw new BenchmarkValidationError(`${field} 不能超过 ${max} 个字符`);
  return value;
}

function optStrOf(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return strOf(raw, field, max);
}

function numInRange(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new BenchmarkValidationError(`${field} 必须是数字`);
  }
  if (raw < min || raw > max) {
    throw new BenchmarkValidationError(`${field} 必须在 ${min} ~ ${max} 之间（实际 ${raw}）`);
  }
  return raw;
}

function suiteIdOf(raw: unknown): string {
  const value = strOf(raw, "id", 64);
  if (!SUITE_ID_PATTERN.test(value)) {
    throw new BenchmarkValidationError(
      "suite.id 只能包含小写字母、数字与连字符，以字母或数字开头，长度 2 ~ 64",
    );
  }
  return value;
}

function suiteVersionOf(raw: unknown): string {
  const value = strOf(raw, "version", 16);
  if (!SUITE_VERSION_PATTERN.test(value)) {
    throw new BenchmarkValidationError(
      `suite.version 必须是 x.y 或 x.y.z 形式的数据集版本（实际 ${value}）；不要把项目版本 ${"2.3.0"} 当数据集版本`,
    );
  }
  return value;
}

function caseIdOf(raw: unknown, index: number): string {
  const value = strOf(raw, `cases[${index}].id`, 64);
  if (!CASE_ID_PATTERN.test(value)) {
    throw new BenchmarkValidationError(
      `cases[${index}].id 只能包含小写字母、数字、点、下划线与连字符，以字母或数字开头`,
    );
  }
  return value;
}

/**
 * §23 beatPlanRef 只允许指向 Suite 目录内的相对路径。
 * 绝对路径、盘符、向上目录一律拒绝——引用越出 Suite 目录就可能在别的部署上
 * 读到不该读的文件（TASK §40「all fixed BeatPlans exist」的那道关卡在预检里，
 * 这里先保证它顶多是一条干净的相对路径）。
 */
function beatPlanRefOf(raw: unknown, index: number): string {
  const value = strOf(raw, `cases[${index}].beatPlanRef`, 200);
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value)) {
    throw new BenchmarkValidationError(`cases[${index}].beatPlanRef 必须是 Suite 内的相对路径`);
  }
  if (value.split(/[/\\]/).includes("..")) {
    throw new BenchmarkValidationError(`cases[${index}].beatPlanRef 不能包含上级目录`);
  }
  return value;
}

function provenanceOf(raw: unknown, field: string): BenchmarkProvenanceNote {
  const r = objOf(raw, field);
  const origin = r.origin;
  if (origin !== "original" && origin !== "public-domain" && origin !== "licensed" && origin !== "user-provided") {
    throw new BenchmarkValidationError(
      `${field}.origin 必须是 original / public-domain / licensed / user-provided 之一`,
    );
  }
  return {
    origin,
    license: strOf(r.license, `${field}.license`, 200),
    ...(optStrOf(r.note, `${field}.note`, 2000) !== undefined ? { note: optStrOf(r.note, `${field}.note`, 2000) } : {}),
  };
}

function storyConfigOf(raw: unknown, index: number): StoryConfig {
  try {
    return validateStoryConfig(raw);
  } catch (e) {
    throw new BenchmarkValidationError(
      `cases[${index}].storyConfig 不是合法的 StoryConfig：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 固定骨架的引用在写盘前就能查形状：readBeatPlan 在预检里做（要读盘）。 */
function caseOf(raw: unknown, index: number): BenchmarkCase {
  const r = objOf(raw, `cases[${index}]`);
  const out: BenchmarkCase = {
    id: caseIdOf(r.id, index),
    title: strOf(r.title, `cases[${index}].title`, 200),
    genre: strOf(r.genre, `cases[${index}].genre`, 40),
    storyConfig: storyConfigOf(r.storyConfig, index),
    beatPlanMode: r.beatPlanMode === "fixed" ? "fixed" : r.beatPlanMode === "regenerate" ? "regenerate" : (() => {
      throw new BenchmarkValidationError(`cases[${index}].beatPlanMode 必须是 fixed 或 regenerate`);
    })(),
  };
  if (out.beatPlanMode === "fixed") {
    const ref = r.beatPlanRef;
    if (typeof ref !== "string" || !ref.trim()) {
      throw new BenchmarkValidationError(`cases[${index}] 是 fixed 模式，必须给 beatPlanRef`);
    }
    out.beatPlanRef = beatPlanRefOf(ref, index);
  } else if (r.beatPlanRef !== undefined && r.beatPlanRef !== null && r.beatPlanRef !== "") {
    throw new BenchmarkValidationError(
      `cases[${index}] 是 regenerate 模式，给 beatPlanRef 没有意义（骨架由 Planner 现生成）`,
    );
  }
  if (r.tags !== undefined && r.tags !== null) {
    if (!Array.isArray(r.tags)) throw new BenchmarkValidationError(`cases[${index}].tags 必须是数组`);
    const tags: string[] = [];
    for (const tag of r.tags) tags.push(strOf(tag, `cases[${index}].tags[]`, 40).toLowerCase());
    if (tags.length > 0) out.tags = tags;
  }
  if (r.source !== undefined && r.source !== null) {
    out.source = provenanceOf(r.source, `cases[${index}].source`);
  }
  return out;
}

/** 协议里的指标键必须真的在注册表里（TASK §40「metrics supported」）。 */
function acceptedMetricsOf(raw: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BenchmarkValidationError("protocol.acceptedMetrics 必须是非空数组");
  }
  const out: string[] = [];
  for (const item of raw) {
    const key = strOf(item, "protocol.acceptedMetrics[]", 64);
    if (!known.has(key)) {
      throw new BenchmarkValidationError(`protocol.acceptedMetrics 含不支持的指标 ${key}`);
    }
    if (out.includes(key)) {
      throw new BenchmarkValidationError(`protocol.acceptedMetrics 里 ${key} 重复了`);
    }
    out.push(key);
  }
  return out;
}

function protocolOf(raw: unknown, known: ReadonlySet<string>): BenchmarkProtocol {
  const r = objOf(raw, "protocol");
  const repetitions = numInRange(
    r.repetitions,
    "protocol.repetitions",
    BENCHMARK_REPETITIONS_LIMIT.min,
    BENCHMARK_REPETITIONS_LIMIT.max,
  );
  if (!Number.isInteger(repetitions)) {
    throw new BenchmarkValidationError("protocol.repetitions 必须是整数");
  }
  const plannerMode = r.plannerMode;
  if (plannerMode !== "normal" && plannerMode !== "fixed-plan") {
    throw new BenchmarkValidationError("protocol.plannerMode 必须是 normal 或 fixed-plan");
  }
  const handling = r.failureHandling;
  if (handling !== "include" && handling !== "exclude-with-count") {
    throw new BenchmarkValidationError("protocol.failureHandling 必须是 include 或 exclude-with-count");
  }
  const out: BenchmarkProtocol = {
    repetitions,
    plannerMode,
    acceptedMetrics: acceptedMetricsOf(r.acceptedMetrics, known),
    failureHandling: handling,
  };
  if (r.passThreshold !== undefined && r.passThreshold !== null) {
    out.passThreshold = numInRange(
      r.passThreshold,
      "protocol.passThreshold",
      BENCHMARK_PASS_THRESHOLD_LIMIT.min,
      BENCHMARK_PASS_THRESHOLD_LIMIT.max,
    );
  }
  return out;
}

function unknownKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new BenchmarkValidationError(`${field} 含未知字段 ${key}（这个版本不认它，也不想默默忽略）`);
    }
  }
}

/**
 * 校验一份 Suite。
 *
 * 三道结构关卡（TASK §100）：
 *   1. id / version 形态与唯一性（case id 重复直接拒绝，不靠去重糊过去）；
 *   2. storyConfig 仍是正式 StoryConfig——Benchmark 不改配置格式；
 *   3. plannerMode 与各题的 beatPlanMode 必须自洽：fixed-plan 不许有
 *      regenerate 的题，否则「一次 Planner 都不调」这句话是假的。
 */
export function validateBenchmarkSuite(raw: unknown, known: ReadonlySet<string>): BenchmarkSuite {
  rejectSecretBearingKeys(raw);
  const r = objOf(raw, "suite");
  unknownKeys(
    r,
    ["schemaVersion", "id", "version", "name", "description", "cases", "protocol", "source", "createdAt"],
    "suite",
  );
  if (r.schemaVersion !== BENCHMARK_SUITE_SCHEMA_VERSION) {
    throw new BenchmarkValidationError(
      `suite.schemaVersion 只支持 ${BENCHMARK_SUITE_SCHEMA_VERSION}（实际 ${String(r.schemaVersion)}）`,
    );
  }
  if (!Array.isArray(r.cases)) throw new BenchmarkValidationError("suite.cases 必须是数组");
  if (r.cases.length < SUITE_CASE_LIMIT.min || r.cases.length > SUITE_CASE_LIMIT.max) {
    throw new BenchmarkValidationError(
      `suite.cases 必须 ${SUITE_CASE_LIMIT.min} ~ ${SUITE_CASE_LIMIT.max} 道题（实际 ${r.cases.length}）`,
    );
  }

  const cases = r.cases.map((item, index) => caseOf(item, index));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) {
      throw new BenchmarkValidationError(`case id ${item.id} 重复：Benchmark Case ID 必须稳定且唯一（§10）`);
    }
    seen.add(item.id);
  }

  const protocol = protocolOf(r.protocol, known);
  if (protocol.plannerMode === "fixed-plan") {
    const free = cases.filter((item) => item.beatPlanMode !== "fixed");
    if (free.length > 0) {
      throw new BenchmarkValidationError(
        `protocol.plannerMode 是 fixed-plan，但 ${free.length} 道题没有固定骨架（如 ${free[0].id}）`,
      );
    }
  }

  const out: BenchmarkSuite = {
    schemaVersion: BENCHMARK_SUITE_SCHEMA_VERSION,
    id: suiteIdOf(r.id),
    version: suiteVersionOf(r.version),
    name: strOf(r.name, "suite.name", 200),
    ...(optStrOf(r.description, "suite.description", 2000) !== undefined
      ? { description: optStrOf(r.description, "suite.description", 2000) }
      : {}),
    cases,
    protocol,
    source: provenanceOf(r.source, "suite.source"),
    createdAt: strOf(r.createdAt, "suite.createdAt", 40),
  };
  return out;
}

/**
 * 读盘后复核一份 Suite 是否仍然自洽（手改文件之后跑之前的那道关）。
 *
 * 摘要本身在 Infrastructure（`infrastructure/tracking/benchmark-digest.ts`）：
 * Domain 不许 import node:crypto（§39 的纯度测试），而 Suite 的规范化表示必须
 * 与散列函数放在一起，否则「什么进摘要」这件事会被拆成两处、各自漂移。
 */
export function benchmarkSuiteOf(raw: unknown, known: ReadonlySet<string>): BenchmarkSuite | null {
  try {
    return validateBenchmarkSuite(raw, known);
  } catch {
    return null;
  }
}

/** §41 样本数：cases × repetitions。这个数必须在任何 LLM 请求之前就算出来。 */
export function benchmarkSampleCount(suite: BenchmarkSuite): number {
  return suite.cases.length * suite.protocol.repetitions;
}

/** §40 固定骨架的引用清单：预检要逐条确认文件真的存在。 */
export function fixedBeatPlanRefs(suite: BenchmarkSuite): { caseId: string; ref: string }[] {
  return suite.cases
    .filter((item) => item.beatPlanMode === "fixed" && typeof item.beatPlanRef === "string")
    .map((item) => ({ caseId: item.id, ref: item.beatPlanRef as string }));
}

/** 单条协议校验（不带 Suite）：CRUD 之外的路径也要能单独验证协议形状。 */
export function validateBenchmarkProtocol(raw: unknown, known: ReadonlySet<string>): BenchmarkProtocol {
  rejectSecretBearingKeys(raw);
  const r = objOf(raw, "protocol");
  unknownKeys(r, ["repetitions", "plannerMode", "acceptedMetrics", "failureHandling", "passThreshold"], "protocol");
  return protocolOf(r, known);
}
