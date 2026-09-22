import { NextRequest, NextResponse } from "next/server";
import { startRun } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

/**
 * §27 POST /api/runs —— Automatic Run。
 * 请求体是 StoryConfig（可带 model / baseUrl / temperature 覆盖）。
 * 响应只含 run_id 与产物文件名，不返回本地绝对路径（§67）。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await startRun(body);
  return NextResponse.json(json, { status });
}
