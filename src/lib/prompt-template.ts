import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

export const STORY_TEMPLATE_PATH = join(PROJECT_ROOT, "prompts", "story.txt");

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
