/**
 * v0.2.0 CLI（TASK §59-61）：从 StoryConfig 文件生成小说。
 * 与 UI/Backend 使用同一个 StoryConfig 模型与 PromptBuilder（§61）。
 *
 * 用法：
 *   npx tsx scripts/generate-cli.ts --config configs/example_story.json [--out <dir>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoryConfig } from "@/lib/config-io";
import { PromptBuilder } from "@/lib/prompt-builder";
import { clientFromEnv, LLMError } from "@/lib/llm";
import { saveStoryWithSnapshot } from "@/lib/output";
import { validateStoryConfig } from "@/types/story-config";
import "dotenv/config";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const configPath = argValue("--config");
  if (!configPath) {
    console.error("用法：npx tsx scripts/generate-cli.ts --config configs/example_story.json [--out <dir>]");
    process.exit(1);
  }
  if (!process.env.LLM_API_KEY) {
    console.error("未配置 LLM_API_KEY（.env）。CLI 与 UI 使用同一服务端配置。");
    process.exit(1);
  }

  console.log(`[cli] 读取配置：${configPath}`);
  const config = parseStoryConfig(readFileSync(configPath, "utf8"));
  validateStoryConfig(config);
  console.log(`[cli] 配置有效：${config.title}（${config.genre} · 约 ${config.target_words} 字）`);

  const builder = new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));
  const client = clientFromEnv();
  const temperature = 0.8;

  console.log("[cli] 生成中……");
  const started = Date.now();
  const content = await client.generate(builder.build(config), temperature, "你是一名专业短篇小说作者。");
  const created = new Date().toISOString();
  const model = process.env.LLM_MODEL || "gpt-4o-mini";

  const { mdPath, configPath: snapshotPath, metaPath } = await saveStoryWithSnapshot(
    config,
    content,
    { project_version: "0.2.0", model, generated_at: created },
  );

  console.log(`[cli] 完成（${((Date.now() - started) / 1000).toFixed(1)}s，${content.replace(/\s/g, "").length} 字）`);
  console.log(`[cli] 正文：${mdPath}`);
  console.log(`[cli] 快照：${snapshotPath}`);
  console.log(`[cli] 元数据：${metaPath}`);
}

main().catch((e) => {
  if (e instanceof LLMError) {
    console.error(`生成失败：${e.message}`);
  } else {
    console.error(`失败：${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
});
