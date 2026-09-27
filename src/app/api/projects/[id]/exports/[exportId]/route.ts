import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition/workspace";
import { toApiError } from "@/application/error-model";

/**
 * §24/§32 GET /api/projects/<id>/exports/<exportId> —— 下载一次已导出的文件。
 *
 * 只按 index.json 里记下的文件名读（§42）：URL 里递多少花样都没用，
 * 因为最终取哪一段内容是由账上那条记录说的，不是由 URL 说的。
 * 账上没有这条、或者文件已经被人删了，都是 404——记录说导出过而文件不在，
 * 那这一条对不上号，如实告诉用户"找不到"，不去磁盘上另找一个相近的顶上。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/exports/[exportId]">) {
  const { id, exportId } = await ctx.params;
  try {
    const outcome = await createWorkspace().readExport(id, exportId);
    if (outcome === null) {
      return NextResponse.json(
        { error: { code: "WORKSPACE_NOT_FOUND", message: "没有这一条导出记录，或它对应的文件已经不在" } },
        { status: 404 },
      );
    }
    // 复制一份再交给 Response：readFileSync 出来的 Buffer 可能挂在共享的
    // 8KB 池子上（byteOffset 不一定为 0），直接把 buffer 递过去会让响应体多出一截尾巴。
    const bytes = new Uint8Array(outcome.bytes);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": outcome.mimeType,
        "Content-Length": String(outcome.byteSize),
        "Content-Disposition": outcome.download,
      },
    });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
