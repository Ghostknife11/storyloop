import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as postValidate } from "@/app/api/validate/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getVersion } from "@/app/api/version/route";
import { POST as postPromptPreview } from "@/app/api/prompt/preview/route";
import { GET as getRunDetail } from "@/app/api/runs/[run_id]/route";
import { GET as getRunAttemptDetail } from "@/app/api/runs/[run_id]/attempts/[attempt_number]/route";
import {
  API_ERROR_CODES,
  ApiError,
  errorBody,
  toApiError,
  type ApiErrorCode,
} from "@/lib/api-error";
import {
  getRun,
  getRunAttempt,
  startRun,
  startRunFromPlan,
  reviewStory,
  repairStory,
  validateStory,
  planStory,
} from "@/lib/generate-service";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { BeatValidator } from "@/lib/beat-validator";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { LLMError, LLMTimeoutError } from "@/lib/llm";
import { BeatParseError } from "@/lib/beat-parser";
import { BeatValidationParseError } from "@/lib/beat-validation-parser";
import { ReviewParseError } from "@/lib/review-parser";
import { CommercialReviewParseError } from "@/lib/commercial-review-parser";
import { ValidatorError } from "@/lib/story-validator";
import { ArtifactWriteError } from "@/storage/artifact-store";
import { ConfigValidationError } from "@/types/story-config";
import { BeatPlanValidationError } from "@/types/beat-plan";
import type { BeatPlan } from "@/types/beat-plan";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_COMMERCIAL_REVIEW,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  SAMPLE_VALIDATION,
  FakeLLM,
  repoRoot,
  repoVersion,
  withTmpDir,
} from "./helpers/fixtures";
import type { BeatValidationResult } from "@/types/beat-validation";

/**
 * v1.0.0 合同测试：公开 API 表面冻结（TASK §12/§13/§14/§51）。
 *
 * 冻结三层：
 *   1. 错误契约：error body 的字段集、code 白名单、异常 → (code, status) 映射。
 *   2. 路由清单：src/app/api 下有哪些 route.ts、各导出什么方法。多一个、少一个都算走样。
 *   3. 每个入口的请求/响应形状（含条件字段与「忽略某字段」这类容易走样的约定）。
 *
 * LLM 一律 FakeLLM 或注入的假件（§47）：没有一条用例会发出真实网络请求。
 */

const RUN_OK_KEYS = [
  "run_id",
  "status",
  "story",
  "beat_plan",
  // v1.4.0 §26：BeatPlan 结构校验同样是纯追加字段
  "beat_validation",
  "beat_validation_status",
  "validation",
  "validation_status",
  "review",
  "review_status",
  // v1.5.0 TASK §31：商业可读性结论与 review 完全并列，同样是纯追加字段
  "commercial_review",
  "commercial_review_status",
  // v1.2.0 §25：统一质量层是新增字段，原有字段一个不动
  "quality",
  "artifacts",
  "quality_status",
  "attempt_count",
  "selected_attempt",
  "repair_count",
  "attempts",
  // v1.6.0：出身清单同样是纯追加字段，与 run-manifest.json 是同一份内容
  "manifest",
].sort();

/** v1.0.0 冻结的路由清单：[路径, HTTP 方法]。 */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["api/generate", "POST"],
  ["api/health", "GET"],
  ["api/plan", "POST"],
  ["api/prompt/preview", "POST"],
  ["api/repair", "POST"],
  ["api/review", "POST"],
  // v1.5.0：与 /api/review 完全并列的第二个审阅入口
  ["api/review/commercial", "POST"],
  ["api/runs", "POST"],
  ["api/runs/from-plan", "POST"],
  ["api/runs/[run_id]", "GET"],
  ["api/runs/[run_id]/attempts/[attempt_number]", "GET"],
  ["api/validate", "POST"],
  // v1.4.0：手动校验剧情骨架的结构
  ["api/validate-beats", "POST"],
  ["api/version", "GET"],
];

function post(path: string, payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest(`http://localhost/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function get(path: string) {
  return new NextRequest(`http://localhost/${path}`, { method: "GET" });
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 走完整 Pipeline 的假件：四个阶段都只用到 generate()。 */
function runDeps(llm: FakeLLM, beatValidation?: BeatValidationResult) {
  // 降到这些阶段真正需要的形状，接口其余部分（baseUrl/apiKey/...）与用例无关
  const client = llm as never;
  return {
    llm: client,
    planner: new BeatPlanner(client),
    generator: new StoryGenerator(client),
    validator: new StoryValidator(),
    reviewer: new BasicReviewer(client),
    repairer: new StoryRepairer(client),
    repairStrategy: new RepairStrategy(),
    // v1.4.0：BeatValidator 单独用一条假 LLM——它排在主回复序列中间，
    // 不拆开会让每条用例里的 plan / story / review 位置全部错位
    beatValidator: new BeatValidator(
      new FakeLLM([JSON.stringify(beatValidation ?? SAMPLE_BEAT_VALIDATION)]) as never,
    ),
    // v1.5.0：商业审阅同样是独立的一次调用。FakeLLM 对单条回复会一直重复返回，
    // 于是这里不必在每条用例的主回复序列里给它排一个位置。
    commercialReviewer: new CommercialReviewer(
      new FakeLLM([JSON.stringify(SAMPLE_COMMERCIAL_REVIEW)]) as never,
    ),
  };
}

describe("v1.0.0 API 冻结 — 错误契约", () => {
  it("错误码白名单恰好是十三种", () => {
    expect([...API_ERROR_CODES].sort()).toEqual(
      [
        "ARTIFACT_WRITE_FAILED",
        // v1.4.0：BeatPlan 结构校验自身失败
        "BEAT_VALIDATION_FAILED",
        "COMMERCIAL_REVIEW_FAILED",
        "CONFIG_INVALID",
        "GENERATION_FAILED",
        "INTERNAL_ERROR",
        "LLM_REQUEST_FAILED",
        "LLM_TIMEOUT",
        "PLANNER_INVALID_OUTPUT",
        "REPAIR_FAILED",
        "REVIEW_FAILED",
        "RUN_NOT_FOUND",
        "VALIDATION_FAILED_INTERNAL",
      ],
    );
  });

  it("错误 body 只有 error/code/message 三个必备字段，run_id 与 stage 可选", () => {
    expect(Object.keys(errorBody("RUN_NOT_FOUND", "不存在")).sort()).toEqual(["error"]);
    const detail = errorBody("LLM_TIMEOUT", "慢了", { run_id: "r1", stage: "planning" }).error;
    expect(Object.keys(detail).sort()).toEqual(["code", "message", "run_id", "stage"]);
    const bare = errorBody("LLM_TIMEOUT", "慢了").error;
    expect(bare).not.toHaveProperty("run_id");
    expect(bare).not.toHaveProperty("stage");
  });

  it("ApiError 自带 httpStatus，body() 只暴露 code/message/run_id/stage", () => {
    const err = new ApiError("CONFIG_INVALID", "配置不合法", 400, "r1", "planning");
    expect([err.httpStatus, err.code]).toEqual([400, "CONFIG_INVALID"]);
    expect(Object.keys(err.body()).sort()).toEqual(["error"]);
    expect(Object.keys(err.body().error).sort()).toEqual(["code", "message", "run_id", "stage"]);
  });

  /** 异常 → (code, status) 映射表：改一个映射就红，防止回归 v0.9.0 的死码问题。 */
  const MAPPING: ReadonlyArray<readonly [unknown, ApiErrorCode, number]> = [
    [new LLMTimeoutError("超时"), "LLM_TIMEOUT", 504],
    [new LLMError("401"), "LLM_REQUEST_FAILED", 502],
    [new BeatParseError("解析不出 JSON"), "PLANNER_INVALID_OUTPUT", 502],
    [new ReviewParseError("解析不出 JSON"), "REVIEW_FAILED", 502],
    [new ValidatorError("规则炸了"), "VALIDATION_FAILED_INTERNAL", 500],
    [new BeatValidationParseError("解析不出 JSON"), "BEAT_VALIDATION_FAILED", 502],
    [new CommercialReviewParseError("解析不出 JSON"), "COMMERCIAL_REVIEW_FAILED", 502],
    [new ArtifactWriteError("story.md", new Error("EACCES")), "ARTIFACT_WRITE_FAILED", 500],
    [new ConfigValidationError("配置不合法"), "CONFIG_INVALID", 400],
    [new BeatPlanValidationError("骨架不合法"), "CONFIG_INVALID", 400],
    [new Error("没见过的异常"), "INTERNAL_ERROR", 500],
  ];

  for (const [source, code, status] of MAPPING) {
    it(`${(source as Error).name || "未知异常"} → ${code} / ${status}`, () => {
      const mapped = toApiError(source);
      expect([mapped.code, mapped.httpStatus]).toEqual([code, status]);
    });
  }

  it("内部错误的 message 固定，不带异常原文", () => {
    const mapped = toApiError(new Error("/Users/secret/xxx 炸了"));
    expect(mapped.message).toBe("服务器内部错误");
  });
});

describe("v1.0.0 API 冻结 — 路由清单", () => {
  it("src/app/api 下的 route.ts 与导出方法逐条对得上", () => {
    const found: string[] = [];
    const apiRoot = join(repoRoot(), "src", "app", "api");
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "route.ts") {
          const rel = `api/${next.slice(apiRoot.length + 1).replace(/\\/g, "/").replace(/route\.ts$/, "").replace(/\/$/, "")}`;
          const methods = [...readFileSync(next, "utf8").matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)].map(
            (m) => m[1],
          );
          found.push(`${rel} ${methods.join(",")}`);
        }
      }
    };
    expect(statSync(apiRoot).isDirectory()).toBe(true);
    walk(apiRoot);
    expect(found.sort()).toEqual(ROUTES.map(([path, method]) => `${path} ${method}`).sort());
  });
});

describe("v1.0.0 API 冻结 — 纯路由", () => {
  it("GET /api/health 只返回 status: ok", async () => {
    // 纯路由不接收任何参数：签名走样（开始读 request/依赖注入）就算破坏契约
    const res = await getHealth();
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ status: "ok" });
  });

  it("GET /api/version 的 version 与仓库 VERSION 一致", async () => {
    const res = await getVersion();
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ version: repoVersion() });
  });

  it("POST 路由收到坏 JSON 一律 400 CONFIG_INVALID", async () => {
    withTmpDir();
    const res = await postValidate(post("api/validate", "{ 不是 JSON"));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("POST /api/prompt/preview 只返回 prompt，且不调用 LLM", async () => {
    withTmpDir();
    const res = await postPromptPreview(post("api/prompt/preview", { config: SAMPLE_CONFIG, beat_plan: SAMPLE_BEAT_PLAN }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(Object.keys(body)).toEqual(["prompt"]);
    expect(String(body.prompt)).toContain(SAMPLE_CONFIG.title);
  });

  it("POST /api/plan 成功返回 BeatPlan，且最外层就是骨架本体（没有 config 包装）", async () => {
    withTmpDir();
    const llm = new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN)]) as never;
    const { status, json } = await planStory(SAMPLE_CONFIG, llm, new BeatPlanner(llm));
    expect(status).toBe(200);
    const plan = json as BeatPlan;
    expect(plan.beat_plan_version).toBe("1");
    expect(plan.beats).toHaveLength(SAMPLE_BEAT_PLAN.beats.length);
    // 顶层就是骨架本体：没有 config / status 之类的包装层
    expect(Object.keys(json as object).sort()).toEqual(["beat_plan_version", "beats", "summary"]);
  });

  it("POST /api/plan 不支持 {config} 包装：包装后缺 title 直接 400", async () => {
    withTmpDir();
    const { status, json } = await planStory({ config: SAMPLE_CONFIG }, new FakeLLM([]) as never, new BeatPlanner(new FakeLLM([]) as never));
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });
});

describe("v1.0.0 API 冻结 — 单步入口", () => {
  it("POST /api/validate 成功响应只有 passed 与 issues，空 story 走 200 而非 400", async () => {
    withTmpDir();
    const good = await postValidate(post("api/validate", { config: SAMPLE_CONFIG, story: SAMPLE_STORY }));
    expect(good.status).toBe(200);
    expect(Object.keys(await jsonOf(good)).sort()).toEqual(["issues", "passed"]);

    // 空串是「值不合法」不是「请求不合法」：交给规则判 EMPTY_CONTENT
    const empty = await postValidate(post("api/validate", { config: SAMPLE_CONFIG, story: "" }));
    expect(empty.status).toBe(200);
    expect(await jsonOf(empty)).toMatchObject({ passed: false });
  });

  it("POST /api/validate 的 story 不是字符串才 400", async () => {
    withTmpDir();
    const res = await postValidate(post("api/validate", { config: SAMPLE_CONFIG, story: 42 }));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("POST /api/review 成功返回 score/summary/strengths/problems 四字段", async () => {
    withTmpDir();
    const { status, json } = await reviewStory(
      { config: SAMPLE_CONFIG, story: SAMPLE_STORY },
      { reviewer: new BasicReviewer(new FakeLLM([JSON.stringify(SAMPLE_REVIEW)]) as never) },
    );
    expect(status).toBe(200);
    expect(Object.keys(json as object).sort()).toEqual(["problems", "score", "strengths", "summary"]);
  });

  it("POST /api/review 缺 story 直返 400，且不调用 Reviewer", async () => {
    withTmpDir();
    let called = 0;
    const { status, json } = await reviewStory({ config: SAMPLE_CONFIG }, {
      reviewer: { review: async () => { called += 1; return SAMPLE_REVIEW; } } as never,
    });
    expect(status).toBe(400);
    expect((json as { error: { message: string } }).error.message).toContain("story is required");
    expect(called).toBe(0);
  });

  it("POST /api/repair 成功返回 repaired_story/issue_type/success/notes，没有 diff 字段", async () => {
    withTmpDir();
    const { status, json } = await repairStory(
      {
        config: SAMPLE_CONFIG,
        beat_plan: SAMPLE_BEAT_PLAN,
        story: SAMPLE_STORY,
        issue_type: "general",
        issue_message: "高潮缺失",
      },
      { repairer: new StoryRepairer(new FakeLLM(["修订后的正文。"]) as never) },
    );
    expect(status).toBe(200);
    expect(Object.keys(json as object).sort()).toEqual(["issue_type", "notes", "repaired_story", "success"]);
    expect(json).not.toHaveProperty("diff");
  });

  it("POST /api/repair 的 issue_type 不在白名单内 → 400", async () => {
    withTmpDir();
    const { status, json } = await repairStory({
      config: SAMPLE_CONFIG,
      beat_plan: SAMPLE_BEAT_PLAN,
      story: SAMPLE_STORY,
      issue_type: "不存在的类型",
      issue_message: "高潮缺失",
    });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  });

  it("只读校验与一步修订都不接受 retry_policy 越界以外的策略字段影响", async () => {
    withTmpDir();
    // retry_policy 只被三个 run 路由读取，其它路由静默忽略
    const { status } = await reviewStory(
      { config: SAMPLE_CONFIG, story: SAMPLE_STORY, retry_policy: { max_attempts: 99 } },
      { reviewer: new BasicReviewer(new FakeLLM([JSON.stringify(SAMPLE_REVIEW)]) as never) },
    );
    expect(status).toBe(200);

    const bad = await validateStory({ config: SAMPLE_CONFIG, story: SAMPLE_STORY, retry_policy: { max_attempts: 99 } });
    expect(bad.status).toBe(200);
  });
});

describe("v1.0.0 API 冻结 — Run 入口", () => {
  it("POST /api/runs 的响应字段集与 artifacts 条件键", async () => {
    withTmpDir();
    const { status, json } = await startRun(
      { config: SAMPLE_CONFIG },
      runDeps(new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN), SAMPLE_STORY, JSON.stringify(SAMPLE_REVIEW)])),
    );
    expect(status).toBe(200);
    const run = json as unknown as Record<string, unknown>;
    expect(Object.keys(run).sort()).toEqual(RUN_OK_KEYS);
    // validation / review / commercial review 都成功：九个 artifact 键齐
    // （v1.4.0 多一个 beat-validation.json，v1.5.0 多一个 commercial-review.json）
    expect(Object.keys(run.artifacts as object).sort()).toEqual(
      [
        "beat_plan", "beat_validation", "commercial_review", "config", "metadata",
        "quality", "review", "story", "validation",
      ],
    );
    expect(run.quality_status).toBe("accepted");
    expect(run.attempt_count).toBe(1);
    expect(run.selected_attempt).toBe(1);
    expect(run.repair_count).toBe(0);
    expect(run.run_id).toMatch(/^\d{8}_\d{6}_[a-z0-9]{6}$/);
    const attempts = run.attempts as Array<Record<string, unknown>>;
    expect(Object.keys(attempts[0]).sort()).toEqual([
      "accepted",
      "attempt_number",
      "repair_count",
      "repairs",
      "retry_reason",
      "review_score",
      "validation_passed",
    ]);
  });

  it("retry_policy 越界在 run 入口是 400，合法边界则放行", async () => {
    withTmpDir();
    const bad = await startRun({ config: SAMPLE_CONFIG, retry_policy: { max_attempts: 0 } }, runDeps(new FakeLLM([])));
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");

    withTmpDir();
    const ok = await startRun(
      { config: SAMPLE_CONFIG, retry_policy: { max_attempts: 5, min_review_score: 100, max_repairs_per_attempt: 0 } },
      runDeps(new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN), SAMPLE_STORY, JSON.stringify(SAMPLE_REVIEW)])),
    );
    expect(ok.status).toBe(200);
    const run = ok.json as unknown as Record<string, unknown>;
    // min_review_score=100：Review 正常出分（artifacts 仍含 review.json），但分数不够 → exhausted
    expect(Object.keys(run.artifacts as object)).toContain("review");
    expect(run.quality_status).toBe("exhausted");
  });

  it("POST /api/runs/from-plan 缺 beat_plan 直返 400 且不调用 LLM", async () => {
    withTmpDir();
    let called = 0;
    const { status, json } = await startRunFromPlan({ config: SAMPLE_CONFIG }, runDeps({ generate: async () => { called += 1; return SAMPLE_STORY; } } as never));
    expect(status).toBe(400);
    expect((json as { error: { message: string } }).error.message).toContain("beat_plan is required");
    expect(called).toBe(0);
  });

  it("LLM 超时映射为 504 LLM_TIMEOUT，失败映射为 502 LLM_REQUEST_FAILED", async () => {
    withTmpDir();
    const timeout = await startRun({ config: SAMPLE_CONFIG }, runDeps({ generate: async () => { throw new LLMTimeoutError("超时"); } } as never));
    expect([timeout.status, (timeout.json as { error: { code: string } }).error.code]).toEqual([504, "LLM_TIMEOUT"]);

    withTmpDir();
    const failed = await startRunFromPlan(
      { config: SAMPLE_CONFIG, beat_plan: SAMPLE_BEAT_PLAN },
      runDeps({ generate: async () => { throw new LLMError("401"); } } as never),
    );
    expect([failed.status, (failed.json as { error: { code: string } }).error.code]).toEqual([502, "LLM_REQUEST_FAILED"]);
  });

  it("GET /api/runs/<id> 的 RunDetail 字段集（没有 beat_plan 与 artifacts）", async () => {
    withTmpDir();
    const created = await startRun(
      { config: SAMPLE_CONFIG },
      runDeps(new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN), SAMPLE_STORY, JSON.stringify(SAMPLE_REVIEW)])),
    );
    const runId = (created.json as { run_id: string }).run_id;
    const res = await getRunDetail(get(`api/runs/${runId}`), { params: Promise.resolve({ run_id: runId }) } as never);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual([
      "attempt_count",
      "attempts",
      "beat_validation",
      "beat_validation_status",
      // v1.5.0 TASK §31：商业可读性结论同样是纯追加字段
      "commercial_review",
      "commercial_review_status",
      "enable_repair",
      // v1.6.0：出身清单与 POST 响应同源，都是纯追加字段
      "manifest",
      "max_attempts",
      "max_repairs_per_attempt",
      "min_review_score",
      // v1.2.0 §26：新增字段；旧 Run 没有 quality.json 时由服务端临时装配后照样返回
      "quality",
      "quality_status",
      "repair_count",
      "review",
      "review_status",
      "run_id",
      "selected_attempt",
      "status",
      "story",
      "validation",
      "validation_status",
    ]);
    expect(detail).not.toHaveProperty("beat_plan");
    expect(detail).not.toHaveProperty("artifacts");
    expect(detail.run_id).toBe(runId);
    expect(String(detail.story)).toContain(SAMPLE_CONFIG.title);
  });

  it("GET /api/runs/<id> 与 attempt 查询的错误码：非法 run_id 400，不存在 404 同一码", async () => {
    withTmpDir();
    const badId = await getRunDetail(get("api/runs/..%2F..%2Fetc"), { params: Promise.resolve({ run_id: "../../etc" }) } as never);
    expect(badId.status).toBe(400);
    expect((await jsonOf(badId)).error).toMatchObject({ code: "CONFIG_INVALID" });

    const missing = await getRunDetail(get("api/runs/20200101_000000_zzzzzz"), { params: Promise.resolve({ run_id: "20200101_000000_zzzzzz" }) } as never);
    expect(missing.status).toBe(404);
    expect((await jsonOf(missing)).error).toMatchObject({ code: "RUN_NOT_FOUND" });

    const missingAttempt = await getRunAttemptDetail(get("api/runs/20200101_000000_zzzzzz/attempts/1"), {
      params: Promise.resolve({ run_id: "20200101_000000_zzzzzz", attempt_number: "1" }),
    } as never);
    expect(missingAttempt.status).toBe(404);
    expect((await jsonOf(missingAttempt)).error).toMatchObject({ code: "RUN_NOT_FOUND" });

    const badAttempt = await getRunAttemptDetail(get("api/runs/20200101_000000_zzzzzz/attempts/abc"), {
      params: Promise.resolve({ run_id: "20200101_000000_zzzzzz", attempt_number: "abc" }),
    } as never);
    expect(badAttempt.status).toBe(400);
    expect((await jsonOf(badAttempt)).error).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("GET /api/runs/<id>/attempts/<n> 的 AttemptDetail 字段集与 selected 标记", async () => {
    withTmpDir();
    const created = await startRun(
      { config: SAMPLE_CONFIG },
      runDeps(new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN), SAMPLE_STORY, JSON.stringify(SAMPLE_REVIEW)])),
    );
    const runId = (created.json as { run_id: string }).run_id;
    const res = await getRunAttemptDetail(get(`api/runs/${runId}/attempts/1`), {
      params: Promise.resolve({ run_id: runId, attempt_number: "1" }),
    } as never);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual([
      "accepted",
      "attempt_number",
      // v1.5.0 TASK §17：这一次尝试的商业可读性结论
      "commercial_review",
      "initial_story",
      // v1.2.0 §26：这一次 Attempt 的质量快照
      "quality",
      "repair_count",
      "repairs",
      "retry_reason",
      "review",
      "run_id",
      "selected",
      "story",
      "validation",
    ]);
    // 没发生修订：initial_story 是 null 而非省略
    expect(detail.initial_story).toBeNull();
    expect(detail.selected).toBe(true);
    expect(detail.validation).toEqual(SAMPLE_VALIDATION);
    // v1.5.0：商业结论与 review 各自独立回传，都是完整对象
    expect(detail.commercial_review).toEqual(SAMPLE_COMMERCIAL_REVIEW);
  });

  it("Run 查询不依赖异常路径：getRun/getRunAttempt 直接返回 {status, json}", async () => {
    withTmpDir();
    const lookup = await getRun("20200101_000000_zzzzzz", new ArtifactStore());
    expect(lookup.status).toBe(404);
    // Run 不存在与 attempt 不存在共用 RUN_NOT_FOUND，只能靠 message 区分
    expect((lookup.json as { error: { message: string } }).error.message).toContain("run_id 不存在");

    const created = await startRun(
      { config: SAMPLE_CONFIG },
      runDeps(new FakeLLM([JSON.stringify(SAMPLE_BEAT_PLAN), SAMPLE_STORY, JSON.stringify(SAMPLE_REVIEW)])),
    );
    const runId = (created.json as { run_id: string }).run_id;
    const attempt = await getRunAttempt(runId, 99, new ArtifactStore());
    expect(attempt.status).toBe(404);
    expect((attempt.json as { error: { message: string } }).error.message).toContain("Attempt 99");
    expect((attempt.json as { error: { code: string } }).error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("v1.0.0 API 冻结 — 安全约定", () => {
  it("异常里的绝对路径不会原样出现在响应 message 里", async () => {
    withTmpDir();
    const dir = process.cwd();
    const { status, json } = await planStory({ title: "x", genre: "悬疑", premise: "p", target_words: 5000 }, new FakeLLM([]) as never, {
      plan: async () => {
        throw new Error(`读取 ${dir}\\runs\\x\\beats.json 失败`);
      },
    } as never);
    const message = (json as { error: { message: string } }).error.message;
    // 未预期异常走固定文案，路径根本不出现在响应里
    expect(status).toBe(500);
    expect(message).not.toContain(dir);

    // 已知异常走 safeText：路径打码成 <path>，其余信息保留
    const mapped = toApiError(new LLMError(`连接 ${dir}\\v1 失败`));
    expect(mapped.message).not.toContain(dir);
    expect(mapped.message).toContain("<path>");
  });

  it("示例 env 不含真实凭据样例：.env.example 仍是空模板", () => {
    const example = readFileSync(join(repoRoot(), ".env.example"), "utf8");
    for (const line of example.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const value = trimmed.slice(trimmed.indexOf("=") + 1);
      expect(value, ".env.example 不应给出可用的凭据值").toBe("");
    }
  });

  it("API 路由源码不读取请求头里的凭据", async () => {
    const apiRoot = join(repoRoot(), "src", "app", "api");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name.endsWith(".ts")) files.push(next);
      }
    };
    walk(apiRoot);
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} 不应碰 Authorization 头`).not.toContain("authorization");
      expect(text, `${file} 不应碰 cookie`).not.toContain("cookie");
    }
  });
});
