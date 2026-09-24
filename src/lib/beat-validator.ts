import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import {
  beatValidationPassed,
  type BeatValidationIssue,
  type BeatValidationResult,
} from "@/types/beat-validation";
import { parseBeatValidationResult } from "@/lib/beat-validation-parser";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §26 BeatValidator 温度：比生成更低换取稳定结构判断，不做复杂策略。 */
export const BEAT_VALIDATION_TEMPERATURE = 0.2;

/** 少于这么多拍时，正面 / 冲突 / 收束必然挤在一起。 */
const MIN_STRUCTURE_BEATS = 3;

/**
 * §3 规则层：不调用 LLM、不读文件、纯函数的骨架结构检查。
 * 只查能直接证明的东西——空骨架、拍数不足、编号重复、编号不连续。
 * 这一层出现 error 时没必要再花钱调模型（§10），因此由调用方短路。
 */
export function checkBeatPlanDeterministic(plan: BeatPlan): BeatValidationIssue[] {
  const issues: BeatValidationIssue[] = [];
  const beats = plan.beats ?? [];

  if (beats.length === 0) {
    issues.push({
      code: "EMPTY_PLAN",
      severity: "error",
      message: "BeatPlan 里没有任何一拍，没有可生成的剧情骨架。",
    });
    return issues;
  }

  if (beats.length < MIN_STRUCTURE_BEATS) {
    issues.push({
      code: "TOO_FEW_BEATS",
      severity: "warning",
      message: `只有 ${beats.length} 拍，正面建立 / 冲突升级 / 高潮收束大概率会挤在同一拍里。`,
      beat_ids: beats.map((b) => b.id),
    });
  }

  const ids = beats.map((b) => b.id);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length > 0) {
    issues.push({
      code: "DUPLICATE_BEAT",
      severity: "error",
      message: `Beat 编号重复：${duplicated.join("、")}。编号是拍的唯一标识，重复后无法指认是哪一拍出了问题。`,
      beat_ids: duplicated,
    });
    // 编号重复本身就会破坏「连续」的判定，不再叠加一条 BROKEN_SEQUENCE
    return issues;
  }

  const consecutive = ids.every((id, i) => id === i + 1);
  if (!consecutive) {
    issues.push({
      code: "BROKEN_SEQUENCE",
      severity: "error",
      message: `Beat 编号必须从 1 连续递增，当前是 ${ids.join("、")}。顺序不唯一就无法确认事件的先后。`,
      beat_ids: ids,
    });
  }

  return issues;
}

/** 同一处问题只报一次：规则层与结构层可能写出同一条命中项。 */
function dedupe(issues: readonly BeatValidationIssue[]): BeatValidationIssue[] {
  const seen = new Set<string>();
  const out: BeatValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${(issue.beat_ids ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
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
 * §12 BeatValidator：StoryConfig + BeatPlan → Prompt → LLM → BeatValidationResult。
 * 与 StoryValidator 分离（§2）：StoryValidator 看正文，这里看骨架。
 * §4 只读、只判断、只返回结论——不修改 BeatPlan、不重排、不补拍、不据此重新规划。
 * §3 不做跨拍因果推演，也不学习历史校验结论。
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
   * §5 passed 一律由合并后的 issues 重新推导，不采信模型自报的 passed。
   */
  async validate(
    config: StoryConfig,
    plan: BeatPlan,
    temperature = BEAT_VALIDATION_TEMPERATURE,
  ): Promise<BeatValidationResult> {
    const deterministic = checkBeatPlanDeterministic(plan);
    const structural = deterministic.filter((issue) => issue.severity === "error");
    if (structural.length > 0) {
      return {
        passed: false,
        issues: deterministic,
        summary: `剧情骨架存在结构性错误（${structural.map((i) => i.code).join("、")}），已跳过结构复核。`,
      };
    }

    const raw = await this.llm.generate(
      this.buildBeatValidationPrompt(config, plan),
      temperature,
      "你是一名短篇小说剧情骨架结构校验者。只输出 JSON。",
    );
    const reviewed = parseBeatValidationResult(raw);
    const issues = dedupe([...deterministic, ...reviewed.issues]);
    return { passed: beatValidationPassed(issues), issues, summary: reviewed.summary };
  }
}
