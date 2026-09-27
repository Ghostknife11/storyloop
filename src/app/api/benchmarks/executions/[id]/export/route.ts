import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";
import { isBenchmarkId } from "@/domain/benchmark-result";

/**
 * §83/§64 GET /api/benchmarks/executions/:id/export —— 导出一次执行的结果。
 *
 * `?format=json`（snapshot / aggregate / sample metrics / run references 四块）
 * 或 `?format=csv`（一行一个 Case × Repetition，指标扁平展开）。默认 json。
 *
 * §67 是这里唯一要紧的纪律：导出里没有生成正文、没有提示词原文、没有 baseUrl、
 * 没有任何凭据。CSV 只放 runId / caseId / 指标；JSON 的快照块搬的是 RunManifest
 * 里那份只记事实的快照（模型名 + 地址类别 + 提示词摘要 + 参数）。
 *
 * 复制一份再交给 Response：渲染出来的 Uint8Array 直接递过去也可能被共享池
 * 截断（与工作区导出路由同一个坑）。
 */
export async function GET(request: Request, ctx: RouteContext<"/api/benchmarks/executions/[id]/export">) {
  const { id } = await ctx.params;
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  try {
    if (!isBenchmarkId(id)) {
      return NextResponse.json(
        { error: { code: "BENCHMARK_NOT_FOUND", message: "没有这次 Benchmark 执行" } },
        { status: 404 },
      );
    }
    const outcome = await createBenchmarkCases().export(id, format);
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
