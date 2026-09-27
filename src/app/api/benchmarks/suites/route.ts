import { NextResponse } from "next/server";
import { createBenchmarkCases } from "@/composition/benchmark";
import { toApiError } from "@/application/error-model";

/**
 * §83 GET /api/benchmarks/suites —— 全部已存 Suite（一个版本一行）。
 *
 * 只回摘要：题数、重复次数、将要跑多少个样本、内容摘要、来源说明。题面本身
 * 不在这里摊开（那是 :id 接口的事），列表页要的只是「点哪一个」。
 */
export async function GET() {
  try {
    const suites = await createBenchmarkCases().listSuites();
    return NextResponse.json({ suites });
  } catch (e) {
    const err = toApiError(e);
    return NextResponse.json(err.body(), { status: err.httpStatus });
  }
}
