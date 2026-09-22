import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/core/pipeline";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@/core/retry-policy";
import { ArtifactStore } from "@/storage/artifact-store";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { StoryRepairer } from "@/lib/story-repairer";
import { RepairStrategy } from "@/core/repair-strategy";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_CONFIG,
  SAMPLE_REVIEW,
  SAMPLE_STORY,
  FakeLLM,
  repoRoot,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v1.0.1 新增：文档字段表 ↔ 真实产物字段集 对照合同测试。
 *
 * 1.0.0 的合同测试只断言「TASK 要求的必备字段在不在」（那本就是「至少」语义），
 * 而 docs/run-artifacts.md 与 README 按「字段集」写，于是文档漏字段、多字段都没有
 * 任何测试会红——1.0.1 修订的正是这类偏差。这份测试把方向反过来：文档写什么，
 * 产物就得有什么；产物多出什么，文档也必须写上。
 *
 * 做法是跑几条真实路径的 Pipeline（只有 LLM 与校验 / 审阅组件是假的），把各层 metadata
 * 实际出现的键收成一个集合，与文档里列出的名字双向比对。两边都是集合：文档多写、漏写、
 * 改名都算走样。条件字段只在特定路径出现，因此五条路径必须都跑到：
 * 成功 / 修订后接受 / 重试耗尽 / 生成失败 / 校验与审阅组件自身异常。
 */

const PLAN_REPLY = JSON.stringify(SAMPLE_BEAT_PLAN);
const GOOD_REVIEW = JSON.stringify(SAMPLE_REVIEW);
const LOW_REVIEW = JSON.stringify({
  score: 41,
  summary: "正文冲突没有展开。",
  strengths: ["开头有画面"],
  problems: ["高潮缺失"],
});

function pipelineWith(
  llm: FakeLLM,
  store: ArtifactStore,
  retryPolicy?: RetryPolicy,
  brokenComponents?: { validator?: unknown; reviewer?: unknown },
) {
  // 四个阶段都只用到 generate()，这里一次性降到它们需要的形状
  const client = llm as never;
  return new GenerationPipeline(
    new BeatPlanner(client),
    new StoryGenerator(client),
    (brokenComponents?.validator ?? new StoryValidator()) as never,
    (brokenComponents?.reviewer ?? new BasicReviewer(client)) as never,
    store,
    retryPolicy,
    new StoryRepairer(client),
    new RepairStrategy(),
  );
}

/** 跑一次真 Pipeline，返回 run 目录与其中每层 metadata 的键集合。
 *  失败路径下 Pipeline 会抛 PipelineError，但产物已经落盘——照样收。 */
async function runScenario(
  replies: string[],
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  opts: { breakLlm?: (llm: FakeLLM) => void; validator?: unknown; reviewer?: unknown } = {},
) {
  const dir = withTmpDir();
  const llm = new FakeLLM(replies);
  opts.breakLlm?.(llm);
  let runId = "";
  try {
    const result = await pipelineWith(llm, new ArtifactStore(), policy, opts).run(SAMPLE_CONFIG);
    runId = result.run_id;
  } catch (e) {
    runId = (e as { runId?: string }).runId ?? "";
    expect(runId, "失败路径也应留下 run 目录").not.toBe("");
  }
  const runDir = join(dir, "runs", runId);
  return {
    runId,
    runKeys: Object.keys(JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as object),
    attemptKeys: attemptKeysOf(join(runDir, "attempts")),
    repairKeys: repairKeysOf(join(runDir, "attempts")),
  };
}

function attemptKeysOf(attemptsRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(attemptsRoot)) return out;
  for (const attempt of readdirSync(attemptsRoot, { withFileTypes: true })) {
    if (!attempt.isDirectory()) continue;
    const meta = join(attemptsRoot, attempt.name, "metadata.json");
    if (existsSync(meta)) out.push(...Object.keys(JSON.parse(readFileSync(meta, "utf8")) as object));
  }
  return out;
}

function repairKeysOf(attemptsRoot: string): string[] {
  const out: string[] = [];
  if (!existsSync(attemptsRoot)) return out;
  for (const attempt of readdirSync(attemptsRoot, { withFileTypes: true })) {
    if (!attempt.isDirectory()) continue;
    const repairsRoot = join(attemptsRoot, attempt.name, "repairs");
    if (!existsSync(repairsRoot)) continue;
    for (const repair of readdirSync(repairsRoot, { withFileTypes: true })) {
      if (!repair.isDirectory()) continue;
      const meta = join(repairsRoot, repair.name, "metadata.json");
      if (existsSync(meta)) out.push(...Object.keys(JSON.parse(readFileSync(meta, "utf8")) as object));
    }
  }
  return out;
}

function sectionOf(doc: string, heading: string): string {
  const at = doc.indexOf(heading);
  expect(at, `docs/run-artifacts.md 找不到小节 ${heading}`).toBeGreaterThan(-1);
  const next = doc.indexOf("\n### ", at + 1);
  return doc.slice(at, next === -1 ? undefined : next);
}

/** 取表格第一列里的字段名（单元格可能是 `a` / `b` 两个字段并列）。 */
function tableFields(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    // 表格里用 \| 转义了类型列的空格分隔（如 `boolean \| null`），先占位再切
    const cells = line
      .replace(/\\\|/g, "\u0000")
      .split("|")
      .map((cell) => cell.replace(/\u0000/g, "|").trim());
    const name = cells[1] ?? "";
    if (!name.startsWith("`")) continue; // 表头行与 |---| 行没有反引号
    for (const token of name.replace(/`/g, "").split("/")) {
      const field = token.trim();
      if (/^[a-z][a-z0-9_]*$/.test(field)) out.push(field);
    }
  }
  return [...new Set(out)];
}

/** README 的运行级字段清单是正文里的一个自然段，取到第一个句号为止。 */
function readmeRunFields(readme: string): string[] {
  const anchor = "运行级 `metadata.json` 的字段：";
  const at = readme.indexOf(anchor);
  expect(at, `README 找不到「${anchor}」这一段`).toBeGreaterThan(-1);
  const paragraph = readme.slice(at, readme.indexOf("。", at));
  const names = [...paragraph.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
  expect(names.length, "README 这一段应当列出一批字段名").toBeGreaterThan(5);
  return [...new Set(names)];
}

/** 双向比对：文档多写的、漏写的都报出来，错误信息里直接给出差集。 */
function expectSameSet(label: string, documented: string[], actual: string[]) {
  const missing = documented.filter((field) => !actual.includes(field));
  const undocumented = actual.filter((field) => !documented.includes(field));
  expect(missing, `${label}：文档写了但产物里没有 → ${missing.join(", ")}`).toEqual([]);
  expect(undocumented, `${label}：产物里有但文档没写 → ${undocumented.join(", ")}`).toEqual([]);
}

describe("v1.0.1 文档与产物字段集 — 真实路径", () => {
  it("五条路径覆盖全部条件字段：成功 / 修订后接受 / 重试耗尽 / 生成失败 / 校验审阅组件异常", async () => {
    const happy = await runScenario([PLAN_REPLY, SAMPLE_STORY, GOOD_REVIEW]);
    const repaired = await runScenario([
      PLAN_REPLY,
      SAMPLE_STORY,
      LOW_REVIEW,
      "修订后的正文，补上了高潮。",
      GOOD_REVIEW,
    ]);
    const exhausted = await runScenario([PLAN_REPLY, SAMPLE_STORY, LOW_REVIEW], {
      ...DEFAULT_RETRY_POLICY,
      max_attempts: 1,
      enable_repair: false,
    });
    const failed = await runScenario([PLAN_REPLY], DEFAULT_RETRY_POLICY, {
      breakLlm: (llm) => llm.failNextWith(new Error(" plan boom")),
    });
    // §12：校验 / 审阅组件自身抛异常时只写 metadata，没有 validation.json / review.json
    const brokenCheck = await runScenario([PLAN_REPLY, SAMPLE_STORY, SAMPLE_STORY], {
      ...DEFAULT_RETRY_POLICY,
      enable_repair: false,
    }, {
      validator: {
        validate: () => {
          throw new Error("validator boom");
        },
      },
      reviewer: {
        review: () => {
          throw new Error("reviewer boom");
        },
      },
    });

    expect(happy.runKeys).toContain("quality_status");
    expect(repaired.repairKeys).toContain("repair_number");
    expect(exhausted.attemptKeys).toContain("retry_reason");
    expect(failed.runKeys).toContain("error");
    expect(brokenCheck.attemptKeys).toContain("validation_error");
    expect(brokenCheck.attemptKeys).toContain("review_error");
    expect(brokenCheck.runKeys).toContain("validation_error");
    expect(brokenCheck.runKeys).toContain("review_error");

    const run = unique([
      ...happy.runKeys,
      ...repaired.runKeys,
      ...exhausted.runKeys,
      ...failed.runKeys,
      ...brokenCheck.runKeys,
    ]);
    const attempt = unique([
      ...happy.attemptKeys,
      ...repaired.attemptKeys,
      ...exhausted.attemptKeys,
      ...failed.attemptKeys,
      ...brokenCheck.attemptKeys,
    ]);
    const repair = unique([...repaired.repairKeys]);

    const doc = readFileSync(join(repoRoot(), "docs", "run-artifacts.md"), "utf8");
    const readme = readFileSync(join(repoRoot(), "README.md"), "utf8");

    expectSameSet("运行级 metadata（docs/run-artifacts.md）", tableFields(sectionOf(doc, "### 运行级 metadata.json")), run);
    expectSameSet("attempt 级 metadata（docs/run-artifacts.md）", tableFields(sectionOf(doc, "### attempt 级 metadata.json")), attempt);
    expectSameSet("repair 级 metadata（docs/run-artifacts.md）", tableFields(sectionOf(doc, "### repair 级 metadata.json")), repair);
    expectSameSet("运行级 metadata（README）", readmeRunFields(readme), run);
  });
});

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
