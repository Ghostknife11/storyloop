import { NextRequest, NextResponse } from "next/server";
import { repairStory } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

/**
 * §38 POST /api/repair —— 手动定点修订。
 * 请求体 {config, beat_plan, story, issue_type, issue_message}：
 * 响应 {repaired_story, issue_type, success}，与 Pipeline 内部的
 * Repair-before-Retry 共用同一个 StoryRepairer / repair.txt（§10）。
 * §38/§67：不返回本地绝对路径；§38 不要求也不写入 run_id。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await repairStory(body);
  return NextResponse.json(json, { status });
}
