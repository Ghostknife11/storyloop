import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

export const STORY_TEMPLATE_PATH = join(process.cwd(), "prompts", "story.txt");

/** §24 模板缺失/读取失败必须抛清晰错误，禁止静默回退到隐藏 Prompt。 */
export async function loadPromptTemplate(path = STORY_TEMPLATE_PATH): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new PromptTemplateError(
      `Prompt 模板读取失败：${path}（${e instanceof Error ? e.message : String(e)}）。请确认 prompts/story.txt 存在且可读。`,
    );
  }
  if (!raw.trim()) {
    throw new PromptTemplateError(`Prompt 模板为空：${path}`);
  }
  return raw;
}
