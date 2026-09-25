import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import {
  COMMERCIAL_DIMENSION_DEFINITIONS,
  type CommercialReviewResult,
} from "@/types/commercial-review";
import { parseCommercialReviewResult } from "@/lib/commercial-review-parser";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §3 商业审阅温度：与基础审阅同一个量级，换取稳定的四维判断。 */
export const COMMERCIAL_REVIEW_TEMPERATURE = 0.3;

/**
 * §12 CommercialReviewer：StoryConfig + Story → Prompt → LLM → CommercialReviewResult。
 *
 * 与 BasicReviewer（Co/N/C/Ca 那一套）是两个独立的审阅者，共用一个 LLMClient，
 * 但不共用一个 Prompt、不共用一套 schema、也不互相读取结论（TASK §12）：
 * 结构质量与商业可读性并不总是一致，合成一个巨型 Prompt 只会让两边都更难稳定。
 *
 * §14 只 evaluate / explain / suggest：不改写正文、不重写、不触发修复或重试。
 * 分数再低也只是屏幕上多一行说明（TASK §15）。
 */
export class CommercialReviewer {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "commercial_reviewer.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `商业审阅模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
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

  buildCommercialReviewPrompt(config: StoryConfig, story: string): string {
    const out = this.template
      .replaceAll("{{title}}", config.title)
      .replaceAll("{{genre}}", config.genre)
      .replaceAll("{{premise}}", config.premise)
      .replaceAll("{{setting}}", this.normalize(config.setting))
      .replaceAll("{{protagonist}}", this.renderProtagonist(config))
      .replaceAll("{{conflict}}", this.normalize(config.conflict))
      .replaceAll("{{stakes}}", this.normalize(config.stakes))
      .replaceAll("{{ending}}", this.normalize(config.ending, "未指定，由作者自行决定"))
      .replaceAll("{{target_words}}", String(config.target_words))
      .replaceAll("{{style}}", this.normalize(config.style))
      .replaceAll("{{extra_requirements}}", this.normalize(config.extra_requirements))
      .replaceAll("{{hook_definition}}", COMMERCIAL_DIMENSION_DEFINITIONS.hook)
      .replaceAll("{{pacing_definition}}", COMMERCIAL_DIMENSION_DEFINITIONS.pacing)
      .replaceAll("{{engagement_definition}}", COMMERCIAL_DIMENSION_DEFINITIONS.engagement)
      .replaceAll("{{payoff_definition}}", COMMERCIAL_DIMENSION_DEFINITIONS.payoff)
      .replaceAll("{{story}}", story);
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      throw new Error(`商业审阅模板包含未支持的占位符：${out.match(/\{\{[a-z_]+\}\}/g)?.join(", ")}`);
    }
    return out;
  }

  async review(
    config: StoryConfig,
    story: string,
    temperature = COMMERCIAL_REVIEW_TEMPERATURE,
  ): Promise<CommercialReviewResult> {
    const raw = await this.llm.generate(
      this.buildCommercialReviewPrompt(config, story),
      temperature,
      "你是一名短篇小说商业可读性审阅者。只评价开篇抓力、节奏、持续阅读动力与回报。只输出 JSON。",
    );
    return parseCommercialReviewResult(raw);
  }
}
