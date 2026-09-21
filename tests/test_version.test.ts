import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/version/route";

describe("GET /api/version", () => {
  it("返回 0.5.0", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("0.5.0");
  });
});
