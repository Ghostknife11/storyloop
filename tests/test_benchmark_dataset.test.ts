import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBeatPlan } from "@/domain/beat-plan";
import { benchmarkMetricKeys, benchmarkMetricDefinition } from "@/domain/benchmark-metric";
import { benchmarkSuiteOf, fixedBeatPlanRefs, benchmarkSampleCount } from "@/domain/benchmark-suite";

/**
 * v2.3.0 随仓库发布的那份 Suite（TASK §112/§114 数据集安全）。
 *
 * 一个 Benchmark 平台最容易被滥用的地方不是代码，是题库：把爬来的正文、
 * 别家模型生成的故事、没有许可的素材塞进 Suite，整个平台的数字就都建在
 * 说不清来源的数据上。所以这份 Suite 必须在结构上就答得出三个问题：
 *
 *   1. 它是合法的（过同一套 validateBenchmarkSuite）；
 *   2. 它的来源与许可写得明明白白（§13：没有 license 的题目读不进来）；
 *   3. 引用的每一份固定骨架都真的躺在 Suite 目录里（§40 all fixed BeatPlans exist）。
 *
 * 这条测试还有一个附带作用：谁要是把 Suite 改坏了，跑一遍测试就知道，
 * 不用等到发起一次执行才发现 400。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE_DIR = resolve(HERE, "..", "benchmarks", "suites", "storyloop-core", "1.0.0");
const SUITE_FILE = join(SUITE_DIR, "suite.json");

function readSuiteJson(): Record<string, unknown> {
  expect(existsSync(SUITE_FILE)).toBe(true);
  return JSON.parse(readFileSync(SUITE_FILE, "utf8")) as Record<string, unknown>;
}

describe("发布的 Suite：结构与协议（§100）", () => {
  const raw = readSuiteJson();
  const suite = benchmarkSuiteOf(raw, benchmarkMetricKeys());

  it("能过同一套校验，不是一个特例硬编码", () => {
    expect(suite).not.toBeNull();
    expect(suite?.id).toBe("storyloop-core");
    expect(suite?.version).toBe("1.0.0");
    expect(suite?.cases.length).toBeGreaterThan(0);
  });

  it("协议里的每个指标都在注册表里，且没有缺漏", () => {
    const accepted = suite?.protocol.acceptedMetrics ?? [];
    expect(accepted.length).toBe(benchmarkMetricKeys().size);
    for (const key of accepted) {
      expect(benchmarkMetricDefinition(key)).not.toBeNull();
    }
  });

  it("PASS 阈值写在 Suite 里，不是代码里的默认值（§95/§96）", () => {
    // 71 只是这份 Suite 自己的选择：换一份 Suite 就该是另一个数。
    // 这里断言的是「阈值来自文件」，而不是「阈值等于某个神数」。
    expect(suite?.protocol.passThreshold).toBe(71);
    const rawThreshold = (raw.protocol as Record<string, unknown>).passThreshold;
    expect(rawThreshold).toBe(71);
  });

  it("样本数是题数 × 重复次数，发起执行之前就算得出来", () => {
    const count = suite ? benchmarkSampleCount(suite) : 0;
    expect(count).toBe((suite?.cases.length ?? 0) * (suite?.protocol.repetitions ?? 0));
    expect(count).toBeLessThanOrEqual(30);
  });
});

describe("发布的 Suite：来源与许可（§13/§112/§114）", () => {
  const suite = benchmarkSuiteOf(readSuiteJson(), benchmarkMetricKeys());

  it("Suite 级来源说明了原创与许可，题目不靠默认值兜底", () => {
    expect(suite?.source.origin).toBe("original");
    expect(suite?.source.license.trim().length).toBeGreaterThan(0);
    expect(suite?.source.note?.trim().length).toBeGreaterThan(0);
  });

  it("每道题都有非空的题材、题面与目标字数——空题面会让测量变成空转", () => {
    for (const item of suite?.cases ?? []) {
      expect(item.genre.trim().length).toBeGreaterThan(0);
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.storyConfig.premise.trim().length).toBeGreaterThan(0);
      expect(item.storyConfig.target_words).toBeGreaterThanOrEqual(500);
    }
  });

  it("题面至少覆盖两个题材，按题材分组才有意义", () => {
    const genres = new Set((suite?.cases ?? []).map((item) => item.genre));
    expect(genres.size).toBeGreaterThanOrEqual(2);
  });

  it("固定骨架的引用都指向存在的文件，且过 BeatPlan 校验", () => {
    const refs = suite ? fixedBeatPlanRefs(suite) : [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const planFile = join(SUITE_DIR, ref.ref);
      expect(existsSync(planFile)).toBe(true);
      const plan = validateBeatPlan(JSON.parse(readFileSync(planFile, "utf8")) as unknown);
      expect(plan.beats.length).toBeGreaterThan(0);
    }
  });

  it("没有夹带外部作品的痕迹：Suite 文件里只有题面，没有任何正文或提示词", () => {
    const text = readFileSync(SUITE_FILE, "utf8");
    // 禁止出现在题库字段里的东西（§61/§66：凭据、接口地址、原始提示词）
    expect(text).not.toMatch(/sk-[A-Za-z0-9]|api[_-]?key|bearer /i);
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("http://");
    expect(text).not.toContain("https://");
  });
});
