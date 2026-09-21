/**
 * v0.6.0 CLI（TASK §31）：生成命令统一走 GenerationPipeline。
 *   run  —— StoryConfig → Config → Planning → Generation → Save Story → Validate → Review
 *   run --beats <beats.json> —— 手动模式：用户编辑后的 BeatPlan 直接进入生成
 *   plan —— 只产出 BeatPlan，供后续 run --beats 使用
 *   review —— 对已有正文单独审阅（与 Pipeline 使用同一个 BasicReviewer）
 *   validate —— 对已有正文单独跑硬性规则（与 Pipeline 使用同一个 StoryValidator）
 * 与 UI/API 使用同一套 Pipeline：CLI 不再自己编排流程。
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json
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
import { validateStoryConfig } from "@/types/story-config";
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

function reportRun(result: RunOk, started: number) {
  console.log(`Run ID: ${result.run_id}`);
  console.log(`Status: ${result.status}`);
  console.log(`Beats: ${result.beat_plan.beats.length}`);
  console.log(`Story: runs/${result.run_id}/story.md`);
  reportValidation(result.validation, result.validation_error);
  reportReview(result.review, result.review_error);
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
  const started = Date.now();
  const { status, json } = beatsPath
    ? await startRunFromPlan({
      config,
      beat_plan: parseBeatPlan(readFileSync(beatsPath, "utf8")),
      ...runtime,
    })
    : await startRun({ config, ...runtime });

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
