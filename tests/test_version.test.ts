import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/version/route";
import { projectVersion } from "@/lib/version";
import { repoVersion } from "./helpers/fixtures";

describe("GET /api/version", () => {
  it("返回 VERSION 文件里的版本号", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(repoVersion());
  });

  it("projectVersion() 与 VERSION 文件同源", () => {
    expect(projectVersion()).toBe(repoVersion());
  });
});
