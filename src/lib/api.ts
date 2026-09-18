import type { StoryRequest } from "@/types/story-request";

export interface GenerateApiResult {
  title: string;
  content: string;
  model: string;
  created_at: string;
  saved_to: string;
  metadata_to: string;
  request: { genre: string; target_words: number };
}

/** §34 生成服务：generateStory(request: StoryRequest)。运行参数单独传递。 */
export async function generateStory(
  request: StoryRequest,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<GenerateApiResult> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, ...runtime }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `生成失败（HTTP ${res.status}）`);
  }
  return data as GenerateApiResult;
}

/** §29-30 Prompt Preview（开发功能）。 */
export async function previewPrompt(request: StoryRequest): Promise<string> {
  const res = await fetch("/api/prompt/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `预览失败（HTTP ${res.status}）`);
  }
  return data.prompt as string;
}
