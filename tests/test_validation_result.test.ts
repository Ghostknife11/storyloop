import { describe, expect, it } from "vitest";
import {
  VALIDATION_ISSUE_CODES,
  VALIDATION_SEVERITIES,
  validationPassed,
  validateValidationResult,
} from "@/types/validation-result";

/**
 * §33 ValidationResult / ValidationIssue：只查结构，不重新判断规则是否合理。
 * §5 Severity 只有 warning / error；§6 Code 必须稳定。
 * 只用 Fixture，绝不打真实付费 API。
 */

const errorIssue = {
  code: "TOO_SHORT",
  severity: "error",
  message: "正文长度 12 明显短于目标字数（下限 750）。",
};

const warningIssue = {
  code: "MISSING_ENDING",
  severity: "warning",
  message: "正文结尾不像一个完整收束。",
};

describe("validateValidationResult（§4/§5/§33）", () => {
  it("passed true with no errors", () => {
    const r = validateValidationResult({ passed: true, issues: [] });
    expect(r).toEqual({ passed: true, issues: [] });
  });

  it("passed false with error", () => {
    const r = validateValidationResult({ passed: false, issues: [errorIssue] });
    expect(r.passed).toBe(false);
    expect(r.issues).toEqual([errorIssue]);
  });

  it("warning does not force fail", () => {
    const r = validateValidationResult({ passed: true, issues: [warningIssue] });
    expect(r.passed).toBe(true);
    expect(r.issues[0].severity).toBe("warning");
    // §5：只有 warning 时 passed 仍可显式为 true
    expect(validationPassed(r.issues)).toBe(true);
  });

  it("passed 缺省时按 issues 推导", () => {
    expect(validateValidationResult({ issues: [warningIssue] }).passed).toBe(true);
    expect(validateValidationResult({ issues: [errorIssue] }).passed).toBe(false);
    expect(validateValidationResult({ issues: [] }).passed).toBe(true);
  });

  it("invalid severity rejected", () => {
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ ...errorIssue, severity: "info" }] }),
    ).toThrow(/severity 非法/);
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ ...errorIssue, severity: "critical" }] }),
    ).toThrow(/severity 非法/);
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ ...errorIssue, severity: "" }] }),
    ).toThrow(/severity 非法/);
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ ...errorIssue, severity: 42 }] }),
    ).toThrow(/severity 非法/);
  });

  it("issue code required", () => {
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ severity: "error", message: "m" }] }),
    ).toThrow(/issues\[0\]\.code 必填/);
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ code: "  ", severity: "error", message: "m" }] }),
    ).toThrow(/issues\[0\]\.code 必填/);
  });

  it("未知 code rejected（§6 Code 必须稳定）", () => {
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ code: "MADE_UP", severity: "error", message: "m" }] }),
    ).toThrow(/issues\[0\]\.code 非法/);
  });

  it("issue message 不能为空", () => {
    expect(() =>
      validateValidationResult({ passed: true, issues: [{ ...errorIssue, message: "   " }] }),
    ).toThrow(/issues\[0\]\.message 不能为空/);
  });

  it("issues 不是数组 rejected", () => {
    expect(() => validateValidationResult({ passed: true, issues: "nope" })).toThrow(/issues 必须是数组/);
    expect(() => validateValidationResult({ passed: true })).toThrow(/issues 必须是数组/);
    expect(() => validateValidationResult(null)).toThrow(/issues 必须是数组/);
  });

  it("多个 issue 全部保留，顺序不变", () => {
    const r = validateValidationResult({ passed: false, issues: [errorIssue, warningIssue] });
    expect(r.issues).toEqual([errorIssue, warningIssue]);
  });

  it("§6/§5 白名单覆盖本版本全部 Code 与 Severity", () => {
    expect([...VALIDATION_ISSUE_CODES]).toEqual([
      "EMPTY_CONTENT", "TOO_SHORT", "POSSIBLE_TRUNCATION",
      "MISSING_PROTAGONIST", "MISSING_ENDING", "INVALID_OUTPUT",
    ]);
    expect([...VALIDATION_SEVERITIES]).toEqual(["warning", "error"]);
  });

  it("§10/§58 不产生修复 / 重试 / 评分等未来字段", () => {
    const r = validateValidationResult({ passed: true, issues: [warningIssue] }) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["issues", "passed"]);
    for (const forbidden of ["fixed_story", "revised_story", "patched_story", "score", "suggestions", "retry"]) {
      expect(r).not.toHaveProperty(forbidden);
    }
    const issue = r.issues as Array<Record<string, unknown>>;
    expect(Object.keys(issue[0]).sort()).toEqual(["code", "message", "severity"]);
  });
});
