import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";

export interface GenerateApiResult {
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

/** §27/§28 第一阶段：StoryConfig → BeatPlanner → BeatPlan。 */
export async function planStory(
  config: StoryConfig,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<BeatPlan> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ...runtime }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `规划失败（HTTP ${res.status}）`);
  return data as BeatPlan;
}

/** §29 第二阶段：必须携带 beat_plan。 */
export async function generateStory(
  config: StoryConfig,
  plan: BeatPlan,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<GenerateApiResult> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, beat_plan: plan, ...runtime }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `生成失败（HTTP ${res.status}）`);
  return data as GenerateApiResult;
}

/** §30 Prompt Preview（config 必填，beat_plan 可选）。 */
export async function previewPrompt(
  config: StoryConfig,
  plan?: BeatPlan,
): Promise<string> {
  const res = await fetch("/api/prompt/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan ? { config, beat_plan: plan } : config),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `预览失败（HTTP ${res.status}）`);
  return data.prompt as string;
}
