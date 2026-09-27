import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { errorBody, toApiError } from "@/application/error-model";

/**
 * §32 GET  /api/projects/<id>/exports —— 导出历史（只增不改，按时间正序）。
 * §32 POST /api/projects/<id>/exports —— 导出一篇稿件（DOCX / EPUB）。
 *
 * 导出的源是**稿件**，所以请求体里只有 documentId 与 format，没有 runId
 * （§22）：绕过编辑器直接从 Run 导出的那条暗道这里不给开。
 *
 * 响应带 Content-Disposition 与 MIME，但**不带文件字节**——文件在
 * GET /api/projects/<id>/exports/<exportId> 那一条路上（§24）。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/exports">) {
  const { id } = await ctx.params;
  try {
    const exports_ = await createWorkspace().listExports(id);
    return NextResponse.json({ exports: exports_ });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/exports">) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("WORKSPACE_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const outcome = await createWorkspace().exportDocument(id, body);
    return NextResponse.json(outcome, {
      status: 201,
      headers: { "Content-Disposition": outcome.download },
    });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
