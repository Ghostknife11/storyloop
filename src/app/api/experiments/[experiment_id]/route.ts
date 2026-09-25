import { NextResponse } from "next/server";
import { getExperiment } from "@/lib/experiment-service";
import { toApiError } from "@/lib/api-error";

/**
 * §37 GET /api/experiments/<experiment_id> —— 一份实验的定义、格子与结果。
 *
 * 没跑过的实验：runs 与 result 都是 null（不是空数组）——「还没开始」与
 * 「跑完了但一条没成」是两件事，不能都表示成空。
 * 不存在的 id 是 404 EXPERIMENT_NOT_FOUND。
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/experiments/[experiment_id]">) {
  const { experiment_id } = await ctx.params;
  try {
    const detail = await getExperiment(experiment_id);
    return NextResponse.json(detail);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
