/**
 * §4 ValidationIssue / ValidationResult —— v0.6.0 硬性有效性检查的数据模型。
 * §2：Validator 判断「是否基本可接受」，Reviewer 判断「写得怎么样」。
 * §5：Severity 只有 warning / error，不建立复杂 severity 体系。
 * §10/§11：ValidationResult 只返回结论与命中项，禁止携带 fixed_story / revised_story / patched_story。
 */

export class ValidationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationValidationError";
  }
}

/** §4 ValidationStatus：与 Run status 分开记录，Validator 失败不影响 Run 本身。 */
export type ValidationStatus = "not_started" | "validating" | "completed" | "failed";

/** §5 Severity：本版本只允许 warning / error。 */
export type ValidationSeverity = "warning" | "error";

/** §6 稳定 Code：新增只能追加，不得改名或改含义。 */
export type ValidationIssueCode =
  | "EMPTY_CONTENT"
  | "TOO_SHORT"
  | "POSSIBLE_TRUNCATION"
  | "MISSING_PROTAGONIST"
  | "MISSING_ENDING"
  | "INVALID_OUTPUT";

/** §6 合法 Code 白名单（schema 校验用）。 */
export const VALIDATION_ISSUE_CODES: readonly ValidationIssueCode[] = [
  "EMPTY_CONTENT",
  "TOO_SHORT",
  "POSSIBLE_TRUNCATION",
  "MISSING_PROTAGONIST",
  "MISSING_ENDING",
  "INVALID_OUTPUT",
];

/** §5 合法 Severity 白名单（schema 校验用）。 */
export const VALIDATION_SEVERITIES: readonly ValidationSeverity[] = ["warning", "error"];

/** §4 ValidationIssue：一条硬性规则命中记录。 */
export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  message: string;
}

/** §4 ValidationResult：一个布尔结论 + 命中项列表。§10 不包含分数，不包含修复建议。 */
export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
}

/**
 * §5 passed 推导的唯一实现：存在 error → false；只有 warning 或无 issue → true。
 * §59：推导只看 issues，绝不参考 Review 分数。
 */
export function validationPassed(issues: readonly ValidationIssue[]): boolean {
  return !issues.some((issue) => issue.severity === "error");
}

/** §33 schema 校验：只查结构，不重新判断规则本身是否合理。 */
export function validateValidationResult(raw: unknown): ValidationResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  if (!Array.isArray(r.issues)) {
    throw new ValidationValidationError("issues 必须是数组");
  }
  const issues = r.issues.map((item, i) => {
    const issue = (item ?? {}) as Record<string, unknown>;
    const code = typeof issue.code === "string" ? issue.code.trim() : "";
    if (!code) {
      throw new ValidationValidationError(`issues[${i}].code 必填`);
    }
    if (!VALIDATION_ISSUE_CODES.includes(code as ValidationIssueCode)) {
      throw new ValidationValidationError(
        `issues[${i}].code 非法：${code}（只允许 ${VALIDATION_ISSUE_CODES.join(" / ")}）`,
      );
    }
    const severity = typeof issue.severity === "string" ? issue.severity.trim() : "";
    if (!VALIDATION_SEVERITIES.includes(severity as ValidationSeverity)) {
      throw new ValidationValidationError(
        `issues[${i}].severity 非法：${severity}（只允许 ${VALIDATION_SEVERITIES.join(" / ")}）`,
      );
    }
    const message = typeof issue.message === "string" ? issue.message.trim() : "";
    if (!message) {
      throw new ValidationValidationError(`issues[${i}].message 不能为空`);
    }
    return { code: code as ValidationIssueCode, severity: severity as ValidationSeverity, message };
  });

  const passed = typeof r.passed === "boolean" ? r.passed : validationPassed(issues);
  return { passed, issues };
}

/**
 * §33 v1.4.1 读回用的宽容版 schema：磁盘上的 validation.json 可能被手改坏。
 * 读接口的承诺是「不失败，最差 null」（compatibility §16），
 * 所以这里不抛异常：结构认不出来就当作这份结论不存在，由调用方按 failed / null 处理。
 */
export function validationResultOf(raw: unknown): ValidationResult | null {
  try {
    return validateValidationResult(raw);
  } catch {
    return null;
  }
}
