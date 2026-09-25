import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import { parseBeatPlan } from "@/lib/beat-parser";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §9 规划阶段的缺省温度：请求没有覆盖时用这一个（与生成的缺省温度不是同一个数）。 */
export const PLAN_TEMPERATURE = 0.7;

/**
 * §9 BeatPlanner：StoryConfig → Planning Prompt → LLM → JSON Parse → BeatPlan。
 * 不得写正文、评价 Beat 质量、自动修复 Beat（§9 职责限定）。
 * 规划输出非法 → BeatParseError，由用户手动 Regenerate（§13，禁止业务层自动重试）。
 */
export class BeatPlanner {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "beat_planner.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `Beat 规划模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  private normalize(value: string | undefined, emptyText = "未指定"): string {
    return (value ?? "").trim() || emptyText;
  }

  private renderProtagonist(config: StoryConfig): string {
    const p = config.protagonist;
    return [
      `姓名：${this.normalize(p?.name)}`,
      `身份：${this.normalize(p?.identity)}`,
      `目标：${this.normalize(p?.goal)}`,
      `动机：${this.normalize(p?.motivation)}`,
    ].join("\n");
  }

  buildPlanningPrompt(config: StoryConfig): string {
    return this.template
      .replaceAll("{{title}}", config.title)
      .replaceAll("{{genre}}", config.genre)
      .replaceAll("{{premise}}", config.premise)
      .replaceAll("{{setting}}", this.normalize(config.setting))
      .replaceAll("{{protagonist}}", this.renderProtagonist(config))
      .replaceAll("{{conflict}}", this.normalize(config.conflict))
      .replaceAll("{{stakes}}", this.normalize(config.stakes))
      .replaceAll("{{ending}}", this.normalize(config.ending, "未指定，由作者自行决定"))
      .replaceAll("{{target_words}}", String(config.target_words));
  }

  async plan(config: StoryConfig, temperature = PLAN_TEMPERATURE): Promise<BeatPlan> {
    const raw = await this.llm.generate(
      this.buildPlanningPrompt(config),
      temperature,
      "你是一名短篇小说剧情策划。只输出 JSON。",
    );
    return parseBeatPlan(raw);
  }
}
