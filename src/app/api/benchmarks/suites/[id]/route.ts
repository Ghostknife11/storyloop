import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";

/**
 * §83 GET /api/benchmarks/suites/:id —— 一份 Suite 全文。
 *
 * `?version=1.0.0` 指定版本；省略时取版本号最大的那一版。
 * 这里是唯一会返回题面（storyConfig）与来源说明的地方，所以也不返回任何
 * Base-URL 或凭据——Suite 文件里压根就没存这些字段（§68）。
 */
export async function GET(request: Request, ctx: RouteContext<"/api/benchmarks/suites/[id]">) {
  const { id } = await ctx.params;
  const version = new URL(request.url).searchParams.get("version") ?? undefined;
  try {
    const suite = await createBenchmarkCases().getSuite(id, version);
    return NextResponse.json(suite);
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
