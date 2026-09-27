import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";

/**
 * §83 /api/benchmarks/executions —— 列表（GET）与开跑（POST）。
 *
 * 两个动词放在一个文件里，因为它们是同一份资源的读与写，拆成两个目录只会让
 * 「一次执行长什么样」有两处接线。
 */

/**
 * GET：执行列表（时间正序）。
 *
 * 摘要给到聚合结果，不给样本明细：一个执行几十个样本、每个样本二十二个指标，
 * 全摊开页面就只剩滚动条了。要明细走 :id。`?suiteId=<id>` 只看某一份 Suite 的历史。
 */
export async function GET(request: Request) {
  const suiteId = new URL(request.url).searchParams.get("suiteId") ?? undefined;
  try {
    const executions = await createBenchmarkCases().listExecutions();
    const filtered = suiteId === undefined ? executions : executions.filter((item) => item.suiteId === suiteId);
    return NextResponse.json({ executions: filtered });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}

/**
 * POST：跑完一次执行。
 *
 * 请求体只有四个字段（suiteId / suiteVersion / label / allowLargeBenchmark），
 * 没有 model、temperature、baseUrl、apiKey。Benchmark 测的是服务端当下这一套
 * 配置（§81）；允许在请求里覆盖它们，「测量这个部署的真实表现」这句话就不成立。
 *
 * 三种拒绝都发生在第一个 LLM 请求之前，一次付费调用都不发生（§40/§46）：
 *   400 BENCHMARK_INVALID  —— Suite 不合法、骨架缺文件、提示词不全、没配凭据；
 *   409 BENCHMARK_CONFLICT —— 同一版本正在跑，或样本数超过安全线且没显式确认；
 *   404 BENCHMARK_NOT_FOUND—— 没这份 Suite。
 * 中途被杀留下的 partial 会如实落盘，这里不谎报 completed。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BENCHMARK_INVALID", message: "请求体不是合法 JSON" } },
      { status: 400 },
    );
  }
  try {
    const execution = await createBenchmarkCases().run(body);
    return NextResponse.json(execution, { status: 201 });
  } catch (e) {
    const err = toApiError(e);
    // 堆栈已由用例层记进服务端日志（§37：路由只解析 / 调用 / 映射）
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
