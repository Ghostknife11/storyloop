/**
 * v0.9.0 统一 API 错误（TASK §11/§12/§13）。
 *
 * 这一组断言盯三件事：错误码是稳定枚举、状态码按用户/运行时错误分开、
 * 响应体永远不带堆栈与服务器绝对路径。全部是纯函数，不需要桩。
 */

import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  ApiError,
  errorBody,
  errorMessageOf,
  toApiError,
} from "@/lib/api-error";
import { LLMError, LLMRequestError, LLMTimeoutError } from "@/lib/llm";
import { BeatParseError } from "@/lib/beat-parser";
import { BeatValidationParseError } from "@/lib/beat-validation-parser";
import { BeatPlanValidationError } from "@/types/beat-plan";
import { BeatValidationValidationError } from "@/types/beat-validation";
import { ReviewParseError } from "@/lib/review-parser";
import { CommercialReviewParseError } from "@/lib/commercial-review-parser";
import { PipelineError } from "@/core/pipeline";
import { ArtifactWriteError } from "@/storage/artifact-store";

const RUN_ID = "20260922_101500_ab12cd";

/** 带堆栈与绝对路径的原始异常：模拟真实环境里泄漏出来的那种错误。 */
class LeakyError extends Error {
  constructor() {
    super("读不到 D:\\secret\\config.json（C:\\Users\\someone\\keys）");
    this.name = "LeakyError";
    this.stack = "Error: 读不到 D:\\secret\\config.json\n    at readFile (node:internal/fs:whatever)";
  }
}

/**
 * 形似 node:fs 的真实异常：除了 message，还带 code / syscall / errno 自有属性。
 * 拿裸 Error 当夹具会漏掉关键信息——ArtifactWriteError 正是从这几个属性里取失败码的。
 */
function fsErrorLike(message: string, code: string, syscall: string): Error {
  const error = new Error(message);
  Object.assign(error, { code, syscall, errno: -1, path: message.split("'")[1] ?? "" });
  return error;
}

describe("§11 稳定错误码", () => {
  it("错误码清单固定，且互不重复", () => {
    expect([...API_ERROR_CODES]).toEqual([
      "CONFIG_INVALID",
      "RUN_NOT_FOUND",
      "LLM_TIMEOUT",
      "LLM_REQUEST_FAILED",
      "PLANNER_INVALID_OUTPUT",
      "GENERATION_FAILED",
      "VALIDATION_FAILED_INTERNAL",
      "REVIEW_FAILED",
      "REPAIR_FAILED",
      // v1.5.0：商业可读性审阅自身失败，与 REVIEW_FAILED 是两条独立的路
      "COMMERCIAL_REVIEW_FAILED",
      "ARTIFACT_WRITE_FAILED",
      // v1.4.0：BeatPlan 结构校验自身失败
      "BEAT_VALIDATION_FAILED",
      "INTERNAL_ERROR",
    ]);
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it("body() 只带 code / message，run_id 与 stage 有才带", () => {
    expect(new ApiError("CONFIG_INVALID", "配置非法", 400).body()).toEqual({
      error: { code: "CONFIG_INVALID", message: "配置非法" },
    });
    expect(new ApiError("GENERATION_FAILED", "生成失败", 502, RUN_ID, "generating").body()).toEqual({
      error: { code: "GENERATION_FAILED", message: "生成失败", run_id: RUN_ID, stage: "generating" },
    });
  });

  it("errorBody() 与 ApiError.body() 形状一致", () => {
    expect(errorBody("RUN_NOT_FOUND", "run_id 不存在", { run_id: RUN_ID })).toEqual({
      error: { code: "RUN_NOT_FOUND", message: "run_id 不存在", run_id: RUN_ID },
    });
  });

  it("空 run_id / 空 stage 不会被写进响应", () => {
    const body = new ApiError("INTERNAL_ERROR", "boom", 500, "", "").body();
    expect(body.error).not.toHaveProperty("run_id");
    expect(body.error).not.toHaveProperty("stage");
  });
});

describe("§12 状态码按错误性质分开", () => {
  it("超时 → LLM_TIMEOUT + 504", () => {
    const err = toApiError(new PipelineError("规划超时", RUN_ID, "planning", new LLMTimeoutError()));
    expect(err.code).toBe("LLM_TIMEOUT");
    expect(err.httpStatus).toBe(504);
    expect(err.runId).toBe(RUN_ID);
    expect(err.stage).toBe("planning");
  });

  it("模型接口失败 → LLM_REQUEST_FAILED + 502", () => {
    const err = toApiError(new LLMRequestError("LLM API 返回 401", 401));
    expect(err.code).toBe("LLM_REQUEST_FAILED");
    expect(err.httpStatus).toBe(502);
  });

  it("planning 阶段的 PipelineError → PLANNER_INVALID_OUTPUT + 502", () => {
    const err = toApiError(new PipelineError("拿不到 BeatPlan", RUN_ID, "planning", new Error("解析失败")));
    expect(err.code).toBe("PLANNER_INVALID_OUTPUT");
    expect(err.httpStatus).toBe(502);
  });

  it("其它阶段的 PipelineError → GENERATION_FAILED + 502", () => {
    const err = toApiError(new PipelineError("生成失败", RUN_ID, "generating", new Error("解析失败")));
    expect(err.code).toBe("GENERATION_FAILED");
    expect(err.httpStatus).toBe(502);
  });

  it("BeatParseError / ReviewParseError 各有专属码，不一律算生成失败", () => {
    const beat = new Error("不是 JSON");
    beat.name = "BeatParseError";
    expect(toApiError(beat).code).toBe("PLANNER_INVALID_OUTPUT");

    const review = new Error("分数越界");
    review.name = "ReviewParseError";
    expect(toApiError(review).code).toBe("REVIEW_FAILED");
  });

  it("v1.4.0 BeatValidationParseError → BEAT_VALIDATION_FAILED + 502", () => {
    const beatValidation = new BeatValidationParseError("不是 JSON");
    const err = toApiError(beatValidation);
    expect(err.code).toBe("BEAT_VALIDATION_FAILED");
    expect(err.httpStatus).toBe(502);
  });

  it("v1.5.0 CommercialReviewParseError → COMMERCIAL_REVIEW_FAILED + 502，与 REVIEW_FAILED 分开", () => {
    // 商业审阅与结构审阅是两条独立的路：错误码也不共用 REVIEW_FAILED
    const err = toApiError(new CommercialReviewParseError("Commercial Reviewer 输出不是合法 JSON"));
    expect(err.code).toBe("COMMERCIAL_REVIEW_FAILED");
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain("Commercial review failed");
    expect(toApiError(new ReviewParseError("分数越界")).code).toBe("REVIEW_FAILED");
  });

  it("v1.4.0 请求体里的 BeatPlan / BeatValidationResult 不合法是用户错误，400", () => {
    expect(toApiError(new BeatPlanValidationError("骨架不合法")).httpStatus).toBe(400);
    expect(toApiError(new BeatValidationValidationError("issues 不是数组")).httpStatus).toBe(400);
  });

  it("ValidatorError → VALIDATION_FAILED_INTERNAL + 500", () => {
    const validator = new Error("校验器炸了");
    validator.name = "ValidatorError";
    const err = toApiError(validator);
    expect(err.code).toBe("VALIDATION_FAILED_INTERNAL");
    expect(err.httpStatus).toBe(500);
  });

  it("ArtifactWriteError → ARTIFACT_WRITE_FAILED + 500", () => {
    const err = toApiError(new ArtifactWriteError("attempts/01/story.md", new Error("磁盘满")));
    expect(err.code).toBe("ARTIFACT_WRITE_FAILED");
    expect(err.httpStatus).toBe(500);
  });

  it("用户错误一律 400，不因为「内部实现里抛的是 Error」就升到 500", () => {
    for (const name of [
      "ConfigValidationError",
      "UnsafeRequestUrlError",
      "UnsupportedConfigVersionError",
      "RetryPolicyError",
      "RepairValidationError",
      "BeatPlanValidationError",
      "ReviewValidationError",
      "ValidationValidationError",
    ]) {
      const e = new Error("非法");
      e.name = name;
      const err = toApiError(e);
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.httpStatus).toBe(400);
    }
  });

  it("ApiError 原样透传，不被二次包装", () => {
    const original = new ApiError("REPAIR_FAILED", "修订失败", 502, RUN_ID, "generating");
    expect(toApiError(original)).toBe(original);
  });

  it("未预期异常 → INTERNAL_ERROR + 500，消息不含堆栈", () => {
    const err = toApiError(new LeakyError());
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.httpStatus).toBe(500);
    expect(err.message).not.toContain("at readFile");
  });

  it("非 Error 值也能收敛成一个错误", () => {
    expect(toApiError("一句字符串").code).toBe("INTERNAL_ERROR");
    expect(toApiError(undefined).code).toBe("INTERNAL_ERROR");
  });
});

describe("§13 响应不泄漏", () => {
  // 断言必须落在原始 message 上。v0.9.0 用 JSON.stringify(body) 之后判断，
  // 而 stringify 会把 \ 转义成 \\，原始路径永远匹配不上——那条断言是绿的，
  // 响应里却带着完整绝对路径。这里直接查 err.message 本身。
  it("堆栈与服务器绝对路径都不进 message（断言原始字符串，不绕 JSON.stringify）", () => {
    const err = toApiError(new LeakyError());
    expect(err.message).not.toContain("at readFile");
    expect(err.message).not.toContain("D:\\secret");
    expect(err.message).not.toContain("C:\\Users\\");
    // 兜底文案是固定的，不把异常文本拼进来
    expect(err.message).toBe("服务器内部错误");
  });

  it("body() 序列化之后同样干净（双重确认）", () => {
    const body = toApiError(new LeakyError()).body();
    expect(body.error.message).not.toContain("at readFile");
    expect(body.error.message).not.toContain("D:\\secret");
    expect(body.error.message).not.toContain("C:\\Users\\");
  });

  it("ArtifactWriteError 的绝对路径不进 message（裸抛，validate/review 路由就是这条）", () => {
    const leaky = new ArtifactWriteError("review.json", fsErrorLike(
      "EACCES: permission denied, open 'D:\\test\\zhihu\\repo\\runs\\20260922_101500_ab12cd\\review.json'",
      "EACCES",
      "open",
    ));
    const err = toApiError(leaky);
    expect(err.code).toBe("ARTIFACT_WRITE_FAILED");
    expect(err.httpStatus).toBe(500);
    expect(err.message).not.toContain("D:\\test");
    expect(err.message).not.toContain("runs\\20260922");
    // 相对文件名要留下，否则用户不知道是哪个产物写失败
    expect(err.message).toContain("review.json");
    // fs 失败码也要留下，够定位是权限还是磁盘
    expect(err.message).toContain("EACCES");
  });

  it("LLMTimeoutError 一路裹在 PipelineError 里也保留专属错误码", () => {
    const wrapped = new PipelineError(
      "生成阶段失败",
      RUN_ID,
      "generating",
      new PipelineError("内层", RUN_ID, "generating", new LLMTimeoutError("超时 180000ms")),
    );
    const err = toApiError(wrapped);
    expect(err.code).toBe("LLM_TIMEOUT");
    expect(err.httpStatus).toBe(504);
    expect(err.runId).toBe(RUN_ID);
  });

  it("LLMError 的非超时子类不会被误判成 LLM_TIMEOUT", () => {
    const err = toApiError(new PipelineError("失败", RUN_ID, "generating", new LLMError("模型不可用")));
    expect(err.code).toBe("LLM_REQUEST_FAILED");
  });

  it("LLMRequestError 的 status 不参与映射——一律 LLM_REQUEST_FAILED", () => {
    for (const status of [400, 401, 429, 500, 503]) {
      expect(toApiError(new LLMRequestError("失败", status)).code).toBe("LLM_REQUEST_FAILED");
    }
  });
});

describe("§12 具体异常优先于 PipelineError 阶段壳（v0.9.1 分支顺序）", () => {
  // v0.9.0 把 `e instanceof PipelineError` 排在具体异常之前，主链路上抛的一切都被
  // 包在 PipelineError 里，于是 BeatParseError / ArtifactWriteError / 用户错误这几支
  // 全是死码：写盘失败报成 GENERATION_FAILED/502，配置错误也报成 502 而不是 400。
  const wrap = (cause: Error, stage = "generating") =>
    new PipelineError(`Run ${RUN_ID} failed at ${stage}`, RUN_ID, stage, cause);

  it("写盘失败被 PipelineError 包裹 → 仍是 ARTIFACT_WRITE_FAILED + 500", () => {
    const err = toApiError(wrap(new ArtifactWriteError("attempts/01/story.md", new Error("磁盘满"))));
    expect(err.code).toBe("ARTIFACT_WRITE_FAILED");
    expect(err.httpStatus).toBe(500);
    expect(err.stage).toBe("generating");
    expect(err.runId).toBe(RUN_ID);
  });

  it("BeatParseError 被包裹 → 保留专属前缀，不被阶段壳消息吃掉", () => {
    const err = toApiError(wrap(new BeatParseError("Planner 输出不是合法 JSON"), "planning"));
    expect(err.code).toBe("PLANNER_INVALID_OUTPUT");
    expect(err.httpStatus).toBe(502);
    expect(err.stage).toBe("planning");
    expect(err.message).toContain("Plan generation failed. 原因：");
    expect(err.message).not.toContain("failed at planning");
  });

  it("ReviewParseError 被包裹 → REVIEW_FAILED，不是 GENERATION_FAILED", () => {
    const err = toApiError(wrap(new ReviewParseError("分数越界"), "reviewing"));
    expect(err.code).toBe("REVIEW_FAILED");
    expect(err.httpStatus).toBe(502);
  });

  it("用户错误被包裹 → 400 CONFIG_INVALID，不因为包了 PipelineError 就升到 502", () => {
    const bad = new Error("target_words 必须是整数");
    bad.name = "ConfigValidationError";
    const err = toApiError(wrap(bad, "config"));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.httpStatus).toBe(400);
  });

  it("具体类型都没命中时才退回阶段壳：GENERATION_FAILED + 502", () => {
    const err = toApiError(wrap(new Error("某种没见过的异常")));
    expect(err.code).toBe("GENERATION_FAILED");
    expect(err.httpStatus).toBe(502);
    expect(err.stage).toBe("generating");
  });

  it("planning 阶段壳仍是 PLANNER_INVALID_OUTPUT", () => {
    const err = toApiError(new PipelineError("拿不到 BeatPlan", RUN_ID, "planning", new Error("解析失败")));
    expect(err.code).toBe("PLANNER_INVALID_OUTPUT");
    expect(err.httpStatus).toBe(502);
  });
});

describe("errorMessageOf：CLI 与前端共用同一套解析", () => {
  it("从统一形状里取出给人看的一句话", () => {
    expect(errorMessageOf({ error: { code: "CONFIG_INVALID", message: "target_words 必须是整数" } }))
      .toBe("target_words 必须是整数");
  });

  it("兼容旧形状 {error: string}", () => {
    expect(errorMessageOf({ error: "服务器内部错误" })).toBe("服务器内部错误");
  });

  it("没有 error 字段时不猜，给固定兜底文案", () => {
    expect(errorMessageOf({})).toBe("未知错误");
    expect(errorMessageOf(null)).toBe("未知错误");
    expect(errorMessageOf("一段裸字符串")).toBe("未知错误");
  });

  it("error 是对象但没有 message 时同样兜底", () => {
    expect(errorMessageOf({ error: { code: "INTERNAL_ERROR" } })).toBe("未知错误");
  });
});
