import { join } from "node:path";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { saveStoryWithSnapshot } from "@/lib/output";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";

export { ConfigValidationError, UnsupportedConfigVersionError } from "@/types/story-config";
export { LLMError } from "@/lib/llm";
export { BeatParseError } from "@/lib/beat-parser";
export { BeatPlanValidationError } from "@/types/beat-plan";

/** 模块加载时锁定项目根，避免测试 chdir 后模板路径漂移。 */
const PROJECT_ROOT = process.cwd();

export interface GenerateRuntime {
  model?: string;
  baseUrl?: string;
  temperature?: number;
}

export interface GenerateOk {
  title: string;
  content: string;
  model: string;
  created_at: string;
  saved_to: string;
  config_to: string;
  beats_to: string;
  metadata_to: string;
  request: { genre: string; target_words: number; beat_count: number };
}

export interface GenerateFail {
  error: string;
  status: number;
}

/** §26 兼容：旧请求 {title, prompt} → premise + 默认 target_words。 */
function normalizeLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (typeof out.prompt === "string" && out.prompt.trim() && !out.premise) {
    out.genre = typeof out.genre === "string" && out.genre.trim() ? out.genre : "其他";
    out.premise = out.prompt;
  }
  if (typeof out.target_words !== "number" || !Number.isInteger(out.target_words)) {
    if (out.target_words === undefined || out.target_words === null || out.target_words === "") {
      out.target_words = 5000;
    }
  }
  return out;
}

function runtimeOf(raw: Record<string, unknown>): GenerateRuntime {
  return {
    model: typeof raw.model === "string" ? raw.model : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
  };
}

/**
 * §28 POST /api/plan 的服务层：StoryConfig → BeatPlanner → BeatPlan。
 * §2：两个明确函数顺序工作，不是 GenerationPipeline。
 */
export async function planStory(
  body: unknown,
  llm?: LLMClient,
  planner?: BeatPlanner,
): Promise<{ status: number; json: BeatPlan | { error: string } }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const config = validateStoryConfig(raw);
    const runtime = runtimeOf(raw);
    const p = planner ?? new BeatPlanner(
      llm ?? clientFromEnv(runtime),
      join(PROJECT_ROOT, "prompts", "beat_planner.txt"),
    );
    const plan = await p.plan(config, runtime.temperature ?? 0.7);
    return { status: 200, json: plan };
  } catch (e) {
    if (e instanceof Error && (
      e.name === "ConfigValidationError" ||
      e.name === "RequestValidationError" ||
      e.name === "UnsupportedConfigVersionError"
    )) {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof Error && e.name === "BeatParseError") {
      // §13：明确错误，用户手动 Regenerate，禁止业务层自动重试
      return { status: 502, json: { error: `Plan generation failed. 原因：${e.message}` } };
    }
    if (e instanceof LLMError) {
      return { status: 502, json: { error: `Plan generation failed. 原因：${e.message}` } };
    }
    console.error("[plan] unexpected error:", e);
    return { status: 500, json: { error: "Plan generation failed. 原因：服务器内部错误" } };
  }
}

/**
 * §29 POST /api/generate 的服务层：{config, beat_plan} → StoryGenerator → Story。
 * 没有 beat_plan → 400（§29：不建议偷偷自己再调 Planner）。
 * §71 重新校验 config 与 beat_plan。
 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
  generator?: StoryGenerator,
): Promise<{ status: number; json: GenerateOk | { error: string } }> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    if (raw.beat_plan === undefined || raw.beat_plan === null) {
      return { status: 400, json: { error: "beat_plan is required——先生成剧情骨架（Generate Plan），再生成正文" } };
    }
    const plan = validateBeatPlan(raw.beat_plan);

    const runtime = runtimeOf(raw);
    const gen = generator ?? new StoryGenerator(
      llm ?? clientFromEnv(runtime),
      join(PROJECT_ROOT, "prompts", "story.txt"),
    );
    const content = await gen.generate(config, plan, runtime.temperature ?? 0.8);
    const created = new Date().toISOString();
    const model = (runtime.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
    const { mdPath, configPath, beatsPath, metaPath } = await saveStoryWithSnapshot(
      config,
      plan,
      content,
      { project_version: "0.3.0", model, generated_at: created },
    );
    return {
      status: 200,
      json: {
        title: config.title,
        content,
        model,
        created_at: created,
        saved_to: mdPath,
        config_to: configPath,
        beats_to: beatsPath,
        metadata_to: metaPath,
        request: { genre: config.genre, target_words: config.target_words, beat_count: plan.beats.length },
      },
    };
  } catch (e) {
    if (e instanceof Error && (
      e.name === "ConfigValidationError" ||
      e.name === "RequestValidationError" ||
      e.name === "UnsupportedConfigVersionError" ||
      e.name === "BeatPlanValidationError"
    )) {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof LLMError) {
      return { status: 502, json: { error: `Generation failed. 原因：${e.message}` } };
    }
    console.error("[generate] unexpected error:", e);
    return { status: 500, json: { error: "Generation failed. 原因：服务器内部错误" } };
  }
}

/** §30 preview：config 校验 + story 模板渲染（beat_plan 可选，用于完整预览）。 */
export async function previewPrompt(
  body: unknown,
  generator?: StoryGenerator,
): Promise<{ status: number; json: { prompt: string } | { error: string } }> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));
    const gen = generator ?? new StoryGenerator(
      clientFromEnv(runtimeOf(raw)),
      join(PROJECT_ROOT, "prompts", "story.txt"),
    );
    const planPart = raw.beat_plan;
    const plan = planPart ? validateBeatPlan(planPart) : undefined;
    const prompt = plan
      ? gen.buildStoryPrompt(config, plan)
      : gen.buildStoryPrompt(config, {
        beat_plan_version: "1",
        beats: [{ id: 1, purpose: "（beat_plan 未生成——Generate Plan 后可获得完整 Prompt）", event: "（同上）", characters: [] }],
      });
    return { status: 200, json: { prompt } };
  } catch (e) {
    if (
      e instanceof Error &&
      (
        e.name === "ConfigValidationError" ||
        e.name === "RequestValidationError" ||
        e.name === "UnsupportedConfigVersionError"
      )
    ) {
      return { status: 400, json: { error: e.message } };
    }
    return { status: 500, json: { error: "服务器内部错误" } };
  }
}
