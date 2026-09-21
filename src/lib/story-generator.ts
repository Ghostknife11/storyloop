import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/**
 * §14 StoryGenerator：StoryConfig + BeatPlan → Story Prompt → LLM → Story。
 * 它不是 Pipeline（§2）。§16：BeatPlan 用轻量 renderer 渲染，不 str(dict)。
 */
export class StoryGenerator {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "story.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `Story 模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  /** §16 BeatPlan Renderer：Beat 1 / Purpose / Event / ... 顺序保持一致。 */
  renderBeatPlan(plan: BeatPlan): string {
    return plan.beats
      .map((b) => {
        const lines = [
          `Beat ${b.id}`,
          `Purpose: ${b.purpose}`,
          `Event: ${b.event}`,
          `Characters: ${b.characters.join("、") || "未指定"}`,
        ];
        if (b.conflict) lines.push(`Conflict: ${b.conflict}`);
        if (b.expected_outcome) lines.push(`Expected Outcome: ${b.expected_outcome}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  buildStoryPrompt(config: StoryConfig, plan: BeatPlan): string {
    const out = this.template
      .replaceAll("{{title}}", config.title)
      .replaceAll("{{genre}}", config.genre)
      .replaceAll("{{premise}}", config.premise)
      .replaceAll("{{setting}}", config.setting?.trim() || "未指定")
      .replaceAll("{{protagonist_name}}", config.protagonist?.name?.trim() || "未指定")
      .replaceAll("{{protagonist_identity}}", config.protagonist?.identity?.trim() || "未指定")
      .replaceAll("{{protagonist_goal}}", config.protagonist?.goal?.trim() || "未指定")
      .replaceAll("{{protagonist_motivation}}", config.protagonist?.motivation?.trim() || "未指定")
      .replaceAll("{{conflict}}", config.conflict?.trim() || "未指定")
      .replaceAll("{{stakes}}", config.stakes?.trim() || "未指定")
      .replaceAll("{{ending}}", config.ending?.trim() || "未指定，由作者自行决定")
      .replaceAll("{{target_words}}", String(config.target_words))
      .replaceAll("{{style}}", config.style?.trim() || "未指定")
      .replaceAll("{{extra_requirements}}", config.extra_requirements?.trim() || "未指定")
      .replaceAll("{{beat_plan}}", this.renderBeatPlan(plan));
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      throw new Error(`Story 模板包含未支持的占位符：${out.match(/\{\{[a-z_]+\}\}/g)?.join(", ")}`);
    }
    return out;
  }

  async generate(
    config: StoryConfig,
    plan: BeatPlan,
    temperature = 0.8,
    system = "你是一名专业短篇小说作者。严格参考 StoryConfig 和 Story Beat Plan 创作完整短篇小说。",
  ): Promise<string> {
    return this.llm.generate(this.buildStoryPrompt(config, plan), temperature, system);
  }
}
