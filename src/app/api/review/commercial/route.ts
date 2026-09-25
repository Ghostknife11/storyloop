import { NextRequest, NextResponse } from "next/server";
import { reviewStoryCommercial } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

/**
 * v1.5.0 POST /api/review/commercial —— 手动商业可读性审阅。
 * 与 /api/review 完全并列的第二个入口（§31/§57）：同一个故事可以得到两份互不覆盖的结论，
 * 一份看结构（Co/N/C/Ca），一份看商业可读性（H/P/E/Pf）。
 * 请求体 {config, story}（可选 run_id）：失败时返回明确错误，不影响正文与结构审阅结论。
 * §30 带 run_id 时覆盖该 Run 的 commercial-review.json。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await reviewStoryCommercial(body);
  return NextResponse.json(json, { status });
}
