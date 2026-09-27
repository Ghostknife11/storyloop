/**
 * v2.1.0 TASK §46 quality-stack.json 的安全回归。
 *
 * 统一质量视图是把三套已经存在的结论搬到一张表里，因此它多了一个新的泄露面：
 * 任何一个环节把请求配置、请求头或环境变量顺手带进 diagnostics，这份文件就会
 * 变成一份随 Run 长期留在磁盘上的凭据副本。这里用四条证据钉住它不会：
 *
 *   1. §5 禁用的诊断字段（rootCause / confidenceProbability / repairPolicy /
 *      adaptiveWeight / causalNodeId / evidenceLedgerId / characterDecisionId）
 *      即使模型在回复里写了，也进不了质量栈；
 *   2. 跑一次真 Run（假客户端），落盘的 quality-stack.json 里没有任何凭据形状；
 *   3. 两个读接口（Run 详情与 /quality-stack）的响应体同样干净；
 *   4. 质量栈只收录三套结论的字段，不复制 config / baseUrl / headers / env。
 *
 * 前面几条（v1.1 URL 关卡、v1.6 密钥不落 Manifest、v1.8 遥测、v1.9 失败分析）
 * 在各自的测试文件里把守，这里只查新开的这一路没有把它们绕过去。
 * 铁律同全仓：只有假客户端，没有一次请求打到真实模型。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRunRoute } from "@/app/api/runs/[run_id]/route";
import { GET as getQualityStackRoute } from "@/app/api/runs/[run_id]/quality-stack/route";
import { createStoryLoop } from "@/composition";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { QualityStackCoordinator } from "@/engine/quality-stack-coordinator";
import { qualityStackViewOf } from "@/domain/quality-stack";
import { validateQualityReviewV2Result } from "@/domain/quality-review-v2";
import { qualityCenterState } from "@/interface/quality-center-view";
import { legacyReviewOf } from "@/domain/quality-review-v2";
import type { BeatValidationV2Result } from "@/domain/beat-validation-v2";
import type { CommercialReviewV2Result } from "@/domain/commercial-review-v2";
import {
  FakeLLM,
  SAMPLE_BEAT_PLAN,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_CONFIG,
  REVIEW_REPLY,
  SAMPLE_STORY,
  withTmpDir,
} from "./helpers/fixtures";

/** 形状像凭据，实际是假的：测试用它证明「它没有被带到任何输出里」。 */
const FAKE_KEY = "sk-" + "quality-stack-not-a-real-credential";
const FAKE_URL_SECRET = "url-token-" + "not-a-real-credential";
const FAKE_COOKIE = "session=" + "not-a-real-credential";
const FAKE_ENV_NAME = "STORYLOOP_FAKE_SECRET_ENV";
const FAKE_ENV_VALUE = "env-value-" + "not-a-real-credential";

const SECRETS = [FAKE_KEY, FAKE_URL_SECRET, FAKE_COOKIE, FAKE_ENV_VALUE];

const FORBIDDEN_DIAGNOSTIC_FIELDS = [
  "rootCause",
  "confidenceProbability",
  "repairPolicy",
  "adaptiveWeight",
  "causalNodeId",
  "evidenceLedgerId",
  "characterDecisionId",
];

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const BEAT_VALIDATION_REPLY = JSON.stringify({ passed: true, diagnostics: [], summary: "骨架结构完整。" });

/** 一次 Automatic Run 的五次调用：Plan → 骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
function happyScript(): string[] {
  return [PLAN_REPLY, BEAT_VALIDATION_REPLY, SAMPLE_STORY, REVIEW_REPLY, JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2)];
}

function assertClean(text: string, where: string): void {
  for (const secret of SECRETS) {
    expect(text.includes(secret), `${where} 里出现了凭据 ${secret.slice(0, 12)}…`).toBe(false);
  }
  for (const field of FORBIDDEN_DIAGNOSTIC_FIELDS) {
    expect(text.includes(field), `${where} 里出现了 §5 禁用字段 ${field}`).toBe(false);
  }
  // 形状上的凭据关键字：Authorization / Cookie / api_key / Bearer
  expect(text).not.toMatch(/Authorization/i);
  expect(text).not.toMatch(/Cookie/i);
  expect(text).not.toMatch(/api[_-]?key/i);
  expect(text).not.toMatch(/Bearer\s/i);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("§46/§5 协调器不收禁用的诊断字段", () => {
  it("模型在回复里写了 rootCause / confidenceProbability 一类字段：质量栈里一个都没有", () => {
    const beatValidation: BeatValidationV2Result = {
      passed: true,
      diagnostics: [],
      summary: "骨架结构完整。",
    };
    // 直接构造一份「模型多嘴」的审阅结论：validateQualityReviewV2Result 会按 schema 收，
    // 禁用的那几个键不在 schema 里，因此进不来
    const qualityReview = validateQualityReviewV2Result({
      dimensions: {
        coherence: { score: 84, summary: "一致。", strengths: ["称呼统一"], problems: [] },
        narrative: { score: 82, summary: "完整。", strengths: ["起承转合完整"], problems: [] },
        character: { score: 80, summary: "清楚。", strengths: ["目标明确"], problems: [] },
        causality: { score: 82, summary: "成立。", strengths: ["主线因果成立"], problems: [] },
      },
      diagnostics: [
        {
          category: "causal_gap",
          severity: "error",
          target: "story",
          message: "配角反水没有前文支撑。",
          rootCause: "人物动机没铺垫",
          confidenceProbability: 0.92,
          repairPolicy: "rewrite-middle",
          adaptiveWeight: 2.5,
          causalNodeId: "node-7",
          evidenceLedgerId: "ledger-2",
          characterDecisionId: "decision-9",
        },
      ],
      summary: "主线清楚，配角反水缺铺垫。",
    });
    const commercialReview: CommercialReviewV2Result = SAMPLE_COMMERCIAL_REVIEW_V2;

    const stack = new QualityStackCoordinator().coordinate({ beatValidation, qualityReview, commercialReview });
    const text = JSON.stringify(stack);
    for (const field of FORBIDDEN_DIAGNOSTIC_FIELDS) {
      expect(text).not.toContain(field);
    }
    // 该在的还在：诊断本身没有被一起丢掉
    expect(stack.diagnostics.map((d) => d.id)).toContain("quality-reviewer-1");
    expect(stack.diagnostics[0].message).toBe("配角反水没有前文支撑。");
  });

  it("质量栈的顶层只有 schemaVersion / status / 三个模块 / diagnostics / summary：没有配置位", () => {
    const stack = new QualityStackCoordinator().coordinate({
      beatValidation: { passed: true, diagnostics: [], summary: "骨架结构完整。" },
      qualityReview: validateQualityReviewV2Result({
        dimensions: {
          coherence: { score: 84, summary: "一致。", strengths: ["称呼统一"], problems: [] },
          narrative: { score: 82, summary: "完整。", strengths: ["起承转合完整"], problems: [] },
          character: { score: 80, summary: "清楚。", strengths: ["目标明确"], problems: [] },
          causality: { score: 82, summary: "成立。", strengths: ["主线因果成立"], problems: [] },
        },
        diagnostics: [],
        summary: "整体完整。",
      }),
      commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
    });
    expect(Object.keys(stack).sort()).toEqual(
      ["beatValidation", "commercialReview", "diagnostics", "qualityReview", "schemaVersion", "status", "summary"].sort(),
    );
  });
});

describe("§46 跑一次真 Run：quality-stack.json 与两个读接口都不带凭据", () => {
  it("落盘的那一份干净", async () => {
    withTmpDir();
    vi.stubEnv("LLM_API_KEY", FAKE_KEY);
    vi.stubEnv("LLM_BASE_URL", `https://public.example.com/v1?token=${FAKE_URL_SECRET}`);
    vi.stubEnv("LLM_MODEL", "fake-model");
    vi.stubEnv(FAKE_ENV_NAME, FAKE_ENV_VALUE);

    const fake = new FakeLLM(happyScript());
    const app = createStoryLoop({ llm: fake as never });
    const { status, json } = await app.service.generate({ config: { ...SAMPLE_CONFIG, headers: { Cookie: FAKE_COOKIE } } });
    expect(status, JSON.stringify(json)).toBe(200);
    const runId = (json as { run_id: string }).run_id;

    const file = join(new ArtifactStore().resolveRunDir(runId), "quality-stack.json");
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
    assertClean(readFileSync(file, "utf8"), file);

    // 顺带确认它真的是一次完整装配：三套结论都在，不是一份空壳
    const stack = JSON.parse(readFileSync(file, "utf8")) as { status: string };
    expect(stack.status).toBe("complete");
  });

  it("Run 详情与 /quality-stack 两个响应体同样干净", async () => {
    withTmpDir();
    vi.stubEnv("LLM_API_KEY", FAKE_KEY);
    vi.stubEnv("LLM_BASE_URL", `https://public.example.com/v1?token=${FAKE_URL_SECRET}`);
    vi.stubEnv("LLM_MODEL", "fake-model");
    vi.stubEnv(FAKE_ENV_NAME, FAKE_ENV_VALUE);

    const fake = new FakeLLM(happyScript());
    const app = createStoryLoop({ llm: fake as never });
    const { status, json } = await app.service.generate({ config: { ...SAMPLE_CONFIG, headers: { Cookie: FAKE_COOKIE } } });
    expect(status, JSON.stringify(json)).toBe(200);
    const runId = (json as { run_id: string }).run_id;

    const detail = (await getRunRoute(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ run_id: runId }),
    } as never)) as unknown as Response;
    assertClean(await detail.text(), "GET /api/runs/<id>");

    const stackRes = (await getQualityStackRoute(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ run_id: runId }),
    } as never)) as unknown as Response;
    expect(stackRes.status).toBe(200);
    const body = (await stackRes.json()) as { qualityStack: unknown };
    expect(body.qualityStack).not.toBeNull();
    assertClean(JSON.stringify(body), "GET /api/runs/<id>/quality-stack");
  });

  it("§32 投影与 UI 状态同样不夹带凭据或禁用字段", () => {
    const view = qualityStackViewOf(
      new QualityStackCoordinator().coordinate({
        beatValidation: { passed: true, diagnostics: [], summary: "骨架结构完整。" },
        qualityReview: validateQualityReviewV2Result({
          dimensions: {
            coherence: { score: 84, summary: "一致。", strengths: ["称呼统一"], problems: [] },
            narrative: { score: 82, summary: "完整。", strengths: ["起承转合完整"], problems: [] },
            character: { score: 80, summary: "清楚。", strengths: ["目标明确"], problems: [] },
            causality: { score: 82, summary: "成立。", strengths: ["主线因果成立"], problems: [] },
          },
          diagnostics: [
            { category: "causal_gap", severity: "warning", target: "story", message: "配角反水没有前文支撑。" },
          ],
          summary: "整体完整。",
        }),
        commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
      }),
    );
    expect(view).not.toBeNull();
    const state = qualityCenterState({
      stack: view,
      review: legacyReviewOf(
        validateQualityReviewV2Result({
          dimensions: {
            coherence: { score: 84, summary: "一致。", strengths: ["称呼统一"], problems: [] },
            narrative: { score: 82, summary: "完整。", strengths: ["起承转合完整"], problems: [] },
            character: { score: 80, summary: "清楚。", strengths: ["目标明确"], problems: [] },
            causality: { score: 82, summary: "成立。", strengths: ["主线因果成立"], problems: [] },
          },
          diagnostics: [],
          summary: "整体完整。",
        }),
      ),
      commercialReview: null,
      beatValidation: null,
    });
    expect(state.kind).toBe("ready");
    assertClean(JSON.stringify({ view, state }), "qualityStackViewOf / qualityCenterState");
  });
});
