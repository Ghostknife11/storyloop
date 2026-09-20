/**
 * v0.4.0 CLI（TASK §53/§54）：生成命令统一走 GenerationPipeline。
 *   run  —— StoryConfig → Config → Planning → Generation → Persistence（一个 Run）
 *   run --beats <beats.json> —— 手动模式：用户编辑后的 BeatPlan 直接进入生成
 *   plan —— 只产出 BeatPlan，供后续 run --beats 使用
 * 与 UI/API 使用同一套 Pipeline（§55）：CLI 不再自己编排流程。
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json
 *   npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats plan_20260920.beats.json
 *   npx tsx scripts/generate-cli.ts plan --config configs/example_story.json [--out <beats.json>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseStoryConfig } from "@/lib/config-io";
import { parseBeatPlan } from "@/lib/beat-parser";
import { BeatPlanner } from "@/lib/beat-planner";
import { clientFromEnv, LLMError } from "@/lib/llm";
import { startRun, startRunFromPlan, type RunOk } from "@/lib/generate-service";
import { PipelineError } from "@/core/pipeline";
import { validateStoryConfig } from "@/types/story-config";
import "dotenv/config";

type Command = "run" | "plan";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE = [
  "用法：",
  "  npx tsx scripts/generate-cli.ts run --config <story.json> [--beats <beats.json>] [--model M] [--temperature T]",
  "  npx tsx scripts/generate-cli.ts plan --config <story.json> [--out <beats.json>]",
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

function reportRun(result: RunOk, started: number) {
  console.log(`Run ID: ${result.run_id}`);
  console.log(`Status: ${result.status}`);
  console.log(`Beats: ${result.beat_plan.beats.length}`);
  console.log(`Artifacts: runs/${result.run_id}/`);
  console.log(`[cli] 完成（${((Date.now() - started) / 1000).toFixed(1)}s，${result.story.replace(/\s/g, "").length} 字）`);
}

async function main() {
  const command = process.argv[2] as Command | undefined;
  const configPath = argValue("--config");
  if ((command !== "run" && command !== "plan") || !configPath) {
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
