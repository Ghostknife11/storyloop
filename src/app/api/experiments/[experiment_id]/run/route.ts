import { NextResponse } from "next/server";
import { runExperimentById } from "@/lib/experiment-service";
import { toApiError } from "@/lib/api-error";
import { logger } from "@/lib/logger";

/**
 * §39 POST /api/experiments/<experiment_id>/run —— 把这份定义跑完。
 *
 * 顺序执行全部样本，每个样本都是一次完整 Run；单个样本失败不中止，
 * 最终结果里如实记录 partial。三种拒绝都发生在任何 LLM 请求之前：
 *   404 EXPERIMENT_NOT_FOUND —— 没这个实验；
 *   409 EXPERIMENT_CONFLICT   —— 已经跑过（定义与结果都不可变）；
 *   400 EXPERIMENT_INVALID    —— 服务端没配 LLM_API_KEY，一个样本都跑不了。
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/experiments/[experiment_id]/run">) {
  const { experiment_id } = await ctx.params;
  try {
    const result = await runExperimentById(experiment_id);
    return NextResponse.json(result);
  } catch (e) {
    const err = toApiError(e);
    logger.error(`run experiment failed (${err.code}): ${err.message}`, e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
