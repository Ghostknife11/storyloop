import { NextRequest, NextResponse } from "next/server";
import { handleGenerate } from "@/lib/generate-service";
import { errorBody } from "@/lib/api-error";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await handleGenerate(body);
  return NextResponse.json(json, { status });
}
