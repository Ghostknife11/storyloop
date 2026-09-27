/**
 * v2.0.0：Infrastructure 层的统一日志实现。
 *
 * 规则全部来自 v0.9.0（TASK §8/§9/§10），未作修改：
 * - 四个等级 DEBUG / INFO / WARNING / ERROR，缺省 INFO，由 LOG_LEVEL 决定（§8）。
 * - Run 级带 run_id，Attempt 内带 attempt_number，Repair 内带 repair_number（§9）。
 * - 只做工程日志：不做 Prometheus / OpenTelemetry / Trace / Metrics（§10 禁止）。
 * - 任何输出都会过一遍 redactSecrets：API Key 与 Authorization Header 不得落日志（§9）。
 *
 * 从 interface/logger.ts 搬到 Infrastructure 的原因：它写 stdout/stderr，
 * 是平台副作用；而它用到的脱敏规则已移到 domain/safe-text.ts（纯函数），
 * 依赖方向因此是 Infrastructure → Domain，方向正确。
 */

import { appSettings, type LogLevel } from "@/infrastructure/config/app-config";
import { redactSecrets } from "@/domain/safe-text";

// v2.0.0：脱敏规则搬到 domain/safe-text.ts（纯函数，Domain 层）。
// 这里 re-export 一份，让既有的 `import { redactSecrets } from "@/infrastructure/logging/logger"`
// 继续可用——Infrastructure 依赖 Domain，方向正确。
export { redactSecrets };

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
