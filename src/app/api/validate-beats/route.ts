import { NextRequest, NextResponse } from "next/server";
import { validateStoryBeats } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

/**
 * v1.4.0 POST /api/validate-beats —— 手动校验剧情骨架。
 * 请求体 {config, beat_plan}：只检查 BeatPlan 的结构，不生成正文、不改写骨架（§4）。
 * 与 Pipeline 内部那一次校验复用同一个 BeatValidator；这里的结果不写任何产物——
 * Run 里的 beat-validation.json 由 Pipeline 自己负责，外部调用不该改动它。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await validateStoryBeats(body);
  return NextResponse.json(json, { status });
}
