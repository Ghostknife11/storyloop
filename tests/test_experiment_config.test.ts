import { describe, expect, it } from "vitest";
import {
  expandExperiment,
  mergeOverrides,
  type EffectiveRunConfig,
} from "@/core/experiment-config";
import { validateExperimentDefinition } from "@/types/experiment";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import { SAMPLE_BEAT_PLAN, SAMPLE_CONFIG } from "./helpers/fixtures";

/**
 * v1.7.0 变量合并与样本展开（TASK §19/§20/§21）。
 *
 * 重点在三件事：
 *   1. 合并只做 Base → Override 一层，没写的项保持 Base 的值，不引入第三处默认值；
 *   2. 展开顺序固定（Variant 声明顺序为外循环、repetition 从 1 起为内循环），
 *      这样 runs.json / results.json / UI 三处的顺序永远对得上；
 *   3. retryPolicy 的语义字段（开关类）始终有值——合并不会把它弄丢。
 */

const BASE = {
  schemaVersion: "1",
  experimentId: "exp-001",
  name: "合并与展开",
  base: {
    storyConfig: SAMPLE_CONFIG,
    beatPlanMode: "fixed",
    beatPlan: SAMPLE_BEAT_PLAN,
    modelConfig: { model: "base-model" },
    generationParameters: { temperature: 0.5 },
    retryPolicy: { min_review_score: 60, max_attempts: 3 },
  },
  variants: [] as Record<string, unknown>[],
  repetitions: 1,
};

function definitionOf(variants: Record<string, unknown>[], repetitions = 1, extra: Record<string, unknown> = {}) {
  return validateExperimentDefinition({ ...BASE, variants, repetitions, ...extra });
}

const MODEL_VARIANT = { id: "alt-model", name: "换模型", overrides: { model: "alt-model-x" } };
const TEMP_VARIANT = { id: "hot", name: "高温", overrides: { generation: { temperature: 1.4 } } };
const RETRY_VARIANT = {
  id: "patient",
  name: "多试几次",
  overrides: { retry: { maxAttempts: 4, minReviewScore: 90 } },
};

describe("§19 Base + Overrides → 生效配置", () => {
  it("什么都没改的 Variant：配置与 Base 逐字一致", () => {
    const definition = definitionOf([{ id: "base", name: "基准", overrides: {} }]);
    const { config, changes } = mergeOverrides(definition.base, definition.variants[0]);

    // validateStoryConfig 会返回一份校验后的副本，所以按值比较而不是按引用
    expect(config.storyConfig).toEqual(SAMPLE_CONFIG);
    expect(config.beatPlan).toEqual(SAMPLE_BEAT_PLAN);
    expect(config.model).toBe("base-model");
    expect(config.temperature).toBe(0.5);
    expect(config.retryPolicy).toMatchObject({ max_attempts: 3, min_review_score: 60 });
    expect(changes).toEqual({});
  });

  it("Base 没写的项落到默认策略，而不是 undefined", () => {
    const definition = validateExperimentDefinition({
      schemaVersion: "1",
      experimentId: "exp-default",
      name: "最小定义",
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate" },
      variants: [{ id: "base", name: "基准", overrides: {} }],
      repetitions: 1,
    });
    const { config } = mergeOverrides(definition.base, definition.variants[0]);

    expect(config.model).toBeUndefined();
    expect(config.temperature).toBeUndefined();
    expect(config.beatPlan).toBeNull();
    expect(config.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("每类覆盖各改各的，互不影响", () => {
    const definition = definitionOf([MODEL_VARIANT, TEMP_VARIANT, RETRY_VARIANT]);
    const byId = new Map(definition.variants.map((v) => [v.id, v]));

    const model = mergeOverrides(definition.base, byId.get("alt-model") as never);
    expect(model.config.model).toBe("alt-model-x");
    expect(model.config.temperature).toBe(0.5);
    expect(model.config.retryPolicy.max_attempts).toBe(3);

    const temp = mergeOverrides(definition.base, byId.get("hot") as never);
    expect(temp.config.temperature).toBe(1.4);
    expect(temp.config.model).toBe("base-model");

    const retry = mergeOverrides(definition.base, byId.get("patient") as never);
    expect(retry.config.retryPolicy).toMatchObject({ max_attempts: 4, min_review_score: 90 });
    // 开关类字段不被覆盖掉，保持 Base 的值
    expect(retry.config.retryPolicy.enable_repair).toBe(true);
  });

  it("changes 记录「从什么改成什么」，供 UI 展示这个变体改了什么", () => {
    const definition = definitionOf([RETRY_VARIANT]);
    const { changes } = mergeOverrides(definition.base, definition.variants[0]);
    expect(changes).toEqual({
      maxAttempts: { from: 3, to: 4 },
      minReviewScore: { from: 60, to: 90 },
    });
  });

  it("regenerate 模式给不出骨架：beatPlan 是 null 而不是 Base 的骨架", () => {
    const definition = validateExperimentDefinition({
      schemaVersion: "1",
      experimentId: "exp-regen",
      name: "自己规划",
      base: { storyConfig: SAMPLE_CONFIG, beatPlanMode: "regenerate", modelConfig: { model: "m" } },
      variants: [{ id: "base", name: "基准", overrides: {} }],
      repetitions: 2,
    });
    const { config }: { config: EffectiveRunConfig } = mergeOverrides(definition.base, definition.variants[0]);
    expect(config.beatPlan).toBeNull();
  });
});

describe("§21 Variant × repetition 展开", () => {
  it("一个变体跑两次：repetition 从 1 数到 2", () => {
    const plans = expandExperiment(definitionOf([MODEL_VARIANT], 2));
    expect(plans.map((p) => [p.variantId, p.repetition])).toEqual([
      ["alt-model", 1],
      ["alt-model", 2],
    ]);
    // 两条样本用的是同一份配置
    expect(plans[0].config).toEqual(plans[1].config);
  });

  it("两个变体各跑两次：变体是外循环，顺序与声明一致", () => {
    const plans = expandExperiment(definitionOf([MODEL_VARIANT, TEMP_VARIANT], 2));
    expect(plans.map((p) => `${p.variantId}#${p.repetition}`)).toEqual([
      "alt-model#1",
      "alt-model#2",
      "hot#1",
      "hot#2",
    ]);
    expect(plans).toHaveLength(4);
  });

  it("展开顺序与 variants 数组顺序绑定，不按 id 字典序重排", () => {
    const plans = expandExperiment(definitionOf([TEMP_VARIANT, MODEL_VARIANT], 1));
    expect(plans.map((p) => p.variantId)).toEqual(["hot", "alt-model"]);
  });

  it("变体名一起带出来，UI 不必再回头查一遍", () => {
    const plans = expandExperiment(definitionOf([MODEL_VARIANT], 1));
    expect(plans[0].variantName).toBe("换模型");
  });

  it("三变体 × 四次 = 12 条，全部展开", () => {
    const plans = expandExperiment(
      definitionOf([MODEL_VARIANT, TEMP_VARIANT, RETRY_VARIANT], 4),
    );
    expect(plans).toHaveLength(12);
    expect(new Set(plans.map((p) => p.variantId)).size).toBe(3);
    for (const variantId of ["alt-model", "hot", "patient"]) {
      expect(plans.filter((p) => p.variantId === variantId).map((p) => p.repetition)).toEqual([1, 2, 3, 4]);
    }
  });
});
