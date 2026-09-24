/**
 * v1.4.0 BeatValidationIssue / BeatValidationResult —— 生成正文之前对 BeatPlan 的结构校验模型。
 * §2：Validator 家族一分为二——StoryValidator 检查正文，BeatValidator 检查剧情骨架；
 *      两者都只给结论与命中项，都不改写被检查的对象（§11）。
 * §5：Severity 只有 warning / error，与 ValidationResult 同一套口径，不另立体系。
 * §10/§11：只返回结论与命中项，禁止携带 rewritten_plan / fixed_beats / suggested_plan。
 */

export class BeatValidationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatValidationValidationError";
  }
}

/** §4 BeatValidationStatus：与 Run status 分开记录，BeatValidator 失败不影响 Run 本身。 */
export type BeatValidationStatus = "not_started" | "validating" | "completed" | "failed";

/** §5 Severity：本版本只允许 warning / error。 */
export type BeatValidationSeverity = "warning" | "error";

/** §6 稳定 Code：新增只能追加，不得改名或改含义。 */
export type BeatValidationIssueCode =
  | "EMPTY_PLAN"
  | "TOO_FEW_BEATS"
  | "MISSING_OPENING"
  | "MISSING_ESCALATION"
  | "MISSING_CLIMAX"
  | "MISSING_RESOLUTION"
  | "BROKEN_SEQUENCE"
  | "DUPLICATE_BEAT"
  | "CHARACTER_STATE_CONFLICT"
  | "UNSUPPORTED_TURN"
  | "ENDING_NOT_PREPARED";

/** §6 合法 Code 白名单（schema 校验用）。 */
export const BEAT_VALIDATION_ISSUE_CODES: readonly BeatValidationIssueCode[] = [
  "EMPTY_PLAN",
  "TOO_FEW_BEATS",
  "MISSING_OPENING",
  "MISSING_ESCALATION",
  "MISSING_CLIMAX",
  "MISSING_RESOLUTION",
  "BROKEN_SEQUENCE",
  "DUPLICATE_BEAT",
  "CHARACTER_STATE_CONFLICT",
  "UNSUPPORTED_TURN",
  "ENDING_NOT_PREPARED",
];

/** §5 合法 Severity 白名单（schema 校验用）。 */
export const BEAT_VALIDATION_SEVERITIES: readonly BeatValidationSeverity[] = ["warning", "error"];

/** §4 BeatValidationIssue：一条结构规则命中记录。§7 beat_ids 指到具体那几拍，便于 UI 定位。 */
export interface BeatValidationIssue {
  code: BeatValidationIssueCode;
  severity: BeatValidationSeverity;
  message: string;
  /** 涉及的 Beat 编号（beat id）；整体性问题（如空骨架）不填。 */
  beat_ids?: number[];
}

/** §4 BeatValidationResult：一个布尔结论 + 命中项列表 + 一句话摘要。§10 不包含分数，不包含修复建议。 */
export interface BeatValidationResult {
  passed: boolean;
  issues: BeatValidationIssue[];
  /** 一句话说清这份骨架结构上成不成；面板直接展示，不用再拼。 */
  summary: string;
}

/**
 * §5 passed 推导的唯一实现：存在 error → false；只有 warning 或无 issue → true。
 * §59：推导只看 issues，绝不参考 StoryValidator 的结论或 ReviewResult 的分数。
 */
export function beatValidationPassed(issues: readonly BeatValidationIssue[]): boolean {
  return !issues.some((issue) => issue.severity === "error");
}

/** §33 schema 校验：只查结构，不重新判断规则本身是否合理。 */
export function validateBeatValidationResult(raw: unknown): BeatValidationResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  if (!Array.isArray(r.issues)) {
    throw new BeatValidationValidationError("issues 必须是数组");
  }
  const issues = r.issues.map((item, i) => {
    const issue = (item ?? {}) as Record<string, unknown>;
    const code = typeof issue.code === "string" ? issue.code.trim() : "";
    if (!code) {
      throw new BeatValidationValidationError(`issues[${i}].code 必填`);
    }
    if (!BEAT_VALIDATION_ISSUE_CODES.includes(code as BeatValidationIssueCode)) {
      throw new BeatValidationValidationError(
        `issues[${i}].code 非法：${code}（只允许 ${BEAT_VALIDATION_ISSUE_CODES.join(" / ")}）`,
      );
    }
    const severity = typeof issue.severity === "string" ? issue.severity.trim() : "";
    if (!BEAT_VALIDATION_SEVERITIES.includes(severity as BeatValidationSeverity)) {
      throw new BeatValidationValidationError(
        `issues[${i}].severity 非法：${severity}（只允许 ${BEAT_VALIDATION_SEVERITIES.join(" / ")}）`,
      );
    }
    const message = typeof issue.message === "string" ? issue.message.trim() : "";
    if (!message) {
      throw new BeatValidationValidationError(`issues[${i}].message 不能为空`);
    }
    const beatIds = Array.isArray(issue.beat_ids)
      ? issue.beat_ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0)
      : [];
    const out: BeatValidationIssue = {
      code: code as BeatValidationIssueCode,
      severity: severity as BeatValidationSeverity,
      message,
    };
    if (beatIds.length > 0) out.beat_ids = beatIds;
    return out;
  });

  const passed = typeof r.passed === "boolean" ? r.passed : beatValidationPassed(issues);
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) {
    throw new BeatValidationValidationError("summary 不能为空");
  }
  return { passed, issues, summary };
}
