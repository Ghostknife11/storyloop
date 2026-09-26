import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postRuns } from "@/app/api/runs/route";
import { GET as getRunDetail } from "@/app/api/runs/[run_id]/route";
import { GET as getRunFailureAnalysis } from "@/app/api/runs/[run_id]/failure-analysis/route";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { ArtifactStore } from "@/storage/artifact-store";
import { failureAnalysisOf } from "@/types/failure-analysis";
import { apiErrorOf } from "./helpers/fixtures";

/**
 * v1.9.0 §31 失败分析的 HTTP 表面。
 *
 * 只验证「委托 service → 响应形状」这一层，LLM 用 stubGlobal("fetch") 冒充，
 * 不访问任何真实付费 API。三类旧资产都要能读（§35）：
 *   1. 没有 failure-analysis.json 的旧 Run → 200 + {failureAnalysis: null}
 *   2. 文件被手改坏（JSON 坏 / 形状不对）→ 同样 200 + null，不 500
 *   3. 新 Run 的分析与 Run 详情里的同一份内容逐字一致
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

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

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-failure-api-"));
  process.chdir(tmp);
  return tmp;
}

/** 只回 plan / 正文 / 审阅三件，BusinessReview 这次不跑（Pipeline 不注入 CommercialReviewer 时不会调用）。 */
function stubLLM(story = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const system = (init?.body ? JSON.parse(String(init.body)) : { messages: [] }) as {
        messages?: Array<{ content: string }>;
      };
      const text = (system.messages ?? []).map((m) => m.content).join("\n");
      const content = text.includes("剧情策划")
        ? JSON.stringify({
            beat_plan_version: "1",
            beats: [
              { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
              { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
            ],
          })
        : text.includes("商业可读性审阅者")
          ? JSON.stringify({
              score: 71.5,
              summary: "开篇三句内进入冲突，中段略拖，结尾收得住。",
              strengths: ["第一段就抛出失踪悬念"],
              problems: ["中段推理过程重复"],
              suggestions: ["把中段两次排查合并成一次"],
              dimensions: {
                hook: { score: 82, summary: "开场即冲突，读完想往下看。" },
                pacing: { score: 68, summary: "中段排查过程拖了两轮。" },
                engagement: { score: 74, summary: "主角动机明确，动力持续住了。" },
                payoff: { score: 62, summary: "结局收得干脆但回报略赶。" },
              },
            })
          : text.includes("骨架结构校验者")
            ? JSON.stringify({ passed: true, issues: [], summary: "结构完整。" })
            : text.includes("审阅者")
              ? JSON.stringify({
                  score: 74,
                  summary: "故事整体完整，主线清楚。",
                  strengths: ["开篇冲突建立迅速"],
                  problems: ["中段线索重复"],
                })
              : story;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }),
  );
}

function post(url: string, payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function get(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

const LEGACY_RUN_ID = "20260101_120000_legacy";

/** §35 一个 v1.9.0 之前就存在的 Run：只有正文与一份 metadata，没有任何 v1.9.0 的文件。 */
function writeLegacyRun(dir: string): string {
  const store = new ArtifactStore(join(dir, "runs"));
  store.putStory(LEGACY_RUN_ID, "旧正文", "旧版本写的正文。");
  store.putMetadata(LEGACY_RUN_ID, {
    run_id: LEGACY_RUN_ID,
    status: "completed",
    attempt_count: 1,
    selected_attempt: 1,
    review_score: 74,
  });
  return LEGACY_RUN_ID;
}

describe("v1.9.0 GET /api/runs/<id>/failure-analysis", () => {
  it("成功 Run：200 + 与磁盘上那份 failure-analysis.json 逐字一致的分析", async () => {
    const dir = withTmpDir();
    stubLLM();
    const created = await postRuns(post("/api/runs", { config }));
    const runId = String((await created.json()).run_id);

    const res = await getRunFailureAnalysis(get(`/api/runs/${runId}/failure-analysis`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failureAnalysis: Record<string, unknown> | null };
    expect(body.failureAnalysis).not.toBeNull();
    const analysis = failureAnalysisOf(body.failureAnalysis);
    expect(analysis, "响应体必须是合法的 FailureAnalysisResult").not.toBeNull();
    expect(analysis!.status).toBe("none");
    expect(analysis!.primaryCategory).toBeNull();
    expect(analysis!.secondaryCategories).toEqual([]);
    expect(analysis!.summary).toBe("No run-level failure detected.");
    expect(analysis!.signals).toEqual([]);
    expect(analysis!.evidence).toEqual([]);

    const onDisk = JSON.parse(
      readFileSync(join(dir, "runs", runId, "failure-analysis.json"), "utf8"),
    ) as unknown;
    expect(onDisk).toEqual(body.failureAnalysis);
  });

  it("§35 旧 Run（没有 failure-analysis.json）：仍然 200，body 是 null", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    const res = await getRunFailureAnalysis(get(`/api/runs/${runId}/failure-analysis`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failureAnalysis: unknown };
    expect(body.failureAnalysis).toBeNull();
  });

  it("文件被手改坏（JSON 坏）照样 200 + null，不 500", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    writeFileSync(join(dir, "runs", runId, "failure-analysis.json"), "{ 这不是 JSON", "utf8");
    const res = await getRunFailureAnalysis(get(`/api/runs/${runId}/failure-analysis`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { failureAnalysis: unknown }).failureAnalysis).toBeNull();
  });

  it("形状不对（缺必填字段 / 类别不在白名单）照样 200 + null", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    mkdirSync(join(dir, "runs", runId), { recursive: true });
    writeFileSync(
      join(dir, "runs", runId, "failure-analysis.json"),
      JSON.stringify({ status: "detected", primaryCategory: "MADE_UP_CATEGORY" }),
      "utf8",
    );
    const res = await getRunFailureAnalysis(get(`/api/runs/${runId}/failure-analysis`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { failureAnalysis: unknown }).failureAnalysis).toBeNull();
  });

  it("错误码与 /api/runs/<id> 同一套：非法 run_id 400，不存在 404", async () => {
    withTmpDir();
    const bad = await getRunFailureAnalysis(get("/api/runs/../../etc/failure-analysis"), {
      params: Promise.resolve({ run_id: "../../etc" }),
    } as never);
    expect(bad.status).toBe(400);
    expect(apiErrorOf(await bad.json()).code).toBe("CONFIG_INVALID");

    const missing = await getRunFailureAnalysis(
      get("/api/runs/20200101_000000_zzzzzz/failure-analysis"),
      { params: Promise.resolve({ run_id: "20200101_000000_zzzzzz" }) } as never,
    );
    expect(missing.status).toBe(404);
    expect(apiErrorOf(await missing.json()).code).toBe("RUN_NOT_FOUND");
  });
});

describe("v1.9.0 Run 详情里的 failureAnalysis", () => {
  it("与独立路由读出同一份内容；旧 Run 是 null", async () => {
    const dir = withTmpDir();
    stubLLM();
    const created = await postRuns(post("/api/runs", { config }));
    const runId = String((await created.json()).run_id);

    const detailRes = await getRunDetail(get(`/api/runs/${runId}`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { failureAnalysis: Record<string, unknown> | null };
    expect(failureAnalysisOf(detail.failureAnalysis)).not.toBeNull();

    const soloRes = await getRunFailureAnalysis(get(`/api/runs/${runId}/failure-analysis`), {
      params: Promise.resolve({ run_id: runId }),
    } as never);
    const solo = (await soloRes.json()) as { failureAnalysis: Record<string, unknown> | null };
    expect(solo.failureAnalysis).toEqual(detail.failureAnalysis);

    // §35：旧 Run 的详情同样给 null，前端据此隐藏面板
    const legacyId = writeLegacyRun(dir);
    const legacyRes = await getRunDetail(get(`/api/runs/${legacyId}`), {
      params: Promise.resolve({ run_id: legacyId }),
    } as never);
    expect(legacyRes.status).toBe(200);
    expect(((await legacyRes.json()) as { failureAnalysis: unknown }).failureAnalysis).toBeNull();
  });

  it("metadata 的两个摘要字段与分析结论一致", async () => {
    const dir = withTmpDir();
    stubLLM();
    const created = await postRuns(post("/api/runs", { config }));
    const runId = String((await created.json()).run_id);
    const meta = JSON.parse(
      readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.failure_analysis_status).toBe("none");
    // 没有主要失败类别时这个键整个不出现，不拿一个类别占位
    expect("primary_failure_category" in meta).toBe(false);
  });
});
