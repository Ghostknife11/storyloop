import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";

/** §32 Run 响应：run_id / 状态 / 正文 / 实际使用的 BeatPlan / 产物文件名。 */
export interface RunApiResult {
  run_id: string;
  status: string;
  story: string;
  beat_plan: BeatPlan;
  /** §27/§28：Review 失败时为 null，story 仍然返回。 */
  review: ReviewResult | null;
  review_status: string;
  review_error?: string;
  artifacts: Record<string, string>;
}

/** §28 失败时带上 run_id 与 stage，让 UI 能指出失败阶段（不猜）。 */
export class RunApiError extends Error {
  constructor(message: string, public runId?: string, public stage?: string) {
    super(message);
    this.name = "RunApiError";
  }
}

async function postRun(url: string, payload: unknown): Promise<RunApiResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data as { error?: string; run_id?: string; stage?: string };
    throw new RunApiError(err?.error || `生成失败（HTTP ${res.status}）`, err?.run_id, err?.stage);
  }
  return data as RunApiResult;
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

/** §32 Automatic Run：StoryConfig → 一个完整 Run。 */
export async function startRun(
  config: StoryConfig,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<RunApiResult> {
  return postRun("/api/runs", { config, ...runtime });
}

/** §33 Manual Run：必须携带 beat_plan（§29 不偷偷回退到自动规划）。 */
export async function generateFromPlan(
  config: StoryConfig,
  plan: BeatPlan,
  runtime: { model?: string; baseUrl?: string; temperature?: number },
): Promise<RunApiResult> {
  return postRun("/api/runs/from-plan", { config, beat_plan: plan, ...runtime });
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

/**
 * §29 手动审阅（Review Again）：只重新 Review，不重新生成 Story（§50）。
 * 带 runId 时服务端覆盖该 Run 的 review.json（§30）。
 */
export async function reviewStory(
  config: StoryConfig,
  story: string,
  runtime: { model?: string; baseUrl?: string; temperature?: number } = {},
  runId?: string,
): Promise<ReviewResult> {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, story, ...runtime, ...(runId ? { run_id: runId } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `审阅失败（HTTP ${res.status}）`);
  return data as ReviewResult;
}
