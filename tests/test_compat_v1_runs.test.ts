/**
 * v1.9.0 → v2.0.0 兼容门禁（TASK §20/§21/§42/§54/§55）。
 *
 * 2.0.0 改的是「谁依赖谁」，不是「磁盘上长什么样」。这一文件用三条证据钉住这件事：
 *
 *   1. 跑一次真 Run（走组合根 → 用例 → 引擎），落盘后用**另一个全新的** ArtifactStore
 *      把所有产物读回来。v1.9.0 写在 runs/ 下的 Run，2.0.0 必须原样读得出来（§21）——
 *      不需要批量迁移，也不需要转换层（§42：不许为了新架构重写磁盘文件）。
 *   2. 同样的 Run 再过一遍 API 路由与界面层的解析函数：老产物在老展示路径上还得成立。
 *   3. 三条安全回归不许被重构碰坏：URL 关卡（§54）、密钥不落响应（§55）、
 *      以及未知字段不能让读路径崩（老版本的文件里有这一版不认识的键）。
 *
 * 铁律同全仓（§47）：这里只有假客户端，没有一次请求打到真实模型。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRunRoute } from "@/app/api/runs/[run_id]/route";
import { createStoryLoop } from "@/composition";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { ExperimentStore } from "@/infrastructure/storage/experiment-store";
import { manifestPanelState } from "@/interface/manifest-view";
import { telemetryPanelState } from "@/interface/telemetry-view";
import { qualityPanelState } from "@/interface/quality-view";
import { runScoresOf } from "@/analysis/experiment-summary";
import { FakeLLM, SAMPLE_BEAT_PLAN, SAMPLE_COMMERCIAL_REVIEW, SAMPLE_COMMERCIAL_REVIEW_V2, SAMPLE_CONFIG, REVIEW_REPLY, SAMPLE_REVIEW, SAMPLE_STORY, withTmpDir } from "./helpers/fixtures";
import { RUN_FILES } from "./test_contract_artifacts.test";

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const BEAT_VALIDATION_REPLY = JSON.stringify({ passed: true, diagnostics: [], summary: "骨架结构完整。" });

/** 一次 Automatic Run 的五次调用：Plan → 骨架校验 → 正文 → 结构审阅 → 商业审阅。 */
const HAPPY_SCRIPT = [PLAN_REPLY, BEAT_VALIDATION_REPLY, SAMPLE_STORY, REVIEW_REPLY, JSON.stringify(SAMPLE_COMMERCIAL_REVIEW_V2)];

/** 一次顺利跑完后拿到的 RunOk（只取后面断言要用到的字段）。 */
async function runOnce(patch: Record<string, unknown> = {}): Promise<{ runId: string; json: Record<string, unknown>; app: ReturnType<typeof createStoryLoop> }> {
  const fake = new FakeLLM(HAPPY_SCRIPT);
  const app = createStoryLoop({ llm: fake as never });
  const { status, json } = await app.service.generate({ config: SAMPLE_CONFIG, ...patch });
  expect(status, JSON.stringify(json)).toBe(200);
  const runId = (json as { run_id: string }).run_id;
  return { runId, json: JSON.parse(JSON.stringify(json)) as Record<string, unknown>, app };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// §21 落盘形状：2.0.0 写出来的 Run 目录仍然是 v1.x 的那一套
// ---------------------------------------------------------------------------

describe("§21 一次 Run 落盘后仍是 v1.x 的文件清单", () => {
  it("运行级文件名一个不多一个不少，且都是 v1.x 就有的名字", async () => {
    withTmpDir();
    const { runId } = await runOnce();
    const files = readdirSync(join("runs", runId)).sort();
    expect(files).toEqual(["attempts", ...RUN_FILES].sort());
  });

  it("manifest / telemetry 的 schemaVersion 都还是 \"1\"，metadata 仍是 v1.x 的 snake_case", async () => {
    withTmpDir();
    const { runId } = await runOnce();
    for (const name of ["run-manifest.json", "telemetry.json"]) {
      const raw = JSON.parse(readFileSync(join("runs", runId, name), "utf8")) as { schemaVersion?: unknown };
      expect(raw.schemaVersion, name).toBe("1");
    }
    // metadata.json 没有 schemaVersion（v1.0.0 起就是这个形状），字段名一个都没改
    const meta = JSON.parse(readFileSync(join("runs", runId, "metadata.json"), "utf8")) as Record<string, unknown>;
    for (const key of ["run_id", "project_version", "status", "model"]) {
      expect(Object.keys(meta), key).toContain(key);
    }
    expect(meta.run_id).toBe(runId);
  });

  it("没有 2.0.0 专属的新键混进老产物（§20/§74：能力只增不减，格式不变）", async () => {
    withTmpDir();
    const { runId } = await runOnce();
    const manifest = JSON.parse(readFileSync(join("runs", runId, "run-manifest.json"), "utf8")) as Record<string, unknown>;
    for (const forbidden of ["compositionRoot", "useCase", "layer", "dependencies", "container"]) {
      expect(Object.keys(manifest)).not.toContain(forbidden);
    }
    // 普通 Run 不带 experiment 块（那是实验样本才有的 v1.7.0 字段）
    expect(manifest.experiment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §21/§42 读回：换一个全新的存储实例（＝另一个版本的进程）也读得出来
// ---------------------------------------------------------------------------

describe("§21/§42 v1.x 产物原样读得回来，不需要迁移", () => {
  it("端口读回的全部结论与跑的时候一致", async () => {
    withTmpDir();
    const { runId } = await runOnce();

    // 全新的实例：不共享任何内存状态，等于另一个进程第一次打开这个目录
    const store = new ArtifactStore();
    expect(store.runExists(runId)).toBe(true);

    const manifest = store.readRunManifest(runId);
    expect(manifest?.runId).toBe(runId);
    expect(manifest?.schemaVersion).toBe("1");
    expect(manifest?.artifacts.map((a) => a.path)).toContain("story.md");

    // 正文只做透传（标题头是渲染时加的），不许被改写
    const story = store.readFinalStory(runId);
    expect(story).toContain(SAMPLE_STORY.slice(0, 20));
    expect(story?.length).toBeGreaterThanOrEqual(SAMPLE_STORY.length);
    expect(store.readFinalReview(runId)?.score).toBe(SAMPLE_REVIEW.score);
    expect(store.readFinalValidation(runId)).not.toBeNull();
    expect(store.readFinalBeatValidation(runId)?.passed).toBe(true);
    expect(store.readFinalCommercialReview(runId)?.score).toBe(SAMPLE_COMMERCIAL_REVIEW.score);
    expect(store.readFinalQuality(runId)).not.toBeNull();
    // v1.9.0 起成功的 Run 也会写 failure-analysis.json：结论是「没失败」
    const analysis = store.readFailureAnalysis(runId);
    expect(analysis?.status).toBe("none");
    expect(analysis?.schemaVersion).toBe("1");

    const telemetry = store.readRunTelemetry(runId);
    expect(telemetry?.status).toBe("completed");
    expect(telemetry?.runId).toBe(runId);
    expect(telemetry?.stages.length).toBeGreaterThan(0);
  });

  it("分析层的分数读取（runScoresOf）对 v1.x 产物同样成立", async () => {
    withTmpDir();
    const { runId } = await runOnce();
    const scores = runScoresOf(runId, new ArtifactStore());
    expect(scores.overallScore).toBe(SAMPLE_REVIEW.score);
    expect(scores.commercialScore).toBe(SAMPLE_COMMERCIAL_REVIEW.score);
  });

  it("磁盘上多一个这一版不认识的键，读路径照样工作（未知字段不致命）", async () => {
    withTmpDir();
    const { runId } = await runOnce();

    // 模拟「将来的版本往 metadata / telemetry 里加了个键」：老读路径必须容忍
    const metadataPath = join("runs", runId, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.future_field_2_1_0 = { anything: true };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

    const telemetryPath = join("runs", runId, "telemetry.json");
    const telemetry = JSON.parse(readFileSync(telemetryPath, "utf8")) as Record<string, unknown>;
    telemetry.future_metric = { p99_ms: 12 };
    writeFileSync(telemetryPath, JSON.stringify(telemetry, null, 2), "utf8");

    const store = new ArtifactStore();
    expect(store.readRunMetadata(runId)).not.toBeNull();
    expect(store.readRunTelemetry(runId)?.status).toBe("completed");
    // 界面层的解析函数也不许被未知键打翻
    expect(telemetryPanelState(store.readRunTelemetry(runId)).kind).not.toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
// §20/§74  老产物在老展示路径上仍然成立：API 路由 + 界面层解析
// ---------------------------------------------------------------------------

describe("§20/§74 API 与界面层读 v1.x 产物", () => {
  it("GET /api/runs/<id> 返回完整 Run 详情，且不含本机绝对路径", async () => {
    withTmpDir();
    const { runId } = await runOnce();

    const res = await getRunRoute(
      new NextRequest(`http://localhost/api/runs/${runId}`),
      { params: Promise.resolve({ run_id: runId }) } as never,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(body.run_id).toBe(runId);
    expect(body.status).toBe("completed");
    expect(String(body.story)).toContain(SAMPLE_STORY.slice(0, 20));
    // §67：响应里只有相对文件名，没有 D:\... 或 /home/... 这样的绝对路径
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/tmp\//);
    expect(text).not.toContain("\\Users\\");
  });

  it("manifest-view / quality-view 对 v1.x manifest 仍然产出可渲染状态", async () => {
    withTmpDir();
    const { runId } = await runOnce();
    const manifest = new ArtifactStore().readRunManifest(runId);
    expect(manifest).not.toBeNull();

    const panel = manifestPanelState(manifest);
    expect(panel.kind).not.toBe("hidden");
    expect(JSON.stringify(panel)).toContain(runId);

    const quality = new ArtifactStore().readFinalQuality(runId);
    expect(qualityPanelState({ quality }).kind).not.toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
// §21 实验产物同样向后兼容
// ---------------------------------------------------------------------------

describe("§21 v1.7.0 起就有的实验产物读得回来", () => {
  it("用一个全新的 ExperimentStore 读回定义与结果", async () => {
    withTmpDir();
    const fake = new FakeLLM(HAPPY_SCRIPT.slice(1).concat(HAPPY_SCRIPT.slice(1)));
    const app = createStoryLoop({ llm: fake as never });
    const definition = {
      schemaVersion: "1",
      name: "模型对比",
      experimentId: "exp-compat",
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "fixed", beatPlan: SAMPLE_BEAT_PLAN },
      variants: [{ id: "model-a", name: "模型 A" }],
      repetitions: 1,
      createdAt: "2026-09-20T00:00:00.000Z",
    };

    const created = await app.service.createExperiment(definition);
    expect(created.experimentId).toBe("exp-compat");
    const result = await app.service.runExperiment("exp-compat");
    expect(result.status).toBe("completed");

    // 全新实例读回（§42：磁盘上的三个 JSON 一个字节都没被重写）
    const store = new ExperimentStore("runs");
    expect(store.readDefinition("exp-compat")?.experimentId).toBe("exp-compat");
    const results = store.readResults("exp-compat");
    expect(results?.summary.successCount).toBe(1);
    expect(results?.runs[0].runId).toBeTruthy();

    // 实验样本的 Manifest 上带 experiment 出身块（v1.7.0 的形状）
    const manifest = new ArtifactStore().readRunManifest(results!.runs[0].runId!);
    expect(manifest?.experiment?.experimentId).toBe("exp-compat");

    const detail = await app.service.getExperiment("exp-compat");
    expect(detail.runs?.entries).toHaveLength(1);
    expect(detail.result?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// §54  URL 关卡：重构之后这条路还必须拦得住
// ---------------------------------------------------------------------------

describe("§54 v1.1.0 的 URL 关卡在组合根这条路上仍然生效", () => {
  it("请求体带非公网 baseUrl → 400 CONFIG_INVALID，且一个字节都没发出去", async () => {
    withTmpDir();
    const calls = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }));
    vi.stubGlobal("fetch", calls);

    // 不注入客户端：让请求真的走 clientFor → assertPublicBaseUrl
    const { status, json } = await createStoryLoop().service.generate({
      config: SAMPLE_CONFIG,
      baseUrl: "http://127.0.0.1:9/v1",
    });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    expect(calls).not.toHaveBeenCalled();
  });

  it("云元数据地址同样被挡在发请求之前", async () => {
    withTmpDir();
    const calls = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }));
    vi.stubGlobal("fetch", calls);

    const { status, json } = await createStoryLoop().service.generate({
      config: SAMPLE_CONFIG,
      baseUrl: "http://169.254.169.254/latest/meta-data",
    });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    expect(calls).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §55  密钥回归：密钥不进响应、不进产物
// ---------------------------------------------------------------------------

describe("§55 密钥只待在服务端", () => {
  it("响应体与落盘产物里都找不到 API Key", async () => {
    withTmpDir();
    // 形状像密钥，实际上是一个假的；测试用它来证明「它没有被带到任何输出里」
    const FAKE_KEY = "sk-" + "compat-not-a-real-credential";
    vi.stubEnv("LLM_API_KEY", FAKE_KEY);
    vi.stubEnv("LLM_MODEL", "fake-model");

    const fake = new FakeLLM(HAPPY_SCRIPT);
    const app = createStoryLoop({ llm: fake as never });
    const { status, json } = await app.service.generate({ config: SAMPLE_CONFIG });
    expect(status).toBe(200);
    const runId = (json as { run_id: string }).run_id;

    expect(JSON.stringify(json)).not.toContain(FAKE_KEY);

    // 落盘的每一个文件（含 attempts/ 子目录）都不该带上它
    const pending = [join("runs", runId)];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        expect(readFileSync(full, "utf8").includes(FAKE_KEY), `${full} 里出现了 API Key`).toBe(false);
      }
    }
  });
});
