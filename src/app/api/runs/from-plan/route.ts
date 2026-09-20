import { NextRequest, NextResponse } from "next/server";
import { startRunFromPlan } from "@/lib/generate-service";

/**
 * §29 POST /api/runs/from-plan —— Manual Run。
 * 请求体 {config, beat_plan}：beat_plan 缺失 → 400，不偷偷回退到自动规划。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { status, json } = await startRunFromPlan(body);
  return NextResponse.json(json, { status });
}
