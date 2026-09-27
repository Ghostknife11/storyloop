/**
 * v2.2.0 Creator Health：**确定性**的项目/创作健康判定（TASK §16/§17/§18/§19）。
 *
 * 这个模块回答六个问题，而且只回答这六个：
 *   当前项目是否可继续创作？最近一次 Run 是否正常？当前 Draft 是否存在？
 *   质量诊断里有没有 blocker？是不是频繁 Retry / Repair？有没有已导出的稿件？
 *
 * 三条硬约束，写在这里也测在这里：
 *   1. **纯函数**。输入是一份观察结果（HealthObservation），输出是结论；
 *      不读磁盘、不调模型、不认时间（updatedAt 由调用方给）。所以同一份观察
 *      永远得到同一个结论，测试里也不用 mock 任何东西。
 *   2. **只看可观测量**。每一条信号背后都必须是一件已经发生、能指出来源的事实：
 *      哪一次 Run、哪一篇稿件、哪一个导出物。不推导、不预测、不给建议。
 *   3. **不建议改模型 / 改提示词 / 改温度**（§19）。这里能说的是「有 2 条质量
 *      warning」，不能说的是「换成更强的模型」。前者是事实，后者是主张——
 *      而这个版本没有能力为任何主张背书。
 *
 * 状态怎么定（§18）：
 *   blocked   = 有硬失败/规划或校验 blocker / 最近一次关键流程失败
 *   attention = 有 warning（质量偏低 / 重试耗尽 / 审阅已过期）
 *   healthy   = 一条 blocker 都没有
 * 「healthy」不是「没有问题」，而是「没有需要用户现在处理的问题」——
 *   info 级的信号照样列出来，只是不把状态顶上去。
 */

/** 信号严重度。 */
export type HealthSeverity = "info" | "warning" | "error";

/** 项目健康状态。 */
export type HealthStatus = "healthy" | "attention" | "blocked";

/** 一条信号：稳定码 + 严重度 + 人话 + 可选的出处。 */
export interface HealthSignal {
  /** 稳定码（snake_case），UI 与测试都认它，不认 message——文案会改，码不改。 */
  code: string;
  severity: HealthSeverity;
  /** 一句话说清这件事。不做建议。 */
  message: string;
  /** 出处：Run id / 稿件 id。说不出来的信号整个键不出现，不写 null。 */
  source?: string;
}

/** 结论。signals 顺序固定（按码排序），同一输入必得同一输出。 */
export interface ProjectHealthResult {
  status: HealthStatus;
  signals: HealthSignal[];
  updatedAt: string;
}

/** 最近一次 Run 的结局。null = 这个项目还没有 Run，不是「失败」。 */
export type LatestRunOutcome = "accepted" | "exhausted" | "failed";

/**
 * 观察结果：一份**已经发生的事实**清单。
 *
 * 全是可选项以外的东西都能缺：缺的那一项表示「不知道」，而「不知道」不出信号——
 * 把「读不到质量结论」画成一条 warning 会让用户以为自己写的东西有问题。
 */
export interface HealthObservation {
  /** 归这个项目的 Run 数。0 是一条事实（刚建的项目），不是缺失。 */
  runCount: number;
  /** 需要过重试或修订的 Run 占比（0..1）。null = 没有 Run，此时算不出占比。 */
  retriedShare: number | null;
  /** 最近一次 Run 的结局；null = 没有 Run 或读不到结局。 */
  latestRunOutcome: LatestRunOutcome | null;
  /** 最近一次 Run 里 error 级质量问题的条数；null = 没有质量结论。 */
  qualityErrorCount: number | null;
  /** 最近一次 Run 里 warning 级质量问题的条数；null = 没有质量结论。 */
  qualityWarningCount: number | null;
  /**
   * 当前稿件的正文是否仍与它来源那次 Run 的正文逐字一致。
   * true = 质量结论还对着这一版；false = 编辑过，旧结论不能再当成这一版的质量。
   * null = 无从比较（没有当前稿件 / 稿件不是从 Run 来的 / 那次 Run 已不在）。
   */
  qualityCurrent: boolean | null;
  /** 项目下有没有当前在写的稿件。 */
  hasCurrentDocument: boolean;
  /** 已导出的件数。 */
  exportCount: number;
  /** 项目是否已归档。归档不改变任何健康判定，只是让用户知道自己在看旧项目。 */
  archived: boolean;
  /** 这些信号指得出的出处：最近一次 Run 与当前稿件的 id。 */
  latestRunId?: string;
  documentId?: string;
}

/**
 * "频繁重试" 的判据：这个项目里过半的 Run 都要靠重试或修订才收场。
 *
 * 单独抽出来是个常数而不是藏在 if 里，因为这个数没有客观标准——有人觉得三成就算
 * 频繁。把它显式写在代码里，将来要调的时候知道该动哪里，测试也知道该测哪里。
 */
export const RETRY_PRESSURE_SHARE = 0.5;

/**
 * 一条质量问题里能用来分桶的两个字段。刻意不 import QualityResult：
 * Domain 不需要知道质量结论长什么样，只需要它愿不愿意亮出来的这两个属性。
 */
export interface QualityIssueShape {
  /** 问题出自校验侧还是审阅侧。 */
  source?: string;
  /** 校验侧自己标的严重度；审阅侧的问题没有这个字段。 */
  severity?: string;
}

/**
 * 把一次运行的质量问题分成「硬伤」与「建议」两桶。
 *
 * 判据不是健康模块自己发明的，而是仓库既有口径：只有校验侧的问题本来就有 severity
 * （见 domain/quality.ts 里 QualityIssue.severity 的注释），因为只有它们能让一次
 * 运行被判不通过；审阅侧的问题一条都没有严重度，它们全是建议。
 *
 * 所以：severity 是 error → 硬伤；其余（校验侧的 warning、以及全部审阅侧问题）→ 建议。
 * 「没有严重度」在这一步算建议而不是「不知道」，这句话对整个评审体系成立：
 * 审阅侧的意见从来没有、也不该有让一次运行失败的能力。
 */
export function countQualityIssues(issues: QualityIssueShape[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** 出信号一律经过这里：按码排序，同一份观察必得同一串信号。 */
function finalize(signals: HealthSignal[]): HealthSignal[] {
  return [...signals].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function statusOf(signals: HealthSignal[]): HealthStatus {
  if (signals.some((s) => s.severity === "error")) return "blocked";
  if (signals.some((s) => s.severity === "warning")) return "attention";
  return "healthy";
}

/**
 * 判定健康。纯函数：同一份 observation 与同一个 updatedAt 必得同一份结论。
 *
 * 规则的顺序就是上面注释里的顺序，一条规则一条规则独立判，互不掩盖——
 * 一次失败的 Run 和一个过期稿件可以同时出现，用户两个都要看见。
 */
export function assessProjectHealth(observation: HealthObservation, updatedAt: string): ProjectHealthResult {
  const signals: HealthSignal[] = [];

  if (observation.runCount === 0) {
    signals.push({ code: "no_runs", severity: "info", message: "这个项目还没有任何运行记录" });
  }

  if (
    observation.latestRunOutcome === "failed" ||
    observation.latestRunOutcome === "exhausted"
  ) {
    const reason = observation.latestRunOutcome === "exhausted" ? "重试预算用尽仍未被接受" : "这一次运行失败";
    signals.push({
      code: "latest_run_failed",
      severity: "error",
      message: `最近一次运行没有产出正文：${reason}`,
      ...(observation.latestRunId !== undefined ? { source: observation.latestRunId } : {}),
    });
  }

  if (observation.qualityErrorCount !== null && observation.qualityErrorCount > 0) {
    signals.push({
      code: "quality_blockers",
      severity: "error",
      message: `最近一次运行的质量诊断有 ${observation.qualityErrorCount} 项 blocker`,
      ...(observation.latestRunId !== undefined ? { source: observation.latestRunId } : {}),
    });
  }

  if (observation.qualityWarningCount !== null && observation.qualityWarningCount > 0) {
    signals.push({
      code: "quality_warnings",
      severity: "warning",
      message: `最近一次运行的质量诊断有 ${observation.qualityWarningCount} 项 warning`,
      ...(observation.latestRunId !== undefined ? { source: observation.latestRunId } : {}),
    });
  }

  if (!observation.hasCurrentDocument && observation.runCount > 0) {
    signals.push({
      code: "no_current_document",
      severity: "warning",
      message: "有运行记录但还没有在写的稿件：可以从任意一次运行建一篇",
    });
  }

  if (observation.qualityCurrent === false) {
    signals.push({
      code: "quality_stale",
      severity: "warning",
      message: "当前稿件在最近一次审阅之后改过：那次质量结论不再代表这一版",
      ...(observation.documentId !== undefined ? { source: observation.documentId } : {}),
    });
  }

  if (observation.retriedShare !== null && observation.retriedShare >= RETRY_PRESSURE_SHARE) {
    signals.push({
      code: "retry_pressure",
      severity: "warning",
      message: `这个项目过半的运行都要靠重试或修订才收场（${Math.round(observation.retriedShare * 100)}%）`,
    });
  }

  if (observation.hasCurrentDocument && observation.exportCount === 0) {
    signals.push({
      code: "no_exports",
      severity: "info",
      message: "当前稿件还没有导出过 DOCX / EPUB",
      ...(observation.documentId !== undefined ? { source: observation.documentId } : {}),
    });
  }

  if (observation.archived) {
    signals.push({ code: "archived", severity: "info", message: "项目已归档：里面的运行与稿件都还在，只是不再出现在默认列表最前面" });
  }

  const finalized = finalize(signals);
  return { status: statusOf(finalized), signals: finalized, updatedAt };
}

/** 码的完整清单。UI 与文档用它保证「没有未登记的码」。 */
export const HEALTH_SIGNAL_CODES = [
  "archived",
  "latest_run_failed",
  "no_current_document",
  "no_exports",
  "no_runs",
  "quality_blockers",
  "quality_stale",
  "quality_warnings",
  "retry_pressure",
] as const;

export type HealthSignalCode = (typeof HEALTH_SIGNAL_CODES)[number];
