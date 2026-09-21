/**
 * §8/§9/§10 RunContext：一次完整故事生成 = 一个 Run。
 * 状态只用于表示当前 Run 运行到了哪里（§11），不是 Observability。
 * v0.5.0 新增 reviewing（§18）：Story 落盘之后的审阅阶段。
 * v0.6.0 新增 validating（§17）：Story 落盘之后、审阅之前的硬性有效性检查阶段。
 */

import { randomBytes } from "node:crypto";

export type RunStatus =
  | "created"
  | "planning"
  | "generating"
  | "saving"
  | "validating"
  | "reviewing"
  | "completed"
  | "failed";

export interface RunContext {
  run_id: string;
  project_version: string;
  started_at: string;
  status: RunStatus;
  current_stage: string | null;
  error: string | null;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** §8 Run ID：时间戳 + 短随机。唯一、文件系统安全、不依赖用户输入。 */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  return `${stamp}_${suffix}`;
}

export function createRunContext(projectVersion: string): RunContext {
  return {
    run_id: generateRunId(),
    project_version: projectVersion,
    started_at: new Date().toISOString(),
    status: "created",
    current_stage: null,
    error: null,
  };
}

export function transitionStage(ctx: RunContext, stage: string, status: RunStatus): void {
  ctx.current_stage = stage;
  ctx.status = status;
}

/** §27/§28：失败不吞异常，记录阶段与安全错误信息。 */
export function failRun(ctx: RunContext, stage: string, error: string): void {
  ctx.status = "failed";
  ctx.current_stage = stage;
  ctx.error = error;
}
