import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { errorBody, toApiError } from "@/application/error-model";

/**
 * §31 GET   /api/projects/<id>/documents/<docId> —— 读一篇稿（含正文）。
 * §31 PATCH /api/projects/<id>/documents/<docId> —— 保存。
 *
 * PATCH 的白名单只有 title / content / status / isFavorite 四项（§20）。
 * contentHash **不在白名单里**：正文的摘要由服务端现算，请求体声明一个哈希
 * 是无效的——那等于让调用方自己指认一份内容是什么。
 *
 * 保存是原子写，且 hash 对不上时整篇都不落盘（500），不会留下"内容改了、哈希还是旧的"
 * 这种自相矛盾的稿件。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/documents/[docId]">) {
  const { id, docId } = await ctx.params;
  try {
    const document = await createWorkspace().getDocument(id, docId);
    return NextResponse.json(document);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/projects/[id]/documents/[docId]">) {
  const { id, docId } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("WORKSPACE_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const document = await createWorkspace().saveDocument(id, docId, body);
    return NextResponse.json(document);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
