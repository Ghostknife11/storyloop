import { NextRequest, NextResponse } from "next/server";
import { handleGenerate } from "@/lib/generate-service";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { status, json } = await handleGenerate(body);
  return NextResponse.json(json, { status });
}
