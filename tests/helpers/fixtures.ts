/**
 * v0.9.0 共享测试 Fixtures（TASK §46/§47）。
 *
 * 所有测试复用同一套样例数据与假 LLM，避免每个文件各自复制一份：
 *   - 样例 StoryConfig / BeatPlan / Story / ReviewResult / ValidationResult
 *   - FakeLLM：固定响应、按调用顺序返回、模拟超时、模拟异常、记录 prompts
 *   - apiErrorOf：解析 v0.9.0 统一错误响应 {error:{code,message,...}}
 *
 * 铁律：普通测试绝不调用真实收费 API（§47）——这里只有假组件。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult, ValidationIssueCode } from "@/types/validation-result";
import { LLMError, LLMTimeoutError } from "@/lib/llm";
import type { ApiErrorDetail } from "@/lib/api-error";

// ---------------------------------------------------------------------------
// 样例数据：中文内容，覆盖 §22 要求的 UTF-8 场景
// ---------------------------------------------------------------------------

export const SAMPLE_CONFIG: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "一名商业贿赂案的唯一证人在出庭前一天突然失踪，负责保护她的警员只离开了三分钟。",
  setting: "现代一线城市，商业贿赂案庭审前夜。",
  conflict: "女主必须在嫌疑人销毁证据之前找到失踪证人。",
  stakes: "证人缺席将导致案件失败。",
  ending: "陈岚在雨夜找到证人，但选择说出自己那三分钟的去向。",
  target_words: 5000,
  protagonist: { name: "陈岚", identity: "刑警", goal: "在开庭前找到证人" },
  style: "冷峻、节奏紧凑",
  extra_requirements: "不要使用超自然元素。",
});

export const SAMPLE_BEAT_PLAN: BeatPlan = validateBeatPlan({
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪，陈岚接到电话。", characters: ["陈岚"] },
    { id: 2, purpose: "升级冲突", event: "线索指向嫌疑人律师。", characters: ["陈岚", "周衡"] },
    { id: 3, purpose: "高潮对峙", event: "陈岚在码头截住销毁证据的人。", characters: ["陈岚", "周衡"] },
    { id: 4, purpose: "收束", event: "证人被找到，案件重新开庭。", characters: ["陈岚"] },
  ],
});

/** 远超长度下限、含主角名、以句号结尾：可通过全部硬规则。 */
export const SAMPLE_STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

export const SAMPLE_REVIEW: ReviewResult = {
  score: 82,
  summary: "节奏紧凑，悬念保持到尾。",
  strengths: ["开场三分钟失踪写得干净"],
  problems: [],
};

export const SAMPLE_VALIDATION: ValidationResult = { passed: true, issues: [] };

export function validationFailed(code: ValidationIssueCode, message: string): ValidationResult {
  return { passed: false, issues: [{ code, severity: "error", message }] };
}

export const MISSING_ENDING = validationFailed("MISSING_ENDING", "故事缺少明确结局。");
export const TOO_SHORT = validationFailed("TOO_SHORT", "正文长度明显短于目标字数。");
export const MISSING_PROTAGONIST = validationFailed("MISSING_PROTAGONIST", "正文中没有出现主角。");
export const EMPTY_CONTENT = validationFailed("EMPTY_CONTENT", "正文为空，没有可校验的内容。");
export const INVALID_OUTPUT = validationFailed("INVALID_OUTPUT", "正文不是可读的小说文本。");

export function reviewOf(score: number, problems: string[] = []): ReviewResult {
  return { score, summary: "总结。", strengths: ["强"], problems };
}

// ---------------------------------------------------------------------------
// 统一错误响应解析（§11）
// ---------------------------------------------------------------------------

/** 仓库 VERSION 文件内容：project_version 的唯一真源（§42），与 src/lib/version.ts 同源。 */
export function repoVersion(): string {
  return readFileSync(join(repoRoot(), "VERSION"), "utf8").trim();
}

/** 仓库根目录：tests/helpers/ 上溯两级。供合同测试读 configs/、docs/、examples/ 等入库资产。 */
export function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** 把 v0.9.0 的 {error:{code,message,run_id?,stage?}} 解析成可断言的细节对象。 */
export function apiErrorOf(json: unknown): ApiErrorDetail {
  const body = json as { error?: unknown } | null;
  const err = body?.error;
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as ApiErrorDetail;
  }
  // 旧形状（扁平字符串）不允许再出现；测试直接失败比静默兼容更有意义
  throw new Error(`响应不是统一错误形状：${JSON.stringify(json)}`);
}

// ---------------------------------------------------------------------------
// FakeLLM（§47）：固定响应 / 顺序返回 / 模拟超时 / 模拟异常 / 记录 prompts
// ---------------------------------------------------------------------------

export class FakeLLM {
  readonly prompts: Array<{ prompt: string; temperature: number; system?: string }> = [];

  private index = 0;
  private nextError: Error | null = null;

  constructor(private readonly replies: string[] = []) {}

  /** 让下一次调用抛出指定错误（超时 / 请求失败 / 任意异常）。 */
  failNextWith(error: Error): this {
    this.nextError = error;
    return this;
  }

  /** 便捷：模拟一次 LLM 超时。 */
  timeoutNext(): this {
    return this.failNextWith(new LLMTimeoutError());
  }

  async generate(prompt: string, temperature = 0.8, system?: string): Promise<string> {
    this.prompts.push({ prompt, temperature, system });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    const reply = this.replies[Math.min(this.index++, this.replies.length - 1)];
    if (reply === undefined) throw new LLMError("FakeLLM 没有更多预设响应");
    return reply;
  }
}

// ---------------------------------------------------------------------------
// 临时目录：run 产物根（每次测试独立，测完即删）
// ---------------------------------------------------------------------------

const realCwd = process.cwd();
let currentTmp: string | null = null;

afterEach(() => {
  process.chdir(realCwd);
  if (currentTmp) {
    rmSync(currentTmp, { recursive: true, force: true });
    currentTmp = null;
  }
});

/** 新建临时目录并 chdir 进去；返回目录路径（run 产物落在 <dir>/runs）。 */
export function withTmpDir(): string {
  currentTmp = mkdtempSync(join(tmpdir(), "storyloop-v090-"));
  process.chdir(currentTmp);
  return currentTmp;
}
