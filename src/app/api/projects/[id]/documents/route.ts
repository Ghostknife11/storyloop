import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { errorBody, toApiError } from "@/application/error-model";

/**
 * §31 GET  /api/projects/<id>/documents —— 稿件列表（列表项，不含正文）。
 * §31 POST /api/projects/<id>/documents —— 从一次 Run 建稿（Run → Draft）。
 *
 * 建的是一份**独立副本**：之后在编辑器里怎么改，都不回写 Run 的 story.md（§8/§48）。
 * 请求体只认 runId；title / status 可省——标题默认取 story.md 的第一行 H1。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/documents">) {
  const { id } = await ctx.params;
  try {
    const documents = await createWorkspace().listDocuments(id);
    return NextResponse.json({ documents });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/documents">) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("WORKSPACE_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const document = await createWorkspace().createDocumentFromRun(id, body);
    return NextResponse.json(document, { status: 201 });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
