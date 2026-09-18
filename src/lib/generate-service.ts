import { join } from "node:path";
import { PromptBuilder } from "@/lib/prompt-builder";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { saveStoryWithMeta } from "@/lib/output";
import { validateStoryRequest, TARGET_WORDS_DEFAULT, type StoryRequest } from "@/lib/story-request";

export { RequestValidationError } from "@/lib/story-request";
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
  metadata_to: string;
  request: Pick<StoryRequest, "genre" | "target_words">;
}

export interface GenerateFail {
  error: string;
  status: number;
}

/**
 * v0.1.0 生成服务：StoryRequest → PromptBuilder → LLM（system+user）→ 保存 .md + .json。
 * v0.0.1 的 buildPrompt(title, prompt) 已被 PromptBuilder 取代（§57：API 不再自己拼 Prompt）。
 */
export async function generateStory(
  request: StoryRequest,
  runtime: GenerateRuntime = {},
  llm?: LLMClient,
  builder?: PromptBuilder,
): Promise<GenerateOk> {
  const pb = builder ?? new PromptBuilder(promptsPath("story.txt"));
  const finalPrompt = pb.build(request);
  const client = llm ?? clientFromEnv({ model: runtime.model, baseUrl: runtime.baseUrl });
  const content = await client.generate(
    finalPrompt,
    runtime.temperature ?? 0.8,
    SYSTEM_PROMPT,
  );
  const created = new Date().toISOString();
  const model = (runtime.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
  const { mdPath, jsonPath } = await saveStoryWithMeta(
    { title: request.title, content },
    {
      title: request.title,
      genre: request.genre,
      premise: request.premise,
      target_words: request.target_words,
      style: request.style,
      extra_requirements: request.extra_requirements,
      model,
      created_at: created,
    },
  );
  return {
    title: request.title,
    content,
    model,
    created_at: created,
    saved_to: mdPath,
    metadata_to: jsonPath,
    request: { genre: request.genre, target_words: request.target_words },
  };
}

function promptsPath(name: string): string {
  return join(process.cwd(), "prompts", name);
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
      out.target_words = TARGET_WORDS_DEFAULT;
    }
  }
  return out;
}

/** §30 Prompt Preview：校验 + 渲染最终 Prompt，不调用 LLM、不保存。 */
export async function previewPrompt(
  body: unknown,
  builder?: PromptBuilder,
): Promise<{ status: number; json: { prompt: string } | { error: string } }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const request = validateStoryRequest(raw);
    const pb = builder ?? new PromptBuilder(promptsPath("story.txt"));
    return { status: 200, json: { prompt: pb.build(request) } };
  } catch (e) {
    if (e instanceof Error && (e.name === "RequestValidationError" || e.name === "PromptTemplateError")) {
      return { status: 400, json: { error: e.message } };
    }
    return { status: 500, json: { error: "服务器内部错误" } };
  }
}

/** 路由适配层：领域异常 → HTTP 状态码（400 / 502 / 500）。 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
  builder?: PromptBuilder,
): Promise<{ status: number; json: GenerateOk | { error: string } }> {
  try {
    const raw = normalizeLegacy((body ?? {}) as Record<string, unknown>);
    const request = validateStoryRequest(raw);
    const runtime = {
      model: typeof raw.model === "string" ? raw.model : undefined,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
      temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    };
    const result = await generateStory(request, runtime, llm, builder);
    return { status: 200, json: result };
  } catch (e) {
    if (e instanceof Error && e.name === "RequestValidationError") {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof LLMError) {
      return { status: 502, json: { error: `Generation failed. 原因：${e.message}` } };
    }
    console.error("[generate] unexpected error:", e);
    return { status: 500, json: { error: "Generation failed. 原因：服务器内部错误" } };
  }
}
