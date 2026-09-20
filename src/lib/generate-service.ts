import { join } from "node:path";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { GenerationPipeline, PipelineError, type GenerationResult } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";

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

/** §32 v0.4.0 Run 响应：只回 run_id / 状态 / 产物文件名，不返回本地绝对路径（§67）。 */
export interface RunOk {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  artifacts: Record<string, string>;
}

export type RunResult = { status: number; json: RunOk | { error: string } };

/** §5 依赖注入：测试用 Mock LLM / 假 Planner，绝不打真实付费 API。 */
export interface RunDeps {
  llm?: LLMClient;
  planner?: BeatPlanner;
  generator?: StoryGenerator;
  artifactStore?: ArtifactStore;
}

/**
 * §23 组装 GenerationPipeline。runs/ 根在调用时解析（而非模块加载时），
 * 让测试可以在临时目录里跑完整 Run。
 */
export function buildPipeline(runtime: GenerateRuntime, deps: RunDeps = {}): GenerationPipeline {
  const llm = deps.llm ?? clientFromEnv(runtime);
  const planner = deps.planner ?? new BeatPlanner(
    llm,
    join(PROJECT_ROOT, "prompts", "beat_planner.txt"),
  );
  const generator = deps.generator ?? new StoryGenerator(
    llm,
    join(PROJECT_ROOT, "prompts", "story.txt"),
  );
  const artifactStore = deps.artifactStore ?? new ArtifactStore();
  return new GenerationPipeline(planner, generator, artifactStore);
}

function runOkOf(result: GenerationResult): RunOk {
  return {
    run_id: result.run_id,
    status: result.status,
    story: result.story,
    beat_plan: result.beat_plan,
    artifacts: result.artifacts,
  };
}

/** §28 错误映射：阶段来自 PipelineError，用户拿得到失败阶段。 */
function runFail(e: unknown): RunResult {
  if (e instanceof PipelineError) {
    return { status: 502, json: { error: e.message } };
  }
  if (e instanceof Error && (
    e.name === "ConfigValidationError" ||
    e.name === "RequestValidationError" ||
    e.name === "UnsupportedConfigVersionError" ||
    e.name === "BeatPlanValidationError"
  )) {
    return { status: 400, json: { error: e.message } };
  }
  if (e instanceof LLMError || (e instanceof Error && e.name === "BeatParseError")) {
    return { status: 502, json: { error: `Generation failed. 原因：${e.message}` } };
  }
  console.error("[runs] unexpected error:", e);
  return { status: 500, json: { error: "Generation failed. 原因：服务器内部错误" } };
}

/** §6/§32 Automatic Run：StoryConfig → Config → Planning → Generation → Persistence。 */
export async function startRun(body: unknown, deps: RunDeps = {}): Promise<RunResult> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));
    const runtime = runtimeOf(raw);
    const result = await buildPipeline(runtime, deps).run(config, runtime);
    return { status: 200, json: runOkOf(result) };
  } catch (e) {
    return runFail(e);
  }
}

/** §29 Manual Run：config + beat_plan 复用同一条 Pipeline，run_id 由 Pipeline 统一生成。 */
export async function startRunFromPlan(body: unknown, deps: RunDeps = {}): Promise<RunResult> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    if (raw.beat_plan === undefined || raw.beat_plan === null) {
      return { status: 400, json: { error: "beat_plan is required——先生成剧情骨架（Generate Plan），再生成正文" } };
    }
    const plan = validateBeatPlan(raw.beat_plan);

    const runtime = runtimeOf(raw);
    const result = await buildPipeline(runtime, deps).runWithPlan(config, plan, runtime);
    return { status: 200, json: runOkOf(result) };
  } catch (e) {
    return runFail(e);
  }
}

/**
 * §29/§35 POST /api/generate 的服务层：保留的兼容入口，内部走 Manual Run。
 * 没有 beat_plan → 400（§29：不建议偷偷自己再调 Planner）。
 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
  generator?: StoryGenerator,
): Promise<RunResult> {
  return startRunFromPlan(body, { llm, generator });
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
