import { describe, expect, it } from "vitest";
import { validateBeatPlan } from "@/domain/beat-plan";
import { benchmarkMetricKeys } from "@/domain/benchmark-metric";
import {
  SUITE_CASE_LIMIT,
  benchmarkSampleCount,
  benchmarkSuiteOf,
  validateBenchmarkProtocol,
  validateBenchmarkSuite,
  type BenchmarkCase,
} from "@/domain/benchmark-suite";
import { validateStoryConfig } from "@/domain/story-config";
import { SAMPLE_BEAT_PLAN, SAMPLE_CONFIG } from "./helpers/fixtures";

/**
 * v2.3.0 Suite / Case / Protocol 校验（TASK §100 三道结构关卡）。
 *
 * 这一组测试只在一件事上严格：**题面与协议在跑之前就必须自洽**。
 * 跑到一半才发现题重复了、指标名写错了、骨架文件不存在，代价是已经花掉的钱。
 * 所以这里的每一条拒绝都发生在任何 LLM 请求之前。
 */

function caseOf(id: string, patch: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id,
    title: `${id} 的标题`,
    genre: "悬疑",
    storyConfig: validateStoryConfig(SAMPLE_CONFIG),
    beatPlanMode: "regenerate",
    ...patch,
  };
}

function suiteOf(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const cases = [caseOf("suspense-001"), caseOf("rich-family-001")];
  return {
    schemaVersion: "1",
    id: "storyloop-core",
    version: "1.0.0",
    name: "核心题面",
    cases,
    protocol: {
      repetitions: 2,
      plannerMode: "normal",
      acceptedMetrics: ["overall_quality", "failure_rate"],
      failureHandling: "include",
    },
    source: { origin: "original", license: "CC0-1.0" },
    createdAt: "2026-09-28",
    ...patch,
  };
}

const KEYS = benchmarkMetricKeys();

describe("Suite 身份", () => {
  it("id / version / digest 三件事一起才说得出测的是哪份题", () => {
    const suite = validateBenchmarkSuite(suiteOf(), KEYS);
    expect(suite.id).toBe("storyloop-core");
    expect(suite.version).toBe("1.0.0");
    // 同一版本号下改一道题，版本号不变——digest 由 Infrastructure 算，这里只确认
    // 领域层老老实实把题目带在了对象上，摘要才有东西可摘
    expect(suite.cases.map((c) => c.id)).toEqual(["suspense-001", "rich-family-001"]);
  });

  it("数据集版本只查形状：x.y 或 x.y.z，带前缀的版本号拒绝", () => {
    // 数据集版本与项目版本是两个号（§7/§8）：这里不禁止 `2.3.0` 这种数字形态——
    // 禁止它就得让领域层知道项目版本号，那反而把两件事又绑到一起。
    // 真正把「换了道题」和「升了一次系统」分开的是 digest，见 benchmark-digest 的测试。
    expect(validateBenchmarkSuite(suiteOf({ version: "2.3.0" }), KEYS).version).toBe("2.3.0");
    expect(validateBenchmarkSuite(suiteOf({ version: "1.10" }), KEYS).version).toBe("1.10");
    for (const bad of ["v1.0", "1", "1.0.0.0", "latest"]) {
      expect(() => validateBenchmarkSuite(suiteOf({ version: bad }), KEYS)).toThrow(/数据集版本/);
    }
  });

  it("suite id 只能是单个干净目录名", () => {
    expect(() => validateBenchmarkSuite(suiteOf({ id: "a/b" }), KEYS)).toThrow(/suite.id/);
    expect(() => validateBenchmarkSuite(suiteOf({ id: "Core" }), KEYS)).toThrow(/suite.id/);
  });

  it("未知字段一律拒绝，不默默忽略（字段拼错比没有字段更糟）", () => {
    expect(() => validateBenchmarkSuite(suiteOf({ recommendedModel: "gpt-x" }), KEYS).valueOf()).toThrow(/未知字段/);
  });
});

describe("Case（§9/§10）", () => {
  it("case id 重复直接拒绝，不靠去重糊过去", () => {
    expect(() =>
      validateBenchmarkSuite(suiteOf({ cases: [caseOf("dup"), caseOf("dup")] }), KEYS),
    ).toThrow(/case id dup 重复/);
  });

  it("fixed 题必须给 beatPlanRef，regenerate 给了反而报错", () => {
    expect(() => validateBenchmarkSuite(suiteOf({ cases: [caseOf("fixed-001", { beatPlanMode: "fixed" })] }), KEYS))
      .toThrow(/必须给 beatPlanRef/);
    expect(() =>
      validateBenchmarkSuite(
        suiteOf({ cases: [caseOf("regen-001", { beatPlanRef: "cases/regen-001/beat-plan.json" })] }),
        KEYS,
      ),
    ).toThrow(/给 beatPlanRef 没有意义/);
  });

  it("beatPlanRef 只指向 Suite 目录内：绝对路径与上级目录都拒绝", () => {
    for (const bad of ["/etc/passwd", "C:\\windows\\x.json", "../outside/beat-plan.json", "a/../../b.json"]) {
      expect(() =>
        validateBenchmarkSuite(
          suiteOf({ cases: [caseOf("fixed-001", { beatPlanMode: "fixed", beatPlanRef: bad })] }),
          KEYS,
        ),
      ).toThrow(/相对路径|上级目录/);
    }
    const ok = validateBenchmarkSuite(
      suiteOf({
        cases: [caseOf("fixed-001", { beatPlanMode: "fixed", beatPlanRef: "cases/fixed-001/beat-plan.json" })],
      }),
      KEYS,
    );
    expect(ok.cases[0]?.beatPlanRef).toBe("cases/fixed-001/beat-plan.json");
  });

  it("题数有下限也有上限", () => {
    expect(() => validateBenchmarkSuite(suiteOf({ cases: [] }), KEYS)).toThrow(new RegExp(`${SUITE_CASE_LIMIT.min}`));
    const many = Array.from({ length: SUITE_CASE_LIMIT.max + 1 }, (_, i) => caseOf(`case-${i}`));
    expect(() => validateBenchmarkSuite(suiteOf({ cases: many }), KEYS)).toThrow(new RegExp(`${SUITE_CASE_LIMIT.max}`));
  });

  it("tags 一律小写，界面上的分组才不会同一个词出现两次", () => {
    const suite = validateBenchmarkSuite(
      suiteOf({ cases: [caseOf("tagged-001", { tags: ["悬疑", "Suspense"] })] }),
      KEYS,
    );
    expect(suite.cases[0]?.tags).toEqual(["悬疑", "suspense"]);
  });
});

describe("Protocol（§16/§17）", () => {
  it("plannerMode=fixed-plan 时不许有 regenerate 的题", () => {
    expect(() =>
      validateBenchmarkSuite(
        suiteOf({ protocol: { repetitions: 1, plannerMode: "fixed-plan", acceptedMetrics: ["overall_quality"], failureHandling: "include" } }),
        KEYS,
      ),
    ).toThrow(/fixed-plan/);
  });

  it("acceptedMetrics 必须非空、不许重复、必须是注册表里的键", () => {
    expect(() =>
      validateBenchmarkProtocol({ repetitions: 1, plannerMode: "normal", acceptedMetrics: [], failureHandling: "include" }, KEYS),
    ).toThrow(/非空数组/);
    expect(() =>
      validateBenchmarkProtocol(
        { repetitions: 1, plannerMode: "normal", acceptedMetrics: ["overall_quality", "overall_quality"], failureHandling: "include" },
        KEYS,
      ),
    ).toThrow(/重复/);
    expect(() =>
      validateBenchmarkProtocol(
        { repetitions: 1, plannerMode: "normal", acceptedMetrics: ["made_up_score"], failureHandling: "include" },
        KEYS,
      ),
    ).toThrow(/不支持的指标/);
  });

  it("repetitions 是乘数，不是自由参数", () => {
    for (const bad of [0, 6, 1.5]) {
      expect(() =>
        validateBenchmarkProtocol(
          { repetitions: bad, plannerMode: "normal", acceptedMetrics: ["overall_quality"], failureHandling: "include" },
          KEYS,
        ),
      ).toThrow(/repetitions/);
    }
  });

  it("PASS 阈值可选，取值受协议约束；不给就没有切线（§95）", () => {
    const base = { repetitions: 1, plannerMode: "normal", acceptedMetrics: ["overall_quality"], failureHandling: "include" as const };
    expect(validateBenchmarkProtocol({ ...base }, KEYS).passThreshold).toBeUndefined();
    expect(validateBenchmarkProtocol({ ...base, passThreshold: 71 }, KEYS).passThreshold).toBe(71);
    expect(() => validateBenchmarkProtocol({ ...base, passThreshold: 101 }, KEYS)).toThrow(/passThreshold/);
    expect(() => validateBenchmarkProtocol({ ...base, passThreshold: -1 }, KEYS)).toThrow(/passThreshold/);
  });

  it("failuresHandling 只能是那两个值——失败样本怎么参与聚合必须是显式决定", () => {
    const base = { repetitions: 1, plannerMode: "normal" as const, acceptedMetrics: ["overall_quality"] };
    expect(() => validateBenchmarkProtocol({ ...base, failureHandling: "drop" }, KEYS)).toThrow(/failureHandling/);
    expect(validateBenchmarkProtocol({ ...base, failureHandling: "exclude-with-count" }, KEYS).failureHandling).toBe(
      "exclude-with-count",
    );
  });
});

describe("凭据与许可（§13/§61/§112）", () => {
  it("凭据形状的键名出现在 Suite 任何一层都直接拒绝", () => {
    for (const key of ["baseUrl", "api_key", "headers", "token", "prompt", "system_prompt"]) {
      expect(() => validateBenchmarkSuite(suiteOf({ [key]: "x" }), KEYS)).toThrow(/不允许出现在 Benchmark Suite/);
      expect(() => validateBenchmarkSuite(suiteOf({ cases: [{ ...caseOf("a"), [key]: "x" }] }), KEYS)).toThrow(
        /不允许出现在 Benchmark Suite/,
      );
    }
  });

  it("没有 license 的 Suite 读不进来——来源必须结构上就有答案", () => {
    expect(() => validateBenchmarkSuite(suiteOf({ source: { origin: "original" } }), KEYS)).toThrow(/license/);
    expect(benchmarkSuiteOf(suiteOf({ source: { origin: "original", license: "" } }), KEYS)).toBeNull();
  });

  it("origin 只能是那四种，自定义来源一律拒绝", () => {
    for (const origin of ["original", "public-domain", "licensed", "user-provided"]) {
      expect(benchmarkSuiteOf(suiteOf({ source: { origin, license: "x" } }), KEYS)).not.toBeNull();
    }
    expect(() => validateBenchmarkSuite(suiteOf({ source: { origin: "found-online", license: "x" } }), KEYS)).toThrow(
      /origin/,
    );
  });
});

describe("Benchmark 不是策略（§2/§82）", () => {
  it("Suite 里没有任何字段能被读回去改生成行为", () => {
    // 这道断言守的是「不许加」：谁加了 recommendedModel / adaptive / autoApply
    // 这类字段，测试当场红——Benchmark 测系统，不控制系统
    const forbidden = ["recommendedModel", "adaptive", "autoApply", "bestVariant", "winner", "tuning"];
    const suite = suiteOf();
    for (const key of forbidden) {
      expect(suite).not.toHaveProperty(key);
      expect(() => validateBenchmarkSuite(suiteOf({ [key]: "on" }), KEYS)).toThrow(/未知字段/);
    }
  });

  it("storyConfig 仍是正式 StoryConfig，Benchmark 不发明第二种配置格式", () => {
    const suite = validateBenchmarkSuite(suiteOf(), KEYS);
    const first = suite.cases[0];
    expect(first?.storyConfig.config_version).toBe(SAMPLE_CONFIG.config_version);
    expect(() => validateBenchmarkSuite(suiteOf({ cases: [{ ...caseOf("a"), storyConfig: { title: "没有题材" } }] }), KEYS))
      .toThrow(/storyConfig/);
  });

  it("固定骨架的题也要过正式的 BeatPlan 校验（骨架不是随手写的 JSON）", () => {
    expect(() => validateBeatPlan({ beats: [] })).toThrow();
    expect(validateBeatPlan(SAMPLE_BEAT_PLAN).beats.length).toBeGreaterThan(0);
  });

  it("样本数是题数 × 重复次数，且这个数在跑之前就算得出来", () => {
    const suite = validateBenchmarkSuite(suiteOf(), KEYS);
    expect(benchmarkSampleCount(suite)).toBe(4);
  });
});
