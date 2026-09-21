import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { RepairIssueType, RepairRequest, RepairResult } from "@/types/repair";
import { LLMClient } from "@/lib/llm";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

/** §10 修订温度：比生成保守（不让它顺手重写正文），比审阅宽松（允许改写句子）。 */
export const REPAIR_TEMPERATURE = 0.5;

/** §10 修订角色：system 与模板双重声明，防止模型只改一两句就收尾。 */
const REPAIR_SYSTEM = "你是一名短篇小说修订编辑。只输出修订后的完整正文，不要解释修改过程。";

/**
 * §9 StoryRepairer：现有 Story + 一个 Repair Issue + StoryConfig + BeatPlan
 * → Repair Prompt → LLM → 修订后完整正文（§11：返回完整正文，不是 diff / patch）。
 *
 * 职责边界（§9）：只做修订。不决定 Retry、不打分、不改 StoryConfig / BeatPlan、
 * 不切换模型。只处理简单问题，不做因果分析与失败归因（§26/§65）。
 */
export class StoryRepairer {
  private template: string;

  constructor(
    private readonly llm: LLMClient,
    templatePath: string = join(PROJECT_ROOT, "prompts", "repair.txt"),
  ) {
    try {
      this.template = readFileSync(templatePath, "utf8");
    } catch (e) {
      throw new Error(
        `Repair 模板读取失败：${templatePath}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  private normalize(value: string | undefined, emptyText = "未指定"): string {
    return (value ?? "").trim() || emptyText;
  }

  /** §10 StoryConfig 渲染成多行文本，模型不必自己解析 JSON。 */
  renderConfig(config: StoryConfig): string {
    const p = config.protagonist;
    return [
      `标题：${config.title}`,
      `题材：${config.genre}`,
      `核心设定：${config.premise}`,
      `背景：${this.normalize(config.setting)}`,
      `主角：${this.normalize(p?.name)}`,
      `主角身份：${this.normalize(p?.identity)}`,
      `主角目标：${this.normalize(p?.goal)}`,
      `冲突：${this.normalize(config.conflict)}`,
      `失败代价：${this.normalize(config.stakes)}`,
      `结局方向：${this.normalize(config.ending, "未指定，由作者自行决定")}`,
      `目标字数：${config.target_words}`,
      `风格：${this.normalize(config.style)}`,
      `附加要求：${this.normalize(config.extra_requirements)}`,
    ].join("\n");
  }

  /** §16 BeatPlan Renderer：与 StoryGenerator 同一套轻量文本，不 str(dict)。 */
  renderBeatPlan(plan: BeatPlan): string {
    return plan.beats
      .map((b) => {
        const lines = [
          `Beat ${b.id}`,
          `Purpose: ${b.purpose}`,
          `Event: ${b.event}`,
          `Characters: ${b.characters.join("、") || "未指定"}`,
        ];
        if (b.conflict) lines.push(`Conflict: ${b.conflict}`);
        if (b.expected_outcome) lines.push(`Expected Outcome: ${b.expected_outcome}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  /** §10 独立 Repair Prompt：不复用 story.txt 加 flag，模板写坏立刻报错。 */
  buildRepairPrompt(request: RepairRequest, plan: BeatPlan): string {
    const out = this.template
      .replaceAll("{{story_config}}", this.renderConfig(request.config as StoryConfig))
      .replaceAll("{{beat_plan}}", this.renderBeatPlan(plan))
      .replaceAll("{{issue_type}}", request.issue_type)
      .replaceAll("{{issue_message}}", request.issue_message)
      .replaceAll("{{story}}", request.story);
    if (/\{\{[a-z_]+\}\}/.test(out)) {
      throw new Error(`Repair 模板包含未支持的占位符：${out.match(/\{\{[a-z_]+\}\}/g)?.join(", ")}`);
    }
    return out;
  }

  /**
   * §4 StoryRepairer.repair：成功回修订后正文；LLM 异常 / 空输出都算没修好
   * （success=false），由调用方决定继续用原正文还是整篇重试（§22）。
   */
  async repair(request: RepairRequest): Promise<RepairResult> {
    const issueType: RepairIssueType = request.issue_type;
    if (!request.story.trim()) {
      return { repaired_story: "", issue_type: issueType, success: false, notes: "没有可修订的正文" };
    }
    try {
      const prompt = this.buildRepairPrompt(request, request.beat_plan as BeatPlan);
      const repaired = (await this.llm.generate(prompt, REPAIR_TEMPERATURE, REPAIR_SYSTEM)).trim();
      if (!repaired) {
        return { repaired_story: "", issue_type: issueType, success: false, notes: "修订结果为空" };
      }
      return { repaired_story: repaired, issue_type: issueType, success: true, notes: null };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { repaired_story: "", issue_type: issueType, success: false, notes: `修订失败：${detail}` };
    }
  }
}
