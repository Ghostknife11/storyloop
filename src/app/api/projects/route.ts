import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { errorBody, toApiError } from "@/application/error-model";

/**
 * §30 GET  /api/projects —— 项目列表（未归档在前，再按更新时间倒序）。
 * §30 POST /api/projects —— 建一个项目。只收 name / storyConfigRef / isFavorite。
 *
 * 列表里不带稿件正文，也不带 Run 产物：一个项目下可以有很多稿，
 * 这里只回答「有哪些项目、各自名下几次运行」。
 */
export async function GET() {
  try {
    const projects = await createWorkspace().listProjects();
    return NextResponse.json({ projects });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // 请求体不是合法 JSON：这时候连"建什么"都不知道，只能按结构错回
    return NextResponse.json(errorBody("WORKSPACE_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const project = await createWorkspace().createProject(body);
    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
