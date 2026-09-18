import { readFileSync } from "node:fs";
import type { StoryRequest } from "@/lib/story-request";
import { PromptTemplateError } from "@/lib/prompt-template";

/**
 * v0.1.0 PromptBuilder（TASK §21/§22）。
 * 只做：load template → normalize fields → render → return final prompt。
 * 不负责：调用 LLM、保存故事、自动优化 Prompt、题材策略（§22）。
 */
export class PromptBuilder {
  private template: string;

  constructor(templatePath: string) {
    // §24 模板缺失/读取失败 → 清晰报错，禁止静默回退
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

  /** §20 空可选字段归一化：输出「未指定」，绝不出现 None/undefined/null。 */
  private normalize(value: string | undefined): string {
    const v = (value ?? "").trim();
    return v || "未指定";
  }

  build(request: StoryRequest): string {
    const replacements: Record<string, string> = {
      title: request.title,
      genre: request.genre,
      premise: request.premise,
      target_words: String(request.target_words),
      style: this.normalize(request.style),
      extra_requirements: this.normalize(request.extra_requirements),
    };
    let out = this.template;
    for (const [key, value] of Object.entries(replacements)) {
      out = out.replaceAll(`{{${key}}}`, value);
    }
    // 未被替换的占位符说明模板包含不支持的变量名 —— 视为模板错误而非静默输出
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      const leftover = out.match(/\{\{[a-z_]+\}\}/g)?.join(", ") ?? "";
      throw new PromptTemplateError(`模板包含未支持的占位符：${leftover}`);
    }
    return out;
  }
}
