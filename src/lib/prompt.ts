export class PromptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptValidationError";
  }
}

/**
 * v0.0.1 prompt builder — 最朴素的模板拼接。
 * 刻意不引入 Prompt Registry / Version Manager / Router（见 TASK §19）。
 */
export function buildPrompt(title: string, userPrompt: string): string {
  if (!title || !title.trim()) {
    throw new PromptValidationError("标题不能为空");
  }
  if (!userPrompt || !userPrompt.trim()) {
    throw new PromptValidationError("故事需求不能为空");
  }
  return `你是一名短篇小说作者。

请根据以下要求创作完整故事。

标题：
${title.trim()}

要求：
${userPrompt.trim()}

要求：
- 输出完整小说正文
- 保持故事连贯
- 必须拥有明确结局`;
}
