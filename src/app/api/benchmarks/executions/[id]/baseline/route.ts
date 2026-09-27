import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";
import { isBenchmarkId } from "@/domain/benchmark-result";
import { BenchmarkValidationError } from "@/domain/benchmark-suite";

/**
 * §93 POST /api/benchmarks/executions/:id/baseline —— 标记 / 取消标记基线。
 *
 * 为什么不在 §83 推荐的那几条里：基线是 §93 允许、但不强制的能力，而它必须有
 * 一个真实的写入口，才不只是界面上的装饰。会话期标签，进程重启就忘——界面上
 * 说的是「本次会话的基线」，不说成永久状态。
 *
 * 为什么不是执行上的一个字段：执行写完之后不许改（§37），而「哪一次算基线」
 * 是会变的操作。标签放运行期，历史数据一个字都不用动。
 */
export async function POST(request: Request, ctx: RouteContext<"/api/benchmarks/executions/[id]/baseline">) {
  const { id } = await ctx.params;
  try {
    if (!isBenchmarkId(id)) throw new BenchmarkValidationError("执行 id 不合法");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "BENCHMARK_INVALID", message: "请求体不是合法 JSON" } },
        { status: 400 },
      );
    }
    const raw = (body ?? {}) as Record<string, unknown>;
    if (typeof raw.isBaseline !== "boolean") {
      throw new BenchmarkValidationError("isBaseline 只能是 true / false");
    }
    const isBaseline = createBenchmarkCases().setBaseline(id, raw.isBaseline);
    return NextResponse.json({ benchmarkId: id, isBaseline });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
