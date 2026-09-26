import { NextResponse } from "next/server";
import { getRunFailureAnalysis } from "@/lib/generate-service";

/**
 * §31 GET /api/runs/<run_id>/failure-analysis —— 读回这次 Run 的失败分类。
 * §35：没有 failure-analysis.json 的旧 Run 也返回 200，body 是
 * {failureAnalysis: null}——缺的是一份分析，不是这个 Run。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[run_id]/failure-analysis">) {
  const { run_id } = await ctx.params;
  const { status, json } = await getRunFailureAnalysis(run_id);
  return NextResponse.json(json, { status });
}
