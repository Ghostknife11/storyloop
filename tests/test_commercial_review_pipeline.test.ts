import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline, PipelineError } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { CommercialReviewer } from "@/lib/commercial-reviewer";
import type { CommercialReviewResult } from "@/types/commercial-review";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_STORY,
  FakeLLM,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.5.0 商业可读性审阅在真实管道里的落点（TASK §13/§16/§17/§18/§24/§39/§15）。
 *
 * 真组件跑真 Pipeline，只有 LLM 是假的（§66 绝不调用付费 API）。重点验证九件事：
 *   1. Run 根目录与 attempt 目录各落一份 commercial-review.json，内容逐字相同；
 *   2. 根目录那份描述的是**入选 Attempt** 的正文——重试时不张冠李戴；
 *   3. 修订发生在商业审阅之前，所以磁盘上那份描述的是修订后的正文；
 *   4. repairs/NN/ 下没有 commercial-review.json；
 *   5. metadata 派生 commercial_review_status / commercial_score；
 *   6. 商业审阅者自身抛异常：这一路 failed，故事 / 校验 / 质量结论一个都不丢；
 *   7. 商业分再低也不触发重试、不触发修订（§15）；
 *   8. 没注入 CommercialReviewer 时这一步等于不存在（§5）；
 *   9. 商业审阅不改写 validation.json / review.json / quality.json 的任何一个字段。
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify({
  score: 82,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
});
const LOW_REVIEW = JSON.stringify({
  score: 41,
  summary: "正文冲突没有展开。",
  strengths: ["开头有画面"],
  problems: ["高潮缺失"],
});

const COMMERCIAL_HIGH = JSON.stringify({
  score: 88,
  summary: "开篇即冲突，全篇有推力。",
  strengths: ["第一段抛出悬念"],
  problems: [],
  suggestions: ["中段压缩一轮排查"],
  dimensions: {
    hook: { score: 90, summary: "开场即冲突。" },
    pacing: { score: 86, summary: "节奏稳。" },
    engagement: { score: 88, summary: "动力持续。" },
    payoff: { score: 88, summary: "回报到位。" },
  },
});

/** 结构分很高、商业分很低的结论：用来证明商业分不驱动任何自动动作。 */
const COMMERCIAL_LOW = JSON.stringify({
  score: 12,
  summary: "四维都很低。",
  strengths: [],
  problems: ["开篇太平", "中段拖", "动力断", "结尾空"],
  suggestions: ["重写开篇"],
  dimensions: {
    hook: { score: 20, summary: "开篇没有抓力。" },
    pacing: { score: 10, summary: "大量原地踏步。" },
    engagement: { score: 8, summary: "中段读不下去。" },
    payoff: { score: 10, summary: "结尾没有回报。" },
  },
});

/** 一次 spy 版的商业审阅者：记录它收到的正文，原样返回固定结论。 */
function spyReviewer(
  reply: unknown = JSON.parse(COMMERCIAL_HIGH) as CommercialReviewResult,
): { reviewer: CommercialReviewer; seen: string[] } {
  const seen: string[] = [];
  const reviewer = new CommercialReviewer({
    generate: async (prompt: string) => {
      // prompt 里含 {{story}} 展开后的正文，这里整份记下来，只关心「评的是哪一版」
      seen.push(prompt);
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  } as never);
  return { reviewer, seen };
}

function pipelineWith(
  llm: FakeLLM,
  store: ArtifactStore,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  commercialReviewer?: CommercialReviewer,
) {
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    new StoryValidator(),
    new BasicReviewer(client),
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
    // 后面三槽按顺序是 qualityAssembler / projectVersion / beatValidator，都走默认值或留空；
    // 商业审阅者是第 12 个参数（§12：两个审阅者并列，各拿各的结论）
    undefined,
    undefined,
    undefined,
    commercialReviewer,
  );
}

function runDirOf(dir: string, runId: string): string {
  return join(dir, "runs", runId);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("v1.5.0 Happy Path：两份 commercial-review.json 一致（§16/§17）", () => {
  it("Run 根目录与 attempts/01 各一份，内容逐字相同，SCHEMA 合法", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, spyReviewer().reviewer).run(
      SAMPLE_CONFIG,
    );

    const rootFile = join(runDirOf(dir, result.run_id), "commercial-review.json");
    const attemptFile = join(runDirOf(dir, result.run_id), "attempts", "01", "commercial-review.json");
    expect(existsSync(rootFile)).toBe(true);
    expect(existsSync(attemptFile)).toBe(true);
    // §39：根目录那份是入选 Attempt 的副本，两个字节都不能差
    expect(readFileSync(rootFile, "utf8")).toBe(readFileSync(attemptFile, "utf8"));

    const parsed = JSON.parse(readFileSync(rootFile, "utf8")) as CommercialReviewResult;
    expect(parsed.score).toBe(88);
    expect(result.commercial_review).toEqual(parsed);
    expect(result.commercial_review_status).toBe("completed");
  });

  it("metadata 派生 commercial_review_status=completed 与 commercial_score=88，artifacts 多一个索引", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, spyReviewer().reviewer).run(
      SAMPLE_CONFIG,
    );

    const meta = readJson(join(runDirOf(dir, result.run_id), "metadata.json"));
    expect(meta.commercial_review_status).toBe("completed");
    expect(meta.commercial_score).toBe(88);
    expect(meta.commercial_review_error).toBeUndefined();
    expect((meta.artifacts as Record<string, string>).commercial_review).toBe("commercial-review.json");
  });

  it("商业审阅跑在结构审阅之后：这一步拿到的就是这一步的正文", async () => {
    withTmpDir();
    const { reviewer, seen } = spyReviewer();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, reviewer).run(SAMPLE_CONFIG);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(SAMPLE_STORY);
  });

  it("修复目录下没有 commercial-review.json：一次尝试只跑一次商业审阅", async () => {
    const dir = withTmpDir();
    const repaired = `${SAMPLE_STORY}\n\n陈岚在法庭上见到了证人。`;
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, repaired, GOOD_REVIEW]);
    const result = await pipelineWith(
      llm,
      new ArtifactStore(),
      DEFAULT_RETRY_POLICY,
      spyReviewer().reviewer,
    ).run(SAMPLE_CONFIG);

    expect(existsSync(join(runDirOf(dir, result.run_id), "attempts", "01", "repairs", "01"))).toBe(true);
    expect(
      existsSync(join(runDirOf(dir, result.run_id), "attempts", "01", "repairs", "01", "commercial-review.json")),
    ).toBe(false);
  });

  it("修订发生在商业审阅之前：磁盘上那份描述修订后的正文（§18）", async () => {
    withTmpDir();
    const repaired = `${SAMPLE_STORY}\n\n陈岚在法庭上见到了证人。`;
    const { reviewer, seen } = spyReviewer();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW, repaired, GOOD_REVIEW]);
    await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, reviewer).run(SAMPLE_CONFIG);

    // 只评了一次，而且评的是修订后的那一版（初版正文在 initial_story.md 里）
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("陈岚在法庭上见到了证人。");
    expect(seen[0]).not.toBe(SAMPLE_STORY);
  });
});

describe("v1.5.0 重试路径：根目录那份永远对得上入选 Attempt（§39）", () => {
  it("两次 Attempt 各写各的结论，根目录复制的是入选那份，不混", async () => {
    const dir = withTmpDir();
    const short = "陈岚走进派出所，然后又走了。";
    const seen: string[] = [];
    let n = 0;
    const reviewer = new CommercialReviewer({
      generate: async (prompt: string) => {
        // 整份 prompt 记下来：正文是最后一次 generate 里唯一变化的东西
        seen.push(prompt);
        n += 1;
        return JSON.stringify({
          ...JSON.parse(COMMERCIAL_HIGH) as CommercialReviewResult,
          summary: `第 ${n} 次商业审阅`,
          dimensions: {
            hook: { score: 50 + n, summary: `hook ${n}` },
            pacing: { score: 60 + n, summary: `pacing ${n}` },
            engagement: { score: 70 + n, summary: `engagement ${n}` },
            payoff: { score: 80 + n, summary: `payoff ${n}` },
          },
        });
      },
    } as never);

    const llm = new FakeLLM([PLAN_REPLY, short, GOOD_REVIEW, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(
      llm,
      new ArtifactStore(),
      { ...DEFAULT_RETRY_POLICY, enable_repair: false },
      reviewer,
    ).run(SAMPLE_CONFIG);

    expect(result.selected_attempt).toBe(2);
    expect(readdirSync(join(runDirOf(dir, result.run_id), "attempts")).sort()).toEqual(["01", "02"]);
    // 每次尝试各跑一次商业审阅，互不覆盖
    expect(seen).toHaveLength(2);

    const first = JSON.parse(
      readFileSync(join(runDirOf(dir, result.run_id), "attempts", "01", "commercial-review.json"), "utf8"),
    ) as CommercialReviewResult;
    const second = JSON.parse(
      readFileSync(join(runDirOf(dir, result.run_id), "attempts", "02", "commercial-review.json"), "utf8"),
    ) as CommercialReviewResult;
    const root = JSON.parse(
      readFileSync(join(runDirOf(dir, result.run_id), "commercial-review.json"), "utf8"),
    ) as CommercialReviewResult;
    expect(first.summary).toBe("第 1 次商业审阅");
    expect(second.summary).toBe("第 2 次商业审阅");
    expect(root).toEqual(second);
    expect(root).not.toEqual(first);
    expect(result.commercial_review).toEqual(second);
  });
});

describe("v1.5.0 失败隔离：商业审阅者自身异常（§24/§25/§40）", () => {
  const throwingReviewer = new CommercialReviewer({
    generate: async () => {
      throw new Error("commercial reviewer exploded: /Users/knife/secret");
    },
  } as never);

  it("这一路 failed：不写文件、记 error，但故事 / 校验 / 审阅 / 质量全部保留", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, throwingReviewer).run(
      SAMPLE_CONFIG,
    );

    const runDir = runDirOf(dir, result.run_id);
    expect(result.status).toBe("completed");
    expect(result.quality_status).toBe("accepted");
    expect(result.story).toContain(SAMPLE_STORY);
    expect(existsSync(join(runDir, "story.md"))).toBe(true);
    expect(existsSync(join(runDir, "validation.json"))).toBe(true);
    expect(existsSync(join(runDir, "review.json"))).toBe(true);
    expect(existsSync(join(runDir, "quality.json"))).toBe(true);
    // 商业这一路失败：一处文件都不写，根目录也没有残留
    expect(existsSync(join(runDir, "commercial-review.json"))).toBe(false);
    expect(existsSync(join(runDir, "attempts", "01", "commercial-review.json"))).toBe(false);
  });

  it("metadata 记 commercial_review_status=failed 与 commercial_review_error，且不出现 commercial_score", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, throwingReviewer).run(
      SAMPLE_CONFIG,
    );

    const meta = readJson(join(runDirOf(dir, result.run_id), "metadata.json"));
    expect(meta.commercial_review_status).toBe("failed");
    expect(String(meta.commercial_review_error)).toContain("commercial reviewer exploded");
    expect(meta.commercial_score).toBeUndefined();
    expect((meta.artifacts as Record<string, string>).commercial_review).toBeUndefined();

    expect(result.commercial_review).toBeNull();
    expect(result.commercial_review_status).toBe("failed");
    expect(result.commercial_review_error).toContain("commercial reviewer exploded");
  });

  it("错误文本过 safe-text：本机路径不落盘", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, throwingReviewer).run(
      SAMPLE_CONFIG,
    );
    const meta = readJson(join(runDirOf(dir, result.run_id), "metadata.json"));
    expect(String(meta.commercial_review_error)).not.toMatch(/\/Users\//);
    expect(String(meta.commercial_review_error)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("结构审阅与质量结论与该路失败无关：分数照旧", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, throwingReviewer).run(
      SAMPLE_CONFIG,
    );
    const review = readJson(join(runDirOf(dir, result.run_id), "review.json"));
    const quality = readJson(join(runDirOf(dir, result.run_id), "quality.json"));
    expect(review.score).toBe(82);
    expect(quality.overall_score).toBe(82);
    expect(result.review?.score).toBe(82);
  });

  it("商业审阅输出不合法（缺维度）时同一套隔离：结论缺失，Run 不失败", async () => {
    const dir = withTmpDir();
    const badReviewer = new CommercialReviewer({
      generate: async () => JSON.stringify({ score: 90, summary: "缺维度", strengths: [], problems: [], suggestions: [] }),
    } as never);
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, badReviewer).run(
      SAMPLE_CONFIG,
    );
    expect(result.status).toBe("completed");
    expect(result.commercial_review_status).toBe("failed");
    expect(existsSync(join(runDirOf(dir, result.run_id), "commercial-review.json"))).toBe(false);
  });
});

describe("v1.5.0 商业分不驱动任何自动动作（§15/§57）", () => {
  it("商业四维全低也不会触发重试或修订", async () => {
    const dir = withTmpDir();
    const { reviewer } = spyReviewer(COMMERCIAL_LOW);
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, reviewer).run(SAMPLE_CONFIG);

    expect(result.attempt_count).toBe(1);
    expect(result.quality_status).toBe("accepted");
    expect(result.selected_attempt).toBe(1);
    // 分数确实低（均分 12），但一次修订、一次重试都没多跑
    expect(result.commercial_review?.score).toBe(12);
    expect(existsSync(join(runDirOf(dir, result.run_id), "attempts", "01", "repairs"))).toBe(false);
    expect(readdirSync(join(runDirOf(dir, result.run_id), "attempts")).sort()).toEqual(["01"]);
  });

  it("min_review_score 仍然只看结构审阅分：商业分低不改变采纳结论", async () => {
    const dir = withTmpDir();
    const { reviewer } = spyReviewer(COMMERCIAL_LOW);
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, reviewer).run(SAMPLE_CONFIG);

    const meta = readJson(join(runDirOf(dir, result.run_id), "metadata.json"));
    expect(meta.review_score).toBe(82);
    expect(meta.quality_status).toBe("accepted");
    expect(meta.commercial_score).toBe(12);
    // 两个分数各自独立存在，互不换算
    expect(meta.overall_score).toBe(82);
  });
});

describe("v1.5.0 没注入 CommercialReviewer：这一步等于不存在（§5）", () => {
  it("不写文件、status 是 not_started，Run 照常 completed", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, undefined).run(SAMPLE_CONFIG);

    const runDir = runDirOf(dir, result.run_id);
    expect(result.status).toBe("completed");
    expect(result.commercial_review).toBeNull();
    expect(result.commercial_review_status).toBe("not_started");
    expect(existsSync(join(runDir, "commercial-review.json"))).toBe(false);
    expect(readdirSync(join(runDir, "attempts", "01")).sort()).toEqual([
      "metadata.json",
      "quality.json",
      "review.json",
      "story.md",
      "validation.json",
    ]);
  });

  it("metadata 只留 commercial_review_status=not_started，没有 commercial_score", async () => {
    const dir = withTmpDir();
    const llm = new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const result = await pipelineWith(llm, new ArtifactStore(), DEFAULT_RETRY_POLICY, undefined).run(SAMPLE_CONFIG);
    const meta = readJson(join(runDirOf(dir, result.run_id), "metadata.json"));
    expect(meta.commercial_review_status).toBe("not_started");
    expect(meta.commercial_score).toBeUndefined();
  });
});

describe("v1.5.0 与结构审阅产物互不干扰（§12/§26）", () => {
  it("review.json / quality.json 与不接商业审阅时逐字一致", async () => {
    const dirA = withTmpDir();
    const plain = await pipelineWith(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]),
      new ArtifactStore(),
      DEFAULT_RETRY_POLICY,
      undefined,
    ).run(SAMPLE_CONFIG);

    const dirB = withTmpDir();
    const withCommercial = await pipelineWith(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]),
      new ArtifactStore(),
      DEFAULT_RETRY_POLICY,
      spyReviewer().reviewer,
    ).run(SAMPLE_CONFIG);

    const reviewA = readFileSync(join(runDirOf(dirA, plain.run_id), "review.json"), "utf8");
    const reviewB = readFileSync(join(runDirOf(dirB, withCommercial.run_id), "review.json"), "utf8");
    const qualityA = readFileSync(join(runDirOf(dirA, plain.run_id), "quality.json"), "utf8");
    const qualityB = readFileSync(join(runDirOf(dirB, withCommercial.run_id), "quality.json"), "utf8");
    expect(reviewB).toBe(reviewA);
    expect(qualityB).toBe(qualityA);
    // 唯一差别就是多了商业审阅这一路
    expect(existsSync(join(runDirOf(dirB, withCommercial.run_id), "commercial-review.json"))).toBe(true);
  });
});

/**
 * v1.5.1 失败路径：Run 没跑完时 commercial_review_status 说真话。
 *
 * Run 失败时 promote 从未执行，运行根目录没有 commercial-review.json，所以结论本体不能写；
 * 但「这一步到底跑没跑成」是已经发生过的事实——attempt 目录里躺着的那份文件就是证据。
 * v1.5.0 首发时这里硬写 COMMERCIAL_CHECK_SKIPPED，于是「第一次尝试商业审阅跑成了、
 * 第二次尝试生成失败」的 Run，metadata 声称这一步从没跑过。用假的 not_started 掩盖
 * 已经发生过的一步，比少写一个字段更糟：读接口与 UI 都据此把整个面板藏掉。
 */
describe("v1.5.1 失败路径：状态不许谎称这一步没跑过", () => {
  /** 允许定点修订时，重试前会多出几次调用；关掉它，调用顺序才是可数的。 */
  const NO_REPAIR: RetryPolicy = { ...DEFAULT_RETRY_POLICY, enable_repair: false };

  /** 数着第几次调用：第 failAt 次 generate 时抛错，其余交给 FakeLLM 的预设响应。 */
  function failAtNth(llm: FakeLLM, failAt: number, message: string) {
    let calls = 0;
    return {
      generate: async (prompt: string, temperature = 0.8, system?: string): Promise<string> => {
        calls += 1;
        if (calls === failAt) throw new Error(message);
        return llm.generate(prompt, temperature, system);
      },
    };
  }

  /** 跑一个注定失败的 Run，把 run_id 交出来：失败路径的产物全靠它定位。 */
  async function runFailingAt(
    llm: FakeLLM,
    failAt: number,
    message: string,
    commercialReviewer?: CommercialReviewer,
  ): Promise<string> {
    const client = failAtNth(llm, failAt, message);
    const pipeline = new GenerationPipeline(
      new BeatPlanner(client as never),
      new StoryGenerator(client as never),
      new StoryValidator(),
      new BasicReviewer(client as never),
      new ArtifactStore(),
      NO_REPAIR,
      new StoryRepairer(client as never),
      new RepairStrategy(),
      // qualityAssembler / projectVersion / beatValidator 走默认或缺省；
      // 商业审阅者是第 12 个参数（§12：两个审阅者并列，各拿各的结论）
      undefined,
      undefined,
      undefined,
      commercialReviewer,
    );
    try {
      await pipeline.run(SAMPLE_CONFIG);
    } catch (e) {
      if (e instanceof PipelineError) return e.runId;
      throw e;
    }
    throw new Error("这个 Run 本该失败");
  }

  it("第一次尝试商业审阅跑成、第二次生成失败：status=completed，但不写结论本体", async () => {
    const dir = withTmpDir();
    // 关掉修订后调用顺序可数：1 规划、2 第一次正文、3 第一次结构审阅、4 第二次正文。
    const runId = await runFailingAt(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW]),
      4,
      "stream broken: attempt 2 /Users/knife/secret",
      spyReviewer().reviewer,
    );

    const runDir = runDirOf(dir, runId);
    // 第一次尝试确实写过那份文件——它是这一步跑成过的物证
    expect(existsSync(join(runDir, "attempts", "01", "commercial-review.json"))).toBe(true);

    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.status).toBe("failed");
    // v1.5.1：状态说真话，不是 not_started
    expect(meta.commercial_review_status).toBe("completed");
    // 但结论本体一个字段都不写：promote 从未执行，根目录那份文件不存在
    expect(meta.commercial_score).toBeUndefined();
    expect((meta.artifacts as Record<string, string>).commercial_review).toBeUndefined();
    expect(existsSync(join(runDir, "commercial-review.json"))).toBe(false);
  });

  it("失败路径的 error 文本同样过 safe-text：本机路径不落盘", async () => {
    const dir = withTmpDir();
    const runId = await runFailingAt(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW]),
      4,
      "stream broken: attempt 2 /Users/knife/secret",
      spyReviewer().reviewer,
    );

    const meta = readJson(join(runDirOf(dir, runId), "metadata.json"));
    expect(String(meta.error)).not.toMatch(/\/Users\//);
    expect(String(meta.error)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("商业审阅自己失败后又遇到生成失败：status=failed 且 error 保留", async () => {
    const dir = withTmpDir();
    const throwingReviewer = new CommercialReviewer({
      generate: async () => {
        throw new Error("commercial reviewer exploded");
      },
    } as never);
    const runId = await runFailingAt(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW]),
      4,
      "stream broken",
      throwingReviewer,
    );

    const runDir = runDirOf(dir, runId);
    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.commercial_review_status).toBe("failed");
    expect(String(meta.commercial_review_error)).toContain("commercial reviewer exploded");
    expect(meta.commercial_score).toBeUndefined();
    // 这一路失败时连 attempt 目录那份都不写，根目录更不会有
    expect(existsSync(join(runDir, "commercial-review.json"))).toBe(false);
    expect(existsSync(join(runDir, "attempts", "01", "commercial-review.json"))).toBe(false);
  });

  it("一个 Attempt 都没跑到就失败：仍然是从没跑过的 not_started", async () => {
    const dir = withTmpDir();
    const runId = await runFailingAt(
      new FakeLLM([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW]),
      1,
      "planning exploded",
      spyReviewer().reviewer,
    );

    const runDir = runDirOf(dir, runId);
    const meta = readJson(join(runDir, "metadata.json"));
    expect(meta.commercial_review_status).toBe("not_started");
    expect(meta.commercial_review_error).toBeUndefined();
    expect(meta.commercial_score).toBeUndefined();
    expect(existsSync(join(runDir, "attempts", "01", "commercial-review.json"))).toBe(false);
  });
});

