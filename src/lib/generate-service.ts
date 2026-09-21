import { join } from "node:path";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import { validateBeatPlan, type BeatPlan } from "@/types/beat-plan";
import { BeatPlanner } from "@/lib/beat-planner";
import { StoryGenerator } from "@/lib/story-generator";
import { StoryValidator } from "@/lib/story-validator";
import { BasicReviewer } from "@/lib/basic-reviewer";
import { GenerationPipeline, PipelineError, type GenerationResult } from "@/core/pipeline";
import { ArtifactStore } from "@/storage/artifact-store";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";

export { ConfigValidationError, UnsupportedConfigVersionError } from "@/types/story-config";
export { LLMError } from "@/lib/llm";
export { BeatParseError } from "@/lib/beat-parser";
export { BeatPlanValidationError } from "@/types/beat-plan";
export { ReviewValidationError } from "@/types/review-result";
export { ReviewParseError } from "@/lib/review-parser";
export { ValidationValidationError } from "@/types/validation-result";

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

/** §32 v0.5.0 Run 响应：run_id / 状态 / 正文 / 评价 / 产物文件名，不返回本地绝对路径（§67）。
 *  v0.6.0 增加 validation / validation_status / validation_error（§26）。 */
export interface RunOk {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  /** §26：硬性有效性检查结果；Validator 自身异常时为 null。 */
  validation: ValidationResult | null;
  validation_status: string;
  validation_error?: string;
  /** §28：Review 失败时为 null，但 story 仍然返回。 */
  review: ReviewResult | null;
  review_status: string;
  review_error?: string;
  artifacts: Record<string, string>;
}

export interface RunError {
  error: string;
  run_id?: string;
  stage?: string;
}

export type RunResult = { status: number; json: RunOk | RunError };

/** §5 依赖注入：测试用 Mock LLM / 假 Planner / 假 Validator / 假 Reviewer，绝不打真实付费 API。 */
export interface RunDeps {
  llm?: LLMClient;
  planner?: BeatPlanner;
  generator?: StoryGenerator;
  validator?: StoryValidator;
  reviewer?: BasicReviewer;
  artifactStore?: ArtifactStore;
}

/**
 * §23 组装 GenerationPipeline。runs/ 根在调用时解析（而非模块加载时），
 * 让测试可以在临时目录里跑完整 Run。
 * §25 Writer 与 Reviewer 使用同一个 LLMClient——不引入 Reviewer Model / Model Router。
 * §3 Validator 是纯规则，不需要 LLM。
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
  const validator = deps.validator ?? new StoryValidator();
  const reviewer = deps.reviewer ?? new BasicReviewer(
    llm,
    join(PROJECT_ROOT, "prompts", "reviewer.txt"),
  );
  const artifactStore = deps.artifactStore ?? new ArtifactStore();
  return new GenerationPipeline(planner, generator, validator, reviewer, artifactStore);
}

function runOkOf(result: GenerationResult): RunOk {
  const ok: RunOk = {
    run_id: result.run_id,
    status: result.status,
    story: result.story,
    beat_plan: result.beat_plan,
    validation: result.validation,
    validation_status: result.validation_status,
    review: result.review,
    review_status: result.review_status,
    artifacts: result.artifacts,
  };
  if (result.validation_error) ok.validation_error = result.validation_error;
  if (result.review_error) ok.review_error = result.review_error;
  return ok;
}

/** §28 错误映射：阶段来自 PipelineError，用户拿得到失败阶段与 run_id。 */
function runFail(e: unknown): RunResult {
  if (e instanceof PipelineError) {
    return { status: 502, json: { error: e.message, run_id: e.runId, stage: e.stage } };
  }
  if (e instanceof Error && (
    e.name === "ConfigValidationError" ||
    e.name === "RequestValidationError" ||
    e.name === "UnsupportedConfigVersionError" ||
    e.name === "BeatPlanValidationError" ||
    e.name === "ReviewValidationError"
  )) {
    return { status: 400, json: { error: e.message } };
  }
  if (
    e instanceof LLMError ||
    (e instanceof Error && (e.name === "BeatParseError" || e.name === "ReviewParseError"))
  ) {
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

/** §29/§30 手动审阅结果：成功回 ReviewResult；失败回安全错误信息。 */
export type ReviewOutcome =
  | { status: number; json: ReviewResult }
  | { status: number; json: { error: string } };

/**
 * §29 POST /api/review 的服务层：{config, story}（可选 run_id）→ BasicReviewer → ReviewResult。
 * §30 带上 run_id 时覆盖该 Run 的 review.json——不建立 review_v1 / review_history。
 * §3/§4 只审阅，不据此重新生成或改写正文。
 */
export async function reviewStory(body: unknown, deps: RunDeps = {}): Promise<ReviewOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    const story = typeof raw.story === "string" ? raw.story.trim() : "";
    if (!story) {
      return { status: 400, json: { error: "story is required——提供需要审阅的小说正文" } };
    }

    const runtime = runtimeOf(raw);
    const reviewer = deps.reviewer ?? new BasicReviewer(
      deps.llm ?? clientFromEnv(runtime),
      join(PROJECT_ROOT, "prompts", "reviewer.txt"),
    );
    const review = await reviewer.review(config, story);

    // §30：re-review 覆盖当前 review.json（run_id 越界由 ArtifactStore 拦截）
    const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
    if (runId) {
      const store = deps.artifactStore ?? new ArtifactStore();
      let exists: boolean;
      try {
        exists = store.runExists(runId);
      } catch {
        return { status: 400, json: { error: `run_id 非法：${runId}` } };
      }
      if (!exists) {
        return {
          status: 400,
          json: { error: `run_id 不存在：${runId}（只能覆盖已存在 Run 的 review.json）` },
        };
      }
      store.putReview(runId, review);
    }

    return { status: 200, json: review };
  } catch (e) {
    if (e instanceof Error && (
      e.name === "ConfigValidationError" ||
      e.name === "RequestValidationError" ||
      e.name === "UnsupportedConfigVersionError" ||
      e.name === "ReviewValidationError"
    )) {
      return { status: 400, json: { error: e.message } };
    }
    if (
      e instanceof LLMError ||
      (e instanceof Error && (e.name === "BeatParseError" || e.name === "ReviewParseError"))
    ) {
      // §15：明确错误，用户手动 Review Again，禁止业务层自动重试
      return { status: 502, json: { error: `Review failed. 原因：${e.message}` } };
    }
    console.error("[review] unexpected error:", e);
    return { status: 500, json: { error: "Review failed. 原因：服务器内部错误" } };
  }
}

/** §27 手动校验结果：成功回 ValidationResult；失败回安全错误信息。 */
export type ValidationOutcome =
  | { status: number; json: ValidationResult }
  | { status: number; json: { error: string } };

/**
 * §27 POST /api/validate 的服务层：{config, story}（可选 run_id）→ StoryValidator → ValidationResult。
 * §27 带上 run_id 时覆盖该 Run 的 validation.json——不建立 validation_history。
 * §2/§59 只做硬性有效性检查，不调用 Reviewer，也不参考 Review 分数。
 */
export async function validateStory(body: unknown, deps: RunDeps = {}): Promise<ValidationOutcome> {
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    const config = validateStoryConfig(raw.config ?? normalizeLegacy(raw));

    // §27：story 字段缺失或类型不对属于请求格式错误（400）；
    // 而「有值却全是空白」是内容层面的硬失败，交给 EMPTY_CONTENT 规则报告（§10/§16）。
    if (typeof raw.story !== "string") {
      return { status: 400, json: { error: "story is required——提供需要校验的小说正文" } };
    }
    const story = raw.story;

    const validator = deps.validator ?? new StoryValidator();
    const validation = validator.validate(config, story);

    // §27：re-validate 覆盖当前 validation.json（run_id 越界由 ArtifactStore 拦截）
    const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
    if (runId) {
      const store = deps.artifactStore ?? new ArtifactStore();
      let exists: boolean;
      try {
        exists = store.runExists(runId);
      } catch {
        return { status: 400, json: { error: `run_id 非法：${runId}` } };
      }
      if (!exists) {
        return {
          status: 400,
          json: { error: `run_id 不存在：${runId}（只能覆盖已存在 Run 的 validation.json）` },
        };
      }
      store.putValidation(runId, validation);
    }

    return { status: 200, json: validation };
  } catch (e) {
    if (e instanceof Error && (
      e.name === "ConfigValidationError" ||
      e.name === "RequestValidationError" ||
      e.name === "UnsupportedConfigVersionError" ||
      e.name === "ValidationValidationError"
    )) {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof Error && e.name === "ValidatorError") {
      console.error("[validate] validator error:", e);
      return { status: 500, json: { error: `Validation failed. 原因：${e.message}` } };
    }
    console.error("[validate] unexpected error:", e);
    return { status: 500, json: { error: "Validation failed. 原因：服务器内部错误" } };
  }
}
