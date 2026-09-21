import { NextResponse } from "next/server";
import { getRunAttempt } from "@/lib/generate-service";

/**
 * §39 GET /api/runs/<run_id>/attempts/<attempt_number>。
 * §35：返回这一次 Attempt 的正文与独立 Validation / Review，不做比较 / 排名 / Score Delta。
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[run_id]/attempts/[attempt_number]">,
) {
  const { run_id, attempt_number } = await ctx.params;
  const { status, json } = await getRunAttempt(run_id, attempt_number);
  return NextResponse.json(json, { status });
}
