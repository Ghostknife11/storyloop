/**
 * v0.8.0 CLI（TASK §41/§42/§51）：生成命令统一走 GenerationPipeline。
 *   run  —— StoryConfig → Config → Planning → Attempt（Generate → Save → Validate → Review → Repair? → Revalidate → Re-review → Decide）→ Retry? → Finalize
 *   run --beats <beats.json> —— 手动模式：用户编辑后的 BeatPlan 直接进入生成
 *   plan —— 只产出 BeatPlan，供后续 run --beats 使用
 *   review —— 对已有正文单独审阅（与 Pipeline 使用同一个 BasicReviewer）
 *   validate —— 对已有正文单独跑硬性规则（与 Pipeline 使用同一个 StoryValidator）
 * 与 UI/API 使用同一套 Pipeline：CLI 不再自己编排流程。
 * v0.8.0：Repair-before-Retry（§20）——Attempt 不过时先定点修一次，修不好才整篇重生。
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --max-attempts 2 --min-score 70
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --enable-repair --max-repairs 1
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats plan_20260920.beats.json
 *   npx tsx scripts/generate-cli.ts plan --config configs/example_story.json [--out <beats.json>]
 *   npx tsx scripts/generate-cli.ts review --config configs/example_story.json --story story.md [--run-id <run_id>]
 *   npx tsx scripts/generate-cli.ts validate --config configs/example_story.json --story story.md [--run-id <run_id>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseStoryConfig } from "@/lib/config-io";
import { parseBeatPlan } from "@/lib/beat-parser";
import { BeatPlanner } from "@/lib/beat-planner";
import { clientFromEnv, LLMError } from "@/lib/llm";
import {
  startRun, startRunFromPlan, reviewStory, validateStory, type RunOk,
} from "@/lib/generate-service";
import { PipelineError } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateStoryConfig } from "@/types/story-config";
import { validateRepairRecord, type RepairRecord } from "@/types/repair";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import 'dotenv/config';

type Command = "run" | "plan" | "review" | "validate";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE = [
  "用法：",
  "  npx tsx scripts/generate-cli.ts run --config <story.json> [--beats <beats.json>] [--model M] [--temperature T]",
  "       [--max-attempts 1..5] [--min-score 0..100] [--no-retry-on-validation-failure]",
  "       [--enable-repair | --no-repair] [--max-repairs 0..3]",
  "  npx tsx scripts/generate-cli.ts plan --config <story.json> [--out <beats.json>]",
  "  npx tsx scripts/generate-cli.ts review --config <story.json> --story <story.md> [--run-id <run_id>]",
  "  npx tsx scripts/generate-cli.ts validate --config <story.json> --story <story.md> [--run-id <run_id>]",
].join("\n");

function runtimeOf() {
  const temperature = Number(argValue("--temperature"));
  return {
    model: argValue("--model"),
    baseUrl: argValue("--base-url"),
    temperature: Number.isFinite(temperature) ? temperature : undefined,
  };
}

/** §41 CLI 重试参数：越界即退出，与 Settings / API 使用同一套范围（§31）。 */
function retryPolicyOf() {
  const maxAttempts = Number(argValue("--max-attempts"));
  const minScore = Number(argValue("--min-score"));
  if (Number.isFinite(maxAttempts) && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)) {
    console.error("--max-attempts 必须是 1 ~ 5 的整数（含首次生成）");
    process.exit(1);
  }
  if (Number.isFinite(minScore) && (minScore < 0 || minScore > 100)) {
    console.error("--min-score 必须在 0 ~ 100 之间");
    process.exit(1);
  }
  // §18/§41：定点修订开关与单次 Attempt 上限，范围与 Settings UI 一致（0 ~ 3，默认 1）
  const enableRepair = process.argv.includes("--enable-repair");
  const disableRepair = process.argv.includes("--no-repair");
  if (enableRepair && disableRepair) {
    console.error("--enable-repair 与 --no-repair 只能给一个");
    process.exit(1);
  }
  const maxRepairs = Number(argValue("--max-repairs"));
  if (Number.isFinite(maxRepairs) && (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3)) {
    console.error("--max-repairs 必须是 0 ~ 3 的整数（同一次 Attempt 内最多修订几次）");
    process.exit(1);
  }
  const policy: Record<string, unknown> = {};
  if (Number.isFinite(maxAttempts)) policy.max_attempts = maxAttempts;
  if (Number.isFinite(minScore)) policy.min_review_score = minScore;
  if (process.argv.includes("--no-retry-on-validation-failure")) {
    policy.retry_on_validation_failure = false;
  }
  if (enableRepair) policy.enable_repair = true;
  if (disableRepair) policy.enable_repair = false;
  if (Number.isFinite(maxRepairs)) policy.max_repairs_per_attempt = maxRepairs;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function readConfig(configPath: string) {
  const config = parseStoryConfig(readFileSync(configPath, "utf8"));
  validateStoryConfig(config);
  console.log(`[cli] 配置有效：${config.title}（${config.genre} · 约 ${config.target_words} 字）`);
  return config;
}

/** §37 CLI 输出 Review：分数 / 总结 / 优点 / 问题，只展示，不据此做任何动作。 */
function reportReview(review: ReviewResult | null, reviewError?: string) {
  if (!review) {
    console.log(`Review: failed${reviewError ? `（${reviewError}）` : ""}（正文已保留，可重新审阅）`);
    return;
  }
  const score = Number.isInteger(review.score) ? String(review.score) : review.score.toFixed(1);
  console.log(`Review Score: ${score} / 100`);
  console.log(`Review Summary: ${review.summary}`);
  if (review.strengths.length) {
    console.log("Strengths:");
    review.strengths.forEach((s) => console.log(`  ✓ ${s}`));
  }
  if (review.problems.length) {
    console.log("Problems:");
    review.problems.forEach((p) => console.log(`  • ${p}`));
  }
}

/** §31 CLI 输出 Validation：PASSED / FAILED + Issues（Code / Severity / Message）。只展示，不据此做任何动作。 */
function reportValidation(validation: ValidationResult | null, validationError?: string) {
  if (!validation) {
    console.log(`Validation: failed${validationError ? `（${validationError}）` : ""}（正文已保留，可重新校验）`);
    return;
  }
  console.log(`Validation: ${validation.passed ? "PASSED" : "FAILED"}`);
  validation.issues.forEach((issue) => {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  });
}

function scoreText(score: number | null): string {
  if (score === null) return "n/a";
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function validationText(validation: ValidationResult | null): string {
  if (!validation) return "failed（结论缺失，正文已保留）";
  const codes = validation.issues.map((i) => i.code).join(", ");
  return validation.passed
    ? "PASSED"
    : `FAILED${codes ? ` (${codes})` : ""}`;
}

/**
 * §41 Attempt 明细：Validation → Review → Repair → Revalidation → Review after repair。
 * 初始校验 / 审阅结论与修订记录都从这次 Run 自己的产物读回（§29~§32），
 * 不另建统计、不编数据：修订没成功时 Revalidation 就是 not run。
 */
function reportAttemptDetail(runId: string, attemptNumber: number, beforeScore: number | null) {
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
  console.log(`Attempt ${attemptNumber}`);
  console.log(`Validation: ${validationText(repairs[0]?.before_validation ?? initial)}`);
  // §36：修订前的分数取这条修订记录的 before_review_score；没有修订就用最终结论
  console.log(`Review: ${scoreText(repairs[0] ? repairs[0].before_review_score : beforeScore)}`);

  for (const repair of repairs) {
    console.log(`Repair: ${repair.issue_type}`);
    if (repair.after_validation) {
      console.log(`Revalidation: ${validationText(repair.after_validation)}`);
    } else {
      console.log("Revalidation: not run（修订未成功，保留修订前结论，直接整篇重生）");
    }
    console.log(`Review after repair: ${scoreText(repair.after_review_score)}`);
  }
}

function reportRun(result: RunOk, started: number) {
  console.log(`Run ID: ${result.run_id}`);
  console.log(`Status: ${result.status}`);
  console.log(`Beats: ${result.beat_plan.beats.length}`);
  console.log(`Story: runs/${result.run_id}/story.md`);
  // §41/§42 Attempt 过程：每一次尝试一段。被重试写 retry，用尽写 failed，采纳写 accepted。
  result.attempts.forEach((a) => {
    const score = a.review_score === null
      ? null
      : Number.isInteger(a.review_score) ? String(a.review_score) : a.review_score.toFixed(1);
    reportAttemptDetail(result.run_id, a.attempt_number, a.review_score);
    if (a.retry_reason === "generation_error") {
      console.log(`Attempt ${a.attempt_number} → failed`);
    } else if (a.accepted) {
      console.log(`Attempt ${a.attempt_number}${score ? `: review ${score}` : ""} → accepted`);
    } else if (a.retry_reason === "validation_failed") {
      console.log(`Attempt ${a.attempt_number}: validation failed → retry`);
    } else if (score) {
      console.log(`Attempt ${a.attempt_number}: review ${score} → retry`);
    } else {
      console.log(`Attempt ${a.attempt_number} → failed`);
    }
  });
  console.log(`Quality Status: ${result.quality_status}`);
  console.log(`Selected Attempt: ${result.selected_attempt}`);
  reportValidation(result.validation, result.validation_error);
  reportReview(result.review, result.review_error);
  console.log(`Attempts: runs/${result.run_id}/attempts/`);
  console.log(`Repairs: runs/${result.run_id}/attempts/NN/repairs/`);
  console.log(`Artifacts: runs/${result.run_id}/`);
  console.log(`[cli] 完成（${((Date.now() - started) / 1000).toFixed(1)}s，${result.story.replace(/\s/g, "").length} 字）`);
}

async function main() {
  const command = process.argv[2] as Command | undefined;
  const configPath = argValue("--config");
  if (
    (command !== "run" && command !== "plan" && command !== "review" && command !== "validate") ||
    !configPath
  ) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!process.env.LLM_API_KEY) {
    console.error("未配置 LLM_API_KEY（.env）。CLI 与 UI 使用同一服务端配置。");
    process.exit(1);
  }

  console.log(`[cli] 读取配置：${configPath}`);
  const config = readConfig(configPath);
  const runtime = runtimeOf();

  if (command === "validate") {
    // §31 validate 子命令：与 Pipeline 使用同一个 StoryValidator，只校验不生成
    const storyPath = argValue("--story");
    if (!storyPath) {
      console.error("validate 需要 --story <story.md>（要校验的正文文件）");
      process.exit(1);
    }
    const markdown = readFileSync(storyPath, "utf8");
    // story.md 由 putStory 写成「# 标题\n\n正文」：校验时去掉 H1 标题行
    const story = markdown.replace(/^#\s+.*\n+/, "").trim();
    if (!story) {
      console.error(`未从 ${storyPath} 读取到正文`);
      process.exit(1);
    }
    const runId = argValue("--run-id");
    console.log("[cli] 校验正文……");
    const { status, json } = await validateStory({
      config,
      story,
      ...(runId ? { run_id: runId } : {}),
    });
    if (status !== 200) {
      console.error(`失败：${(json as { error: string }).error}`);
      process.exit(1);
    }
    reportValidation(json as ValidationResult);
    return;
  }

  if (command === "review") {
    // §37 review 子命令：与 Pipeline 使用同一个 BasicReviewer，只审阅不生成
    const storyPath = argValue("--story");
    if (!storyPath) {
      console.error("review 需要 --story <story.md>（要审阅的正文文件）");
      process.exit(1);
    }
    const markdown = readFileSync(storyPath, "utf8");
    // story.md 由 putStory 写成「# 标题\n\n正文」：审阅时去掉 H1 标题行
    const story = markdown.replace(/^#\s+.*\n+/, "").trim();
    if (!story) {
      console.error(`未从 ${storyPath} 读取到正文`);
      process.exit(1);
    }
    console.log("[cli] 审阅正文……");
    const { status, json } = await reviewStory({ config, story, ...runtime });
    if (status !== 200) {
      console.error(`失败：${(json as { error: string }).error}`);
      process.exit(1);
    }
    reportReview(json as ReviewResult);
    return;
  }

  if (command === "plan") {
    const planner = new BeatPlanner(clientFromEnv(runtime));
    console.log("[cli] 规划剧情骨架……");
    const plan = await planner.plan(config, runtime.temperature ?? 0.7);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const out = argValue("--out") ?? `plan_${stamp}.beats.json`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(plan, null, 2), "utf8");
    console.log(`[cli] BeatPlan：${plan.beats.length} 个 Beat → ${out}`);
    console.log(`[cli] 下一步：npx tsx scripts/generate-cli.ts run --config ${configPath} --beats ${out}`);
    return;
  }

  const beatsPath = argValue("--beats");
  console.log(beatsPath ? "[cli] Manual Run（用户提供的 BeatPlan）" : "[cli] Automatic Run");
  const retryPolicy = retryPolicyOf();
  // §32：明确告知调用方自动重试会增加 API 调用与费用
  const maxAttempts = Number(argValue("--max-attempts"));
  if (Number.isFinite(maxAttempts) && maxAttempts > 1) {
    console.log(`[cli] 自动重试已开启：最多 ${maxAttempts} 次生成尝试，会增加 API 调用与费用`);
  }
  // §32/§41：定点修订同样要多打模型，先把策略说清楚
  const repairPolicy = retryPolicy as Record<string, unknown> | undefined;
  const repairOff = repairPolicy?.enable_repair === false;
  const repairLimit = typeof repairPolicy?.max_repairs_per_attempt === "number"
    ? repairPolicy.max_repairs_per_attempt
    : null;
  if (repairOff) {
    console.log("[cli] 定点修订已关闭：Attempt 不过时直接整篇重生");
  } else if (repairLimit === 0) {
    console.log("[cli] 定点修订开启但单次 Attempt 修订上限为 0：等于不修订，Attempt 不过时直接整篇重生");
  } else if (repairLimit !== null || repairPolicy?.enable_repair === true) {
    console.log(
      `[cli] 定点修订已开启：同一次 Attempt 内最多修 ${repairLimit ?? 1} 次（Repair-before-Retry），会增加 API 调用与费用`,
    );
  }
  const started = Date.now();
  const { status, json } = beatsPath
    ? await startRunFromPlan({
      config,
      beat_plan: parseBeatPlan(readFileSync(beatsPath, "utf8")),
      ...runtime,
      ...(retryPolicy ? { retry_policy: retryPolicy } : {}),
    })
    : await startRun({ config, ...runtime, ...(retryPolicy ? { retry_policy: retryPolicy } : {}) });

  if (status !== 200) {
    // PipelineError 已带 run_id 与失败阶段（§28）
    console.error(`失败：${(json as { error: string }).error}`);
    process.exit(1);
  }
  reportRun(json as RunOk, started);
}

main().catch((e) => {
  if (e instanceof LLMError || e instanceof PipelineError) {
    console.error(`失败：${e.message}`);
  } else {
    console.error(`失败：${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
});
