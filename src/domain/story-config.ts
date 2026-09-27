export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export class UnsupportedConfigVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConfigVersionError";
  }
}

/** §23 配置格式版本（与项目 VERSION 是两回事，§25）。 */
export const STORY_CONFIG_VERSION = "1";
export const SUPPORTED_CONFIG_VERSIONS = ["1"];

/** §68 前端/后端共用的 StoryConfig 类型（snake_case 统一命名，§69）。 */
export interface CharacterConfig {
  name: string;
  identity?: string;
  goal?: string;
  motivation?: string;
}

export interface StoryConfig {
  config_version: string;

  title: string;
  genre: string;
  premise: string;

  setting?: string;
  protagonist?: CharacterConfig;

  conflict?: string;
  stakes?: string;
  ending?: string;

  target_words: number;
  style?: string;
  extra_requirements?: string;
}

/** §39 Genre presets 属于 UI 便利，后端接受任意字符串。 */
export const GENRE_PRESETS = ["悬疑", "豪门", "重生", "都市", "言情", "科幻", "奇幻", "其他"] as const;

/** §40 Style presets 同样只是 UI 便利。 */
export const STYLE_PRESETS = ["节奏紧凑", "克制冷峻", "轻松幽默", "电影感", "第一人称", "第三人称"] as const;

export const TARGET_WORDS_MIN = 500;
export const TARGET_WORDS_MAX = 30000;
export const TARGET_WORDS_DEFAULT = 5000;
export const TITLE_MAX = 120;

/** §26/§70 StoryConfig 校验：title/genre/premise/target_words/config_version 必须合法；protagonist 存在时 name 必填。 */
export function validateStoryConfig(raw: unknown): StoryConfig {
  const r = (raw ?? {}) as Record<string, unknown>;

  const version = typeof r.config_version === "string" && r.config_version.trim() ? r.config_version.trim() : STORY_CONFIG_VERSION;
  if (!SUPPORTED_CONFIG_VERSIONS.includes(version)) {
    throw new UnsupportedConfigVersionError(`不支持的 config_version：${version}（当前支持 ${SUPPORTED_CONFIG_VERSIONS.join(", ")}）`);
  }

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) throw new ConfigValidationError("标题不能为空");
  if (title.length > TITLE_MAX) throw new ConfigValidationError(`标题不能超过 ${TITLE_MAX} 字`);

  const genre = typeof r.genre === "string" ? r.genre.trim() : "";
  if (!genre) throw new ConfigValidationError("题材不能为空");

  const premise = typeof r.premise === "string" ? r.premise.trim() : "";
  if (!premise) throw new ConfigValidationError("故事核心设定（premise）不能为空");

  const targetWords = r.target_words;
  if (typeof targetWords !== "number" || !Number.isInteger(targetWords)) {
    throw new ConfigValidationError("目标字数必须是整数");
  }
  if (targetWords < TARGET_WORDS_MIN || targetWords > TARGET_WORDS_MAX) {
    throw new ConfigValidationError(`目标字数必须在 ${TARGET_WORDS_MIN} ~ ${TARGET_WORDS_MAX} 之间`);
  }

  const config: StoryConfig = {
    config_version: version,
    title,
    genre,
    premise,
    target_words: targetWords,
  };

  if (typeof r.setting === "string" && r.setting.trim()) config.setting = r.setting.trim();

  if (r.protagonist !== undefined && r.protagonist !== null) {
    if (typeof r.protagonist !== "object") throw new ConfigValidationError("protagonist 必须是对象");
    const p = r.protagonist as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) throw new ConfigValidationError("主角姓名（protagonist.name）不能为空");
    const protagonist: CharacterConfig = { name: name.slice(0, 60) };
    if (typeof p.identity === "string" && p.identity.trim()) protagonist.identity = p.identity.trim();
    if (typeof p.goal === "string" && p.goal.trim()) protagonist.goal = p.goal.trim();
    if (typeof p.motivation === "string" && p.motivation.trim()) protagonist.motivation = p.motivation.trim();
    config.protagonist = protagonist;
  }

  if (typeof r.conflict === "string" && r.conflict.trim()) config.conflict = r.conflict.trim();
  if (typeof r.stakes === "string" && r.stakes.trim()) config.stakes = r.stakes.trim();
  if (typeof r.ending === "string" && r.ending.trim()) config.ending = r.ending.trim();
  if (typeof r.style === "string" && r.style.trim()) config.style = r.style.trim();
  if (typeof r.extra_requirements === "string" && r.extra_requirements.trim()) config.extra_requirements = r.extra_requirements.trim();

  return config;
}

/** config.json 读进来但 JSON 本身坏掉（与校验不过是两件事）。 */
export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

/** §63/§64 序列化：UTF-8、可读字段名、2 空格缩进，保证 round-trip。 */
export function serializeStoryConfig(config: StoryConfig): string {
  return JSON.stringify(config, null, 2);
}

/**
 * §46 Load 原子性：先完整解析，再完整验证，全部成功才返回。
 * 失败抛 ConfigLoadError / ConfigValidationError / UnsupportedConfigVersionError，
 * 调用方不得部分应用结果。
 */
export function parseStoryConfig(text: string): StoryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigLoadError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return validateStoryConfig(raw);
}

/** §47 保存文件名：sanitized_title.story.json */
export function configFilename(title: string): string {
  const safe = title.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "untitled";
  return `${safe}.story.json`;
}
