/**
 * v1.5.0 商业可读性审阅（TASK §9/§10/§11）。
 *
 * 与 v1.3.0 的四个基础质量维度（Co/N/C/Ca）是两套独立评价：
 * 那一套回答「这篇故事写得是否成立」，这一套回答「读起来是否抓人」。
 * 两套之间不做换算、不做合并、不互相驱动（TASK §12/§26）——
 * QualityResult 仍然只承载 Co/N/C/Ca，商业结论独立存在于自己的产物与 API 字段里。
 *
 * 边界（TASK §14/§15/§29）：商业分只是启发式评价输出，不是市场预测。
 * 它不能改写正文、不能触发重试或修订，也不会被包装成爆款概率 / 销量预测。
 */

export class CommercialReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommercialReviewValidationError";
  }
}

/** §8 商业维度分与整体分同一区间：0 ~ 100。 */
export const COMMERCIAL_SCORE_MIN = 0;
export const COMMERCIAL_SCORE_MAX = 100;

/**
 * §3 固定商业四维：顺序即承诺的顺序，报告与 UI 都按这个顺序呈现。
 * 本版本固定这四个，不按题材增减（TASK §11 禁止动态权重与题材适配权重）。
 */
export const COMMERCIAL_DIMENSION_KEYS = [
  "hook",
  "pacing",
  "engagement",
  "payoff",
] as const;

export type CommercialDimensionKey = (typeof COMMERCIAL_DIMENSION_KEYS)[number];

/** §9 单个商业维度：0 ~ 100 的分数 + 一段短评。 */
export interface CommercialDimensionAssessment {
  score: number;
  summary: string;
}

/** §9 四个维度必须齐全；缺一个就不是一份合法的商业审阅结论。 */
export type CommercialDimensions = Record<CommercialDimensionKey, CommercialDimensionAssessment>;

/**
 * §24 商业审阅状态：与 Run status 分开记录，这一路失败不影响 Run 本身。
 * not_started 也表示「这次 Run 根本没接商业审阅者」——与 Beat 校验状态同一约定。
 */
export type CommercialReviewStatus = "not_started" | "reviewing" | "completed" | "failed";

/** §10 CommercialReviewResult：整体分 + 总结 + 优点 + 问题 + 建议 + 四个商业维度。 */
export interface CommercialReviewResult {
  /** §11：永远是四个维度的确定性均分（见 aggregateCommercialDimensions）。 */
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
  suggestions: string[];
  dimensions: CommercialDimensions;
}

/** §47 README 维度表：键、维度名、含义——审阅提示词、文档与 UI 共用同一份。 */
export const COMMERCIAL_DIMENSION_LABELS: Record<CommercialDimensionKey, string> = {
  hook: "Hook",
  pacing: "Pacing",
  engagement: "Engagement",
  payoff: "Payoff",
};

/** §47 短标记：UI 面板里与维度名并排显示（H / P / E / Pf）。 */
export const COMMERCIAL_DIMENSION_SHORTS: Record<CommercialDimensionKey, string> = {
  hook: "H",
  pacing: "P",
  engagement: "E",
  payoff: "Pf",
};

/** §47 维度定义口径：与 README 维度表的 Meaning 列逐字一致。 */
export const COMMERCIAL_DIMENSION_DEFINITIONS: Record<CommercialDimensionKey, string> = {
  hook: "开篇抓力、冲突进入速度",
  pacing: "阅读节奏、拖沓与推进速度",
  engagement: "全篇持续阅读动力",
  payoff: "高潮与结尾对前文承诺的回报",
};

export function isCommercialDimensionKey(value: unknown): value is CommercialDimensionKey {
  return typeof value === "string" && (COMMERCIAL_DIMENSION_KEYS as readonly string[]).includes(value);
}

/**
 * §11 确定性聚合：overall = (H + P + E + Pf) / 4，四舍五入到 1 位小数。
 * 纯算术：没有题材权重、没有动态权重、没有学习出来的权重——
 * 同样的四个维度无论在什么机器、什么时间跑，都得到同一个 overall。
 */
export function aggregateCommercialDimensions(dimensions: CommercialDimensions): number {
  const total = COMMERCIAL_DIMENSION_KEYS.reduce(
    (sum, key) => sum + dimensions[key].score,
    0,
  );
  return Math.round((total / COMMERCIAL_DIMENSION_KEYS.length) * 10) / 10;
}

/**
 * §11 商业整体分：只有一个口径，就是四维均分。
 * QualityAssembler 的 overall_score、metadata 的 commercial_score、
 * RetryPolicy 看不到的这块、UI 面板显示的分，读的都是这一个函数。
 */
export function commercialOverallScore(review: CommercialReviewResult): number {
  return aggregateCommercialDimensions(review.dimensions);
}

function commercialItems(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new CommercialReviewValidationError(`${field} 必须是数组`);
  return raw.map((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new CommercialReviewValidationError(`${field}[${i}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

/**
 * §23 商业维度 schema：出现就必须四个齐全、各自 0 ~ 100 且带非空短评。
 * 缺维度、多维度、类型不对、分数越界一律按解析失败处理——不补 0、不挑一个先凑着，
 * 因为补出来的数会被当成真实评价参与聚合与展示。
 */
export function validateCommercialDimensions(raw: unknown): CommercialDimensions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialReviewValidationError("dimensions 必须是包含四个商业维度的对象");
  }
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(COMMERCIAL_DIMENSION_KEYS);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      throw new CommercialReviewValidationError(
        `dimensions 包含未知维度 ${key}（只支持 ${COMMERCIAL_DIMENSION_KEYS.join(" / ")}）`,
      );
    }
  }

  const out = {} as CommercialDimensions;
  for (const key of COMMERCIAL_DIMENSION_KEYS) {
    const d = r[key];
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      throw new CommercialReviewValidationError(`dimensions.${key} 缺失或不是对象`);
    }
    const { score, summary } = d as Record<string, unknown>;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new CommercialReviewValidationError(`dimensions.${key}.score 必须是数字`);
    }
    if (score < COMMERCIAL_SCORE_MIN || score > COMMERCIAL_SCORE_MAX) {
      throw new CommercialReviewValidationError(
        `dimensions.${key}.score 必须在 ${COMMERCIAL_SCORE_MIN} ~ ${COMMERCIAL_SCORE_MAX} 之间（实际 ${score}）`,
      );
    }
    const text = typeof summary === "string" ? summary.trim() : "";
    if (!text) throw new CommercialReviewValidationError(`dimensions.${key}.summary 不能为空`);
    out[key] = { score, summary: text };
  }
  return out;
}

/**
 * §23 商业审阅输出 schema：score / summary / strengths / problems / suggestions /
 * 四个维度齐全，各自都要过校验。
 *
 * 注意 score 的双重身份：模型必须给出它（缺了或越界就是非法输出），但落盘与返回的
 * 永远是四个维度的确定性均分——模型自报的分数与四维不一致时以均分为准，
 * 这样「商业整体分」才可复现，也不会出现一个模型随口报的高分盖住四个维度的实情。
 */
export function validateCommercialReviewResult(raw: unknown): CommercialReviewResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const score = r.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new CommercialReviewValidationError("score 必须是数字");
  }
  if (score < COMMERCIAL_SCORE_MIN || score > COMMERCIAL_SCORE_MAX) {
    throw new CommercialReviewValidationError(
      `score 必须在 ${COMMERCIAL_SCORE_MIN} ~ ${COMMERCIAL_SCORE_MAX} 之间（实际 ${score}）`,
    );
  }

  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) throw new CommercialReviewValidationError("summary 不能为空");

  const dimensions = validateCommercialDimensions(r.dimensions);
  return {
    score: aggregateCommercialDimensions(dimensions),
    summary,
    strengths: commercialItems(r.strengths, "strengths"),
    problems: commercialItems(r.problems, "problems"),
    suggestions: commercialItems(r.suggestions, "suggestions"),
    dimensions,
  };
}

/**
 * §32 读旧 Run 用的宽容版 schema：磁盘上的 commercial-review.json 可能来自手改，
 * 也可能根本不存在（v1.5.0 之前的 Run）。读接口的承诺是「不失败，最差 null」，
 * 所以这里不抛异常，只回答「这份结论能不能用」，并且只认已知字段——
 * 认不出的键不进响应，缺字段按解析失败处理，绝不补默认值冒充真实评价。
 */
export function commercialReviewResultOf(raw: unknown): CommercialReviewResult | null {
  try {
    return validateCommercialReviewResult(raw);
  } catch {
    return null;
  }
}
