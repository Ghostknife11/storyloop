import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postCommercialReview } from "@/app/api/review/commercial/route";
import { GET as getRunDetail } from "@/app/api/runs/[run_id]/route";
import { GET as getRunAttemptDetail } from "@/app/api/runs/[run_id]/attempts/[attempt_number]/route";
import { getRun, getRunAttempt, reviewStoryCommercial } from "@/lib/generate-service";
import { reviewStoryCommercial as reviewStoryCommercialFromApi } from "@/lib/api";
import { ArtifactStore } from "@/storage/artifact-store";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import { CommercialReviewParseError } from "@/lib/commercial-review-parser";
import { aggregateCommercialDimensions } from "@/types/commercial-review";
import { apiErrorOf, FakeLLM, SAMPLE_COMMERCIAL_REVIEW } from "./helpers/fixtures";

/**
 * v1.5.0 POST /api/review/commercial 契约（TASK §30/§31/§32）。
 * 这是与 /api/review 完全并列的第二个审阅入口：同一个故事两份互不覆盖的结论。
 * 全部用假 LLM 从传输层注入（§66：绝不调用真实付费 API，也不读任何真实密钥）。
 */

const config = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

const story = "# 消失的目击者\n\n陈岚在雨里追上了搬救兵的人，惠姨已经带着律师冲出院子。";

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
  tmp = mkdtempSync(join(tmpdir(), "storyloop-commercial-api-"));
  process.chdir(tmp);
  return tmp;
}

function post(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest("http://localhost/api/review/commercial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * 冒充 OpenAI-compatible /chat/completions，只回一份固定的商业可读性结论。
 * 路由自己组装 CommercialReviewer，所以只能从传输层注入。
 */
function stubCommercialLLM(content: string = JSON.stringify(SAMPLE_COMMERCIAL_REVIEW)) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/review/commercial（v1.5.0 §30/§31）", () => {
  it("合法请求 → 200 + CommercialReviewResult 六个字段，score 是四维重算值", async () => {
    withTmpDir();
    stubCommercialLLM();
    const res = await postCommercialReview(post({ config, story }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Object.keys(body).sort()).toEqual([
      "dimensions",
      "problems",
      "score",
      "strengths",
      "suggestions",
      "summary",
    ]);
    // 模型自报的 score 不被采信：落盘/响应的永远是四维等权均分
    expect(body.score).toBe(aggregateCommercialDimensions(SAMPLE_COMMERCIAL_REVIEW.dimensions));
    expect(Object.keys(body.dimensions as object).sort()).toEqual([
      "engagement",
      "hook",
      "pacing",
      "payoff",
    ]);
  });

  it("模型自报的 score 与维度不符时，响应里的是重算值", async () => {
    withTmpDir();
    const liar = { ...SAMPLE_COMMERCIAL_REVIEW, score: 99 };
    stubCommercialLLM(JSON.stringify(liar));
    const res = await postCommercialReview(post({ config, story }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.score).toBe(aggregateCommercialDimensions(SAMPLE_COMMERCIAL_REVIEW.dimensions));
    expect(body.score).not.toBe(99);
  });

  it("请求体不是合法 JSON → 400 CONFIG_INVALID，不调模型", async () => {
    withTmpDir();
    const fetchMock = stubCommercialLLM();
    const res = await postCommercialReview(post("{ not json"));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).code).toBe("CONFIG_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("缺 story → 400，提示要的是商业审阅的正文", async () => {
    withTmpDir();
    const fetchMock = stubCommercialLLM();
    const res = await postCommercialReview(post({ config }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("商业审阅");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("模型输出不是 JSON → 502 COMMERCIAL_REVIEW_FAILED，既不 500 也不套 REVIEW_FAILED", async () => {
    withTmpDir();
    const outcome = await reviewStoryCommercial(
      { config, story },
      { commercialReviewer: new CommercialReviewer(new FakeLLM(["这份稿子还行"]) as never) } as never,
    );
    expect(outcome.status).toBe(502);
    expect(apiErrorOf(outcome.json).code).toBe("COMMERCIAL_REVIEW_FAILED");
  });

  it("CommercialReviewParseError → COMMERCIAL_REVIEW_FAILED（§11 错误码白名单里的一种）", async () => {
    withTmpDir();
    const outcome = await reviewStoryCommercial(
      { config, story },
      {
        commercialReviewer: {
          review: () => {
            throw new CommercialReviewParseError("Commercial Reviewer 输出不是合法 JSON：boom");
          },
        } as never,
      } as never,
    );
    expect(outcome.status).toBe(502);
    expect(apiErrorOf(outcome.json).code).toBe("COMMERCIAL_REVIEW_FAILED");
  });

  it("带 run_id 时覆盖该 Run 的 commercial-review.json，且不动 review.json（§30）", async () => {
    const dir = withTmpDir();
    const runId = "20260101_120000_com01";
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "story.md"), story);
    writeFileSync(join(runDir, "review.json"), JSON.stringify({ score: 70, summary: "结构尚可" }));
    const reviewBefore = readFileSync(join(runDir, "review.json"), "utf8");
    stubCommercialLLM();

    const res = await postCommercialReview(post({ config, story, run_id: runId }));
    expect(res.status).toBe(200);

    const written = JSON.parse(readFileSync(join(runDir, "commercial-review.json"), "utf8"));
    expect(written).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(readFileSync(join(runDir, "review.json"), "utf8")).toBe(reviewBefore);
  });

  it("run_id 指向不存在的 Run → 404 RUN_NOT_FOUND，不会调用模型也不会建目录", async () => {
    const dir = withTmpDir();
    mkdirSync(join(dir, "runs"), { recursive: true });
    const fetchMock = stubCommercialLLM();
    const res = await postCommercialReview(post({ config, story, run_id: "20260101_000000_none" }));
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(apiErrorOf(body).code).toBe("RUN_NOT_FOUND");
    expect(apiErrorOf(body).message).toContain("commercial-review.json");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "runs", "20260101_000000_none"))).toBe(false);
  });
});

/** 造一个带 commercial-review.json 的 Run，专供读接口用例。 */
function writeRunWithCommercialReview(dir: string): string {
  const runId = "20260101_130000_cr001";
  const runDir = join(dir, "runs", runId);
  mkdirSync(join(runDir, "attempts", "01"), { recursive: true });
  writeFileSync(join(runDir, "story.md"), story);
  writeFileSync(join(runDir, "commercial-review.json"), JSON.stringify(SAMPLE_COMMERCIAL_REVIEW));
  writeFileSync(join(runDir, "attempts", "01", "story.md"), story);
  writeFileSync(join(runDir, "attempts", "01", "commercial-review.json"), JSON.stringify(SAMPLE_COMMERCIAL_REVIEW));
  writeFileSync(
    join(runDir, "metadata.json"),
    JSON.stringify({
      run_id: runId,
      project_version: "1.5.0",
      status: "completed",
      started_at: "2026-01-01T13:00:00.000Z",
      finished_at: "2026-01-01T13:01:00.000Z",
      model: "gpt-4o-mini",
      commercial_review_status: "completed",
      commercial_score: SAMPLE_COMMERCIAL_REVIEW.score,
      artifacts: { story: "story.md", metadata: "metadata.json", commercial_review: "commercial-review.json" },
    }),
  );
  writeFileSync(join(runDir, "attempts", "01", "metadata.json"), JSON.stringify({ attempt_number: 1, accepted: true }));
  return runId;
}

/** 造一个 v1.5.0 之前的老 Run：没有 commercial-review.json，也没有相关 metadata 字段。 */
function writeLegacyRun(dir: string): string {
  const runId = "20260101_120000_legacy";
  const runDir = join(dir, "runs", runId);
  mkdirSync(join(runDir, "attempts", "01"), { recursive: true });
  writeFileSync(join(runDir, "story.md"), story);
  writeFileSync(
    join(runDir, "metadata.json"),
    JSON.stringify({
      run_id: runId,
      project_version: "1.4.1",
      status: "completed",
      started_at: "2026-01-01T12:00:00.000Z",
      finished_at: "2026-01-01T12:01:00.000Z",
      model: "gpt-4o-mini",
      artifacts: { story: "story.md", metadata: "metadata.json" },
    }),
  );
  writeFileSync(join(runDir, "attempts", "01", "story.md"), story);
  writeFileSync(join(runDir, "attempts", "01", "metadata.json"), JSON.stringify({ attempt_number: 1 }));
  return runId;
}

describe("读接口的商业可读性字段（v1.5.0 §32 旧 Run 兼容）", () => {
  it("Run 详情：跑过商业审阅的 Run 读回结论，status 是 completed", async () => {
    const dir = withTmpDir();
    const runId = writeRunWithCommercialReview(dir);
    const store = new ArtifactStore(join(dir, "runs"));

    const detail = await getRun(runId, store);
    expect(detail.status).toBe(200);
    if (detail.status !== 200) return;
    expect(detail.json.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(detail.json.commercial_review_status).toBe("completed");

    const res = await getRunDetail({} as never, { params: Promise.resolve({ run_id: runId }) } as never);
    const body = await readJson(res);
    expect(body.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(body.commercial_review_status).toBe("completed");
    // §31：结构审阅的字段原样还在，没有被商业审阅挤掉
    expect(body.review_status).toBe("not_started");
  });

  it("v1.4.1 的老 Run：commercial_review 是 null、status 兜底 not_started，照样 200", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    const store = new ArtifactStore(join(dir, "runs"));

    const detail = await getRun(runId, store);
    expect(detail.status).toBe(200);
    if (detail.status !== 200) return;
    expect(detail.json.commercial_review).toBeNull();
    expect(detail.json.commercial_review_status).toBe("not_started");
    // 读一次不会把磁盘补写成新版结构
    expect(existsSync(join(dir, "runs", runId, "commercial-review.json"))).toBe(false);
  });

  it("Old run metadata 里没有 commercial_review_status 字段：不强行补写", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    const store = new ArtifactStore(join(dir, "runs"));
    await getRun(runId, store);
    const meta = JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8"));
    expect(meta).not.toHaveProperty("commercial_review_status");
    expect(meta).not.toHaveProperty("commercial_score");
  });

  it("Attempt 详情：读该次尝试自己的那两份商业结论", async () => {
    const dir = withTmpDir();
    const runId = writeRunWithCommercialReview(dir);
    const store = new ArtifactStore(join(dir, "runs"));

    const detail = await getRunAttempt(runId, 1, store);
    expect(detail.status).toBe(200);
    if (detail.status !== 200) return;
    expect(detail.json.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    expect(detail.json.commercial_review!.score).toBe(SAMPLE_COMMERCIAL_REVIEW.score);

    const res = await getRunAttemptDetail({} as never, {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    const body = await readJson(res);
    expect(body.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
  });

  it("老 Run 的 Attempt 详情：commercial_review 是 null，不是 500", async () => {
    const dir = withTmpDir();
    const runId = writeLegacyRun(dir);
    const detail = await getRunAttempt(runId, 1, new ArtifactStore(join(dir, "runs")));
    expect(detail.status).toBe(200);
    if (detail.status !== 200) return;
    expect(detail.json.commercial_review).toBeNull();
  });
});

describe("src/lib/api.ts 客户端接线（§31）", () => {
  it("reviewStoryCommercial 打在 /api/review/commercial 上，story 与 run_id 都在请求体里", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => SAMPLE_COMMERCIAL_REVIEW,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reviewStoryCommercialFromApi(
      config as never,
      story,
      { model: "gpt-4o-mini", baseUrl: "https://api.example.com/v1" },
      "run-1",
    );

    expect(result).toEqual(SAMPLE_COMMERCIAL_REVIEW);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/review/commercial");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ story, run_id: "run-1", model: "gpt-4o-mini" });
    expect(body.config).toEqual(config);
    // 敏感信息不会出现在请求体或 URL 上
    expect(url).not.toContain("key");
    expect(String(init.body)).not.toContain("api_key");
  });
});
