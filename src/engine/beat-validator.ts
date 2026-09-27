import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/domain/story-config";
import type { BeatPlan } from "@/domain/beat-plan";
import {
  BEAT_DIAGNOSTIC_TARGET,
  beatValidationV2Passed,
  type BeatValidationV2Result,
} from "@/domain/beat-validation-v2";
import type { QualityDiagnostic } from "@/domain/quality-diagnostic";
import { validateQualityDiagnostics } from "@/domain/quality-diagnostic";
import { parseBeatValidationV2Result } from "@/engine/beat-validation-parser";
import type { LLMClient } from "@/ports/llm-client";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §26 BeatValidator 温度：比生成更低换取稳定结构判断，不做复杂策略。 */
export const BEAT_VALIDATION_TEMPERATURE = 0.2;

/** 少于这么多拍时，正面 / 冲突 / 收束必然挤在一起。 */
const MIN_STRUCTURE_BEATS = 3;

/**
 * §3 规则层：不调用 LLM、不读文件、纯函数的骨架结构检查。
 * 只查能直接证明的东西——空骨架、拍数不足、编号重复、编号不连续、空拍 / 缺字段。
 * 这一层出现 error 时没必要再花钱调模型（§10），因此由调用方短路。
 *
 * v2.1.0 起命中项写成统一 QualityDiagnostic（TASK §14）：code 变成 category，
 * beat_ids 变成 relatedBeatIds，target 统一是 beat-plan。十一个稳定 Code 一个不改。
 */
export function checkBeatPlanDeterministic(plan: BeatPlan): QualityDiagnostic[] {
  const diagnostics: QualityDiagnostic[] = [];
  const beats = plan.beats ?? [];

  if (beats.length === 0) {
    diagnostics.push({
      id: "beat-validator-1",
      source: "beat-validator",
      category: "EMPTY_PLAN",
      severity: "error",
      target: BEAT_DIAGNOSTIC_TARGET,
      message: "BeatPlan 里没有任何一拍，没有可生成的剧情骨架。",
    });
    return diagnostics;
  }

  if (beats.length < MIN_STRUCTURE_BEATS) {
    diagnostics.push({
      id: "beat-validator-1",
      source: "beat-validator",
      category: "TOO_FEW_BEATS",
      severity: "warning",
      target: BEAT_DIAGNOSTIC_TARGET,
      message: `只有 ${beats.length} 拍，正面建立 / 冲突升级 / 高潮收束大概率会挤在同一拍里。`,
      relatedBeatIds: beats.map((b) => b.id),
    });
  }

  const ids = beats.map((b) => b.id);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length > 0) {
    diagnostics.push({
      id: "beat-validator-1",
      source: "beat-validator",
      category: "DUPLICATE_BEAT",
      severity: "error",
      target: BEAT_DIAGNOSTIC_TARGET,
      message: `Beat 编号重复：${duplicated.join("、")}。编号是拍的唯一标识，重复后无法指认是哪一拍出了问题。`,
      relatedBeatIds: duplicated,
    });
    // 编号重复本身就会破坏「连续」的判定，不再叠加一条 BROKEN_SEQUENCE
    return diagnostics;
  }

  const consecutive = ids.every((id, i) => id === i + 1);
  if (!consecutive) {
    diagnostics.push({
      id: "beat-validator-1",
      source: "beat-validator",
      category: "BROKEN_SEQUENCE",
      severity: "error",
      target: BEAT_DIAGNOSTIC_TARGET,
      message: `Beat 编号必须从 1 连续递增，当前是 ${ids.join("、")}。顺序不唯一就无法确认事件的先后。`,
      relatedBeatIds: ids,
    });
  }

  // §16 空拍 / 缺字段：走 schema 进来的 BeatPlan 永远碰不到这条（validateBeatPlan 会先抛），
  // 规则层是第二道防线，防的是绕过 schema 直接搭出来的对象。没有 purpose / event 的拍
  // 生成器写不出东西，等同于这一拍不存在。
  const unusable = beats.filter(
    (b) => !(typeof b.purpose === "string" && b.purpose.trim()) ||
      !(typeof b.event === "string" && b.event.trim()),
  );
  if (unusable.length > 0) {
    diagnostics.push({
      id: "beat-validator-1",
      source: "beat-validator",
      category: "EMPTY_PLAN",
      severity: "error",
      target: BEAT_DIAGNOSTIC_TARGET,
      message: `第 ${unusable.map((b) => b.id).join("、")} 拍没有结构作用或事件，等同于这一拍不存在，生成器无从下笔。`,
      relatedBeatIds: unusable.map((b) => b.id),
    });
  }

  return diagnostics;
}

/**
 * 同一处问题只报一次：规则层与结构层可能对同一拍说出同一条命中项。
 * 去重键是 category + relatedBeatIds（同一来源、同一处、同一类问题），
 * 与 §23 质量栈的跨来源去重是两件事——这里合并的是同一个校验者的两层结论。
 */
function dedupe(diagnostics: readonly QualityDiagnostic[]): QualityDiagnostic[] {
  const seen = new Set<string>();
  const out: QualityDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.category}|${(diagnostic.relatedBeatIds ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

/** 把 BeatPlan 摊平成带编号的文本，交给模型判结构。 */
function renderBeatPlan(plan: BeatPlan): string {
  return plan.beats
    .map((beat) => {
      const lines = [`Beat ${beat.id}｜结构作用：${beat.purpose}`, `事件：${beat.event}`];
      lines.push(`出场人物：${beat.characters.length > 0 ? beat.characters.join("、") : "（未列出）"}`);
      if (beat.conflict && beat.conflict.trim()) lines.push(`局部冲突：${beat.conflict}`);
      if (beat.expected_outcome && beat.expected_outcome.trim()) {
        lines.push(`拍后状态：${beat.expected_outcome}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * §12 BeatValidator：StoryConfig + BeatPlan → Prompt → LLM → BeatValidationV2Result。
 * 与 StoryValidator 分离（§2）：StoryValidator 看正文，这里看骨架。
 * §4 只读、只判断、只返回结论——不修改 BeatPlan、不重排、不补拍、不据此重新规划。
 * §3 不做跨拍因果推演，也不学习历史校验结论。
 * v2.1.0：命中项换成统一 QualityDiagnostic，passed 由诊断重新推导（TASK §14/§15）。
 */
export class BeatValidator {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "beat_validator.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `Beat 校验模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  private normalize(value: string | undefined, emptyText = "未指定"): string {
    return (value ?? "").trim() || emptyText;
  }

  private renderProtagonist(config: StoryConfig): string {
    const p = config.protagonist;
    return [
      `姓名：${this.normalize(p?.name)}`,
      `身份：${this.normalize(p?.identity)}`,
      `目标：${this.normalize(p?.goal)}`,
      `动机：${this.normalize(p?.motivation)}`,
    ].join("\n");
  }

  buildBeatValidationPrompt(config: StoryConfig, plan: BeatPlan): string {
    const out = this.template
      .replaceAll("{{title}}", config.title)
      .replaceAll("{{genre}}", config.genre)
      .replaceAll("{{premise}}", config.premise)
      .replaceAll("{{setting}}", this.normalize(config.setting))
      .replaceAll("{{protagonist}}", this.renderProtagonist(config))
      .replaceAll("{{conflict}}", this.normalize(config.conflict))
      .replaceAll("{{stakes}}", this.normalize(config.stakes))
      .replaceAll("{{ending}}", this.normalize(config.ending, "未指定，由作者自行决定"))
      .replaceAll("{{target_words}}", String(config.target_words))
      .replaceAll("{{style}}", this.normalize(config.style))
      .replaceAll("{{extra_requirements}}", this.normalize(config.extra_requirements))
      .replaceAll("{{plan_summary}}", this.normalize(plan.summary, "（未提供）"))
      .replaceAll("{{beat_plan}}", renderBeatPlan(plan));
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      throw new Error(`Beat 校验模板包含未支持的占位符：${out.match(/\{\{[a-z_]+\}\}/g)?.join(", ")}`);
    }
    return out;
  }

  /**
   * §3/§10：先跑规则层。规则层已经查出错处时直接下结论，不再请求模型。
   * §5 passed 一律由合并后的诊断重新推导，不采信模型自报的 passed。
   */
  async validate(
    config: StoryConfig,
    plan: BeatPlan,
    temperature = BEAT_VALIDATION_TEMPERATURE,
  ): Promise<BeatValidationV2Result> {
    const deterministic = checkBeatPlanDeterministic(plan);
    const structural = deterministic.filter((d) => d.severity === "error");
    if (structural.length > 0) {
      const codes = structural.map((d) => d.category).join("、");
      return {
        passed: false,
        diagnostics: renumber(deterministic),
        summary: `剧情骨架存在结构性错误（${codes}），已跳过结构复核。`,
      };
    }

    const raw = await this.llm.generate(
      this.buildBeatValidationPrompt(config, plan),
      temperature,
      "你是一名短篇小说剧情骨架结构校验者。只按指定 JSON 输出结构化诊断。",
    );
    const reviewed = parseBeatValidationV2Result(raw);
    const merged = dedupe([...deterministic, ...reviewed.diagnostics]);
    return { passed: beatValidationV2Passed(merged), diagnostics: renumber(merged), summary: reviewed.summary };
  }
}

/**
 * 合并两层结论后统一重新编号：规则层与模型层各自都从 1 开始编号，
 * 直接拼在一起会出现两个 beat-validator-1。id 由校验方按输出顺序指派，
 * 于是同一份骨架两次校验只要输出顺序一致，拿到的 id 就一致。
 */
function renumber(diagnostics: readonly QualityDiagnostic[]): QualityDiagnostic[] {
  return validateQualityDiagnostics(diagnostics, "beat-validator");
}
