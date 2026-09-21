import { NextResponse } from "next/server";
import { getRun } from "@/lib/generate-service";

/**
 * §39 GET /api/runs/<run_id> —— 读回一次 Run 的 Attempt 摘要与最终产物。
 * §40 不提供 GET /api/runs 全局历史列表：这里只按 run_id 精确读一个 Run。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[run_id]">) {
  const { run_id } = await ctx.params;
  const { status, json } = await getRun(run_id);
  return NextResponse.json(json, { status });
}
