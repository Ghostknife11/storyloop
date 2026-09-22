import { NextRequest, NextResponse } from "next/server";
import { reviewStory } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

/**
 * §29 POST /api/review —— 手动审阅（Review Again）。
 * 请求体 {config, story}（可选 run_id）：审阅失败时返回明确错误，
 * 不影响已经生成的正文（§34）。§30 带 run_id 时覆盖该 Run 的 review.json。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await reviewStory(body);
  return NextResponse.json(json, { status });
}
