import {
  STORY_CONFIG_VERSION,
  validateStoryConfig,
  type StoryConfig,
} from "@/types/story-config";

export { ConfigValidationError, UnsupportedConfigVersionError } from "@/types/story-config";

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
