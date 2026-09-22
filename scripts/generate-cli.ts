/**
 * storyloop CLI（TASK §28~§32）。
 *
 *   storygen run       —— StoryConfig → Plan → Attempt（Generate → Save → Validate → Review → Repair? → Revalidate → Re-review → Decide）→ Retry? → Finalize
 *   storygen run --beats <beats.json> —— 手动模式：用户编辑后的 BeatPlan 直接进入生成
 *   storygen plan      —— 只产出 BeatPlan，供后续 run --beats 使用
 *   storygen review    —— 对已有正文单独审阅（与 Pipeline 使用同一个 BasicReviewer）
 *   storygen validate  —— 对已有正文单独跑硬性规则（与 Pipeline 使用同一个 StoryValidator）
 *   storygen repair    —— 对已有正文定点修订一次（与 Pipeline 使用同一个 StoryRepairer）
 *
 * §31 CLI 不重复业务逻辑：所有命令都走 src/lib/generate-service.ts 里的同一个
 * Pipeline / Service，Retry 与 Repair 策略也只有那一份实现。
 * §32 API 与 CLI 行为一致：同一套 StoryConfig 校验、同一套 RetryPolicy 范围。
 *
 * §29/§30 帮助与退出码：
 *   storygen --help / storygen run --help → 用法，退出码 0
 *   0 = 命令正常跑完（含 Validation / Review 给出否定结论——那是模型的判断，不是 CLI 失败）
 *   1 = 运行时失败（LLM 超时 / 请求失败 / Pipeline 失败 / 产物写入失败 / Run 不存在）
 *   2 = 参数或配置不合法（缺参数、未知命令、取值越界、配置文件读不了或校验不过、没配 LLM_API_KEY）
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --max-attempts 2 --min-score 70
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --enable-repair --max-repairs 1
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats plan_20260920.beats.json
 *   npx tsx scripts/generate-cli.ts plan --config configs/example_story.json [--out <beats.json>]
 *   npx tsx scripts/generate-cli.ts review --config configs/example_story.json --story story.md
 *   npx tsx scripts/generate-cli.ts validate --config configs/example_story.json --story story.md
 *   npx tsx scripts/generate-cli.ts repair --config configs/example_story.json --beats plan.json \
 *       --story story.md --issue-type ending --issue-message "故事缺少明确结局。" [--out <story.md>]
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStoryConfig } from "@/lib/config-io";
import { parseBeatPlan } from "@/lib/beat-parser";
import { BeatPlanner } from "@/lib/beat-planner";
import { clientFromEnv } from "@/lib/llm";
import {
  startRun, startRunFromPlan, reviewStory, validateStory, repairStory, type RunOk,
} from "@/lib/generate-service";
import { ArtifactStore } from "@/storage/artifact-store";
import { REPAIR_ISSUE_TYPES, validateRepairRecord, type RepairRecord } from "@/types/repair";
import { errorMessageOf } from "@/lib/api-error";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { RepairResult } from "@/types/repair";
import 'dotenv/config';

/** §30 退出码：只留三个，语义固定。 */
export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

const COMMANDS = ["run", "plan", "review", "validate", "repair"] as const;
export type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return typeof value === "string" && (COMMANDS as readonly string[]).includes(value);
}

/** 输出出口：测试里替换成收集器，就不必起子进程。 */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

// ---------------------------------------------------------------------------
// §29 Help：顶层与每个子命令各一份，只描述自己那一层。
// ---------------------------------------------------------------------------

const RUN_USAGE = [
  "用法：",
  "  storygen run --config <story.json> [--beats <beats.json>] [--model M] [--temperature T]",
  "       [--max-attempts 1..5] [--min-score 0..100] [--no-retry-on-validation-failure]",
  "       [--enable-repair | --no-repair] [--max-repairs 0..3]",
  "",
  "  --config <story.json>             必填：故事配置（StoryConfig）",
  "  --beats <beats.json>              可选：手动模式，用编辑过的 BeatPlan 直接生成",
  "  --model <M>                       可选：覆盖模型名（API Key 只来自服务端 LLM_API_KEY）",
  "  --base-url <url>                  可选：覆盖 LLM_BASE_URL",
  "  --temperature <T>                 可选：温度，缺省用服务端配置",
  "  --max-attempts <1..5>             可选：最多几次生成尝试（含首次），缺省 2",
  "  --min-score <0..100>              可选：审阅分数下限，低于就重试，缺省 70",
  "  --no-retry-on-validation-failure  可选：硬性规则不过也继续，不整篇重生",
  "  --enable-repair | --no-repair     可选：定点修订开关（二选一）",
  "  --max-repairs <0..3>              可选：同一次 Attempt 内最多修订几次，缺省 1",
  "",
  "  退出码：0 正常结束；1 运行时失败；2 参数或配置不合法。",
].join("\n");

const PLAN_USAGE = [
  "用法：",
  "  storygen plan --config <story.json> [--out <beats.json>] [--model M] [--temperature T]",
  "",
  "  --config <story.json>   必填：故事配置（StoryConfig）",
  "  --out <beats.json>      可选：BeatPlan 输出路径，缺省 plan_<时间戳>.beats.json",
  "  --model <M>             可选：覆盖模型名",
  "  --base-url <url>        可选：覆盖 LLM_BASE_URL",
  "  --temperature <T>       可选：温度，缺省用服务端配置",
  "",
  "  退出码：0 正常结束；1 运行时失败；2 参数或配置不合法。",
].join("\n");

const REVIEW_USAGE = [
  "用法：",
  "  storygen review --config <story.json> --story <story.md> [--model M] [--temperature T]",
  "",
  "  --config <story.json>   必填：故事配置（StoryConfig）",
  "  --story <story.md>      必填：要审阅的正文（putStory 写的「# 标题 / 正文」格式）",
  "  --model <M>             可选：覆盖模型名",
  "  --base-url <url>        可选：覆盖 LLM_BASE_URL",
  "  --temperature <T>       可选：温度，缺省用服务端配置",
  "",
  "  退出码：0 审阅跑完（低分也是 0）；1 运行时失败；2 参数或配置不合法。",
].join("\n");

const VALIDATE_USAGE = [
  "用法：",
  "  storygen validate --config <story.json> --story <story.md>",
  "",
  "  --config <story.json>   必填：故事配置（StoryConfig）",
  "  --story <story.md>      必填：要校验的正文（putStory 写的「# 标题 / 正文」格式）",
  "",
  "  只跑硬性规则，不调模型，因此不需要 LLM_API_KEY。",
  "  退出码：0 校验跑完（FAILED 也是 0——那是内容的结论，不是 CLI 失败）；",
  "        1 运行时失败；2 参数或配置不合法。",
].join("\n");

const REPAIR_USAGE = [
  "用法：",
  "  storygen repair --config <story.json> --beats <beats.json> --story <story.md>",
  "         --issue-type <type> --issue-message <text> [--out <story.md>]",
  "",
  "  --config <story.json>       必填：故事配置（StoryConfig）",
  "  --beats <beats.json>        必填：这次 Run 使用的 BeatPlan（修订只改正文，Plan 只作上下文）",
  "  --story <story.md>          必填：要修订的正文",
  `  --issue-type <type>         必填：${REPAIR_ISSUE_TYPES.join(" | ")}`,
  "  --issue-message <text>      必填：要修的问题原文（Validation issue 或 Reviewer problem）",
  "  --out <story.md>            可选：把修订后的正文写到文件（缺省只打到标准输出）",
  "  --model <M>                 可选：覆盖模型名",
  "  --base-url <url>            可选：覆盖 LLM_BASE_URL",
  "  --temperature <T>           可选：温度，缺省用服务端配置",
  "",
  "  只修订正文，不改 StoryConfig / BeatPlan，也不决定是否重试。",
  "  退出码：0 修订跑完（success=false 也是 0）；1 运行时失败；2 参数或配置不合法。",
].join("\n");

const USAGES: Record<Command, string> = {
  run: RUN_USAGE,
  plan: PLAN_USAGE,
  review: REVIEW_USAGE,
  validate: VALIDATE_USAGE,
  repair: REPAIR_USAGE,
};

const MAIN_USAGE = [
  "storyloop —— AI 短篇生成器（v0.9.1 Patch Hardening）",
  "",
  "用法：",
  "  storygen <command> [options]",
  "",
  "命令：",
  "  run       StoryConfig → Plan → Attempt（Generate → Validate → Review → Repair? → Decide）→ Retry?",
  "  plan      只产出 BeatPlan，供 run --beats 使用",
  "  review    对已有正文单独审阅",
  "  validate  对已有正文单独跑硬性规则（不调模型）",
  "  repair    对已有正文定点修订一次",
  "",
  "每个命令各自的参数：",
  "  storygen <command> --help",
  "",
  "全局：",
  "  --help, -h   显示帮助",
  "",
  "配置：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TIMEOUT / LOG_LEVEL / RUNS_DIR",
  "      从 .env 或进程环境读取；API Key 只来自服务端环境，不进任何产物。",
  "",
  "退出码：0 正常结束；1 运行时失败；2 参数或配置不合法。",
].join("\n");

// ---------------------------------------------------------------------------
// 参数解析：只认 --flag value 与 --flag 两种形式，未知 flag 一律算参数错误。
// ---------------------------------------------------------------------------

/** 需要取值的 flag（其余布尔开关在 BOOLEAN_FLAGS 里列）。 */
const VALUE_FLAGS = [
  "--config", "--beats", "--out", "--story", "--model", "--base-url", "--temperature",
  "--max-attempts", "--min-score", "--max-repairs", "--issue-type", "--issue-message", "--run-id",
] as const;

const BOOLEAN_FLAGS = [
  "--help", "-h", "--enable-repair", "--no-repair", "--no-retry-on-validation-failure",
] as const;

export interface ParsedArgs {
  command: Command | undefined;
  help: boolean;
  flags: Record<string, string>;
  switches: Set<string>;
  /** 第一个无法识别的参数，用于给出明确错误。 */
  unknown: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command = isCommand(argv[0]) ? argv[0] : undefined;
  const rest = command ? argv.slice(1) : argv;
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  let help = false;
  let unknown: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(token)) {
      switches.add(token);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        unknown = `${token} 缺少取值`;
        break;
      }
      flags[token] = value;
      i++;
      continue;
    }
    unknown = token;
    break;
  }
  return { command, help, flags, switches, unknown };
}

function flag(flags: Record<string, string>, name: string): string | undefined {
  return flags[name];
}

function numberFlag(flags: Record<string, string>, name: string): number | undefined {
  const raw = flag(flags, name);
  if (raw === undefined) return undefined;
  return Number(raw);
}

// ---------------------------------------------------------------------------
// 输出：与 v0.8.0 一致，只展示，不据此做任何动作。
// ---------------------------------------------------------------------------

/** §37 CLI 输出 Review：分数 / 总结 / 优点 / 问题。 */
function reportReview(review: ReviewResult | null, reviewError: string | undefined, io: CliIo) {
  if (!review) {
    io.out(`Review: failed${reviewError ? `（${reviewError}）` : ""}（正文已保留，可重新审阅）`);
    return;
  }
  const score = Number.isInteger(review.score) ? String(review.score) : review.score.toFixed(1);
  io.out(`Review Score: ${score} / 100`);
  io.out(`Review Summary: ${review.summary}`);
  if (review.strengths.length) {
    io.out("Strengths:");
    review.strengths.forEach((s) => io.out(`  ✓ ${s}`));
  }
  if (review.problems.length) {
    io.out("Problems:");
    review.problems.forEach((p) => io.out(`  • ${p}`));
  }
}

/** §31 CLI 输出 Validation：PASSED / FAILED + Issues（Code / Severity / Message）。 */
function reportValidation(validation: ValidationResult | null, validationError: string | undefined, io: CliIo) {
  if (!validation) {
    io.out(`Validation: failed${validationError ? `（${validationError}）` : ""}（正文已保留，可重新校验）`);
    return;
  }
  io.out(`Validation: ${validation.passed ? "PASSED" : "FAILED"}`);
  validation.issues.forEach((issue) => {
    io.out(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  });
}

function scoreText(score: number | null): string {
  if (score === null) return "n/a";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function validationText(validation: ValidationResult | null): string {
  if (!validation) return "failed（结论缺失，正文已保留）";
  const codes = validation.issues.map((i) => i.code).join(", ");
  return validation.passed ? "PASSED" : `FAILED${codes ? ` (${codes})` : ""}`;
}

/**
 * Attempt 明细：Validation → Review → Repair → Revalidation → Review after repair。
 * 初始校验 / 审阅结论与修订记录都从这次 Run 自己的产物读回，不另建统计、不编数据。
 */
function reportAttemptDetail(runId: string, attemptNumber: number, beforeScore: number | null, io: CliIo) {
  const store = new ArtifactStore();
  const meta = store.readAttemptMetadata(runId, attemptNumber);
  const repairs: RepairRecord[] = [];
  const raw = meta?.repairs;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      try {
        repairs.push(validateRepairRecord(item));
      } catch {
        /* 单条损坏的记录跳过，不影响其它输出 */
      }
    }
  }

  const initial = store.readAttemptValidation(runId, attemptNumber);
  io.out(`Attempt ${attemptNumber}`);
  io.out(`Validation: ${validationText(repairs[0]?.before_validation ?? initial)}`);
  io.out(`Review: ${scoreText(repairs[0] ? repairs[0].before_review_score : beforeScore)}`);

  for (const repair of repairs) {
    io.out(`Repair: ${repair.issue_type}`);
    if (repair.after_validation) {
      io.out(`Revalidation: ${validationText(repair.after_validation)}`);
    } else {
      io.out("Revalidation: not run（修订未成功，保留修订前结论，直接整篇重生）");
    }
    io.out(`Review after repair: ${scoreText(repair.after_review_score)}`);
  }
}

function reportRun(result: RunOk, started: number, io: CliIo) {
  io.out(`Run ID: ${result.run_id}`);
  io.out(`Status: ${result.status}`);
  io.out(`Beats: ${result.beat_plan.beats.length}`);
  io.out(`Story: runs/${result.run_id}/story.md`);
  result.attempts.forEach((a) => {
    const score = a.review_score === null
      ? null
      : Number.isInteger(a.review_score) ? String(a.review_score) : a.review_score.toFixed(1);
    reportAttemptDetail(result.run_id, a.attempt_number, a.review_score, io);
    if (a.retry_reason === "generation_error") {
      io.out(`Attempt ${a.attempt_number} → failed`);
    } else if (a.accepted) {
      io.out(`Attempt ${a.attempt_number}${score ? `: review ${score}` : ""} → accepted`);
    } else if (a.retry_reason === "validation_failed") {
      io.out(`Attempt ${a.attempt_number}: validation failed → retry`);
    } else if (score) {
      io.out(`Attempt ${a.attempt_number}: review ${score} → retry`);
    } else {
      io.out(`Attempt ${a.attempt_number} → failed`);
    }
  });
  io.out(`Quality Status: ${result.quality_status}`);
  io.out(`Selected Attempt: ${result.selected_attempt}`);
  reportValidation(result.validation, result.validation_error, io);
  reportReview(result.review, result.review_error, io);
  io.out(`Attempts: runs/${result.run_id}/attempts/`);
  io.out(`Repairs: runs/${result.run_id}/attempts/NN/repairs/`);
  io.out(`Artifacts: runs/${result.run_id}/`);
  io.out(`[cli] 完成（${((Date.now() - started) / 1000).toFixed(1)}s，${result.story.replace(/\s/g, "").length} 字）`);
}

// ---------------------------------------------------------------------------
// 参数校验：越界即退出码 2，范围与 Settings / API 使用同一套（§32）。
// ---------------------------------------------------------------------------

interface Policy {
  policy: Record<string, unknown> | undefined;
  /** §32 调用方提示：这次会不会自动多打模型。 */
  maxAttempts: number | null;
  repairOff: boolean;
  repairLimit: number | null;
  repairExplicitlyOn: boolean;
}

function retryPolicyOf(args: ParsedArgs): Policy | { error: string } {
  const maxAttempts = numberFlag(args.flags, "--max-attempts");
  const minScore = numberFlag(args.flags, "--min-score");
  const maxRepairs = numberFlag(args.flags, "--max-repairs");
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)) {
    return { error: "--max-attempts 必须是 1 ~ 5 的整数（含首次生成）" };
  }
  if (minScore !== undefined && (minScore < 0 || minScore > 100)) {
    return { error: "--min-score 必须在 0 ~ 100 之间" };
  }
  if (maxRepairs !== undefined && (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3)) {
    return { error: "--max-repairs 必须是 0 ~ 3 的整数（同一次 Attempt 内最多修订几次）" };
  }
  const enableRepair = args.switches.has("--enable-repair");
  const disableRepair = args.switches.has("--no-repair");
  if (enableRepair && disableRepair) {
    return { error: "--enable-repair 与 --no-repair 只能给一个" };
  }
  const policy: Record<string, unknown> = {};
  if (maxAttempts !== undefined) policy.max_attempts = maxAttempts;
  if (minScore !== undefined) policy.min_review_score = minScore;
  if (args.switches.has("--no-retry-on-validation-failure")) {
    policy.retry_on_validation_failure = false;
  }
  if (enableRepair) policy.enable_repair = true;
  if (disableRepair) policy.enable_repair = false;
  if (maxRepairs !== undefined) policy.max_repairs_per_attempt = maxRepairs;
  return {
    policy: Object.keys(policy).length > 0 ? policy : undefined,
    maxAttempts: maxAttempts ?? null,
    repairOff: disableRepair,
    repairLimit: maxRepairs ?? null,
    repairExplicitlyOn: enableRepair,
  };
}

function runtimeOf(args: ParsedArgs) {
  const temperature = numberFlag(args.flags, "--temperature");
  return {
    model: flag(args.flags, "--model"),
    baseUrl: flag(args.flags, "--base-url"),
    temperature: temperature !== undefined && Number.isFinite(temperature) ? temperature : undefined,
  };
}

/**
 * 读并校验 StoryConfig：读不了 / 校验不过都是退出码 2（配置问题，不是运行时问题）。
 * parseStoryConfig 内部就是 JSON.parse + validateStoryConfig，异常文本已经是面向用户的。
 */
function readConfig(configPath: string, io: CliIo) {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    io.err(`失败：读不到配置文件 ${configPath}`);
    return null;
  }
  try {
    const config = parseStoryConfig(raw);
    io.out(`[cli] 配置有效：${config.title}（${config.genre} · 约 ${config.target_words} 字）`);
    return config;
  } catch (e) {
    io.err(`失败：配置不合法：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * story.md 由 putStory 写成「# 标题 + 正文」：单独校验 / 审阅 / 修订时去掉 H1 标题行。
 * 读不到文件或没有正文都算参数问题（退出码 2）。
 */
function readStory(storyPath: string, io: CliIo): string | null {
  let markdown: string;
  try {
    markdown = readFileSync(storyPath, "utf8");
  } catch {
    io.err(`失败：读不到正文文件 ${storyPath}`);
    return null;
  }
  const story = markdown.replace(/^#\s+.*\n+/, "").trim();
  if (!story) {
    io.err(`失败：未从 ${storyPath} 读取到正文`);
    return null;
  }
  return story;
}

/** 读并校验 BeatPlan：读不了 / 不合法都是退出码 2。 */
function readBeats(beatsPath: string, io: CliIo) {
  let raw: string;
  try {
    raw = readFileSync(beatsPath, "utf8");
  } catch {
    io.err(`失败：读不到 BeatPlan 文件 ${beatsPath}`);
    return null;
  }
  try {
    return parseBeatPlan(raw);
  } catch (e) {
    io.err(`失败：BeatPlan 不合法：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function usageError(io: CliIo, message: string, usage: string): number {
  io.err(`失败：${message}`);
  io.err(usage);
  return EXIT_USAGE;
}

// ---------------------------------------------------------------------------
// 各子命令。全部返回退出码，不在命令里直接 process.exit，便于测试。
// ---------------------------------------------------------------------------

async function commandValidate(args: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = flag(args.flags, "--config");
  const storyPath = flag(args.flags, "--story");
  if (!configPath) return usageError(io, "validate 需要 --config <story.json>", VALIDATE_USAGE);
  if (!storyPath) return usageError(io, "validate 需要 --story <story.md>（要校验的正文文件）", VALIDATE_USAGE);

  const config = readConfig(configPath, io);
  if (!config) return EXIT_USAGE;
  const story = readStory(storyPath, io);
  if (story === null) return EXIT_USAGE;

  io.out("[cli] 校验正文……");
  const { status, json } = await validateStory({
    config,
    story,
    ...(flag(args.flags, "--run-id") ? { run_id: flag(args.flags, "--run-id") } : {}),
  });
  if (status !== 200) {
    io.err(`失败：${errorMessageOf(json)}`);
    return EXIT_RUNTIME;
  }
  reportValidation(json as ValidationResult, undefined, io);
  return EXIT_OK;
}

async function commandReview(args: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = flag(args.flags, "--config");
  const storyPath = flag(args.flags, "--story");
  if (!configPath) return usageError(io, "review 需要 --config <story.json>", REVIEW_USAGE);
  if (!storyPath) return usageError(io, "review 需要 --story <story.md>（要审阅的正文文件）", REVIEW_USAGE);

  const config = readConfig(configPath, io);
  if (!config) return EXIT_USAGE;
  const story = readStory(storyPath, io);
  if (story === null) return EXIT_USAGE;

  io.out("[cli] 审阅正文……");
  const { status, json } = await reviewStory({ config, story, ...runtimeOf(args) });
  if (status !== 200) {
    io.err(`失败：${errorMessageOf(json)}`);
    return EXIT_RUNTIME;
  }
  reportReview(json as ReviewResult, undefined, io);
  return EXIT_OK;
}

async function commandRepair(args: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = flag(args.flags, "--config");
  const storyPath = flag(args.flags, "--story");
  const issueType = flag(args.flags, "--issue-type");
  const issueMessage = flag(args.flags, "--issue-message");
  if (!configPath) return usageError(io, "repair 需要 --config <story.json>", REPAIR_USAGE);
  if (!storyPath) return usageError(io, "repair 需要 --story <story.md>（要修订的正文文件）", REPAIR_USAGE);
  if (!issueType) {
    return usageError(io, `repair 需要 --issue-type <${REPAIR_ISSUE_TYPES.join("|")}>`, REPAIR_USAGE);
  }
  if (!issueMessage) return usageError(io, "repair 需要 --issue-message <text>（要修的问题原文）", REPAIR_USAGE);
  // §9/§65：修订只改正文，BeatPlan 只作上下文，所以必须显式给出这次 Run 用的那一份
  const beatsPath = flag(args.flags, "--beats");
  if (!beatsPath) return usageError(io, "repair 需要 --beats <beats.json>（这次 Run 使用的 BeatPlan）", REPAIR_USAGE);

  const config = readConfig(configPath, io);
  if (!config) return EXIT_USAGE;
  const story = readStory(storyPath, io);
  if (story === null) return EXIT_USAGE;
  const plan = readBeats(beatsPath, io);
  if (!plan) return EXIT_USAGE;

  io.out(`[cli] 定点修订（${issueType}）……`);
  const { status, json } = await repairStory({
    config,
    beat_plan: plan,
    story,
    issue_type: issueType,
    issue_message: issueMessage,
    ...runtimeOf(args),
  });
  if (status !== 200) {
    io.err(`失败：${errorMessageOf(json)}`);
    return EXIT_RUNTIME;
  }
  const result = json as RepairResult;
  io.out(`Repair: ${result.issue_type}（${result.success ? "success" : "failed"}）`);
  if (result.notes) io.out(`Notes: ${result.notes}`);
  const out = flag(args.flags, "--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, result.repaired_story, "utf8");
    io.out(`[cli] 修订后正文：${out}`);
  } else {
    io.out(result.repaired_story);
  }
  return EXIT_OK;
}

async function commandPlan(args: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = flag(args.flags, "--config");
  if (!configPath) return usageError(io, "plan 需要 --config <story.json>", PLAN_USAGE);

  const config = readConfig(configPath, io);
  if (!config) return EXIT_USAGE;
  const runtime = runtimeOf(args);

  const planner = new BeatPlanner(clientFromEnv(runtime));
  io.out("[cli] 规划剧情骨架……");
  const plan = await planner.plan(config, runtime.temperature ?? 0.7);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const out = flag(args.flags, "--out") ?? `plan_${stamp}.beats.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(plan, null, 2), "utf8");
  io.out(`[cli] BeatPlan：${plan.beats.length} 个 Beat → ${out}`);
  io.out(`[cli] 下一步：npx tsx scripts/generate-cli.ts run --config ${configPath} --beats ${out}`);
  return EXIT_OK;
}

async function commandRun(args: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = flag(args.flags, "--config");
  if (!configPath) return usageError(io, "run 需要 --config <story.json>", RUN_USAGE);

  const policy = retryPolicyOf(args);
  if ("error" in policy) return usageError(io, policy.error, RUN_USAGE);

  const config = readConfig(configPath, io);
  if (!config) return EXIT_USAGE;
  const runtime = runtimeOf(args);

  let beatPlan: ReturnType<typeof parseBeatPlan> | undefined;
  const beatsPath = flag(args.flags, "--beats");
  if (beatsPath) {
    beatPlan = readBeats(beatsPath, io) ?? undefined;
    if (!beatPlan) return EXIT_USAGE;
    io.out("[cli] Manual Run（用户提供的 BeatPlan）");
  } else {
    io.out("[cli] Automatic Run");
  }

  // §32：明确告知调用方自动重试会增加 API 调用与费用
  if (policy.maxAttempts !== null && policy.maxAttempts > 1) {
    io.out(`[cli] 自动重试已开启：最多 ${policy.maxAttempts} 次生成尝试，会增加 API 调用与费用`);
  }
  // §32/§41：定点修订同样要多打模型，先把策略说清楚
  if (policy.repairOff) {
    io.out("[cli] 定点修订已关闭：Attempt 不过时直接整篇重生");
  } else if (policy.repairLimit === 0) {
    io.out("[cli] 定点修订开启但单次 Attempt 修订上限为 0：等于不修订，Attempt 不过时直接整篇重生");
  } else if (policy.repairLimit !== null || policy.repairExplicitlyOn) {
    io.out(
      `[cli] 定点修订已开启：同一次 Attempt 内最多修 ${policy.repairLimit ?? 1} 次（Repair-before-Retry），会增加 API 调用与费用`,
    );
  }

  const started = Date.now();
  const { status, json } = beatPlan
    ? await startRunFromPlan({
      config,
      beat_plan: beatPlan,
      ...runtime,
      ...(policy.policy ? { retry_policy: policy.policy } : {}),
    })
    : await startRun({ config, ...runtime, ...(policy.policy ? { retry_policy: policy.policy } : {}) });

  if (status !== 200) {
    // PipelineError 已带 run_id 与失败阶段（§28）
    io.err(`失败：${errorMessageOf(json)}`);
    return EXIT_RUNTIME;
  }
  reportRun(json as RunOk, started, io);
  return EXIT_OK;
}

/**
 * §29/§30 CLI 入口：返回退出码而不是自己 process.exit，测试可以直接调用。
 * 顶层 --help / 子命令 --help 都是 0；参数与配置问题都是 2；运行时失败是 1。
 */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
  const args = parseArgs(argv);

  // §29：storygen --help 与 storygen run --help 都必须可用
  if (args.help && !args.command) {
    io.out(MAIN_USAGE);
    return EXIT_OK;
  }
  if (args.help && args.command) {
    io.out(USAGES[args.command]);
    return EXIT_OK;
  }
  if (!args.command) {
    io.err(`失败：缺少子命令（${COMMANDS.join(" / ")}）`);
    io.err(MAIN_USAGE);
    return EXIT_USAGE;
  }
  if (args.unknown !== undefined) {
    return usageError(io, `无法识别的参数：${args.unknown}`, USAGES[args.command]);
  }
  if (!flag(args.flags, "--config")) {
    return usageError(io, `${args.command} 需要 --config <story.json>`, USAGES[args.command]);
  }

  // §32：API Key 只来自服务端环境。validate 不调模型，是唯一例外。
  if (args.command !== "validate" && !process.env.LLM_API_KEY) {
    io.err("失败：未配置 LLM_API_KEY（.env）。CLI 与 UI 使用同一服务端配置。");
    return EXIT_USAGE;
  }

  try {
    switch (args.command) {
      case "run": return await commandRun(args, io);
      case "plan": return await commandPlan(args, io);
      case "review": return await commandReview(args, io);
      case "validate": return await commandValidate(args, io);
      case "repair": return await commandRepair(args, io);
    }
  } catch (e) {
    // §28：LLMError / PipelineError 的 message 已经是可以给用户看的稳定文本
    const message = e instanceof Error ? e.message : String(e);
    io.err(`失败：${message}`);
    return EXIT_RUNTIME;
  }
}

// ---------------------------------------------------------------------------
// 入口：只有被直接执行（npx tsx scripts/generate-cli.ts ...）时才退出进程；
// 被测试 import 时只拿到 runCli，不触发 process.exit。
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = EXIT_RUNTIME; },
  );
}
