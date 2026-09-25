/**
 * v1.7.0 变量合并与样本展开：一份实验定义 → 一组「这次样本实际用什么的」配置。
 *
 * 只有一件事在这里发生：把 Base 与某个 Variant 的 Overrides 合成一份
 * `EffectiveRunConfig`，再按 Variant × repetition 展开成有序的样本清单。
 * 展开顺序固定（Variant 声明顺序为外循环、repetition 为内循环），
 * 因此同一份定义在任何机器上跑出来的样本顺序都一样。
 *
 * 这里的合并只动白名单内的四项（model / temperature / retry.maxAttempts /
 * retry.minReviewScore）。别的键在定义校验阶段就已经被拒绝——
 * 见 `src/types/experiment.ts` 里 NO_EFFECT_OVERRIDE_REASONS 的说明。
 *
 * 地址（baseUrl）刻意不出现在合并结果里：实验样本一律走服务端 LLM_BASE_URL，
 * `clientFor()` 仍会跑 v1.1.0 的公网地址断言，等于每一条样本都过一次关卡。
 */

import type { RetryPolicy } from "@/core/retry-policy";
import { DEFAULT_RETRY_POLICY } from "@/core/retry-policy";
import type { BeatPlan } from "@/types/beat-plan";
import type { StoryConfig } from "@/types/story-config";
import type { ExperimentDefinition, ExperimentVariant } from "@/types/experiment";

/** 一条样本实际生效的配置：Base 合并一个 Variant 之后的结果。 */
export interface EffectiveRunConfig {
  storyConfig: StoryConfig;
  /** fixed 模式：整份骨架（所有 Variant、所有 repetition 共用同一份）。 */
  beatPlan: BeatPlan | null;
  /** undefined = 不覆盖，用服务端默认模型。 */
  model: string | undefined;
  /** undefined = 不覆盖，用服务端默认温度。 */
  temperature: number | undefined;
  retryPolicy: RetryPolicy;
}

/** §21 展开后的一个格子：哪个 Variant、第几次 repetition、实际用什么配置。 */
export interface ExperimentRunPlan {
  variantId: string;
  variantName: string;
  repetition: number;
  config: EffectiveRunConfig;
  /** 这一格里相对 Base 真正改动的项，UI 用它说明「这个 Variant 改了啥」。 */
  changes: VariantChanges;
}

/** UI 里展示「这个 Variant 改了哪些变量」用的小结构；只有覆盖了的键才出现。 */
export interface VariantChanges {
  model?: { from: string | null; to: string };
  temperature?: { from: number | null; to: number };
  maxAttempts?: { from: number | null; to: number };
  minReviewScore?: { from: number | null; to: number };
}

/**
 * Base + Overrides → 生效配置。
 *
 * `from` 用 Base 的值（没写就是 null，表示「沿用服务端默认」），
 * 这样 UI 能把「默认 → 覆盖后」摆出来，而不是只给一个孤零零的覆盖值。
 */
export function mergeOverrides(
  base: ExperimentDefinition["base"],
  variant: ExperimentVariant,
): { config: EffectiveRunConfig; changes: VariantChanges } {
  const retryPolicy: RetryPolicy = { ...(base.retryPolicy ?? DEFAULT_RETRY_POLICY) };
  const changes: VariantChanges = {};

  if (variant.overrides.retry?.maxAttempts !== undefined) {
    changes.maxAttempts = { from: retryPolicy.max_attempts, to: variant.overrides.retry.maxAttempts };
    retryPolicy.max_attempts = variant.overrides.retry.maxAttempts;
  }
  if (variant.overrides.retry?.minReviewScore !== undefined) {
    changes.minReviewScore = { from: retryPolicy.min_review_score, to: variant.overrides.retry.minReviewScore };
    retryPolicy.min_review_score = variant.overrides.retry.minReviewScore;
  }

  return {
    config: {
      storyConfig: base.storyConfig,
      beatPlan: base.beatPlanMode === "fixed" ? (base.beatPlan ?? null) : null,
      model: variant.overrides.model ?? base.modelConfig?.model,
      temperature: variant.overrides.generation?.temperature ?? base.generationParameters?.temperature,
      retryPolicy,
    },
    changes,
  };
}

/**
 * §21 Variant × repetition 展开。
 *
 * 外循环是 Variant（按声明顺序），内循环是 repetition（1 起）。
 * 顺序固定不是美学问题：runs.json 与 results.json 都按这个顺序写，
 * UI 结果表也按这个顺序排，三者对照时才对得上。
 */
export function expandExperiment(definition: ExperimentDefinition): ExperimentRunPlan[] {
  const plans: ExperimentRunPlan[] = [];
  for (const variant of definition.variants) {
    const { config, changes } = mergeOverrides(definition.base, variant);
    for (let repetition = 1; repetition <= definition.repetitions; repetition += 1) {
      plans.push({ variantId: variant.id, variantName: variant.name, repetition, config, changes });
    }
  }
  return plans;
}
