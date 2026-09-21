import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { ReviewResult } from "@/types/review-result";
import { parseReviewResult } from "@/lib/review-parser";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §26 Reviewer 温度：内部使用较低值换取稳定评价，不做复杂策略。 */
export const REVIEW_TEMPERATURE = 0.3;

/**
 * §12 BasicReviewer：StoryConfig + Story → Review Prompt → LLM → ReviewResult。
 * 与 StoryGenerator 分离（§2）：Generator 不顺便返回 score / problems。
 * §4 Reviewer 只读取、分析、返回评价——不修改正文、不重写、不调修复逻辑。
 * §3 Reviewer 不参与生成决策：分数再低也不会触发重新生成。
 */
export class BasicReviewer {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "reviewer.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `Review 模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
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

  buildReviewPrompt(config: StoryConfig, story: string): string {
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
      .replaceAll("{{story}}", story);
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      throw new Error(`Review 模板包含未支持的占位符：${out.match(/\{\{[a-z_]+\}\}/g)?.join(", ")}`);
    }
    return out;
  }

  async review(
    config: StoryConfig,
    story: string,
    temperature = REVIEW_TEMPERATURE,
  ): Promise<ReviewResult> {
    const raw = await this.llm.generate(
      this.buildReviewPrompt(config, story),
      temperature,
      "你是一名短篇小说基础质量审阅者。只输出 JSON。",
    );
    return parseReviewResult(raw);
  }
}
