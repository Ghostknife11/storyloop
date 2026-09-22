/**
 * v0.9.0 统一配置收口（TASK §4/§5/§6/§14）。
 *
 * 四类配置互不越界，各自只有一个来源：
 *   Application Settings —— runs 目录 / 日志等级 / 默认超时，只来自环境变量 + 默认值
 *   LLM Settings        —— base_url / model / temperature / timeout
 *   StoryConfig         —— 故事内容与创作目标（src/types/story-config.ts）
 *   RetryPolicy         —— max_attempts / min_review_score / enable_repair / ...
 *                          （src/core/retry-policy.ts）
 *
 * 优先级固定为（§6，从高到低）：
 *   Request Override（model / baseUrl / temperature / timeoutMs，全部非敏感）
 *   ↓
 *   Runtime Settings（= 环境变量本身；本版本没有第二层配置文件）
 *   ↓
 *   Default Values
 *
 * API Key 不在本模块出现：它只在 src/lib/llm.ts 里从服务端环境读取一次，
 * 不进请求覆盖、不进返回值、不进任何产物（§7）。
 *
 * 所有函数都在调用时读 process.env，不做模块级缓存：测试改环境变量后立即生效，
 * 也不会在测试 chdir 之后还指向旧的 cwd。
 */

/** §5 环境变量清单：命名统一 UPPER_SNAKE_CASE，不维护等价别名。
 *  密钥变量刻意不列在这里——见文件头说明。 */
export const ENV_KEYS = {
  llmBaseUrl: "LLM_BASE_URL",
  llmModel: "LLM_MODEL",
  llmTimeout: "LLM_TIMEOUT",
  logLevel: "LOG_LEVEL",
  runsDir: "RUNS_DIR",
} as const;

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LLM_MODEL = "gpt-4o-mini";
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;
export const DEFAULT_TEMPERATURE = 0.8;

/** §8 四个等级，缺省 INFO；无法识别的值回落到 INFO（确定性优先于猜测）。 */
export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** §4 Application Settings：与模型无关的运行时开关。 */
export interface AppSettings {
  /** Run 产物根目录（§21：所有 Run 路径都被限制在它下面）。 */
  runsDir: string;
  logLevel: LogLevel;
  /** LLM 单次请求超时（毫秒）；底层 Transport Retry 共用这一个上限。 */
  llmTimeoutMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function logLevelOf(raw: string | undefined): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : DEFAULT_LOG_LEVEL;
}

/** §4/§5 Application Settings：请求覆盖不参与这里——这些不是每请求可调的。 */
export function appSettings(): AppSettings {
  return {
    runsDir: process.env[ENV_KEYS.runsDir]?.trim() || "runs",
    logLevel: logLevelOf(process.env[ENV_KEYS.logLevel]),
    llmTimeoutMs: positiveInt(process.env[ENV_KEYS.llmTimeout], DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** §6 请求可覆盖的非敏感项。 */
export interface LLMOverrides {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
}

/** §4 LLM Settings（不含密钥）：请求覆盖 > 环境变量 > 默认值。 */
export interface LLMSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export function llmSettings(overrides: LLMOverrides = {}): LLMSettings {
  const timeoutOverride = overrides.timeoutMs;
  return {
    baseUrl: overrides.baseUrl?.trim() || process.env[ENV_KEYS.llmBaseUrl] || DEFAULT_LLM_BASE_URL,
    model: overrides.model?.trim() || process.env[ENV_KEYS.llmModel] || DEFAULT_LLM_MODEL,
    temperature: overrides.temperature ?? DEFAULT_TEMPERATURE,
    timeoutMs:
      timeoutOverride !== undefined && Number.isFinite(timeoutOverride) && timeoutOverride > 0
        ? Math.floor(timeoutOverride)
        : appSettings().llmTimeoutMs,
  };
}
