import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as postValidateBeats } from "@/app/api/validate-beats/route";
import { GET as getRunDetail } from "@/app/api/runs/[run_id]/route";
import { getRun } from "@/lib/generate-service";
import { ArtifactStore } from "@/storage/artifact-store";
import { validateBeatPlan } from "@/types/beat-plan";
import type { BeatValidationResult } from "@/types/beat-validation";
import { BeatValidator } from "@/lib/beat-validator";
import { BeatValidationParseError } from "@/lib/beat-validation-parser";
import { apiErrorOf, SAMPLE_BEAT_VALIDATION, SAMPLE_BEAT_VALIDATION_FAILED } from "./helpers/fixtures";
import { FakeLLM } from "./helpers/fixtures";

/**
 * v1.4.0 POST /api/validate-beats 契约：手动校验剧情骨架（TASK §7）。
 * 全部用假 LLM / 假 BeatValidator 注入服务层，绝不调用真实付费 API（§66）。
 */

const config = {
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

const beatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪，陈岚接到电话。", characters: ["陈岚"] },
    { id: 2, purpose: "升级冲突", event: "线索指向嫌疑人律师。", characters: ["陈岚", "周衡"] },
    { id: 3, purpose: "高潮对峙", event: "陈岚在码头截住销毁证据的人。", characters: ["陈岚"] },
    { id: 4, purpose: "收束", event: "证人被找到，案件重新开庭。", characters: ["陈岚"] },
  ],
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

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-beat-validation-api-"));
  process.chdir(tmp);
  return tmp;
}

function post(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest("http://localhost/api/validate-beats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * 冒充 OpenAI-compatible /chat/completions，只回一份固定的结构校验结论。
 * 路由自己组装 BeatValidator，所以这里只能从传输层注入（§66：绝不碰真实 API）。
 */
function stubBeatLLM() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(SAMPLE_BEAT_VALIDATION) } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /api/validate-beats（v1.4.0 §7）", () => {
  it("合法请求 → 200 + BeatValidationResult 三个字段", async () => {
    withTmpDir();
    stubBeatLLM();
    const res = await postValidateBeats(post({ config, beat_plan: beatPlan }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as unknown as BeatValidationResult;
    expect(body).toEqual(SAMPLE_BEAT_VALIDATION);
    expect(Object.keys(body).sort()).toEqual(["issues", "passed", "summary"]);
  });

  it("不写任何产物：这次校验不碰 runs/", async () => {
    withTmpDir();
    stubBeatLLM();
    await postValidateBeats(post({ config, beat_plan: beatPlan }));
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmp as string, "runs"))).toBe(false);
    expect(existsSync(join(tmp as string, "outputs"))).toBe(false);
  });

  it("请求体不是合法 JSON → 400 CONFIG_INVALID", async () => {
    withTmpDir();
    const res = await postValidateBeats(post("{ not json"));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).code).toBe("CONFIG_INVALID");
  });

  it("缺 beat_plan → 400，提示要的是剧情骨架", async () => {
    withTmpDir();
    const res = await postValidateBeats(post({ config }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("beat_plan");
  });

  it("beat_plan 不合法 → 400（BeatPlanValidationError 属用户错误）", async () => {
    withTmpDir();
    const res = await postValidateBeats(post({ config, beat_plan: { beats: [] } }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).code).toBe("CONFIG_INVALID");
  });

  it("模型输出不是 JSON → 502 BEAT_VALIDATION_FAILED，不 500", async () => {
    withTmpDir();
    const { validateStoryBeats } = await import("@/lib/generate-service");
    const outcome = await validateStoryBeats(
      { config, beat_plan: beatPlan },
      { beatValidator: new BeatValidator(new FakeLLM(["我觉得这份骨架还行"]) as never) } as never,
    );
    expect(outcome.status).toBe(502);
    expect(apiErrorOf(outcome.json).code).toBe("BEAT_VALIDATION_FAILED");
    expect(apiErrorOf(outcome.json).message).toContain("不是合法 JSON");
  });

  it("校验结论带 error → 200，由调用方决定要不要改（这里只报告）", async () => {
    withTmpDir();
    const { validateStoryBeats } = await import("@/lib/generate-service");
    const outcome = await validateStoryBeats(
      { config, beat_plan: beatPlan },
      { beatValidator: { validate: async () => SAMPLE_BEAT_VALIDATION_FAILED } as never } as never,
    );
    expect(outcome.status).toBe(200);
    expect((outcome.json as BeatValidationResult).passed).toBe(false);
  });

  it("BeatValidationParseError 也归到 BEAT_VALIDATION_FAILED", async () => {
    withTmpDir();
    const { validateStoryBeats } = await import("@/lib/generate-service");
    const outcome = await validateStoryBeats(
      { config, beat_plan: beatPlan },
      {
        beatValidator: {
          validate: () => {
            throw new BeatValidationParseError("BeatValidator 输出不是合法 JSON：boom");
          },
        } as never,
      } as never,
    );
    expect(outcome.status).toBe(502);
    expect(apiErrorOf(outcome.json).code).toBe("BEAT_VALIDATION_FAILED");
  });
});

describe("v1.4.0 GET /api/runs/<run_id>：beat 校验字段 additive", () => {
  function legacyRun(dir: string): string {
    const runId = "20260101_120000_legacy";
    const runDir = join(dir, "runs", runId);
    mkdirSync(join(runDir, "attempts", "01"), { recursive: true });
    writeFileSync(
      join(runDir, "metadata.json"),
      JSON.stringify({
        run_id: runId,
        project_version: "1.3.0",
        status: "completed",
        started_at: "2026-01-01T12:00:00.000Z",
        finished_at: "2026-01-01T12:01:00.000Z",
        model: "gpt-4o-mini",
        artifacts: { config: "config.json", beat_plan: "beats.json", story: "story.md", metadata: "metadata.json" },
      }),
    );
    writeFileSync(join(runDir, "beats.json"), JSON.stringify(beatPlan));
    writeFileSync(join(runDir, "attempts", "01", "metadata.json"), JSON.stringify({ attempt_number: 1 }));
    return runId;
  }

  it("v1.3.0 的老 Run：beat_validation 是 null，status 是 not_started，照样 200", async () => {
    const dir = withTmpDir();
    const runId = legacyRun(dir);

    const detail = await getRun(runId, new ArtifactStore(join(dir, "runs")));
    expect(detail.status).toBe(200);
    if (detail.status !== 200) return;
    expect(detail.json.beat_validation).toBeNull();
    expect(detail.json.beat_validation_status).toBe("not_started");

    const res = await getRunDetail({} as never, { params: Promise.resolve({ run_id: runId }) } as never);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.beat_validation).toBeNull();
    expect(body.beat_validation_status).toBe("not_started");
  });

  it("Run 不存在 → 404，不会因为新字段而 500", async () => {
    const dir = withTmpDir();
    const res = await getRunDetail({} as never, { params: Promise.resolve({ run_id: "20260101_000000_none" }) } as never);
    expect(res.status).toBe(404);
    expect(apiErrorOf(await readJson(res)).code).toBe("RUN_NOT_FOUND");
  });
});
