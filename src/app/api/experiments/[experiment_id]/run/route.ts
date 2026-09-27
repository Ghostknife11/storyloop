import { NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";
import { toApiError } from "@/application/error-model";

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
    const result = await createStoryLoop().service.runExperiment(experiment_id);
    return NextResponse.json(result);
  } catch (e) {
    const err = toApiError(e);
    // 堆栈已由用例层记进服务端日志（§37：路由只解析 / 调用 / 映射）
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
