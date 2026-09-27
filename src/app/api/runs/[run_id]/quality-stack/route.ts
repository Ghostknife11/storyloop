import { NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";

/**
 * v2.1.0 TASK §33 GET /api/runs/<run_id>/quality-stack —— 读回这次 Run 的统一质量视图。
 * §32：没有 quality-stack.json 的旧 Run 也返回 200，body 是
 * {qualityStack: null}——缺的是一份视图，不是这个 Run。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[run_id]/quality-stack">) {
  const { run_id } = await ctx.params;
  const { status, json } = await createStoryLoop().service.getRunQualityStack(run_id);
  return NextResponse.json(json, { status });
}
