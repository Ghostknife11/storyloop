import { NextRequest, NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";
import { errorBody } from "@/application/error-model";

/** §28 POST /api/plan：StoryConfig → BeatPlanner → BeatPlan。 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("CONFIG_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  const { status, json } = await createStoryLoop().service.plan(body);
  return NextResponse.json(json, { status });
}
