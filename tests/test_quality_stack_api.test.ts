import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRuns } from "@/app/api/runs/route";
import { GET as getRun } from "@/app/api/runs/[run_id]/route";
import type { QualityStackView } from "@/domain/quality-stack";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_COMMERCIAL_REVIEW,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_CONFIG,
  SAMPLE_QUALITY_REVIEW_V2,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
} from "./helpers/fixtures";

/**
 * v2.1.0 TASK §32：Run Detail additive 返回 qualityStack。
 *
 * 四条硬要求：
 *   1. 形状只有 status / diagnostics / summary——三套结论本体由 review /
 *      beat_validation / commercial_review 各自返回，这里不当第二处事实来源（§27）；
 *   2. 内容与磁盘上那份 quality-stack.json 逐字一致，服务端不重算、不改写；
 *   3. 没有这份文件的旧 Run 仍然 200，qualityStack 是 null（§27）；
 *   4. 文件被手改坏时同样 200 + null，不让坏数据进响应，也不让读接口 500。
 *
 * LLM 用 stubGlobal("fetch") 冒充，绝不访问真实付费 API。
 */

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  vi.unstubAllGlobals();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-quality-stack-api-"));
  process.chdir(tmp);
  return tmp;
}

/**
 * 冒充 OpenAI-compatible /chat/completions。四个角色按 system 关键词区分：
 * 剧情策划（Planner）/ 商业可读性 / 基础质量审阅 / 骨架结构校验，其余当作者（Generator）。
 * 骨架校验这一路的 system 里没有「审阅」二字，所以它必须单独一个分支——
 * 否则它会拿到正文，Beat 校验就只能以 failed 收场。
 */
function stubLLM() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
    const system = (body.messages ?? []).map((m) => m.content).join("\n");
    const content = system.includes("剧情策划")
      ? JSON.stringify(SAMPLE_BEAT_PLAN)
      : system.includes("商业可读性")
        ? JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2)
        : system.includes("基础质量审阅")
          ? JSON.stringify(SAMPLE_QUALITY_REVIEW_V2)
          : system.includes("骨架结构校验")
            ? JSON.stringify(SAMPLE_BEAT_VALIDATION_V2)
            : SAMPLE_STORY;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function createRun(): Promise<{ runId: string; dir: string }> {
  const dir = withTmpDir();
  stubLLM();
  const res = await postRuns(
    new NextRequest("http://localhost/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: SAMPLE_CONFIG }),
    }),
  );
  expect(res.status).toBe(200);
  const created = (await res.json()) as { run_id: string };
  expect(created.run_id).toMatch(RUN_ID);
  return { runId: created.run_id, dir };
}

async function readDetail(runId: string): Promise<Record<string, unknown>> {
  const res = await getRun(
    new NextRequest(`http://localhost/api/runs/${runId}`),
    { params: Promise.resolve({ run_id: runId }) } as never,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/runs/<id> 的 qualityStack（TASK §32）", () => {
  it("三套组件都跑成：200 + status=complete + 合并后的诊断与计数", async () => {
    const { runId } = await createRun();
    const body = await readDetail(runId);

    const stack = body.qualityStack as QualityStackView;
    expect(stack).not.toBeNull();
    expect(stack.status).toBe("complete");
    // 三个来源各有一条诊断，按 骨架 → 故事质量 → 商业可读性 的顺序合并
    expect(stack.diagnostics.map((d) => d.source)).toEqual([
      "quality-reviewer",
      "commercial-reviewer",
    ]);
    expect(stack.summary).toEqual({ totalDiagnostics: 2, errors: 0, warnings: 2, info: 0 });
  });

  it("形状只有 status / diagnostics / summary：不当三套结论的第二处事实来源", async () => {
    const { runId } = await createRun();
    const body = await readDetail(runId);

    const stack = body.qualityStack as Record<string, unknown>;
    expect(Object.keys(stack).sort()).toEqual(["diagnostics", "status", "summary"]);
    // §27：结论本体仍由老字段给，且一个都没变
    expect(body.review).toEqual(SAMPLE_REVIEW);
    expect(body.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(body.beat_validation).toEqual(SAMPLE_BEAT_VALIDATION);
  });

  it("与磁盘上那份 quality-stack.json 逐字一致：服务端不重算、不改写", async () => {
    const { runId, dir } = await createRun();
    const body = await readDetail(runId);

    const onDisk = JSON.parse(
      readFileSync(join(dir, "runs", runId, "quality-stack.json"), "utf8"),
    ) as QualityStackView & { schemaVersion: string };
    const stack = body.qualityStack as QualityStackView;
    expect(stack.status).toBe(onDisk.status);
    expect(stack.diagnostics).toEqual(onDisk.diagnostics);
    expect(stack.summary).toEqual(onDisk.summary);
  });

  it("旧 Run 没有 quality-stack.json：仍然 200，qualityStack 是 null", async () => {
    const { runId, dir } = await createRun();
    const file = join(dir, "runs", runId, "quality-stack.json");
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    rmSync(file);

    const body = await readDetail(runId);
    expect(body.qualityStack).toBeNull();
    // 缺的只是这份视图，其余字段照旧
    expect(body.review).toEqual(SAMPLE_REVIEW);
    expect(body.telemetry).not.toBeNull();
  });

  it("文件被手改坏：同样 200 + null，坏数据不进响应也不让接口 500", async () => {
    const { runId, dir } = await createRun();
    writeFileSync(join(dir, "runs", runId, "quality-stack.json"), "{ 这不是 JSON", "utf8");

    const body = await readDetail(runId);
    expect(body.qualityStack).toBeNull();
  });

  it("Run 不存在时照旧 404 RUN_NOT_FOUND，不因为多了这一个字段改变错误码", async () => {
    withTmpDir();
    const res = await getRun(
      new NextRequest("http://localhost/api/runs/20200101_000000_zzzzzz"),
      { params: Promise.resolve({ run_id: "20200101_000000_zzzzzz" }) } as never,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
  });

  it("v2.0.0 之前手搓的旧 Run 目录：没有这份文件也读得回来", async () => {
    const dir = withTmpDir();
    const runId = "20250101_000000_oldrun";
    mkdirSync(join(dir, "runs", runId, "attempts", "01"), { recursive: true });
    writeFileSync(
      join(dir, "runs", runId, "metadata.json"),
      JSON.stringify({ status: "completed", attempt_count: 1, selected_attempt: 1 }, null, 2),
      "utf8",
    );

    const body = await readDetail(runId);
    expect(body.status).toBe("completed");
    expect(body.qualityStack).toBeNull();
  });
});
