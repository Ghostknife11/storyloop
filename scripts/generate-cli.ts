/**
 * v0.3.0 CLI（TASK §38）：两阶段生成。
 *   plan     —— StoryConfig → BeatPlanner → beats.json
 *   generate —— StoryConfig + beats.json → StoryGenerator → 正文 + 快照
 * 与 UI/Backend 使用同一套模型（§71）：parseStoryConfig / parseBeatPlan / StoryGenerator。
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts plan --config configs/example_story.json [--out <beats.json>]
 *   npx tsx scripts/generate-cli.ts generate --config configs/example_story.json --beats <beats.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseStoryConfig } from "@/lib/config-io";
import { parseBeatPlan } from "@/lib/beat-parser";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { clientFromEnv, LLMError } from "@/lib/llm";
import { saveStoryWithSnapshot } from "@/lib/output";
import { validateStoryConfig } from "@/types/story-config";
import "dotenv/config";

type Command = "plan" | "generate";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE = [
  "用法：",
  "  npx tsx scripts/generate-cli.ts plan --config <story.json> [--out <beats.json>]",
  "  npx tsx scripts/generate-cli.ts generate --config <story.json> --beats <beats.json>",
].join("\n");

function readConfig(configPath: string) {
  const config = parseStoryConfig(readFileSync(configPath, "utf8"));
  validateStoryConfig(config);
  console.log(`[cli] 配置有效：${config.title}（${config.genre} · 约 ${config.target_words} 字）`);
  return config;
}

async function main() {
  const command = process.argv[2] as Command | undefined;
  const configPath = argValue("--config");
  if ((command !== "plan" && command !== "generate") || !configPath) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!process.env.LLM_API_KEY) {
    console.error("未配置 LLM_API_KEY（.env）。CLI 与 UI 使用同一服务端配置。");
    process.exit(1);
  }

  console.log(`[cli] 读取配置：${configPath}`);
  const config = readConfig(configPath);
  const client = clientFromEnv();

  if (command === "plan") {
    const planner = new BeatPlanner(client);
    console.log("[cli] 规划剧情骨架……");
    const plan = await planner.plan(config);
    const out = argValue("--out") ?? join("outputs", `plan_${Date.now()}.beats.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(plan, null, 2), "utf8");
    console.log(`[cli] BeatPlan：${plan.beats.length} 个 Beat → ${out}`);
    return;
  }

  const beatsPath = argValue("--beats");
  if (!beatsPath) {
    console.error("generate 需要 --beats <beats.json>（先运行 plan 子命令）");
    process.exit(1);
  }
  const plan = parseBeatPlan(readFileSync(beatsPath, "utf8"));
  console.log(`[cli] BeatPlan：${plan.beats.length} 个 Beat（${beatsPath}）`);

  const generator = new StoryGenerator(client);
  console.log("[cli] 生成正文……");
  const started = Date.now();
  const content = await generator.generate(config, plan);
  const created = new Date().toISOString();
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  const { mdPath, configPath: snapshotPath, beatsPath: beatsSnapshot, metaPath } =
    await saveStoryWithSnapshot(config, plan, content, { project_version: "0.3.0", model, generated_at: created });

  console.log(`[cli] 完成（${((Date.now() - started) / 1000).toFixed(1)}s，${content.replace(/\s/g, "").length} 字）`);
  console.log(`[cli] 正文：${mdPath}`);
  console.log(`[cli] 快照：${snapshotPath} / ${beatsSnapshot} / ${metaPath}`);
}

main().catch((e) => {
  if (e instanceof LLMError) {
    console.error(`失败：${e.message}`);
  } else {
    console.error(`失败：${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
});
