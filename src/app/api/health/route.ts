import { NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";

/**
 * §45/§46 GET /api/health —— 版本、能力、可写性。
 *
 * 只回答是非题：配没配模型提供方、产物目录能不能写。API Key 与 baseUrl 一个字
 * 都不出现（§46）——「配了」和「配的是什么」是两件事，接口只需要前者。
 *
 * 能力登记里没有「计划支持」这种字段：每个布尔都是现查出来的（见
 * src/infrastructure/health/health-probe.ts），没配就是 false，不假装健康。
 */
export async function GET() {
  return NextResponse.json(createStoryLoop().health());
}
