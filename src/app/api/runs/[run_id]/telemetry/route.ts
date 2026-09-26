import { NextResponse } from "next/server";
import { getRunTelemetry } from "@/lib/generate-service";

/**
 * §25 GET /api/runs/<run_id>/telemetry —— 读回这次 Run 的遥测。
 * §15/§43：没有 telemetry.json 的旧 Run 也返回 200，body 是 {telemetry: null}——
 * 遥测缺失不是错误，缺的是观测数据，不是这个 Run。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[run_id]/telemetry">) {
  const { run_id } = await ctx.params;
  const { status, json } = await getRunTelemetry(run_id);
  return NextResponse.json(json, { status });
}
