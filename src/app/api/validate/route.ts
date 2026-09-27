import { NextRequest, NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";
import { errorBody } from "@/application/error-model";

/**
 * §27 POST /api/validate —— 手动校验（Revalidate）。
 * 请求体 {config, story}（可选 run_id）：只做硬性有效性检查，不调用 Reviewer（§2）。
 * §27 带 run_id 时覆盖该 Run 的 validation.json，不建立 Validation History。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await createStoryLoop().service.validate(body);
  return NextResponse.json(json, { status });
}
