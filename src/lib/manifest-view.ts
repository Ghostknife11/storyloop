import type { RunManifest } from "@/types/run-manifest";
import { PROMPT_ROLES, type PromptRole } from "@/types/run-manifest";

/**
 * v1.6.0 出身面板的唯一状态推导（与 validation-view / quality-view 同一套模式）。
 *
 * §37 缺失时整体隐藏：v1.6.0 之前生成的 Run 没有 run-manifest.json，写盘失败时也没有。
 * 面板只把清单里已经写下的事实摆出来，不做任何比较、推断或打分——
 * 因此这里没有「更好 / 更差 / 建议」这类派生状态，只有「有几行就展示几行」。
 */
export type ManifestPanelState =
  | { kind: "hidden" }
  | { kind: "ready"; manifest: RunManifest };

export function manifestPanelState(manifest: RunManifest | null | undefined): ManifestPanelState {
  // 读回来的对象可能是坏的：连 runId / 版本号都拿不到就不展示，不猜
  if (!manifest || typeof manifest.runId !== "string" || !manifest.runId.trim()) return { kind: "hidden" };
  if (!manifest.project || typeof manifest.project.version !== "string") return { kind: "hidden" };
  return { kind: "ready", manifest };
}

/** 提示词角色的展示名；角色清单本身来自 PROMPT_ROLES，不在这里另立一份。 */
const PROMPT_ROLE_LABELS: Record<PromptRole, string> = {
  planner: "Planning",
  generator: "Writing",
  "beat-validator": "Beat structure",
  reviewer: "Review",
  "commercial-reviewer": "Commercial review",
  repairer: "Repair",
};

export function promptRoleLabel(role: string): string {
  return PROMPT_ROLE_LABELS[role as PromptRole] ?? role;
}

/** 摘要只露前 12 位：足够分辨是不是同一份提示词，又不把整块哈希铺满面板。 */
export function shortDigest(digest: string | undefined): string | null {
  if (!digest) return null;
  return digest.slice(0, 12);
}

/** 六项温度一行一个：被请求覆盖的值与写死的固定值用同一种写法，数值本身就是事实。 */
export interface TemperatureRow {
  key: string;
  label: string;
  value: number;
}

export function temperatureRowsOf(manifest: RunManifest): TemperatureRow[] {
  const p = manifest.parameters;
  return [
    { key: "planning", label: "Planning", value: p.planning.temperature },
    { key: "generation", label: "Writing", value: p.generation.temperature },
    { key: "review", label: "Review", value: p.review.temperature },
    { key: "commercialReview", label: "Commercial review", value: p.commercialReview.temperature },
    { key: "beatValidation", label: "Beat structure", value: p.beatValidation.temperature },
    { key: "repair", label: "Repair", value: p.repair.temperature },
  ];
}

/** 一次 Attempt 的右侧说明：入选与否、未入选的原因、这一尝试里修过几轮。 */
export function attemptStatusText(attempt: RunManifest["attempts"][number]): string {
  const head = attempt.status === "accepted" ? "accepted" : `not accepted · ${attempt.retryReason ?? "unknown"}`;
  return attempt.repairIds.length > 0
    ? `${head} · repairs ${attempt.repairIds.join(", ")}`
    : head;
}

/** 提示词登记项按 PROMPT_ROLES 的顺序排；那一项在清单里缺了就显示 no digest。 */
export function promptRowsOf(manifest: RunManifest) {
  const byRole = new Map(manifest.prompts.map((p) => [p.role, p]));
  return PROMPT_ROLES.map((role) => {
    const entry = byRole.get(role);
    return {
      role,
      label: promptRoleLabel(role),
      version: entry?.version ?? null,
      digest: shortDigest(entry?.digest),
    };
  });
}

/** 模型一行：槽位名 + 提供商（能反推出来时）+ 模型名 + 地址来源类别。 */
export function modelRowText(manifest: RunManifest): string {
  return Object.entries(manifest.models)
    .map(([slot, s]) => `${slot}: ${s.provider ? `${s.provider} / ` : ""}${s.model}（${s.baseUrlClass}）`)
    .join("；");
}

/**
 * v1.7.1 新增：这条 Run 是不是某个受控实验的样本。
 * 返回 null 表示普通 Run（清单里没有 experiment 块，与 v1.6.0 逐字一致）。
 * 摆出来的是「它属于谁」，不摆「它排第几」——出身面板不参与任何比较。
 */
export function experimentProvenanceText(manifest: RunManifest): string | null {
  const e = manifest.experiment;
  if (!e || typeof e.experimentId !== "string") return null;
  return `experiment ${e.experimentId} · variant ${e.variantId} · repetition ${e.repetition}`;
}

/** 标题右侧那个数字：清单里登记的产物条数。 */
export function artifactCountOf(manifest: RunManifest): number {
  return manifest.artifacts.length;
}
