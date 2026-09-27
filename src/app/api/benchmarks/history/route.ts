import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";

/**
 * §91 GET /api/benchmarks/history —— 历史图取数。
 *
 * 只有真实保存过的执行才会出现在这里（§92）：点从盘上读出来的执行来，一条都不编。
 * 每次执行摊成四个数：Overall、Commercial、Failure Rate、Duration——够画一条趋势线，
 * 不是完整的指标表（那是 :id 接口的事）。
 *
 * `?suiteId=<id>` 只看某一份 Suite 的曲线。跨 Suite 的线也画得出来，但必须承认
 * 那是「不同版本的平台自己跟自己比」，界面上会标出来。
 */
export async function GET(request: Request) {
  const suiteId = new URL(request.url).searchParams.get("suiteId") ?? undefined;
  try {
    const points = await createBenchmarkCases().history(suiteId);
    return NextResponse.json({ points });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
