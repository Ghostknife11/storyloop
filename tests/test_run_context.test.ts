import { describe, expect, it } from "vitest";
import {
  createRunContext,
  failRun,
  generateRunId,
  transitionStage,
  type RunContext,
} from "@/core/run-context";

/**
 * §8~§11/§27/§28/§64 RunContext：状态只表示 Run 走到哪里，
 * 不是 Observability，也不含评分 / 审查等未来字段。
 */

const RUN_ID = /^\d{8}_\d{6}_[a-z0-9]{6}$/;

describe("RunContext（§9/§10/§64）", () => {
  it("run_id generated：时间戳 + 6 位短随机", () => {
    expect(generateRunId()).toMatch(RUN_ID);
  });

  it("run_id unique（连续生成不重复）", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateRunId()));
    expect(ids.size).toBe(500);
  });

  it("run_id 文件系统安全，不依赖用户输入", () => {
    const id = generateRunId();
    expect(id).not.toMatch(/[\\/:*?"<>|\s.]/);
    // 固定字符集：小写字母 + 数字
    expect(/^[a-z0-9_]+$/.test(id)).toBe(true);
  });

  it("initial status valid：created，stage/error 为 null", () => {
    const ctx = createRunContext("0.4.0");
    expect(ctx.run_id).toMatch(RUN_ID);
    expect(ctx.project_version).toBe("0.4.0");
    expect(ctx.status).toBe("created");
    expect(ctx.current_stage).toBeNull();
    expect(ctx.error).toBeNull();
  });

  it("basic status transition works", () => {
    const ctx = createRunContext("0.4.0");
    transitionStage(ctx, "planning", "planning");
    expect(ctx.status).toBe("planning");
    expect(ctx.current_stage).toBe("planning");
    transitionStage(ctx, "generating", "generating");
    expect(ctx.status).toBe("generating");
    expect(ctx.current_stage).toBe("generating");
    transitionStage(ctx, "completed", "completed");
    expect(ctx.status).toBe("completed");
  });

  it("failed run records stage and error（§27/§28）", () => {
    const ctx: RunContext = createRunContext("0.4.0");
    transitionStage(ctx, "generating", "generating");
    failRun(ctx, "generating", "LLM API 返回 500");
    expect(ctx.status).toBe("failed");
    expect(ctx.current_stage).toBe("generating");
    expect(ctx.error).toBe("LLM API 返回 500");
  });

  it("timestamps valid：ISO 字符串且接近当前时间", () => {
    const before = Date.now();
    const ctx = createRunContext("0.4.0");
    const after = Date.now();
    const parsed = Date.parse(ctx.started_at);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});
