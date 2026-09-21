import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  let version = "0.6.0";
  try {
    version = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim() || version;
  } catch {
    /* VERSION 文件缺失时使用内置版本号 */
  }
  return NextResponse.json({ version });
}
