/**
 * §8/§9/§10 RunContext：一次完整故事生成 = 一个 Run。
 * 状态只用于表示当前 Run 运行到了哪里（§11），不是 Observability。
 *
 * v2.0.0：本文件位于 Domain 层，是「一次运行」的稳定契约。它只描述状态，
 * 不做任何事——运行号（run_id）由 Infrastructure 的 id 端口生成后传入，
 * 时间由 clock 端口提供，于是这里的每个函数都是纯函数、可确定性测试。
 * v1.9.1 及以前，run_id 是这里用 node:crypto 直接生成的，那让 Domain
 * 依赖了平台 API，也让「同一个 Run」无法在测试里复现。
 */

export type RunStatus =
  | "created"
  | "planning"
  | "validating_beat_plan"
  | "generating"
  | "saving"
  | "validating"
  | "reviewing"
  | "repairing"
  | "revalidating"
  | "rereviewing"
  | "reviewing_commercial"
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

/**
 * 建一个刚起步的 Run。
 * startedAt 可省略：省略时用调用方的当前时间，生产路径由时钟端口喂进来。
 */
export function createRunContext(
  projectVersion: string,
  runId: string,
  startedAt: string = new Date().toISOString(),
): RunContext {
  return {
    run_id: runId,
    project_version: projectVersion,
    started_at: startedAt,
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
