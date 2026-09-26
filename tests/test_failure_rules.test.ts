import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS } from "@/types/failure-analysis";
import {
  CATEGORY_PRIORITY,
  FAILURE_RULES,
  categoryOfCode,
  categoryPriority,
  codesOfCategory,
  errorCodesOf,
  sourceOfIssueCode,
} from "@/lib/failure-rules";
import { PipelineError } from "@/core/pipeline";
import { ArtifactWriteError } from "@/storage/artifact-store";
import { UnsafeRequestUrlError } from "@/lib/url-guard";
import { LLMTimeoutError } from "@/lib/llm";
import { VALIDATION_ISSUE_CODES } from "@/types/validation-result";
import { BEAT_VALIDATION_ISSUE_CODES } from "@/types/beat-validation";
import { FAILURE_CATEGORIES } from "@/types/failure-analysis";

describe("v1.9.0 §43 类别映射（集中规则表）", () => {
  it("TASK §43 点名的七条映射逐条对上", () => {
    expect(categoryOfCode("CONFIG_INVALID")).toBe("CONFIGURATION");
    expect(categoryOfCode("MISSING_CLIMAX")).toBe("PLANNING");
    expect(categoryOfCode("LLM_TIMEOUT")).toBe("GENERATION");
    expect(categoryOfCode("MISSING_ENDING")).toBe("VALIDATION");
    expect(categoryOfCode("REVIEW_PARSE_ERROR")).toBe("REVIEWER");
    expect(categoryOfCode("ARTIFACT_WRITE_FAILED")).toBe("STORAGE");
    expect(categoryOfCode("UNSAFE_BASE_URL")).toBe("SECURITY");
  });

  it("§6 全部骨架结构码归 PLANNING，§8 全部正文校验码归 VALIDATION", () => {
    for (const code of BEAT_VALIDATION_ISSUE_CODES) {
      expect(categoryOfCode(code), code).toBe("PLANNING");
    }
    for (const code of VALIDATION_ISSUE_CODES) {
      expect(categoryOfCode(code), code).toBe("VALIDATION");
    }
  });

  it("§13 审阅环节自身失败归 REVIEWER，不归 VALIDATION / QUALITY", () => {
    for (const code of ["REVIEW_FAILED", "REVIEW_COMPONENT_FAILED", "COMMERCIAL_REVIEW_FAILED"]) {
      expect(categoryOfCode(code), code).toBe("REVIEWER");
    }
    expect(categoryOfCode("VALIDATION_FAILED_INTERNAL")).toBe("VALIDATION");
    expect(categoryOfCode("LOW_OVERALL_SCORE")).toBe("QUALITY");
  });

  it("§41 未知码查不到规则时返回 null，不猜", () => {
    expect(categoryOfCode("SOME_FUTURE_CODE")).toBeNull();
    expect(categoryOfCode("")).toBeNull();
  });

  it("source 靠 code 反推时指到正确的产物", () => {
    expect(sourceOfIssueCode("MISSING_CLIMAX")).toBe("beat-validation");
    expect(sourceOfIssueCode("TOO_SHORT")).toBe("story-validation");
    expect(sourceOfIssueCode("CONFIG_INVALID")).toBe("metadata");
  });

  it("每个类别都有中文标签，UNKNOWN 也有一句人话", () => {
    for (const category of FAILURE_CATEGORIES) {
      expect(CATEGORY_LABELS[category], category).toBeTruthy();
    }
  });
});

describe("v1.9.0 §22 优先级是确定性的", () => {
  it("规则表的 priority 与 FAILURE_CATEGORIES 的顺序一致", () => {
    for (const rule of FAILURE_RULES) {
      expect(rule.priority, rule.category).toBe(CATEGORY_PRIORITY[rule.category]);
      expect(rule.priority).toBe(FAILURE_CATEGORIES.indexOf(rule.category));
    }
  });

  it("§22 的十级次序：安全/配置 → 存储 → 规划 → 生成 → 校验 → 审阅 → 耗尽 → 质量 → 商业 → 未知", () => {
    expect(categoryPriority("SECURITY")).toBeLessThan(categoryPriority("CONFIGURATION"));
    expect(categoryPriority("CONFIGURATION")).toBeLessThan(categoryPriority("STORAGE"));
    expect(categoryPriority("STORAGE")).toBeLessThan(categoryPriority("PLANNING"));
    expect(categoryPriority("PLANNING")).toBeLessThan(categoryPriority("GENERATION"));
    expect(categoryPriority("GENERATION")).toBeLessThan(categoryPriority("VALIDATION"));
    expect(categoryPriority("VALIDATION")).toBeLessThan(categoryPriority("REVIEWER"));
    expect(categoryPriority("REVIEWER")).toBeLessThan(categoryPriority("RETRY_EXHAUSTION"));
    expect(categoryPriority("RETRY_EXHAUSTION")).toBeLessThanOrEqual(
      categoryPriority("REPAIR_EXHAUSTION"),
    );
    expect(categoryPriority("REPAIR_EXHAUSTION")).toBeLessThan(categoryPriority("QUALITY"));
    expect(categoryPriority("QUALITY")).toBeLessThan(categoryPriority("COMMERCIAL"));
    expect(categoryPriority("COMMERCIAL")).toBeLessThan(categoryPriority("UNKNOWN"));
  });

  it("codesOfCategory 能反向查到同一批码", () => {
    expect(codesOfCategory("STORAGE")).toContain("ARTIFACT_WRITE_FAILED");
    expect(codesOfCategory("SECURITY")).toContain("UNSAFE_BASE_URL");
  });
});

describe("v1.9.0 §40 errorCodesOf：真实异常 → 稳定码", () => {
  it("§43 URL 守卫拒绝 → UNSAFE_BASE_URL（不是 CONFIG_INVALID）", () => {
    const err = new PipelineError("run failed", "r1", "generating", new UnsafeRequestUrlError("baseUrl 不允许指向本机地址：http://127.0.0.1"));
    expect(errorCodesOf(err)).toContain("UNSAFE_BASE_URL");
    expect(categoryOfCode("UNSAFE_BASE_URL")).toBe("SECURITY");
  });

  it("§43 写盘失败 → ARTIFACT_WRITE_FAILED", () => {
    const err = new PipelineError(
      "run failed",
      "r1",
      "saving",
      new ArtifactWriteError("story.md", new Error("disk full")),
    );
    expect(errorCodesOf(err)).toContain("ARTIFACT_WRITE_FAILED");
  });

  it("§43 模型超时 → LLM_TIMEOUT", () => {
    const err = new PipelineError("run failed", "r1", "generating", new LLMTimeoutError("timeout"));
    expect(errorCodesOf(err)).toContain("LLM_TIMEOUT");
  });

  it("一次失败踩到多件事时，链上每个码都留下（§45 次要类别要看得见）", () => {
    const inner = new Error("boom");
    inner.name = "SomeUnknownError";
    const err = new PipelineError("run failed", "r1", "saving", inner);
    const codes = errorCodesOf(err);
    expect(codes).toContain("SomeUnknownError");
    // §41：认不出也不洗白，但仍然可查 → null，由分析器降级
    expect(categoryOfCode("SomeUnknownError")).toBeNull();
  });

  it("空响应 → LLM_EMPTY_RESPONSE", () => {
    const err = new PipelineError("run failed", "r1", "generating", new Error("内容为空"));
    expect(errorCodesOf(err)).toContain("LLM_EMPTY_RESPONSE");
  });
});
