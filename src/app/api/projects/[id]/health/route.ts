import { NextResponse } from "next/server";
import { createWorkspace } from "@/composition";
import { toApiError } from "@/application/error-model";

/**
 * §16/§18 GET /api/projects/<id>/health —— 项目健康判定。
 *
 * 这份结论是**确定性**的：同一份磁盘事实，两次请求得到逐字相同的结果
 * （连信号顺序都一样）。它不调模型、不预测、不给建议——只会告诉你
 * "最近一次运行失败了""质量诊断里有 2 项 blocker""当前稿在审阅之后改过"。
 *
 * 反过来说：这里给不出"换个模型试试"。那需要一次新的判断，而这个版本
 * 不打算在背后替用户做任何主张（§19）。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/projects/[id]/health">) {
  const { id } = await ctx.params;
  try {
    const health = await createWorkspace().health(id);
    return NextResponse.json(health);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
