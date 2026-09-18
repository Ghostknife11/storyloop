import { buildPrompt, PromptValidationError } from "@/lib/prompt";
import { clientFromEnv, LLMClient, LLMError } from "@/lib/llm";
import { saveStory } from "@/lib/output";

export interface GenerateInput {
  title: string;
  prompt: string;
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
}

export interface GenerateFail {
  error: string;
  status: number;
}

/**
 * v0.0.1 生成服务：Prompt 构建 → LLM → 保存 → 返回。
 * llm 参数可注入（测试用 Mock），生产走 clientFromEnv。
 */
export async function generateStory(
  input: GenerateInput,
  llm?: LLMClient,
): Promise<GenerateOk> {
  const built = buildPrompt(input.title, input.prompt);
  const client = llm ?? clientFromEnv({ model: input.model, baseUrl: input.baseUrl });
  const content = await client.generate(built, input.temperature ?? 0.8);
  const savedTo = await saveStory(input.title, content);
  return {
    title: input.title.trim(),
    content,
    model: (input.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini").trim(),
    created_at: new Date().toISOString(),
    saved_to: savedTo,
  };
}

/** 路由适配层：把领域异常映射为 HTTP 状态码（§38：400 / 502 / 500，不 crash）。 */
export async function handleGenerate(
  body: unknown,
  llm?: LLMClient,
): Promise<{ status: number; json: GenerateOk | { error: string } }> {
  let input: GenerateInput;
  try {
    const raw = (body ?? {}) as Record<string, unknown>;
    input = {
      title: typeof raw.title === "string" ? raw.title : "",
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      model: typeof raw.model === "string" ? raw.model : undefined,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
      temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    };
    const result = await generateStory(input, llm);
    return { status: 200, json: result };
  } catch (e) {
    if (e instanceof PromptValidationError) {
      return { status: 400, json: { error: e.message } };
    }
    if (e instanceof LLMError) {
      return { status: 502, json: { error: `Generation failed. 原因：${e.message}` } };
    }
    console.error("[generate] unexpected error:", e);
    return { status: 500, json: { error: "Generation failed. 原因：服务器内部错误" } };
  }
}
