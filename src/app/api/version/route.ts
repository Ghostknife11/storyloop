import { NextResponse } from "next/server";
import { createStoryLoop } from "@/composition";

/** §42/§43 版本号唯一真源是仓库 VERSION 文件，这里只转发，不自己维护第二份。 */
export async function GET() {
  return NextResponse.json({ version: createStoryLoop().service.version() });
}
