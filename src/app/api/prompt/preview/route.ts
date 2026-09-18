import { NextRequest, NextResponse } from "next/server";
import { previewPrompt } from "@/lib/generate-service";

/**
 * §30 Prompt Preview（可选开发功能）：
 * 与 generate 相同的请求，只返回渲染后的最终 Prompt。
 * 只显示、不修改、不保存、不做 Prompt 历史管理（§29）。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { status, json } = await previewPrompt(body);
  return NextResponse.json(json, { status });
}
