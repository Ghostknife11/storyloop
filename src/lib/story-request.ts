export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

/**
 * v0.1.0 结构化故事请求（TASK §14）。
 * 这只是 StoryRequest —— 不是未来的 StoryConfig：
 * 它只描述「这次要模型写什么」，不建立故事世界模型（§3）。
 * LLM 配置（model/baseUrl/temperature）属于运行配置，不在此处（§15）。
 */
export interface StoryRequest {
  title: string;
  genre: string;
  premise: string;
  target_words: number;
  style?: string;
  extra_requirements?: string;
}

export const TARGET_WORDS_MIN = 500;
export const TARGET_WORDS_MAX = 30000;
export const TARGET_WORDS_DEFAULT = 5000;
export const TITLE_MAX = 120;

/** §16/§74 后端验证：title/genre/premise 必填，target_words 范围校验。 */
export function validateStoryRequest(raw: unknown): StoryRequest {
  const r = (raw ?? {}) as Record<string, unknown>;

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) throw new RequestValidationError("标题不能为空");
  if (title.length > TITLE_MAX) throw new RequestValidationError(`标题不能超过 ${TITLE_MAX} 字`);

  const genre = typeof r.genre === "string" ? r.genre.trim() : "";
  if (!genre) throw new RequestValidationError("题材不能为空");

  const premise = typeof r.premise === "string" ? r.premise.trim() : "";
  if (!premise) throw new RequestValidationError("故事核心设定（premise）不能为空");

  const targetWords = r.target_words;
  if (typeof targetWords !== "number" || !Number.isInteger(targetWords)) {
    throw new RequestValidationError("目标字数必须是整数");
  }
  if (targetWords < TARGET_WORDS_MIN || targetWords > TARGET_WORDS_MAX) {
    throw new RequestValidationError(`目标字数必须在 ${TARGET_WORDS_MIN} ~ ${TARGET_WORDS_MAX} 之间`);
  }

  const style = typeof r.style === "string" ? r.style.trim() : "";
  const extra = typeof r.extra_requirements === "string" ? r.extra_requirements.trim() : "";

  return {
    title,
    genre,
    premise,
    target_words: targetWords,
    style: style || undefined,
    extra_requirements: extra || undefined,
  };
}
