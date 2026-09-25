import { NextRequest, NextResponse } from "next/server";
import { createExperiment, listExperiments } from "@/lib/experiment-service";
import { errorBody, toApiError } from "@/lib/api-error";
import { logger } from "@/lib/logger";

/**
 * §36 POST /api/experiments —— 建一份实验定义（先建，不跑）。
 * §38 GET  /api/experiments —— 实验列表：定义摘要 + 结果状态，不带样本详情。
 *
 * 请求体不是 StoryConfig，而是实验定义（契约见 docs/experiments.md）。
 * 结构不合法一律 400 EXPERIMENT_INVALID，此时磁盘上什么都不会多出来。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(errorBody("EXPERIMENT_INVALID", "请求体不是合法 JSON"), { status: 400 });
  }
  try {
    const definition = await createExperiment(body);
    return NextResponse.json(definition, { status: 201 });
  } catch (e) {
    const err = toApiError(e);
    // 与其它路由同一套口径：堆栈只进服务端日志，响应里只有 code 与一句话
    logger.error(`create experiment failed (${err.code}): ${err.message}`, e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

/** §40 不提供跨实验的统计口径：这里只有「有哪些实验、各自跑到哪一步」。 */
export async function GET() {
  const items = await listExperiments();
  return NextResponse.json({ experiments: items });
}
