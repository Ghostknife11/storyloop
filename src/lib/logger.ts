/**
 * v0.9.0 统一日志（TASK §8/§9/§10）。
 *
 * - 四个等级 DEBUG / INFO / WARNING / ERROR，缺省 INFO，由 LOG_LEVEL 决定（§8）。
 * - Run 级带 run_id，Attempt 内带 attempt_number，Repair 内带 repair_number（§9）：
 *     [run=20260922_101500_ab12cd] planning started
 *     [run=... attempt=1] generation completed
 *     [run=... attempt=1 repair=1] repair completed
 * - 只做工程日志：不做 Prometheus / OpenTelemetry / Trace / Metrics（§10 禁止）。
 * - 任何输出都会过一遍 redactSecrets：API Key 与 Authorization Header 不得落日志（§9）。
 *   原始异常仍可整体传入——序列化时同样会脱敏。
 */

import { appSettings, type LogLevel } from "@/lib/app-config";

export interface LogContext {
  run_id?: string;
  attempt_number?: number;
  repair_number?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** §9 脱敏：密钥形态的串一律打码，日志里只剩前后各几位用于定位。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/("?(?:api[_-]?key|authorization|token|password|secret)"?\s*[:=]\s*")([^"]*)(")/gi, "$1***$3");
}

function contextPrefix(context: LogContext): string {
  const parts: string[] = [];
  if (context.run_id) parts.push(`run=${context.run_id}`);
  if (context.attempt_number !== undefined) parts.push(`attempt=${context.attempt_number}`);
  if (context.repair_number !== undefined) parts.push(`repair=${context.repair_number}`);
  return parts.length > 0 ? `[${parts.join(" ")}]` : "[app]";
}

function detailText(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.name}: ${redactSecrets(detail.message)}`;
  if (typeof detail === "string") return ` ${redactSecrets(detail)}`;
  try {
    return ` ${redactSecrets(JSON.stringify(detail) ?? String(detail))}`;
  } catch {
    return ` ${redactSecrets(String(detail))}`;
  }
}

export class Logger {
  constructor(
    private readonly context: LogContext = {},
    /** 测试可注入固定等级；缺省每次调用时读 LOG_LEVEL。 */
    private readonly minLevel?: LogLevel,
  ) {}

  /** §9：派生一个带上下文更具体的 Logger，父级字段保留。 */
  child(patch: LogContext): Logger {
    return new Logger({ ...this.context, ...patch }, this.minLevel);
  }

  debug(message: string, detail?: unknown): void {
    this.write("debug", message, detail);
  }

  info(message: string, detail?: unknown): void {
    this.write("info", message, detail);
  }

  warning(message: string, detail?: unknown): void {
    this.write("warning", message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.write("error", message, detail);
  }

  /** 当前等级下这条消息会不会被写出去（测试与调用方都能问）。 */
  enabled(level: LogLevel): boolean {
    const min = this.minLevel ?? appSettings().logLevel;
    return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
  }

  private write(level: LogLevel, message: string, detail: unknown): void {
    if (!this.enabled(level)) return;
    const line = `${contextPrefix(this.context)} ${level.toUpperCase()} ${redactSecrets(message)}${detailText(detail)}`;
    if (level === "warning" || level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

/** 默认 Logger：Pipeline / 服务层直接用，需要上下文时用 child() 派生。 */
export const logger = new Logger();
