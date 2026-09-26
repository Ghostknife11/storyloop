/**
 * v1.9.0 §23 FailureAnalyzer：把已经发生的事实归类成失败类别。
 *
 * §23/§56 三条硬约束，本文件一条都不破：
 *   1. 纯确定性——同样的输入必然得到同样的输出，没有随机、没有时间、没有顺序歧义。
 *   2. 不调用网络、不调用 LLM。整个文件没有 import 任何客户端。
 *   3. 只读输入里给的事实，**不新增采集**。输入拿不到的就是拿不到，
 *      于是那一项不出现，而不是被补一个看起来合理的值（§49）。
 *
 * §24 本版本禁止 LLM 归因：所以这里不会出现「根因是提示词太长 / 模型能力不足 /
 * 温度不合理」一类句子。能说的只有「Run 在哪个阶段被阻止、存在哪个码、
 * 哪个证据文件里看得见」。
 *
 * §21/§22 Primary / Secondary：primary 取优先级最高的类别，
 * secondary 是其余类别按同一优先级排序——顺序确定，不靠输入顺序。
 */

import { categoryOfCode, categoryPriority } from "@/lib/failure-rules";
import { CATEGORY_LABELS } from "@/types/failure-analysis";
import type { StageName } from "@/types/telemetry";
import type {
  FailureAnalysisInput,
  FailureAnalysisResult,
  FailureCategory,
  FailureEvidence,
  FailureSignal,
  FailureSignalSource,
} from "@/types/failure-analysis";
import { FAILURE_ANALYSIS_SCHEMA_VERSION, isFailureCategory } from "@/types/failure-analysis";
import { QUALITY_DIMENSION_KEYS } from "@/types/quality-dimensions";
import { COMMERCIAL_DIMENSION_KEYS } from "@/types/commercial-review";

/** §41 已知 stage 的大类降级表：码不认识时，至少知道它死在哪一段。 */
const STAGE_CATEGORY: Record<StageName, FailureCategory> = {
  planning: "PLANNING",
  validating_beat_plan: "PLANNING",
  generating: "GENERATION",
  repairing: "GENERATION",
  saving: "STORAGE",
  artifact_promotion: "STORAGE",
  validating: "VALIDATION",
  revalidating: "VALIDATION",
  reviewing: "REVIEWER",
  rereviewing: "REVIEWER",
  reviewing_commercial: "REVIEWER",
};

/** §36/§37 薄弱维度对应的信号码：与 quality / commercial 的维度键一一对应。 */
const QUALITY_WEAKNESS_CODES: Record<string, string> = {
  coherence: "WEAK_COHERENCE",
  narrative: "WEAK_NARRATIVE",
  character: "WEAK_CHARACTER",
  causality: "WEAK_CAUSALITY",
};

const COMMERCIAL_WEAKNESS_CODES: Record<string, string> = {
  hook: "WEAK_HOOK",
  pacing: "WEAK_PACING",
  engagement: "WEAK_ENGAGEMENT",
  payoff: "WEAK_PAYOFF",
};

/** 内部信号：多一个「这个信号能不能定类」的开关（§42：辅助信号不定类）。 */
interface RawSignal {
  signal: FailureSignal;
  /** null 表示这条只是背景 / 辅助观察，不进任何类别。 */
  category: FailureCategory | null;
  evidence: FailureEvidence[];
}

export class FailureAnalyzer {
  /**
   * §23：确定性分类。整个流程只有三步——
   *   收信号（每条都带证据）→ 定类别（规则表 + 优先级）→ 写结论。
   * 任何一步拿不到事实就跳过那一步，不补默认值。
   */
  analyze(input: FailureAnalysisInput): FailureAnalysisResult {
    const raw = this.collect(input);
    const failureEvidenceExists = this.hasFailureEvidence(input, raw);

    const categories = new Map<FailureCategory, FailureEvidence[]>();
    for (const item of raw) {
      if (item.category === null) continue;
      const list = categories.get(item.category) ?? [];
      list.push(...item.evidence);
      categories.set(item.category, list);
    }

    const ordered = [...categories.keys()].sort(
      (a, b) => categoryPriority(a) - categoryPriority(b) || a.localeCompare(b),
    );
    const primary = ordered.length > 0 ? ordered[0] : null;
    const secondary = ordered.slice(1);

    // §49：没失败证据就一道信号都不发——成功 Run 干干净净（§28/§46）
    const signals = failureEvidenceExists ? raw.map((item) => item.signal) : [];
    const evidence = failureEvidenceExists
      ? raw.flatMap((item) => item.evidence)
      : [];

    const status: FailureAnalysisResult["status"] = !failureEvidenceExists
      ? "none"
      : ordered.length === 0
        ? "unknown"
        : raw.some((item) => item.signal.code === "UNRECOGNIZED_FAILURE_CODE")
          ? "partial"
          : "detected";

    return {
      schemaVersion: FAILURE_ANALYSIS_SCHEMA_VERSION,
      runId: input.runId,
      status,
      primaryCategory: status === "none" ? null : primary,
      secondaryCategories: status === "none" ? [] : secondary,
      summary: this.summaryOf(input, status, primary, secondary),
      signals,
      evidence,
      firstFailureStage: failureEvidenceExists ? this.firstFailureStage(input) : null,
      terminalState: input.status ?? input.telemetry?.status ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // 信号收集：每一条都从「已经存在的事实」来
  // -------------------------------------------------------------------------

  private collect(input: FailureAnalysisInput): RawSignal[] {
    const out: RawSignal[] = [];
    const push = (
      code: string,
      source: FailureSignalSource,
      severity: FailureSignal["severity"],
      message: string,
      category: FailureCategory | null,
      evidence: FailureEvidence[] = [],
    ): void => {
      out.push({ signal: { code, source, severity, message }, category, evidence });
    };

    // §15 安全策略：只陈述「被阻止」，不陈述「被谁攻击」
    for (const code of SECURITY_SIGNAL_CODES) {
      if (!input.errorCodes.includes(code)) continue;
      push(
        code,
        "security",
        "error",
        `安全策略阻止了这次操作（${code}）。`,
        "SECURITY",
        [{ code, note: "错误码由运行阶段的异常链给出。" }],
      );
    }

    // §5 配置：这次 Run 在开始之前就不该被接受
    for (const code of CONFIGURATION_SIGNAL_CODES) {
      if (!input.errorCodes.includes(code)) continue;
      push(
        code,
        "metadata",
        "error",
        `配置或前置条件不满足（${code}），Run 未能按预期开始。`,
        "CONFIGURATION",
        [{ code, note: "错误码由运行阶段的异常链给出。" }],
      );
    }

    // §14 存储
    if (input.errorCodes.includes("ARTIFACT_WRITE_FAILED")) {
      push(
        "ARTIFACT_WRITE_FAILED",
        "storage",
        "error",
        "产物写入失败：这次 Run 有结论没能完整落盘。",
        "STORAGE",
        [{ code: "ARTIFACT_WRITE_FAILED", note: "错误码由运行阶段的异常链给出。" }],
      );
    }

    // §6 规划：骨架结构结论
    const beatErrors = (input.beatValidation?.issues ?? []).filter((i) => i.severity === "error");
    for (const issue of beatErrors) {
      push(
        issue.code,
        "beat-validation",
        "error",
        `剧情骨架存在结构问题：${issue.message}`,
        categoryOfCode(issue.code),
        [
          {
            sourceArtifact: "beat-validation.json",
            sourceField: "issues[].code",
            code: issue.code,
            note: issue.message,
          },
        ],
      );
    }
    for (const code of ["BEAT_VALIDATION_FAILED", "BEAT_VALIDATION_COMPONENT_FAILED"]) {
      if (!input.errorCodes.includes(code)) continue;
      const component = code === "BEAT_VALIDATION_COMPONENT_FAILED";
      push(
        code,
        "beat-validation",
        "error",
        component
          ? "骨架校验组件自身失败：这一跳没得出结论，不代表骨架有问题。"
          : "骨架结构校验未通过，正文生成被阻止。",
        "PLANNING",
        [{ code, note: component ? "校验组件自身异常。" : "骨架校验未通过。" }],
      );
    }
    if (input.errorCodes.includes("PLANNER_INVALID_OUTPUT")) {
      push(
        "PLANNER_INVALID_OUTPUT",
        "beat-validation",
        "error",
        "规划阶段没有给出可用的剧情骨架。",
        "PLANNING",
        [{ code: "PLANNER_INVALID_OUTPUT", note: "规划输出无法解析成 BeatPlan。" }],
      );
    }

    // §7 生成
    for (const code of ["LLM_TIMEOUT", "LLM_REQUEST_FAILED", "LLM_EMPTY_RESPONSE", "GENERATION_FAILED"]) {
      if (!input.errorCodes.includes(code)) continue;
      const message = GENERATION_MESSAGES[code];
      // v1.9.1：没有 telemetry.json 就不指这个盘上不存在的文件，只留码与说明
      push(code, "telemetry", "error", message, "GENERATION", [
        input.telemetry
          ? {
              sourceArtifact: "telemetry.json",
              ...(input.telemetry.failureCode ? { sourceField: "failureCode" } : {}),
              stage: input.telemetry.failureStage ?? null,
              code,
              note: message,
            }
          : { code, note: `${message}（这次 Run 没有 telemetry.json 可指。）` },
      ]);
    }

    // §8 校验
    const storyErrors = (input.validation?.issues ?? []).filter((i) => i.severity === "error");
    for (const issue of storyErrors) {
      push(
        issue.code,
        "story-validation",
        "error",
        `正文校验未通过：${issue.message}`,
        categoryOfCode(issue.code),
        [
          {
            sourceArtifact: "validation.json",
            sourceField: "issues[].code",
            code: issue.code,
            note: issue.message,
          },
        ],
      );
    }
    for (const code of ["VALIDATION_FAILED_INTERNAL", "VALIDATION_COMPONENT_FAILED"]) {
      if (!input.errorCodes.includes(code)) continue;
      push(
        code,
        "story-validation",
        "error",
        "正文校验组件自身失败：这一跳没得出结论，不代表正文有问题。",
        "VALIDATION",
        [{ code, note: "校验组件自身异常。" }],
      );
    }

    // §13 审阅：与「故事质量差」严格分开
    for (const code of REVIEWER_SIGNAL_CODES) {
      if (!input.errorCodes.includes(code)) continue;
      push(
        code,
        code.startsWith("COMMERCIAL") ? "commercial-review" : "quality-review",
        "error",
        "审阅环节自身失败：没拿到这一跳的结论，不代表故事质量差。",
        "REVIEWER",
        [{ code, note: "审阅组件自身异常或输出不合法。" }],
      );
    }

    // §38 重试耗尽：只看 attempt 数、上限与采纳结论
    if (this.retryExhausted(input)) {
      push(
        "RETRY_LIMIT_REACHED",
        "retry",
        "error",
        `重试次数已用尽：${textOf(input.attemptCount)} 次 Attempt 达到上限 ${textOf(input.maxAttempts)}，最终没有被采纳。`,
        "RETRY_EXHAUSTION",
        [
          {
            sourceArtifact: "metadata.json",
            sourceField: "attempt_count",
            value: input.attemptCount,
            note: `attempt_count = ${textOf(input.attemptCount)}，max_attempts = ${textOf(input.maxAttempts)}。`,
          },
          {
            sourceArtifact: "metadata.json",
            sourceField: "quality_status",
            value: input.qualityStatus,
            note: `最终采纳结论：${textOf(input.qualityStatus)}。`,
          },
        ],
      );
    }

    // §39 修订耗尽：上限、次数、目标问题是否还在
    if (this.repairExhausted(input)) {
      // v1.9.1：Run 级合计与每次 Attempt 的上限是两个口径，消息里分开说。
      // 写成「3 轮修订达到上限 2」会让读者把两个数当成同一件事
      const last = lastRepairOf(input);
      push(
        "REPAIR_LIMIT_REACHED",
        "repair",
        "error",
        `修订次数已用尽：本次 Run 共 ${textOf(input.repairCount)} 轮修订，每次 Attempt 上限 ${textOf(input.maxRepairsPerAttempt)} 轮，目标问题仍然存在。`,
        "REPAIR_EXHAUSTION",
        [
          {
            sourceArtifact: "metadata.json",
            sourceField: "repair_count",
            value: input.repairCount,
            note: `repair_count = ${textOf(input.repairCount)}（Run 级合计），max_repairs_per_attempt = ${textOf(input.maxRepairsPerAttempt)}（每次 Attempt 上限）。`,
          },
          {
            sourceArtifact: "run-manifest.json",
            sourceField: "repairs[].succeeded",
            ...(last?.attemptId != null ? { attemptId: last.attemptId } : {}),
            ...(last?.repairId != null ? { repairId: last.repairId } : {}),
            note: "修订记录里能看到每一轮的成败。",
          },
        ],
      );
    }

    // §9 质量：低于策略阈值
    const threshold = input.minReviewScore;
    if (
      typeof input.quality?.overall_score === "number" &&
      typeof threshold === "number" &&
      input.quality.overall_score < threshold
    ) {
      push(
        "QUALITY_BELOW_THRESHOLD",
        "quality-review",
        "warning",
        `整体质量分 ${input.quality.overall_score} 低于策略阈值 ${threshold}。`,
        "QUALITY",
        [
          {
            sourceArtifact: "quality.json",
            sourceField: "overall_score",
            value: input.quality.overall_score,
            note: `min_review_score = ${threshold}。`,
          },
        ],
      );
    }
    // §36 薄弱维度：只说「观测到的最低维度」，不说「这就是原因」
    const weakestQuality = weakestOf(
      input.quality?.dimensions,
      QUALITY_DIMENSION_KEYS,
    );
    if (weakestQuality) {
      push(
        QUALITY_WEAKNESS_CODES[weakestQuality.key] ?? "WEAK_QUALITY_DIMENSION",
        "quality-review",
        "warning",
        `观测到的最低质量维度是 ${weakestQuality.key}（${weakestQuality.score}）。`,
        typeof threshold === "number" && weakestQuality.score < threshold ? "QUALITY" : null,
        [
          {
            sourceArtifact: "quality.json",
            sourceField: `dimensions.${weakestQuality.key}.score`,
            value: weakestQuality.score,
            note: "四个维度的分数都由审阅给出，分析器不重新评分。",
          },
        ],
      );
    }

    // §10 商业可读性：是评价结论，不是技术失败
    if (
      typeof input.commercialReview?.score === "number" &&
      typeof threshold === "number" &&
      input.commercialReview.score < threshold
    ) {
      push(
        "LOW_COMMERCIAL_SCORE",
        "commercial-review",
        "warning",
        `商业可读性分 ${input.commercialReview.score} 低于策略阈值 ${threshold}。`,
        "COMMERCIAL",
        [
          {
            sourceArtifact: "commercial-review.json",
            sourceField: "score",
            value: input.commercialReview.score,
            note: `min_review_score = ${threshold}。`,
          },
        ],
      );
    }
    const weakestCommercial = weakestOf(
      input.commercialReview?.dimensions,
      COMMERCIAL_DIMENSION_KEYS,
    );
    if (weakestCommercial) {
      push(
        COMMERCIAL_WEAKNESS_CODES[weakestCommercial.key] ?? "WEAK_COMMERCIAL_DIMENSION",
        "commercial-review",
        "warning",
        `观测到的最低商业可读性维度是 ${weakestCommercial.key}（${weakestCommercial.score}）。`,
        typeof threshold === "number" && weakestCommercial.score < threshold ? "COMMERCIAL" : null,
        [
          {
            sourceArtifact: "commercial-review.json",
            sourceField: `dimensions.${weakestCommercial.key}.score`,
            value: weakestCommercial.score,
            note: "商业维度分数由商业审阅给出，分析器不重新评分。",
          },
        ],
      );
    }

    // §42 产物存在性：辅助信号，不单独定类
    const missing = missingArtifacts(input);
    if (missing.length > 0) {
      push(
        "ARTIFACT_PRESENCE_GAP",
        "storage",
        "warning",
        `这次 Run 没有这些产物：${missing.join("、")}。`,
        null,
        [{ note: "产物存在性只作辅助观察，不单独决定失败类别（§42）。" }],
      );
    }

    // §41 未知码：保留 Signal；阶段已知就按阶段降级，阶段也不知道就不定类
    for (const code of input.errorCodes) {
      if (categoryOfCode(code) !== null) continue;
      if (KNOWN_INTERNAL_CODES.has(code)) continue;
      const stage = input.telemetry?.failureStage ?? null;
      const degraded =
        stage && stage in STAGE_CATEGORY ? STAGE_CATEGORY[stage as StageName] : null;
      push(
        "UNRECOGNIZED_FAILURE_CODE",
        "metadata",
        "warning",
        degraded
          ? `出现未登记的失败码 ${code}；按已知阶段 ${stage} 归入${CATEGORY_LABELS[degraded]}。`
          : `出现未登记的失败码 ${code}；阶段未知，证据不足以归类。`,
        degraded,
        // v1.9.1：证据指的文件必须真在盘上。没有 telemetry.json 时只留码与说明
        [
          input.telemetry
            ? {
                sourceArtifact: "telemetry.json",
                sourceField: "failureCode",
                stage,
                code,
                note: "原始错误码原样保留，未做改写。",
              }
            : { code, note: "原始错误码原样保留，未做改写；这次 Run 没有 telemetry.json 可指。" },
        ],
      );
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // 判定辅助
  // -------------------------------------------------------------------------

  /** §38：到达上限且最终没被采纳，才算重试耗尽。retries > 0 不算。 */
  private retryExhausted(input: FailureAnalysisInput): boolean {
    if (typeof input.maxAttempts !== "number" || typeof input.attemptCount !== "number") return false;
    if (input.attemptCount < input.maxAttempts) return false;
    const anyAccepted = input.attempts.some((a) => a.accepted === true);
    if (anyAccepted) return false;
    return input.qualityStatus !== "accepted";
  }

  /**
   * §39：达到真实修订上限、目标问题仍然存在，才算修订耗尽。
   * 关掉了 Repair（enable_repair = false）时永远不是修订耗尽——
   * 那时一次修订都没发生过。
   * v1.9.1：补上与重试耗尽同一条的采纳闸门——最终被采纳的 Run
   * 不存在「修到最后也没修好」，修订轮数到过上限只说明它试过。
   */
  private repairExhausted(input: FailureAnalysisInput): boolean {
    if (input.enableRepair !== true) return false;
    const anyAccepted = input.attempts.some((a) => a.accepted === true);
    if (anyAccepted) return false;
    if (input.qualityStatus === "accepted") return false;
    if (typeof input.maxRepairsPerAttempt !== "number" || input.maxRepairsPerAttempt < 1) return false;
    if (typeof input.repairCount !== "number" || input.repairCount < 1) return false;
    if (input.repairCount < input.maxRepairsPerAttempt) return false;
    return this.problemPersists(input);
  }

  /** §39：目标问题是否仍存在——用最终校验结论与最终质量分判断，不猜。 */
  private problemPersists(input: FailureAnalysisInput): boolean {
    if (input.quality?.validation_passed === false) return true;
    const hasError = (input.validation?.issues ?? []).some((i) => i.severity === "error");
    if (hasError) return true;
    if (
      typeof input.quality?.overall_score === "number" &&
      typeof input.minReviewScore === "number" &&
      input.quality.overall_score < input.minReviewScore
    ) {
      return true;
    }
    // 最后一轮修订本身没跑成，也算问题还在
    const last = lastRepairOf(input);
    return last !== null && last.success === false;
  }

  /** 有没有「失败过的证据」：遥测说失败、状态不是 completed、或带着错误码。 */
  private hasFailureEvidence(input: FailureAnalysisInput, raw: RawSignal[]): boolean {
    if (input.errorCodes.length > 0) return true;
    if (input.telemetry?.status === "failed") return true;
    if (input.status !== null && input.status !== "completed") return true;
    return raw.some((item) => item.signal.severity === "error");
  }

  /** 第一次失败发生在哪个阶段：遥测的 failureStage 优先，其次第一条 failed 阶段。 */
  private firstFailureStage(input: FailureAnalysisInput): string | null {
    if (input.telemetry?.failureStage) return input.telemetry.failureStage;
    const failed = input.telemetry?.stages.find((s) => s.status === "failed");
    return failed ? failed.stage : null;
  }

  /** §24：结论只用事实句子，不用因果句子。 */
  private summaryOf(
    input: FailureAnalysisInput,
    status: FailureAnalysisResult["status"],
    primary: FailureCategory | null,
    secondary: FailureCategory[],
  ): string {
    if (status === "none") return "No run-level failure detected.";
    const stage = this.firstFailureStage(input);
    if (status === "unknown") {
      const codes = input.errorCodes.length > 0 ? `（${input.errorCodes.join("、")}）` : "";
      return `Run 以失败结束${stage ? `，最后停在 ${stage} 阶段` : ""}，但现有证据不足以归类失败类别${codes}。`;
    }
    const parts = [`Run 在${stage ? ` ${stage} 阶段` : "运行中"}未能完成。`];
    if (primary) {
      parts.push(`主要失败类别：${CATEGORY_LABELS[primary]}（${primary}）。`);
    }
    if (secondary.length > 0) {
      parts.push(
        `同时观察到：${secondary.map((c) => `${CATEGORY_LABELS[c]}（${c}）`).join("、")}。`,
      );
    }
    return parts.join("");
  }
}

// ---------------------------------------------------------------------------
// 常量与纯函数
// ---------------------------------------------------------------------------

const SECURITY_SIGNAL_CODES = [
  "UNSAFE_BASE_URL",
  "UNSAFE_REQUEST_URL",
  "SSRF_BLOCKED",
  "SECRET_SAFE_SERIALIZATION_REJECTED",
];

const CONFIGURATION_SIGNAL_CODES = [
  "CONFIG_INVALID",
  "UNSUPPORTED_CONFIG_VERSION",
  "MISSING_CONFIG_FIELD",
  "INVALID_MODEL_CONFIG",
  "PROMPT_VERSION_NOT_FOUND",
  "EXPERIMENT_PREFLIGHT_FAILED",
  "EXPERIMENT_INVALID",
  "RETRY_POLICY_INVALID",
  "REPAIR_POLICY_INVALID",
];

const REVIEWER_SIGNAL_CODES = [
  "REVIEW_FAILED",
  "REVIEW_COMPONENT_FAILED",
  "REVIEW_PARSE_ERROR",
  "COMMERCIAL_REVIEW_FAILED",
  "COMMERCIAL_REVIEW_COMPONENT_FAILED",
  "COMMERCIAL_REVIEW_PARSE_ERROR",
];

/** 生成阶段的四句话：只描述这一跳发生了什么。 */
const GENERATION_MESSAGES: Record<string, string> = {
  LLM_TIMEOUT: "正文模型调用超时：这一跳没有等到回应。",
  LLM_REQUEST_FAILED: "正文模型调用失败：网络或服务端返回了错误。",
  LLM_EMPTY_RESPONSE: "模型返回了空内容：没有拿到可用的正文。",
  GENERATION_FAILED: "正文生成失败：这一跳没能产出故事。",
};

/** 已经被上面的规则消费掉的内部码：不当成「未知码」重复报到 §41。 */
const KNOWN_INTERNAL_CODES = new Set<string>([
  ...SECURITY_SIGNAL_CODES,
  ...CONFIGURATION_SIGNAL_CODES,
  ...REVIEWER_SIGNAL_CODES,
  ...Object.keys(GENERATION_MESSAGES),
  "ARTIFACT_WRITE_FAILED",
  "BEAT_VALIDATION_FAILED",
  "BEAT_VALIDATION_COMPONENT_FAILED",
  "PLANNER_INVALID_OUTPUT",
  "VALIDATION_FAILED_INTERNAL",
  "VALIDATION_COMPONENT_FAILED",
]);

function textOf(value: number | string | boolean | null | undefined): string {
  if (value === null || value === undefined) return "未知";
  return String(value);
}

/**
 * v1.9.1 真正最后发生的那一轮修订。
 *
 * attempts 按发生顺序排列，每个 Attempt 里的 repairs 也按发生顺序排列，
 * 所以「最后一次 Attempt 的最后一轮」就是时间上的最后一轮。
 * 之前按 repairNumber 取最大：那是「这一次 Attempt 里的第几轮」，
 * 跨 Attempt 一比就会取到第一次尝试的第二轮，而不是真正最后那一轮——
 * 于是「目标问题还在」这件事看的是一轮早就过去的修订。
 */
function lastRepairOf(
  input: FailureAnalysisInput,
): { repairNumber: number; success: boolean; attemptId: string | null; repairId: string | null } | null {
  for (let i = input.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = input.attempts[i];
    const repairs = attempt.repairs ?? [];
    if (repairs.length === 0) continue;
    const last = repairs[repairs.length - 1];
    return {
      repairNumber: last.repairNumber,
      success: last.success,
      attemptId: attempt.attemptId ?? null,
      repairId: last.repairId ?? null,
    };
  }
  return null;
}

/** 四个维度里分数最低的那一个；一个都没有时返回 null（不补 0）。 */
function weakestOf(
  dimensions: Record<string, { score: number } | undefined> | undefined,
  keys: readonly string[],
): { key: string; score: number } | null {
  if (!dimensions) return null;
  const entries = keys
    .map((key) => ({ key, score: dimensions[key]?.score }))
    .filter((entry): entry is { key: string; score: number } => typeof entry.score === "number");
  if (entries.length === 0) return null;
  // 并列最低时取 QUALITY_DIMENSION_KEYS 里的第一个——确定性，不靠遍历顺序
  return entries.reduce((lowest, entry) => (entry.score < lowest.score ? entry : lowest));
}

/** §42 缺哪些产物。只报「按记录本该有」的，不把没跑过的步骤算成缺失。 */
function missingArtifacts(input: FailureAnalysisInput): string[] {
  const missing: string[] = [];
  if (!input.artifactPresence.story) missing.push("story.md");
  if (!input.artifactPresence.validation && input.validationStatus !== "not_started") {
    missing.push("validation.json");
  }
  if (!input.artifactPresence.review && input.reviewStatus !== "not_started") {
    missing.push("review.json");
  }
  if (!input.artifactPresence.quality && input.qualityStatus !== null) missing.push("quality.json");
  if (
    !input.artifactPresence.commercialReview &&
    input.commercialReviewStatus !== "not_started" &&
    input.commercialReviewStatus !== null
  ) {
    missing.push("commercial-review.json");
  }
  return missing;
}

/** 只给测试与调用方用：确认某个类别名合法（别处不 import 也够用）。 */
export function assertFailureCategory(value: unknown): FailureCategory {
  if (!isFailureCategory(value)) throw new Error(`不是合法的失败类别：${String(value)}`);
  return value;
}
