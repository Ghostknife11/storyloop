import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { errorBody, toApiError } from "@/application/error-model";

/**
 * §30 GET   /api/projects/<id> —— 项目详情：项目本身 + 名下的 Run + 稿件 id。
 * §30 PATCH /api/projects/<id> —— 改名 / 收藏 / 改引用。白名单外的字段一律 400。
 *
 * 详情里的 Run 归属是扫 run-manifest.json 归纳出来的（§19 单一事实源），
 * 不是从 project.json 里读一张缓存列表——所以这里永远不会和磁盘上的真相对不上。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  try {
    const detail = await createWorkspace().getProject(id);
    return NextResponse.json(detail);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("WORKSPACE_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const project = await createWorkspace().updateProject(id, body);
    return NextResponse.json(project);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
