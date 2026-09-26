import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { analyzeStoredRun } from "@/lib/failure-analysis-service";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { RepairRequest, RepairResult } from "@/types/repair";
import type { FailureAnalysisResult, FailureEvidence } from "@/types/failure-analysis";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.9.0 §48/§51：失败分析这份产物自己站不站得住。
 *
 * 前三件事必须是真话，否则整份分析就没有意义：
 *   1. 每条证据都指向这个 Run 目录里真实存在的文件、真实存在的字段（§48）；
 *   2. 落盘的文件里没有任何凭据或 URL 里的账号口令（§51）；
 *   3. 样例 examples/example_run 里那份，与分析器对同一批产物现算的结果逐字节相同（§53）。
 *
 * 另外两件是这条链路的兜底：重试 / 修订耗尽要看真实计数（§38/§39），
 * 分析器或写盘自己出错时，一次成功的 Run 不许被拖失败（§29）。
 * 全部用 Fake 组件，绝不打真实付费 API。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

const plan: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
});

const review: ReviewResult = {
  score: 74,
  summary: "故事整体完整，主线清楚。",
  strengths: ["开篇冲突建立迅速"],
  problems: ["中段线索重复"],
};

const STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;
const REPAIRED = `修订后：${STORY}`;

const TOO_SHORT: ValidationResult = {
  passed: false,
  issues: [{ code: "TOO_SHORT", severity: "error", message: "正文长度 12 明显短于目标字数（下限 750）。" }],
};

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
  vi.restoreAllMocks();
});

function withTmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-failure-artifacts-"));
  process.chdir(tmp);
  return tmp;
}

function pipelineOf(
  gen: { generate: () => Promise<string> },
  val: { validate: () => Promise<ValidationResult> },
  rev: { review: () => Promise<ReviewResult> },
  policy = DEFAULT_RETRY_POLICY,
  rep?: { repair: (r: RepairRequest) => Promise<RepairResult> },
) {
  return new GenerationPipeline(
    { plan: async () => plan } as never,
    gen as never,
    val as never,
    rev as never,
    new ArtifactStore(),
    policy,
    rep as never,
  );
}

function analysisOf(dir: string, runId: string): FailureAnalysisResult {
  return JSON.parse(
    readFileSync(join(dir, "runs", runId, "failure-analysis.json"), "utf8"),
  ) as FailureAnalysisResult;
}

function metadataOf(dir: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "runs", runId, "metadata.json"), "utf8")) as Record<string, unknown>;
}

/** 这条证据说的字段，在那个产物里是不是真有这个东西。 */
function fieldExists(runDir: string, evidence: FailureEvidence): boolean {
  if (!evidence.sourceArtifact || !evidence.sourceField) return true; // 没指到具体字段的不强求
  const path = join(runDir, evidence.sourceArtifact);
  if (!existsSync(path)) return false;
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  switch (`${evidence.sourceArtifact}:${evidence.sourceField}`) {
    case "metadata.json:attempt_count":
      return typeof artifact.attempt_count === "number";
    case "metadata.json:quality_status":
      return typeof artifact.quality_status === "string";
    case "metadata.json:repair_count":
      return typeof artifact.repair_count === "number";
    case "validation.json:issues[].code":
      return Array.isArray(artifact.issues);
    case "beat-validation.json:issues[].code":
      return Array.isArray(artifact.issues);
    case "run-manifest.json:repairs[].succeeded":
      return Array.isArray(artifact.repairs);
    case "telemetry.json:failureCode":
      return true; // 失败码只在失败时才有；没有这一跳本身就是事实
    case "telemetry.json:failureStage":
      return true;
    default:
      throw new Error(
        `没见过证据字段 ${evidence.sourceArtifact}:${evidence.sourceField}——要么补用例，要么先确认它指的是什么`,
      );
  }
}

describe("v1.9.0 §48 证据指向真实存在的文件与字段", () => {
  it("校验失败 + 重试耗尽：每条证据都能在 Run 目录里对上", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      { generate: async () => STORY },
      { validate: async () => TOO_SHORT },
      { review: async () => review },
    ).run(config);
    const runDir = join(dir, "runs", result.run_id);
    const analysis = analysisOf(dir, result.run_id);

    // 至少要有正文校验与重试耗尽两组证据
    expect(analysis.evidence.length).toBeGreaterThanOrEqual(3);
    for (const evidence of analysis.evidence) {
      expect(
        !evidence.sourceArtifact || existsSync(join(runDir, evidence.sourceArtifact)),
        `${String(evidence.sourceArtifact)} 不在这个 Run 目录里`,
      ).toBe(true);
      expect(fieldExists(runDir, evidence), `${String(evidence.sourceField)} 指了个不存在的字段`).toBe(true);
    }

    // 正文校验那条：指到 validation.json 的 code，且值就是 TOO_SHORT
    const validationEvidence = analysis.evidence.find(
      (e) => e.sourceArtifact === "validation.json" && e.sourceField === "issues[].code",
    );
    expect(validationEvidence?.code).toBe("TOO_SHORT");
    // 重试耗尽那条：attempt_count 是真数出来的，不是默认值
    const attemptEvidence = analysis.evidence.find((e) => e.sourceField === "attempt_count");
    expect(attemptEvidence?.value).toBe(result.attempt_count);
    expect(attemptEvidence?.value).toBe(2);
  });

  it("§38/§44 次要类别同样是重试耗尽：primary 是正文校验，secondary 是重试次数用尽", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      { generate: async () => STORY },
      { validate: async () => TOO_SHORT },
      { review: async () => review },
    ).run(config);
    const analysis = analysisOf(dir, result.run_id);

    expect(result.quality_status).toBe("exhausted");
    expect(analysis.primaryCategory).toBe("VALIDATION");
    expect(analysis.secondaryCategories).toEqual(["RETRY_EXHAUSTION"]);
    expect(analysis.signals.map((s) => s.code)).toContain("RETRY_LIMIT_REACHED");
    // 摘要只陈述事实：两个类别都点名，且不说「为什么」
    expect(analysis.summary).toContain("正文校验问题（VALIDATION）");
    expect(analysis.summary).toContain("重试次数用尽（RETRY_EXHAUSTION）");
  });

  it("§39 修订耗尽：证据里的修订次数与 metadata 对得上", async () => {
    const dir = withTmpDir();
    const result = await pipelineOf(
      { generate: async () => STORY },
      { validate: async () => TOO_SHORT },
      { review: async () => review },
      { ...DEFAULT_RETRY_POLICY, max_attempts: 1, max_repairs_per_attempt: 1 },
      {
        repair: async (request: RepairRequest): Promise<RepairResult> => ({
          repaired_story: REPAIRED,
          issue_type: request.issue_type,
          success: true,
          notes: null,
        }),
      },
    ).run(config);
    const runDir = join(dir, "runs", result.run_id);
    const meta = metadataOf(dir, result.run_id);
    const analysis = analysisOf(dir, result.run_id);

    // 一次修订、还是同一个问题：这是「修订耗尽」的事实依据
    expect(meta.repair_count).toBe(1);
    expect(analysis.signals.map((s) => s.code)).toContain("REPAIR_LIMIT_REACHED");
    expect(analysis.secondaryCategories).toContain("REPAIR_EXHAUSTION");
    const repairEvidence = analysis.evidence.find((e) => e.sourceField === "repair_count");
    expect(repairEvidence?.value).toBe(1);
    const manifestEvidence = analysis.evidence.find(
      (e) => e.sourceArtifact === "run-manifest.json" && e.sourceField === "repairs[].succeeded",
    );
    expect(manifestEvidence).toBeDefined();
    expect(fieldExists(runDir, manifestEvidence as FailureEvidence)).toBe(true);
    // 修订轮次在 manifest 里也能数出来，不是只有一个说法
    const manifest = JSON.parse(
      readFileSync(join(runDir, "run-manifest.json"), "utf8"),
    ) as { repairs?: unknown[] };
    expect(Array.isArray(manifest.repairs)).toBe(true);
  });
});

describe("v1.9.0 §51 落盘的分析里没有凭据", () => {
  it("异常消息里带着令牌与 URL 口令，failure-analysis.json 里一个都不出现", async () => {
    const dir = withTmpDir();
    // 两个假值：形状照真的写，内容一看就是编的（也绝不该是真东西）
    const fakeToken = "假令牌_" + "甲乙丙丁戊己庚辛";
    const fakePassword = "假口令_" + "一二三四五六";
    let runId = "";
    try {
      await pipelineOf(
        {
          generate: async () => {
            throw new Error(
              `请求失败：https://用户:${fakePassword}@api.invalid/v1/chat 返回 401，Authorization: Bearer ${fakeToken}`,
            );
          },
        },
        { validate: async () => ({ passed: true, issues: [] }) },
        { review: async () => review },
      ).run(config);
      throw new Error("这次 Run 本该失败");
    } catch (e) {
      runId = (e as { runId?: string }).runId ?? "";
    }
    expect(runId).not.toBe("");

    const text = readFileSync(join(dir, "runs", runId, "failure-analysis.json"), "utf8");
    for (const secret of [fakeToken, fakePassword, "api.invalid", "Bearer"]) {
      expect(text, `failure-analysis.json 里出现了 ${secret}`).not.toContain(secret);
    }
    // 也不该冒出任何像凭据的键名
    expect(text).not.toMatch(/api[_-]?key|authorization|cookie|password|token/i);

    // 但失败本身没被抹掉：码与阶段都还在
    const analysis = analysisOf(dir, runId);
    expect(analysis.status).not.toBe("none");
    expect(analysis.firstFailureStage).toBe("generating");
  });
});

describe("v1.9.0 §29 分析自己出错不许拖垮一次成功的 Run", () => {
  it("写盘失败：Run 照常 completed，metadata 记 unavailable，不编类别", async () => {
    const dir = withTmpDir();
    vi.spyOn(ArtifactStore.prototype, "putFailureAnalysis").mockImplementation(() => {
      throw new Error("磁盘只读");
    });
    const result = await pipelineOf(
      { generate: async () => STORY },
      { validate: async () => ({ passed: true, issues: [] }) },
      { review: async () => review },
    ).run(config);

    expect(result.status).toBe("completed");
    expect(result.story).toContain("陈岚");
    // 盘上确实没有那份文件
    expect(existsSync(join(dir, "runs", result.run_id, "failure-analysis.json"))).toBe(false);
    const meta = metadataOf(dir, result.run_id);
    expect(meta.failure_analysis_status).toBe("unavailable");
    // 没有类别可写就整个键不出现，不拿一个类别占位
    expect("primary_failure_category" in meta).toBe(false);
    // 读的人拿到 null：旧 Run、损坏文件、没写成功，一律是「没有这份分析」
    expect(new ArtifactStore("runs").readFailureAnalysis(result.run_id)).toBeNull();
    void dir;
  });

  it("读不到 metadata 时也只留告警：Run 照常 completed", async () => {
    withTmpDir();
    vi.spyOn(ArtifactStore.prototype, "readRunMetadata").mockImplementation(() => {
      throw new Error("读不出来");
    });
    const result = await pipelineOf(
      { generate: async () => STORY },
      { validate: async () => ({ passed: true, issues: [] }) },
      { review: async () => review },
    ).run(config);
    expect(result.status).toBe("completed");
    expect(result.review).toEqual(review);
  });
});

describe("v1.9.0 §53 样例 Run 与分析器现算的结果一致", () => {
  it("examples/example_run/failure-analysis.json 就是鲜活分析的结果", () => {
    const store = new ArtifactStore(join(repoRoot(), "examples"));
    const fresh = analyzeStoredRun("example_run", store);
    const onDisk = JSON.parse(
      readFileSync(join(repoRoot(), "examples", "example_run", "failure-analysis.json"), "utf8"),
    ) as FailureAnalysisResult;
    expect(fresh).toEqual(onDisk);
    // 这个样例的 none 是算出来的，不是手写的：盘上那份没有信号
    expect(onDisk.status).toBe("none");
    expect(onDisk.signals).toEqual([]);
    // 读接口对这份样例也给同一份东西
    expect(store.readFailureAnalysis("example_run")).toEqual(onDisk);
  });

  it("样例目录里只有冻结的那批文件，没有多余产物", () => {
    const files = readdirSync(join(repoRoot(), "examples", "example_run")).sort();
    expect(files).toEqual([
      "README.md",
      "attempts",
      "beat-validation.json",
      "beats.json",
      "commercial-review.json",
      "config.json",
      "failure-analysis.json",
      "metadata.json",
      "quality.json",
      "review.json",
      "run-manifest.json",
      "story.md",
      "telemetry.json",
      "validation.json",
    ]);
  });
});
