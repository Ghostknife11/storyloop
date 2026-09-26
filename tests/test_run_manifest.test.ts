import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { GenerationPipeline } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { buildRunManifest, DEFAULT_MODEL_SLOT } from "@/lib/tracking/manifest-builder";
import {
  PROMPT_VERSIONS,
  promptFileNameOf,
  promptSnapshots,
  readPromptText,
} from "@/lib/tracking/prompt-registry";
import { sha256Hex } from "@/lib/tracking/digest";
import { projectSnapshot } from "@/lib/tracking/project-snapshot";
import {
  RUN_MANIFEST_SCHEMA_VERSION,
  runManifestOf,
  validateRunManifest,
  type RunManifest,
} from "@/types/run-manifest";
import { experimentProvenanceText, manifestPanelState, shortDigest, temperatureRowsOf } from "@/lib/manifest-view";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION,
  SAMPLE_COMMERCIAL_REVIEW,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  FakeLLM,
  repoRoot,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.6.0 TASK — Run & Version Tracking。
 *
 * 这份测试只验证「出身清单」这一件事，分四层：
 *
 * 1. 形状与校验：schemaVersion、camelCase 键、坏数据的两种读法（抛 / 不抛）；
 * 2. 真实 Pipeline 落盘的 run-manifest.json：内容、摘要、attempts、不含凭据；
 * 3. 与 v1.0.0 冻结的 metadata 契约隔离：清单不改 metadata 的任何字段；
 * 4. 旧 Run 兼容：没有清单时读接口给 null、面板隐藏、磁盘不补写。
 *
 * 全部用例只用 FakeLLM / 假组件与合成样例，不调任何真实模型接口。
 */

/** 运行级固定文件名（v1.0.0 冻结，v1.6.0 追加 run-manifest.json，v1.8.0 追加 telemetry.json）。 */
const RUN_FILES = [
  "beat-validation.json",
  "beats.json",
  "commercial-review.json",
  "config.json",
  "metadata.json",
  "quality.json",
  "review.json",
  "run-manifest.json",
  "story.md",
  "telemetry.json",
  "validation.json",
] as const;

const RUN_MANIFEST_FILE = "run-manifest.json";

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify(SAMPLE_REVIEW);
const COMMERCIAL_REPLY = JSON.stringify(SAMPLE_COMMERCIAL_REVIEW);
const LOW_REVIEW = JSON.stringify({
  score: 41,
  summary: "正文冲突没有展开。",
  strengths: ["开头有画面"],
  problems: ["高潮缺失"],
});
/** 修订后的正文：与 SAMPLE_STORY 同量级，且带着主角名字，否则重新校验当场就不过。 */
const REPAIRED_STORY = `陈岚在雨夜找到了证人，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

function pipelineWith(llm: FakeLLM, store: ArtifactStore, policy?: RetryPolicy) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator() as never,
    new BasicReviewer(client) as never,
    store,
    policy,
    new StoryRepairer(client),
    new RepairStrategy(),
    undefined,
    undefined,
    { validate: async () => SAMPLE_BEAT_VALIDATION } as never,
    new CommercialReviewer(new FakeLLM([COMMERCIAL_REPLY]) as never) as never,
  );
}

/** 跑一次真 Pipeline（只有 LLM / 校验 / 审阅是假的），返回 run 目录与落盘的清单。 */
async function runWith(replies: string[], policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  const store = new ArtifactStore(withTmpDir());
  const llm = new FakeLLM(replies);
  const result = await pipelineWith(llm, store, policy).run(SAMPLE_CONFIG);
  const manifestPath = join(store.resolveRunDir(result.run_id), RUN_MANIFEST_FILE);
  return {
    result,
    store,
    manifestPath,
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest,
  };
}

describe("v1.6.0 出身清单 — 形状与校验", () => {
  it("schemaVersion 是 \"1\"，六个提示词角色各一条且都能算出摘要", () => {
    expect(RUN_MANIFEST_SCHEMA_VERSION).toBe("1");
    const snapshots = promptSnapshots();
    expect(snapshots.map((s) => s.role)).toEqual([
      "planner",
      "generator",
      "beat-validator",
      "reviewer",
      "commercial-reviewer",
      "repairer",
    ]);
    for (const snapshot of snapshots) {
      expect(snapshot.version).toBe("1");
      expect(snapshot.version).toBe(PROMPT_VERSIONS[snapshot.role]);
      expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("prompt 摘要就是提示词原文的 sha256", () => {
    for (const role of Object.keys(PROMPT_VERSIONS) as Array<keyof typeof PROMPT_VERSIONS>) {
      const text = readPromptText(role);
      expect(text, `${promptFileNameOf(role)} 应当存在`).not.toBeNull();
      expect(sha256Hex(text as string)).toBe(
        promptSnapshots().find((s) => s.role === role)?.digest,
      );
    }
  });

  it("project 快照带版本号，且不会为了填满字段去跑 git", () => {
    const snapshot = projectSnapshot();
    expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(snapshot).every((key) => key === "version" || key === "commit")).toBe(true);
  });

  it("坏清单两种读法：validateRunManifest 抛，runManifestOf 给 null", () => {
    expect(() => validateRunManifest({ nope: true })).toThrow();
    expect(runManifestOf({ nope: true })).toBeNull();
    expect(runManifestOf(null)).toBeNull();
    expect(runManifestOf("string")).toBeNull();
    expect(runManifestOf([])).toBeNull();
    const good = validateRunManifest({
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId: "20260925_101530_abc123",
      project: { version: "1.6.0" },
      models: {},
      prompts: [],
      parameters: {
        generation: { temperature: 0.8 },
        planning: { temperature: 0.7 },
        review: { temperature: 0.3 },
        commercialReview: { temperature: 0.3 },
        beatValidation: { temperature: 0.2 },
        repair: { temperature: 0.5 },
        retry: {
          maxAttempts: 3,
          minReviewScore: 70,
          retryOnValidationFailure: true,
          enableRepair: true,
          maxRepairsPerAttempt: 2,
        },
      },
      storyConfigRef: "config.json",
      attempts: [],
      repairs: [],
      artifacts: [],
      startedAt: "2026-09-25T10:15:30.000Z",
      completedAt: "2026-09-25T10:20:00.000Z",
    });
    expect(good.runId).toBe("20260925_101530_abc123");
  });

  it("写坏的 JSON 进 ArtifactStore，读回来是 null，不是 500", () => {
    const store = new ArtifactStore(withTmpDir());
    const runId = "20260925_101530_broken1";
    const runDir = store.resolveRunDir(runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, RUN_MANIFEST_FILE), "{ 这不是 JSON", "utf8");
    expect(existsSync(join(runDir, RUN_MANIFEST_FILE))).toBe(true);
    expect(store.readRunManifest(runId)).toBeNull();
  });
});

describe("v1.6.0 出身清单 — 真实 Pipeline 的落盘结果", () => {
  it("Run 根目录多一个 run-manifest.json", async () => {
    const { manifestPath } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("运行级固定文件正好十一个，run-manifest.json 是其中之一", async () => {
    const { store, result } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const runDir = store.resolveRunDir(result.run_id);
    expect(readdirSync(runDir).filter((name) => !name.startsWith(".")).sort()).toEqual(
      ["attempts", ...RUN_FILES].sort(),
    );
    expect(RUN_FILES).toContain(RUN_MANIFEST_FILE);
  });

  it("attempts/ 与 repairs/ 下没有第二份清单", async () => {
    const { store, result } = await runWith([
      PLAN_REPLY,
      SAMPLE_STORY,
      LOW_REVIEW,
      REPAIRED_STORY,
      GOOD_REVIEW,
    ]);
    const runDir = store.resolveRunDir(result.run_id);
    expect(readdirSync(join(runDir, "attempts")).sort()).toEqual(["01"]);
    expect(readdirSync(join(runDir, "attempts", "01")).filter((n) => n === RUN_MANIFEST_FILE)).toEqual([]);
    expect(readdirSync(join(runDir, "attempts", "01", "repairs")).sort()).toEqual(["01"]);
    expect(
      readdirSync(join(runDir, "attempts", "01", "repairs", "01")).filter((n) => n === RUN_MANIFEST_FILE),
    ).toEqual([]);
  });

  it("清单不登记自己，也不登记任何 metadata.json", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const paths = manifest.artifacts.map((a) => a.path);
    expect(paths).not.toContain(RUN_MANIFEST_FILE);
    expect(paths.filter((p) => p.endsWith("metadata.json"))).toEqual([]);
  });

  it("每个登记产物的摘要都与磁盘逐字节一致", async () => {
    const { store, result, manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    expect(manifest.artifacts.length).toBeGreaterThan(5);
    for (const entry of manifest.artifacts) {
      expect(entry.sha256, `${entry.path} 应有摘要`).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sha256, `${entry.path} 的摘要应与磁盘一致`).toBe(
        sha256Hex(readFileSync(join(store.resolveRunDir(result.run_id), entry.path), "utf8")),
      );
    }
  });

  it("根目录 story.md 与 attempt 级那份摘要相同（promote 不变式在清单里也成立）", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const root = manifest.artifacts.find((a) => a.path === "story.md");
    const attemptLevel = manifest.artifacts.find((a) => a.path === "attempts/01/story.md");
    expect(root?.sha256).toBeTruthy();
    expect(root?.sha256).toBe(attemptLevel?.sha256);
  });

  it("没发生的尝试与没跑过的阶段不写占位行", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const paths = manifest.artifacts.map((a) => a.path);
    expect(paths).not.toContain("attempts/02/story.md");
    expect(paths).not.toContain("attempts/01/repairs/01/story.md");
    expect(paths).not.toContain("attempts/01/initial_story.md");
    expect(manifest.attempts.map((a) => a.attemptId)).toEqual(["01"]);
    expect(manifest.repairs).toEqual([]);
  });

  it("attempts 记录每次尝试的结局；入选只有一个", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, SAMPLE_STORY, GOOD_REVIEW], {
      ...DEFAULT_RETRY_POLICY,
      max_attempts: 2,
      enable_repair: false,
    });
    expect(manifest.attempts.map((a) => a.attemptId)).toEqual(["01", "02"]);
    expect(manifest.attempts.map((a) => a.index)).toEqual([1, 2]);
    expect(manifest.attempts.map((a) => a.status)).toEqual(["not_accepted", "accepted"]);
    expect(manifest.attempts[0].retryReason).toBe("review_score_below_threshold");
    expect(manifest.attempts[1].retryReason).toBeNull();
    expect(manifest.selectedAttemptId).toBe("02");
  });

  it("repairs 记录修订轮次、吃进哪份正文、吐出哪份正文", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, REPAIRED_STORY, GOOD_REVIEW]);
    expect(manifest.repairs.length).toBe(1);
    const repair = manifest.repairs[0];
    expect(repair.repairId).toBe("01");
    expect(repair.attemptId).toBe("01");
    expect(repair.succeeded).toBe(true);
    expect(repair.inputStoryArtifact).toBe("attempts/01/initial_story.md");
    expect(repair.outputStoryArtifact).toBe("attempts/01/repairs/01/story.md");
    expect(manifest.attempts[0].repairIds).toEqual([repair.repairId]);
    expect(manifest.selectedRepairId).toBe("01");
  });

  it("参数快照带六项 temperature 与 RetryPolicy 回显", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW], {
      ...DEFAULT_RETRY_POLICY,
      max_attempts: 3,
      min_review_score: 71,
      enable_repair: false,
    });
    expect(manifest.parameters.generation.temperature).toBe(0.8);
    expect(manifest.parameters.planning.temperature).toBe(0.7);
    expect(manifest.parameters.review.temperature).toBe(0.3);
    expect(manifest.parameters.commercialReview.temperature).toBe(0.3);
    expect(manifest.parameters.beatValidation.temperature).toBe(0.2);
    expect(manifest.parameters.repair.temperature).toBe(0.5);
    expect(manifest.parameters.retry).toMatchObject({
      maxAttempts: 3,
      minReviewScore: 71,
      enableRepair: false,
    });
  });

  it("模型条目只记模型名 / provider / baseUrl 分类，baseUrl 原文不落盘", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const slots = Object.keys(manifest.models);
    expect(slots).toContain(DEFAULT_MODEL_SLOT);
    for (const slot of slots) {
      const entry = manifest.models[slot];
      expect(Object.keys(entry).sort()).toEqual(
        ["baseUrlClass", "model", "provider"].filter((k) => k in entry).sort(),
      );
      expect(["server-configured", "request-public-override"]).toContain(entry.baseUrlClass);
      expect(entry.model).toBeTruthy();
    }
  });

  it("客户端没有下发的 topP / maxTokens 不进清单", async () => {
    const { manifestPath } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const raw = readFileSync(manifestPath, "utf8");
    expect(raw).not.toContain("topP");
    expect(raw).not.toContain("maxTokens");
    expect(raw.toLowerCase()).not.toContain("top_p");
  });

  it("TASK §68：清单里不出现任何凭据样式的东西", async () => {
    const { manifestPath } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const raw = readFileSync(manifestPath, "utf8");
    const secretPatterns = [
      /sk-[A-Za-z0-9]{16,}/,
      /AKIA[0-9A-Z]{12,}/,
      /ghp_[A-Za-z0-9]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /["']?(api[_-]?key|secret|token|password|authorization)["']?\s*[:=]\s*["'][^"']{8,}["']/i,
      /https?:\/\/(?:[^/@\s]*@)[^\s"']+/,
    ];
    for (const pattern of secretPatterns) {
      expect(pattern.test(raw), `清单不应出现 ${pattern}`).toBe(false);
    }
  });

  it("失败路径也写清单，且没有入选 Attempt", async () => {
    const store = new ArtifactStore(withTmpDir());
    const llm = new FakeLLM([PLAN_REPLY]);
    llm.failNextWith(new Error("generation boom"));
    let runId = "";
    try {
      await pipelineWith(llm, store).run(SAMPLE_CONFIG);
      throw new Error("这一条路径本该失败");
    } catch (e) {
      runId = (e as { runId?: string }).runId ?? "";
    }
    expect(runId).not.toBe("");
    expect(existsSync(join(store.resolveRunDir(runId), RUN_MANIFEST_FILE))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(store.resolveRunDir(runId), RUN_MANIFEST_FILE), "utf8"),
    ) as RunManifest;
    expect(manifest.selectedAttemptId).toBeUndefined();
    // 死在规划阶段：一次 Attempt 都没跑起来，清单如实列空
    expect(manifest.attempts).toEqual([]);
    expect(manifest.repairs).toEqual([]);
  });

  it("写清单这一步自身失败不会让 Run 失败，只是 manifest 为 null", async () => {
    const store = new ArtifactStore(withTmpDir());
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    (store as unknown as { putManifest: () => never }).putManifest = () => {
      throw new Error("disk full");
    };
    const result = await pipelineWith(llm, store).run(SAMPLE_CONFIG);
    expect(result.status).toBe("completed");
    expect(result.manifest).toBeNull();
    expect(existsSync(join(store.resolveRunDir(result.run_id), "story.md"))).toBe(true);
    expect(existsSync(join(store.resolveRunDir(result.run_id), "quality.json"))).toBe(true);
  });

  it("清单写进去的就是校验过的那一份（读回来形状不变）", async () => {
    const { store, result, manifestPath, manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    expect(validateRunManifest(manifest)).toEqual(manifest);
    expect(store.readRunManifest(result.run_id)).toMatchObject({
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId: manifest.runId,
    });
    expect(readFileSync(manifestPath, "utf8")).toContain(RUN_MANIFEST_SCHEMA_VERSION);
  });
});

describe("v1.6.0 出身清单 — 与 metadata 契约隔离", () => {
  it("清单没有借道改 metadata：字段集一个没多一个没少", async () => {
    const { store, result } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const runDir = store.resolveRunDir(result.run_id);
    const metadata = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as Record<string, unknown>;
    const manifest = JSON.parse(readFileSync(join(runDir, RUN_MANIFEST_FILE), "utf8")) as Record<string, unknown>;
    expect(Object.keys(metadata).length).toBeGreaterThan(25);
    expect(metadata).not.toHaveProperty("manifest");
    expect(metadata).not.toHaveProperty("schemaVersion");
    // 唯一同名的是 artifacts：两边形状不同（metadata 是 逻辑键→文件名 的映射，清单是带摘要的数组）
    const overlap = Object.keys(metadata).filter((key) => key in manifest);
    expect(overlap).toEqual(["artifacts"]);
    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(Array.isArray(metadata.artifacts)).toBe(false);
  });

  it("清单是 camelCase，metadata 仍是 snake_case", async () => {
    const { store, result, manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const camel = /^[a-z][a-zA-Z0-9]*$/;
    for (const key of Object.keys(manifest)) {
      expect(camel.test(key), `清单字段 ${key} 应为 camelCase`).toBe(true);
    }
    expect(Object.keys(manifest.models).every((slot) => camel.test(slot))).toBe(true);
    const metadata = JSON.parse(
      readFileSync(join(store.resolveRunDir(result.run_id), "metadata.json"), "utf8"),
    ) as object;
    expect(Object.keys(metadata).every((key) => /^[a-z][a-z0-9_]*$/.test(key))).toBe(true);
  });

  it("metadata 仍是 v1.5.2 那一套字段（清单没有新的挂点）", async () => {
    const { store, result } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const metadata = JSON.parse(
      readFileSync(join(store.resolveRunDir(result.run_id), "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const field of [
      "run_id",
      "project_version",
      "status",
      "model",
      "quality_status",
      "artifacts",
      "commercial_review_status",
    ]) {
      expect(metadata, `metadata 仍应有 ${field}`).toHaveProperty(field);
    }
  });

  it("合成本样例的清单与磁盘逐字节对得上", () => {
    const exampleRoot = join(repoRoot(), "examples", "example_run");
    const manifest = JSON.parse(readFileSync(join(exampleRoot, RUN_MANIFEST_FILE), "utf8")) as RunManifest;
    expect(manifest.schemaVersion).toBe(RUN_MANIFEST_SCHEMA_VERSION);
    expect(manifest.project.version).toBe("1.6.0");
    const metadata = JSON.parse(readFileSync(join(exampleRoot, "metadata.json"), "utf8")) as {
      project_version: string;
    };
    expect(metadata.project_version).toBe("1.6.0");
    expect(manifest.artifacts.length).toBeGreaterThan(10);
    for (const entry of manifest.artifacts) {
      expect(entry.sha256, `${entry.path} 的摘要应与磁盘一致`).toBe(
        sha256Hex(readFileSync(join(exampleRoot, entry.path), "utf8")),
      );
    }
    const digests = new Set(
      manifest.artifacts.filter((a) => a.path.endsWith("story.md")).map((a) => a.sha256),
    );
    expect(digests.size, "同一份正文的各处副本摘要应相同").toBe(1);
  });
});

describe("v1.6.0 出身清单 — 旧 Run 与界面兜底", () => {
  it("没有 run-manifest.json 的 Run：读回来是 null，磁盘不补写", () => {
    const store = new ArtifactStore(withTmpDir());
    const runId = "20260101_120000_legacy";
    store.putStory(runId, "旧 Run", "旧版本写的正文。");
    expect(store.readRunManifest(runId)).toBeNull();
    expect(existsSync(join(store.resolveRunDir(runId), RUN_MANIFEST_FILE))).toBe(false);
  });

  it("模型槽位缺省名是 default；组装器不把 baseUrl 写进清单", () => {
    expect(DEFAULT_MODEL_SLOT).toBe("default");
    const store = new ArtifactStore(withTmpDir());
    const runId = "20260925_101530_slots1";
    store.putStory(runId, "占位", "正文。");
    const manifest = buildRunManifest(
      {
        runId,
        startedAt: "2026-09-25T10:15:30.000Z",
        runtime: { model: "gpt-4o-mini", baseUrl: "https://api.example.com/v1" },
        policy: DEFAULT_RETRY_POLICY,
        attempts: [],
        selectedAttemptNumber: null,
      },
      store,
      () => new Date("2026-09-25T10:20:00.000Z"),
    );
    expect(Object.keys(manifest.models)).toContain(DEFAULT_MODEL_SLOT);
    expect(manifest.models[DEFAULT_MODEL_SLOT].model).toBe("gpt-4o-mini");
    expect(manifest.models[DEFAULT_MODEL_SLOT].baseUrlClass).toBe("request-public-override");
    expect(validateRunManifest(manifest).runId).toBe(runId);
    expect(JSON.stringify(manifest)).not.toContain("api.example.com");
    expect(manifest.artifacts.map((a) => a.path)).toEqual(["story.md"]);
  });

  it("视图层：面板只看清单在不在，摘要截断，温度六行", async () => {
    const { manifest } = await runWith([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    expect(manifestPanelState(manifest).kind).toBe("ready");
    expect(manifestPanelState(null).kind).toBe("hidden");
    expect(manifestPanelState(undefined).kind).toBe("hidden");
    expect(shortDigest(manifest.prompts[0].digest)).toBe(manifest.prompts[0].digest?.slice(0, 12));
    expect(shortDigest(undefined)).toBeNull();
    expect(temperatureRowsOf(manifest).length).toBe(6);
  });

  it("视图层：实验样本的出身一行文字，普通 Run 没有这一行（v1.7.1 补的展示）", () => {
    const skeleton = {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId: "20260926_101500_expsmp",
      project: { version: "1.7.1" },
      models: {},
      prompts: [],
      parameters: {
        generation: { temperature: 0.8 },
        planning: { temperature: 0.7 },
        review: { temperature: 0.3 },
        commercialReview: { temperature: 0.3 },
        beatValidation: { temperature: 0.2 },
        repair: { temperature: 0.5 },
        retry: {
          maxAttempts: 3,
          minReviewScore: 70,
          retryOnValidationFailure: true,
          enableRepair: true,
          maxRepairsPerAttempt: 2,
        },
      },
      storyConfigRef: "config.json",
      attempts: [],
      repairs: [],
      artifacts: [],
      startedAt: "2026-09-26T10:15:00.000Z",
      completedAt: "2026-09-26T10:20:00.000Z",
    };

    // v1.6.0 的清单没有 experiment 块 → 不摆这一行
    expect(experimentProvenanceText(validateRunManifest(skeleton))).toBeNull();
    // v1.7.0 起实验样本带这个块 → 一行「它属于谁」，不带任何排名语义
    const sample = validateRunManifest({
      ...skeleton,
      experiment: { experimentId: "exp-ab-001", variantId: "model-b", repetition: 2 },
    });
    expect(experimentProvenanceText(sample)).toBe("experiment exp-ab-001 · variant model-b · repetition 2");
  });

  it("sha256Hex 与 node 的 crypto 逐字节一致", () => {
    const text = "同一段文本";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    expect(sha256Hex("")).toBe(createHash("sha256").update("", "utf8").digest("hex"));
  });
});
