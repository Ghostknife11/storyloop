import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";

/**
 * §83 GET /api/benchmarks/executions/:id —— 一次执行的详情。
 *
 * 三件套一次给全：执行（快照 + 样本）、引用的那一版 Suite（Suite 后来被删了
 * 就是 null，跑过的数据照样在）、可选的逐指标比较。
 *
 * `?compare=<另一个执行 id>` 才带 comparison：比较要有两个明确的执行，
 * 不拿「上一次」当参照——上一次是哪一次，取决于列表怎么排，那是个隐藏决定。
 */
export async function GET(request: Request, ctx: RouteContext<"/api/benchmarks/executions/[id]">) {
  const { id } = await ctx.params;
  const compareWith = new URL(request.url).searchParams.get("compare");
  try {
    const detail = await createBenchmarkCases().getExecution(id, compareWith);
    return NextResponse.json(detail);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
