/**
 * 组合根集成测试（TASK §14/§34/§45/§46）。
 *
 * 前面那些测试要么打单个模块，要么打一条流水线；这一份按 §34 写的那两行字来跑：
 *
 *   const deps = createDependencies(config);
 *   const app  = createStoryLoopApplication(deps);
 *   await app.service.generate(body);
 *
 * 断言的正是这个形状：手动装配出来的应用，从计划到落盘一路走得通；而 /api/health
 * 回的每个布尔都是现查出来的，且不含凭据。
 *
 * 铁律同全仓（§47）：模型客户端是假的，没有一次请求打到真实 API。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GET as healthRoute } from "@/app/api/health/route";
import { GET as versionRoute } from "@/app/api/version/route";
import { createDependencies, createStoryLoop, createStoryLoopApplication } from "@/composition";
import { buildPipeline } from "@/application/generate-service";
import { runScoresOf } from "@/analysis/experiment-summary";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { FakeLLM, SAMPLE_BEAT_PLAN, SAMPLE_CONFIG, SAMPLE_REVIEW, SAMPLE_COMMERCIAL_REVIEW, SAMPLE_STORY, withTmpDir } from "./helpers/fixtures";

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const HAPPY_SCRIPT = [
  PLAN_REPLY,
  JSON.stringify({ passed: true, issues: [], summary: "骨架结构完整。" }),
  SAMPLE_STORY,
  JSON.stringify(SAMPLE_REVIEW),
  JSON.stringify(SAMPLE_COMMERCIAL_REVIEW),
];

describe("§34 手动装配：createDependencies → createStoryLoopApplication", () => {
  it("两行字装出一个能用的应用，依赖不是现 new 出来的魔法", async () => {
    withTmpDir();
    const fake = new FakeLLM(HAPPY_SCRIPT);

    // 就是任务书 §34 写的那两行，一行不多
    const deps = createDependencies({ llm: fake as never });
    const app = createStoryLoopApplication(deps);

    // 依赖里该有的东西都在，且都是端口/具体实现的正确搭配
    expect(deps.runsDir).toBeTruthy();
    expect(deps.run?.artifactStore).toBeInstanceOf(ArtifactStore);
    expect(deps.experiment?.artifactStore).toBe(deps.artifactStore);
    expect(deps.experiment?.experimentStore).toBeDefined();
    expect(deps.experiment?.generate).toBe(buildPipeline);
    expect(typeof deps.experiment?.providerProbe).toBe("function");
    // §30：生成路径的唯一正式入口就是它本身，不是另起的一套
    expect(app.generate).toBe(buildPipeline);

    // /api/plan 收的是「骨架本体的请求」（§19 DTO），不支持 {config} 包装
    const plan = await app.service.plan(SAMPLE_CONFIG as unknown as Record<string, unknown>);
    expect(plan.status).toBe(200);
    expect(plan.json).toBeTruthy();
  });

  it("装配好的应用能一路跑到底，产物落在 runsDir 下", async () => {
    withTmpDir();
    const fake = new FakeLLM(HAPPY_SCRIPT);
    const deps = createDependencies({ llm: fake as never });
    const app = createStoryLoopApplication(deps);

    const { status, json } = await app.service.generate({ config: SAMPLE_CONFIG });
    expect(status).toBe(200);
    const runId = (json as { run_id: string }).run_id;

    // §16：门面用的是装好的那个 store，不是自己另开的一个
    expect(readdirSync(join(deps.runsDir, runId))).toContain("story.md");
    expect(deps.artifactStore.runExists(runId)).toBe(true);
    expect(runScoresOf(runId, deps.artifactStore).overallScore).toBe(SAMPLE_REVIEW.score);
  });

  it("runsDir 与注入的 store 可以分开给：CLI / 测试的常用组合", async () => {
    withTmpDir();
    const fake = new FakeLLM(HAPPY_SCRIPT);
    const artifactStore = new ArtifactStore("my-runs");
    const deps = createDependencies({ llm: fake as never, runsDir: "my-runs", artifactStore });
    expect(deps.artifactStore).toBe(artifactStore);
    expect(deps.runsDir).toBe("my-runs");
  });
});

describe("§45/§46 能力与健康：真布尔，不带凭据", () => {
  it("配了密钥才说配了，没配就说 degraded，不假装健康", async () => {
    withTmpDir();
    vi.stubEnv("LLM_API_KEY", "  ");
    const degraded = createStoryLoop().health();
    expect(degraded.capabilities.llm_configured).toBe(false);
    expect(degraded.capabilities.storage_writable).toBe(true);
    expect(degraded.capabilities.experiments).toBe(true);
    expect(degraded.status).toBe("degraded");
    expect(degraded.version).toMatch(/^\d+\.\d+\.\d+$/);

    vi.stubEnv("LLM_API_KEY", "sk-" + "integration-not-a-real-credential");
    const ok = createStoryLoop().health();
    expect(ok.capabilities.llm_configured).toBe(true);
    expect(ok.status).toBe("ok");
  });

  it("报告里没有 API Key、没有 baseUrl、没有绝对路径", async () => {
    withTmpDir();
    const SECRET = "sk-" + "never-leak-me";
    vi.stubEnv("LLM_API_KEY", SECRET);
    vi.stubEnv("OPENAI_BASE_URL", "https://secret-endpoint.example.com/v1");

    const text = JSON.stringify(createStoryLoop().health());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("secret-endpoint.example.com");
    expect(text).not.toMatch(/[A-Za-z]:\\/);
  });

  it("GET /api/health 与 GET /api/version 走的是组装好的同一份应用", async () => {
    withTmpDir();
    vi.stubEnv("LLM_API_KEY", "");

    const health = await healthRoute();
    expect(health.status).toBe(200);
    const healthBody = JSON.parse(await health.text()) as {
      status: string;
      version: string;
      capabilities: Record<string, boolean>;
    };
    expect(healthBody.status).toBe("degraded");
    for (const value of Object.values(healthBody.capabilities)) {
      expect(typeof value).toBe("boolean");
    }

    const version = await versionRoute();
    const versionBody = JSON.parse(await version.text()) as { version: string };
    expect(versionBody.version).toBe(healthBody.version);
  });
});

describe("§31/§37 用例层的方法面：路由与 CLI 只用到这些入口", () => {
  it("门面上每个用例方法都能从组合根直接取到", async () => {
    withTmpDir();
    const check = async (label: string, run: () => Promise<{ status: number }>) => {
      const outcome = await run();
      expect(outcome.status, label).toBe(200);
    };

    // 每次调用单独一个假客户端：每个用例各自吃掉自己的脚本，互不挪用
    await check("plan", async () => createStoryLoop({ llm: new FakeLLM([PLAN_REPLY]) as never }).service.plan(SAMPLE_CONFIG as unknown as Record<string, unknown>));
    await check("generate", async () => createStoryLoop({ llm: new FakeLLM(HAPPY_SCRIPT) as never }).service.generate({ config: SAMPLE_CONFIG }));
    await check("generateFromPlan", async () =>
      createStoryLoop({ llm: new FakeLLM(HAPPY_SCRIPT.slice(1)) as never }).service.generateFromPlan({ config: SAMPLE_CONFIG, beat_plan: SAMPLE_BEAT_PLAN }),
    );
    await check("validate", async () => createStoryLoop({ llm: new FakeLLM([]) as never }).service.validate({ config: SAMPLE_CONFIG as unknown as Record<string, unknown>, story: SAMPLE_STORY }));
    await check("validateBeats", async () => createStoryLoop({ llm: new FakeLLM([JSON.stringify({ passed: true, issues: [], summary: "骨架结构完整。" })]) as never }).service.validateBeats({ config: SAMPLE_CONFIG as unknown as Record<string, unknown>, beat_plan: SAMPLE_BEAT_PLAN }));
    await check("review", async () => createStoryLoop({ llm: new FakeLLM([JSON.stringify(SAMPLE_REVIEW)]) as never }).service.review({ config: SAMPLE_CONFIG as unknown as Record<string, unknown>, story: SAMPLE_STORY }));
    await check("reviewCommercial", async () =>
      createStoryLoop({ llm: new FakeLLM([JSON.stringify(SAMPLE_COMMERCIAL_REVIEW)]) as never }).service.reviewCommercial({ config: SAMPLE_CONFIG as unknown as Record<string, unknown>, story: SAMPLE_STORY }),
    );
    await check("repair", async () => createStoryLoop({ llm: new FakeLLM([SAMPLE_STORY]) as never }).service.repair({
      config: SAMPLE_CONFIG as unknown as Record<string, unknown>,
      beat_plan: SAMPLE_BEAT_PLAN,
      story: SAMPLE_STORY,
      issue_type: "ending",
      issue_message: "故事缺少明确结局。",
    }));
    await check("previewPrompt", async () => createStoryLoop({ llm: new FakeLLM([]) as never }).service.previewPrompt({ config: SAMPLE_CONFIG }));
  });
});
