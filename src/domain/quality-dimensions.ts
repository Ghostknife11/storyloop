/**
 * v1.3.0 多维度审阅：四个基础质量维度（TASK §2/§3）。
 *
 * 边界说明（§34）：维度只是「评价输出」——多给几个可解释的视角，
 * 不参与任何决策。RetryPolicy / RepairStrategy 仍然只看 overall_score 与
 * validation_passed（§19/§23），也没有按维度阈值触发的重试或修订。
 */

/** §3 全部维度键，顺序即承诺的顺序：报告与 UI 都按这个顺序呈现。 */
export const QUALITY_DIMENSION_KEYS = [
  "coherence",
  "narrative",
  "character",
  "causality",
] as const;

export type QualityDimensionKey = (typeof QUALITY_DIMENSION_KEYS)[number];

/** §2 单个维度：0 ~ 100 的分数 + 一段短评。 */
export interface DimensionAssessment {
  score: number;
  summary: string;
}

/** §3 四个维度必须齐全；缺一个就不是合法的多维度结论。 */
export type QualityDimensions = Record<QualityDimensionKey, DimensionAssessment>;

/** §2 维度分与整体分同一区间。 */
export const DIMENSION_SCORE_MIN = 0;
export const DIMENSION_SCORE_MAX = 100;

/** §36/§37 UI 与文档里用的中文维度名，与 QUALITY_DIMENSION_KEYS 一一对应。 */
export const DIMENSION_LABELS: Record<QualityDimensionKey, string> = {
  coherence: "连贯性",
  narrative: "叙事",
  character: "人物",
  causality: "因果",
};

/** §3 维度的定义口径：审阅提示词、文档与 UI 共用同一句话，避免各说各话。 */
export const DIMENSION_DEFINITIONS: Record<QualityDimensionKey, string> = {
  coherence: "整体连贯性：设定、称呼、时间线前后是否一致",
  narrative: "叙事结构与节奏：起承转合是否完整、详略是否得当",
  character: "人物一致性与动机：言行是否符合其目标与处境",
  causality: "因果链：事件推进是否有清楚的前因后果",
};

export function isQualityDimensionKey(value: unknown): value is QualityDimensionKey {
  return typeof value === "string" && (QUALITY_DIMENSION_KEYS as readonly string[]).includes(value);
}

/**
 * §4 确定性聚合：overall = 四个维度均分，四舍五入到 1 位小数。
 * 纯算术，不含权重、不含模型调用——同样的维度永远得到同样的 overall。
 */
export function aggregateDimensionScore(dimensions: QualityDimensions): number {
  const total = QUALITY_DIMENSION_KEYS.reduce(
    (sum, key) => sum + dimensions[key].score,
    0,
  );
  return Math.round((total / QUALITY_DIMENSION_KEYS.length) * 10) / 10;
}
