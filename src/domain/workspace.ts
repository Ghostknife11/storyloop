/**
 * v2.2.0 工作区词汇表（TASK §3/§7/§42）。
 *
 * Project / StoryDocument / DocumentRevision / ExportResult 四个模型共用这一份
 * 地基：id 长什么样、哪些字段是自由文本、时间戳怎么算合法、失败了抛哪一类错。
 * 放在一个文件里不是为了少写几个 import——而是这四个模型的校验口径必须逐字一致，
 * 分成四份迟早会各自漂移（v1.7.0 的 ExperimentDefinition 就是这么长出第二套规则的）。
 *
 * 三条不可协商的边界，全版本有效：
 *   1. id 永远由系统生成，用户输入只可能是**名字 / 标题 / 文件名**；
 *   2. 名字 / 标题是不可信输入，只进展示与正文，绝不能被拼成路径（§42）；
 *   3. 这里没有 I/O、没有时间、没有随机——同样的输入必然得到同样的输出（§39 Domain 纯度）。
 */

/** 当前工作区模型的 schema 版本；字段语义变化时递增。 */
export const WORKSPACE_SCHEMA_VERSION = "1";

/** §42 id 只允许单个目录名：一段、以字母或数字开头、不含路径分隔符。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** id 长度上限；目录名再长就在文件管理器里没法看了。 */
export const WORKSPACE_ID_MAX = 64;

/** 项目名 / 文档标题的上限（§42：它们是不可信输入，但仍然要有界）。 */
export const WORKSPACE_NAME_MAX = 120;
/** 说明性文字的上限。 */
export const WORKSPACE_NOTE_MAX = 500;

/**
 * 控制字符一律不进工作区文本：它们既不能在界面上显示，也不能安全地出现在
 * 导出文件的元数据里。0x7F（DEL）与 C1 控制块同样算。
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 这个字符串能不能当目录名用：单段、以字母或数字开头、不是 "." / ".."。
 *
 * 读与改的路由用这个判定——不合法一律当「不存在」（404），不把 URL 里的原句
 * 喂给路径解析。写成用一次就够的谓词，是因为「合不合法」这件事要在 Domain、
 * Infrastructure 的目录列举和路由三处给出同一个答案（v1.7.1：`exp/../../x`
 * 曾因为三处口径不一致走到 500）。
 */
export function isWorkspaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WORKSPACE_ID_MAX &&
    value !== "." &&
    value !== ".." &&
    ID_PATTERN.test(value)
  );
}

/** 结构不合法（形状、越界、类型不对）。对应 400。 */
export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

/** 指名的东西不在盘上。对应 404。 */
export class WorkspaceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNotFoundError";
  }
}

/** 与磁盘现状冲突（重名、并发改坏、越界引用）。对应 409。 */
export class WorkspaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

/** 状态不允许这个动作（例如给已归档项目建稿件）。对应 409。 */
export class WorkspaceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStateError";
  }
}

function objOf(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkspaceValidationError(`${field} 必须是对象`);
  }
  return raw as Record<string, unknown>;
}

/** 必填文本：去首尾空白、非空、有上限、不含控制字符。 */
export function textOf(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new WorkspaceValidationError(`${field} 必须是非空字符串`);
  }
  const value = raw.trim();
  if (value.length > max) throw new WorkspaceValidationError(`${field} 不能超过 ${max} 个字符`);
  if (CONTROL_CHARS.test(value)) throw new WorkspaceValidationError(`${field} 不能包含控制字符`);
  return value;
}

/** 可空文本：undefined / null / 空串一律归一成 undefined。 */
export function optionalTextOf(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return textOf(raw, field, max);
}

/** 布尔：只接受真布尔，不接受 "true" / 1 这类猜出来的真。 */
export function flagOf(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "boolean") throw new WorkspaceValidationError(`${field} 必须是布尔值`);
  return raw;
}

/** 枚举。 */
export function enumOf<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new WorkspaceValidationError(`${field} 只能是 ${allowed.join(" / ")}（实际 ${String(raw)}）`);
  }
  return raw as T;
}

/**
 * ISO 8601 时间戳。只校验形状，不校验「是不是真的那一刻」——时钟归基础设施，
 * Domain 不需要第二套日期库也能判断一个字段还能不能被当成时间用。
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isoTimestampOf(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !ISO_TIMESTAMP.test(raw)) {
    throw new WorkspaceValidationError(`${field} 必须是 ISO 8601 时间戳（实际 ${String(raw)}）`);
  }
  return raw;
}

/** 未知键一律拒绝（白名单之外的字段不是「先存着」，是契约外的东西）。 */
export function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new WorkspaceValidationError(`${field} 不支持字段 ${key}（白名单：${allowed.join(" / ")}）`);
    }
  }
}

/** 未知键递归扫描：凭据形状的键名出现在请求体里就拒绝（§61 同一套思路）。 */
const FORBIDDEN_KEY_SHAPES = new Set([
  "baseurl",
  "api_key",
  "apikey",
  "llm_api_key",
  "authorization",
  "auth",
  "cookie",
  "headers",
  "env",
  "environment",
  "token",
  "secret",
  "credentials",
  "password",
]);

export function rejectSecretBearingKeys(raw: unknown, path = "workspace"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, i) => rejectSecretBearingKeys(item, `${path}[${i}]`));
    return;
  }
  if (typeof raw !== "object" || raw === null) return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_SHAPES.has(key.toLowerCase())) {
      throw new WorkspaceValidationError(
        `${path}.${key} 不允许出现在工作区请求里（凭据 / 地址 / 原始环境变量都不进项目与稿件，§44）`,
      );
    }
    rejectSecretBearingKeys(value, `${path}.${key}`);
  }
}
