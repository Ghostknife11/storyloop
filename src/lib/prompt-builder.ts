import { readFileSync } from "node:fs";
import type { CharacterConfig, StoryConfig } from "@/types/story-config";
import { PromptTemplateError } from "@/lib/prompt-template";

/**
 * v0.2.0 PromptBuilder（TASK §37）：build(config: StoryConfig)。
 * 只做：load template → normalize fields → render → return final prompt。
 * v0.1.0 的 build(StoryRequest) 已随 StoryRequest 一并退役。
 */
export class PromptBuilder {
  private template: string;

  constructor(templatePath: string) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new PromptTemplateError(
        `Prompt 模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）。请确认模板文件存在且可读。`,
      );
    }
    if (!this.template.trim()) {
      throw new PromptTemplateError(`Prompt 模板为空：${templatePath}`);
    }
  }

  /** §39 空字段归一化：输出「未指定」，绝不出现 None/undefined/null。 */
  private normalize(value: string | undefined, emptyText = "未指定"): string {
    const v = (value ?? "").trim();
    return v || emptyText;
  }

  /** §40 protagonist 渲染辅助（不构成 Character Engine）。 */
  private renderProtagonist(p: CharacterConfig | undefined): Record<string, string> {
    return {
      protagonist_name: this.normalize(p?.name),
      protagonist_identity: this.normalize(p?.identity),
      protagonist_goal: this.normalize(p?.goal),
      protagonist_motivation: this.normalize(p?.motivation),
    };
  }

  build(config: StoryConfig): string {
    const replacements: Record<string, string> = {
      title: config.title,
      genre: config.genre,
      premise: config.premise,
      setting: this.normalize(config.setting),
      ...this.renderProtagonist(config.protagonist),
      conflict: this.normalize(config.conflict),
      stakes: this.normalize(config.stakes),
      ending: this.normalize(config.ending, "未指定，由作者自行决定"),
      target_words: String(config.target_words),
      style: this.normalize(config.style),
      extra_requirements: this.normalize(config.extra_requirements),
    };
    let out = this.template;
    for (const [key, value] of Object.entries(replacements)) {
      out = out.replaceAll(`{{${key}}}`, value);
    }
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      const leftover = out.match(/\{\{[a-z_]+\}\}/g)?.join(", ") ?? "";
      throw new PromptTemplateError(`模板包含未支持的占位符：${leftover}`);
    }
    return out;
  }
}
