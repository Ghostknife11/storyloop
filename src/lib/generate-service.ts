import { join } from "node:path";
import { PromptBuilder } from "@/lib/prompt-builder";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { saveStoryWithSnapshot } from "@/lib/output";
import {
  validateStoryConfig,
  UnsupportedConfigVersionError,
  type StoryConfig,
} from "@/types/story-config";

export { ConfigValidationError, UnsupportedConfigVersionError } from "@/types/story-config";
export { LLMError } from "@/lib/llm";

const SYSTEM_PROMPT = "你是一名专业短篇小说作者。";

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
  metadata_to: string;
  request: { genre: string; target_words: number };
}

export interface GenerateFail {
  error: string;
  status: number;
}

/**
 * v0.2.0 生成服务（§90：普通函数，不是 GenerationPipeline）：
 * StoryConfig 校验 → PromptBuilder → LLM → Story + Config Snapshot。
 * §71：即使配置来自刚保存的 JSON，这里也必须重新校验。
 */
export async function generateStory(
  config: StoryConfig,
  runtime: GenerateRuntime = {},
  llm?: LLMClient,
  builder?: PromptBuilder,
): Promise<GenerateOk> {
  const pb = builder ?? new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));
  const finalPrompt = pb.build(config);
  const client = llm ?? clientFromEnv({ model: runtime.model, baseUrl: runtime.baseUrl });
  const content = await client.generate(finalPrompt, runtime.temperature ?? 0.8, SYSTEM_PROMPT);
  const created = new Date().toISOString();
  const model = (runtime.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
  const { mdPath, configPath, metaPath } = await saveStoryWithSnapshot(
    config,
    content,
    { project_version: "0.2.0", model, generated_at: created },
  );
  return {
    title: config.title,
    content,
    model,
    created_at: created,
    saved_to: mdPath,
    config_to: configPath,
    metadata_to: metaPath,
    request: { genre: config.genre, target_words: config.target_words },
  };
}

/** §26 兼容：旧请求 {title, prompt} → {title, genre:"其他", premise:prompt, target_words:5000}。 */
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

/** 路由适配层：领域异常 → HTTP 状态码（400 / 502 / 500）。 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
  builder?: PromptBuilder,
): Promise<{ status: number; json: GenerateOk | { error: string } }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const config = validateStoryConfig(raw);
    const result = await generateStory(config, runtimeOf(raw), llm, builder);
    return { status: 200, json: result };
  } catch (e) {
    if (e instanceof Error && (e.name === "ConfigValidationError" || e.name === "RequestValidationError")) {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof Error && e.name === "UnsupportedConfigVersionError") {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof LLMError) {
      return { status: 502, json: { error: `Generation failed. 原因：${e.message}` } };
    }
    console.error("[generate] unexpected error:", e);
    return { status: 500, json: { error: "Generation failed. 原因：服务器内部错误" } };
  }
}

/** §30/§35 Prompt Preview / Config 校验预览：校验 + 渲染，不调用 LLM、不保存。 */
export async function previewPrompt(
  body: unknown,
  builder?: PromptBuilder,
): Promise<{ status: number; json: { prompt: string } | { error: string } }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const config = validateStoryConfig(raw);
    const pb = builder ?? new PromptBuilder(join(process.cwd(), "prompts", "story.txt"));
    return { status: 200, json: { prompt: pb.build(config) } };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === "ConfigValidationError" || e.name === "RequestValidationError" || e.name === "UnsupportedConfigVersionError")
    ) {
      return { status: 400, json: { error: e.message } };
    }
    return { status: 500, json: { error: "服务器内部错误" } };
  }
}
