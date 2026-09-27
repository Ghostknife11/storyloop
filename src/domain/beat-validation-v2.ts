/**
 * v2.1.0 Beat Validator v2 的输出契约（TASK §13/§14/§15）。
 *
 * 与 v1.4.0 的 BeatValidationResult 是同一套结论的升级版，不是第二套校验：
 *   - 十一个稳定 Code 一个不改、一个不删（TASK §13「继承」）；
 *   - 命中项从 BeatValidationIssue 换成统一的 QualityDiagnostic（§14），
 *     于是同一条诊断既能进 quality-stack.json，也能被 UI 的 Quality Center 直接渲染；
 *   - relatedBeatIds 取代 beat_ids，字段名与另两个质量组件对齐（§14「统一 relatedBeatIds」）。
 *
 * 边界（TASK §15）：仍然只 detect / explain / block。不重写、不重新规划、不自动修订；
 * 诊断数量再多也不驱动 Retry / Repair（TASK §28）。
 */

import {
  validateQualityDiagnostics,
  type QualityDiagnostic,
} from "@/domain/quality-diagnostic";
import type {
  BeatValidationIssue,
  BeatValidationResult,
} from "@/domain/beat-validation";

export class BeatValidationV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatValidationV2ValidationError";
  }
}

/** §14 BeatValidationV2Result：一个布尔结论 + 统一诊断 + 一句话摘要。§15 不含分数、不含修复建议。 */
export interface BeatValidationV2Result {
  passed: boolean;
  diagnostics: QualityDiagnostic[];
  summary: string;
}

/** §14 每条诊断说的都是骨架本身：target 只有一个合法取值。 */
export const BEAT_DIAGNOSTIC_TARGET = "beat-plan";

/**
 * §5 passed 推导：存在 error 级诊断 → false；只有 warning 或无诊断 → true。
 * 与 v1.4.0 的 beatValidationPassed 同一套口径，只是输入换成了诊断。
 */
export function beatValidationV2Passed(diagnostics: readonly QualityDiagnostic[]): boolean {
  return !diagnostics.some((d) => d.severity === "error");
}

/**
 * §37 v2 骨架校验输出 schema：诊断必须过统一的 QualityDiagnostic 校验（来源固定为
 * beat-validator，类别只能是那十一个继承下来的 Code），summary 不能为空。
 * diagnostics 缺失一律按缺字段抛错，不拿空数组糊弄过去（§37「绝不静默补空」）。
 *
 * passed 与 v1.x 同一条规矩：一律由诊断重新推导，不采信模型自报的布尔值——
 * 模型说「通过了」而诊断里躺着一条 error，落盘的依然是不通过。
 */
export function validateBeatValidationV2Result(raw: unknown): BeatValidationV2Result {
  const r = (raw ?? {}) as Record<string, unknown>;

  const diagnostics = validateQualityDiagnostics(r.diagnostics, "beat-validator");

  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  if (!summary) throw new BeatValidationV2ValidationError("summary 不能为空");

  return { passed: beatValidationV2Passed(diagnostics), diagnostics, summary };
}

/** 读盘用的宽容版：结构认不出来时返回 null，绝不补一条假结论占位。 */
export function beatValidationV2ResultOf(raw: unknown): BeatValidationV2Result | null {
  try {
    return validateBeatValidationV2Result(raw);
  } catch {
    return null;
  }
}

/**
 * §14 DTO 兼容层：BeatValidationV2Result → v1.4.0 的 BeatValidationResult。
 *
 * beat-validation.json、/api/runs 详情、UI 面板读到的仍然是 v1 形状
 * （{passed, issues, summary}）——旧客户端一个字段都不用改。映射是一一对应：
 *   code         ← category（十一个 Code 原样搬回）
 *   severity     ← severity
 *   message      ← message
 *   beat_ids     ← relatedBeatIds（没有就不填这个键）
 *
 * severity 只有一个方向需要翻译：QualityDiagnostic 有 info 档，v1 的
 * BeatValidationIssue 只有 warning / error。Beat 校验只产 warning / error，
 * 万一进来一条 info，按 warning 落进旧 DTO——旧结构里没有第三档，不静默丢档。
 */
export function legacyBeatValidationOf(result: BeatValidationV2Result): BeatValidationResult {
  const issues: BeatValidationIssue[] = result.diagnostics.map((d) => {
    const issue: BeatValidationIssue = {
      code: d.category as BeatValidationIssue["code"],
      severity: d.severity === "info" ? "warning" : d.severity,
      message: d.message,
    };
    if (d.relatedBeatIds && d.relatedBeatIds.length > 0) issue.beat_ids = [...d.relatedBeatIds];
    return issue;
  });
  return { passed: result.passed, issues, summary: result.summary };
}

/**
 * §14 反向映射：v1.4.0 的命中项 → 统一诊断。
 *
 * 旧 Run 的 beat-validation.json 里只有 issues，没有 diagnostics；质量栈要把三套结论
 * 合成一份时得先把旧结论翻译成同一种语言。target 统一填 beat-plan（§4：骨架级诊断
 * 只有一个指向），source 统一填 beat-validator——这不是新评价，只是换一种写法。
 */
export function diagnosticsOfIssues(
  issues: readonly BeatValidationIssue[],
): QualityDiagnostic[] {
  return issues.map((issue, i) => {
    const diagnostic: QualityDiagnostic = {
      id: `beat-validator-${i + 1}`,
      source: "beat-validator",
      category: issue.code,
      severity: issue.severity,
      target: BEAT_DIAGNOSTIC_TARGET,
      message: issue.message,
    };
    if (issue.beat_ids && issue.beat_ids.length > 0) {
      diagnostic.relatedBeatIds = [...issue.beat_ids];
    }
    return diagnostic;
  });
}
