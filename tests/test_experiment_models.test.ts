import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_SCHEMA_VERSION,
  ExperimentValidationError,
  REPETITIONS_LIMIT,
  TOTAL_RUNS_LIMIT,
  VARIANTS_LIMIT,
  experimentDefinitionOf,
  totalRunCount,
  validateExperimentDefinition,
  type ExperimentDefinition,
} from "@/types/experiment";
import { SAMPLE_BEAT_PLAN, SAMPLE_CONFIG } from "./helpers/fixtures";

/**
 * v1.7.0 实验定义的结构校验（TASK §30/§31/§46/§51）。
 *
 * 这些用例全部在前判定——没有一个会碰真实 LLM。重点是三件事：
 *   1. 形状不对 / 越界 / 重复 id → 拒绝，且拒绝发生在任何请求之前；
 *   2. 白名单外的「变量」一律拒绝而不是静默忽略（否则定义声称改了某个变量，
 *      而样本其实什么都没改）；
 *   3. 凭据与地址不进定义（§61）：结构上就不接受，不猜用途。
 */

function definitionOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: "exp-001",
    name: "换模型会不会更好读",
    description: "固定输入，只改 model",
    base: {
      storyConfig: SAMPLE_CONFIG,
      beatPlanMode: "regenerate",
    },
    variants: [
      { id: "base", name: "基准", overrides: {} },
      { id: "alt-model", name: "换个模型", overrides: { model: "other-model" } },
    ],
    repetitions: 1,
    ...overrides,
  };
}

/** 一条合法的 fixed 模式定义：骨架整份塞进定义里。 */
function fixedDefinitionOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return definitionOf({
    base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "fixed", beatPlan: SAMPLE_BEAT_PLAN },
    ...overrides,
  });
}

describe("§30 合法定义", () => {
  it("regenerate 模式：只给故事配置就够了，repetitions 缺省为 1", () => {
    const definition = validateExperimentDefinition(definitionOf());
    expect(definition.schemaVersion).toBe(EXPERIMENT_SCHEMA_VERSION);
    expect(definition.repetitions).toBe(REPETITIONS_LIMIT.min);
    expect(definition.variants.map((v) => v.id)).toEqual(["base", "alt-model"]);
    expect(definition.base.beatPlanMode).toBe("regenerate");
    expect(definition.base.beatPlan).toBeUndefined();
    expect(totalRunCount(definition)).toBe(2);
  });

  it("fixed 模式：整份 BeatPlan 随定义一起校验并保留", () => {
    const definition = validateExperimentDefinition(fixedDefinitionOf());
    expect(definition.base.beatPlanMode).toBe("fixed");
    expect(definition.base.beatPlan).toEqual(SAMPLE_BEAT_PLAN);
  });

  it("createdAt 缺省时补一个 ISO 时间戳", () => {
    const definition = validateExperimentDefinition(definitionOf());
    expect(definition.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("Base 的重试策略可以只给一项，其余用默认值", () => {
    const definition = validateExperimentDefinition(definitionOf({
      base: {
        storyConfig: SAMPLE_CONFIG,
        beatPlanMode: "regenerate",
        retryPolicy: { min_review_score: 60 },
      },
    }));
    expect(definition.base.retryPolicy).toMatchObject({ min_review_score: 60, max_attempts: 2 });
  });
});

describe("§51 结构校验", () => {
  it("schemaVersion 不匹配直接拒绝", () => {
    expect(() => validateExperimentDefinition(definitionOf({ schemaVersion: "2" }))).toThrow(
      /schemaVersion 只支持 1/,
    );
  });

  it("任何非对象输入都拒绝，不猜", () => {
    for (const bad of [null, undefined, 42, "experiment", []]) {
      expect(() => validateExperimentDefinition(bad)).toThrow(ExperimentValidationError);
    }
  });

  it("variants 不能为空：基准本身也是一个 Variant", () => {
    expect(() => validateExperimentDefinition(definitionOf({ variants: [] }))).toThrow(/variants 不能为空/);
    expect(() => validateExperimentDefinition(definitionOf({ variants: "base" }))).toThrow(/必须是数组/);
  });

  it(`variants 最多 ${VARIANTS_LIMIT.max} 个`, () => {
    const many = Array.from({ length: VARIANTS_LIMIT.max + 1 }, (_, i) => ({
      id: `v${i}`,
      name: `变体 ${i}`,
      overrides: {},
    }));
    expect(() => validateExperimentDefinition(definitionOf({ variants: many }))).toThrow(/variants 最多 4/);
  });

  it("variant id 重复即拒绝（下标不能当身份）", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [
        { id: "same", name: "甲", overrides: {} },
        { id: "same", name: "乙", overrides: {} },
      ],
    }))).toThrow(/id 存在重复/);
  });

  it("repetitions 越界拒绝：0 与 6 都不行", () => {
    expect(() => validateExperimentDefinition(definitionOf({ repetitions: 0 }))).toThrow(
      new RegExp(`repetitions 必须是 ${REPETITIONS_LIMIT.min} ~ ${REPETITIONS_LIMIT.max}`),
    );
    expect(() => validateExperimentDefinition(definitionOf({ repetitions: REPETITIONS_LIMIT.max + 1 }))).toThrow(
      /repetitions 必须是/,
    );
    expect(() => validateExperimentDefinition(definitionOf({ repetitions: 1.5 }))).toThrow(/repetitions 必须是/);
  });

  it("总样本数超上限拒绝：一份定义最多跑 12 条", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, name: `v${i}`, overrides: {} }));
    expect(() => validateExperimentDefinition(definitionOf({ variants: four, repetitions: 4 }))).toThrow(
      /总样本数 16/,
    );
    expect(() => validateExperimentDefinition(definitionOf({ variants: four, repetitions: 4 }))).toThrow(
      new RegExp(`超过上限 ${TOTAL_RUNS_LIMIT}`),
    );
    // 3 变体 × 4 次 = 12，正好在上限上，合法
    const three = threeVariants();
    expect(() => validateExperimentDefinition(definitionOf({ variants: three, repetitions: 4 }))).not.toThrow();
  });

  it("experimentId 只接受单个目录名，路径与遍历一律拒绝", () => {
    expect(() => validateExperimentDefinition(definitionOf({ experimentId: "../evil" }))).toThrow(/路径分隔符/);
    expect(() => validateExperimentDefinition(definitionOf({ experimentId: "a/b" }))).toThrow(/路径分隔符/);
    expect(() => validateExperimentDefinition(definitionOf({ experimentId: ".hidden" }))).toThrow(/以字母或数字开头/);
    expect(() => validateExperimentDefinition(definitionOf({ experimentId: "" }))).toThrow(/experimentId 必须是非空字符串/);
  });

  it("beatPlanMode 只能是 fixed / regenerate；fixed 必须带骨架", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "sometimes" },
    }))).toThrow(/beatPlanMode 只能是 fixed 或 regenerate/);

    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "fixed" },
    }))).toThrow(/必须带上 base\.beatPlan/);
  });

  it("regenerate 模式再带固定骨架是自相矛盾，拒绝而不是忽略", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", beatPlan: SAMPLE_BEAT_PLAN },
    }))).toThrow(/不能再带 base\.beatPlan/);
  });

  it("温度越界在两个位置都拒绝", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", generationParameters: { temperature: 2.5 } },
    }))).toThrow(/temperature 必须在 0 ~ 2 之间/);

    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "hot", name: "高温", overrides: { generation: { temperature: -1 } } }],
    }))).toThrow(/temperature 必须在 0 ~ 2 之间/);
  });

  it("base 里不认识的字段拒绝（不静默丢弃）", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", surprise: true },
    }))).toThrow(/base 不支持字段 surprise/);
  });

  it("变体覆盖只认白名单内四项", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "乱改", overrides: { nope: 1 } }],
    }))).toThrow(/overrides 不支持字段 nope/);
  });
});

describe("§61 凭据与地址不进定义", () => {
  it("baseUrl / api_key / authorization 出现在任何位置都拒绝，并报出路径", () => {
    expect(() => validateExperimentDefinition(definitionOf({ baseUrl: "https://x.example/v1" }))).toThrow(
      /experiment\.baseUrl 不允许出现在实验定义里/,
    );
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "夹带", overrides: { model: "m" }, api_key: "sk-test" }],
    }))).toThrow(/variants\[0\]\.api_key 不允许/);
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", headers: { Authorization: "Bearer x" } },
    }))).toThrow(/base\.headers 不允许/);
    // 嵌套在数组里也一样：递归扫，不只看顶层
    expect(() => validateExperimentDefinition(definitionOf({
      description: "ok",
      variants: [{ id: "x", name: "n", overrides: {}, env: { LLM_API_KEY: "sk-test" } }],
    }))).toThrow(/variants\[0\]\.env 不允许/);
  });

  it("变体覆盖里写 baseUrl：拒绝（凭据形状的键名扫描先拦下，路径里看得出在哪）", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { baseUrl: "https://x.example/v1" } }],
    }))).toThrow(/experiment\.variants\[0\]\.overrides\.baseUrl 不允许出现在实验定义里/);
  });
});

describe("§14 白名单外的「变量」：拒绝，并说明它不会改变任何一次请求", () => {
  it("topP / maxTokens 拒绝：LLMClient 只发 model / messages / temperature", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { generation: { topP: 0.9 } } }],
    }))).toThrow(/overrides\.generation\.topP 不允许作为实验变量/);
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { generation: { maxTokens: 4096 } } }],
    }))).toThrow(/maxTokens 不允许作为实验变量/);
  });

  it("prompts 拒绝：六个阶段各读一个固定提示词文件，没有第二个版本可选", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { prompts: { generator: "1" } } }],
    }))).toThrow(/overrides\.prompts 不允许作为实验变量/);
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { prompts: { planner: "2" } } }],
    }))).toThrow(/没有第二个版本可选/);
  });

  it("base 里写 prompts / promptVersions 同样拒绝", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", promptVersions: { generator: "1" } },
    }))).toThrow(/base 不支持字段 promptVersions/);
  });

  it("合法覆盖原样保留：model / temperature / retry 两项", () => {
    const definition = validateExperimentDefinition(definitionOf({
      variants: [
        {
          id: "kitchen-sink",
          name: "全改一遍",
          overrides: {
            model: "m-2",
            generation: { temperature: 1.2 },
            retry: { maxAttempts: 3, minReviewScore: 80 },
          },
        },
      ],
    }));
    expect(definition.variants[0].overrides).toEqual({
      model: "m-2",
      generation: { temperature: 1.2 },
      retry: { maxAttempts: 3, minReviewScore: 80 },
    });
  });

  it("retry 覆盖只认两项：开关类字段不进变体", () => {
    expect(() => validateExperimentDefinition(definitionOf({
      variants: [{ id: "x", name: "n", overrides: { retry: { enable_repair: false } } }],
    }))).toThrow(/overrides\.retry 不支持字段 enable_repair/);
  });
});

describe("读回", () => {
  it("磁盘上被改坏的定义读回来是 null（按不存在处理，不猜）", () => {
    expect(experimentDefinitionOf(null)).toBeNull();
    expect(experimentDefinitionOf({ schemaVersion: "9" })).toBeNull();
    expect(experimentDefinitionOf("{}")).toBeNull();
  });

  it("合法定义读回来逐字可用", () => {
    const definition = validateExperimentDefinition(definitionOf());
    const reread = experimentDefinitionOf(JSON.parse(JSON.stringify(definition)) as unknown);
    expect(reread).toEqual(definition);
  });

  it("校验后的定义类型上不带可选项残留", () => {
    const definition: ExperimentDefinition = validateExperimentDefinition(fixedDefinitionOf());
    expect(definition.base.beatPlan?.beats).toHaveLength(4);
  });
});

function threeVariants() {
  return Array.from({ length: 3 }, (_, i) => ({ id: `v${i}`, name: `变体 ${i}`, overrides: {} }));
}
