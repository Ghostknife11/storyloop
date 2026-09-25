"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FlaskConical, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createExperiment,
  fetchExperiments,
  RunApiError,
  type ExperimentDefinitionApi,
  type ExperimentListItemApi,
} from "@/lib/api";
import { experimentListRow } from "@/lib/experiment-view";
import { REPETITIONS_LIMIT, TOTAL_RUNS_LIMIT, VARIANTS_LIMIT } from "@/types/experiment";
import { validateExperimentDefinition } from "@/types/experiment";

/**
 * `/experiments`（v1.7.0）：实验列表 + 新建实验。
 *
 * 表单只暴露四个真的会改变生成的变量（model / temperature / retry.maxAttempts /
 * retry.minReviewScore）与一种 BeatPlan 模式；topP / maxTokens / 提示词版本 /
 * baseUrl 根本不出现——这个版本的 LLM 请求体只发 model / messages / temperature，
 * 放进表单只会让用户以为改了点什么（TASK §12）。
 */

/** 表单里的一行变体（允许留空表示「与 Base 相同」）。 */
interface VariantDraft {
  id: string;
  name: string;
  model: string;
  temperature: string;
  maxAttempts: string;
  minReviewScore: string;
}

const EMPTY_VARIANT: VariantDraft = { id: "", name: "", model: "", temperature: "", maxAttempts: "", minReviewScore: "" };

const BEAT_PLAN_MODES = [
  {
    value: "regenerate" as const,
    label: "每个样本自己规划",
    hint: "每条样本都会独立跑一遍 Planner——比较的是整条流水线",
  },
  {
    value: "fixed" as const,
    label: "共用一份剧情骨架",
    hint: "所有变体、所有 repetition 用同一份 BeatPlan——比较的是模型与参数",
  },
];

function emptyForm() {
  return {
    experimentId: "",
    name: "",
    description: "",
    title: "",
    genre: "悬疑",
    premise: "",
    targetWords: "5000",
    beatPlanMode: "regenerate" as "regenerate" | "fixed",
    beatPlanJson: "",
    model: "",
    temperature: "",
    maxAttempts: "",
    minReviewScore: "",
    repetitions: "1",
  };
}

type FormState = ReturnType<typeof emptyForm>;

/** 表单 → 实验定义。空字符串一律不塞进定义（服务端会按「未设置」处理）。 */
function definitionOf(form: FormState, variants: VariantDraft[]): unknown {
  const overridesOf = (draft: VariantDraft) => {
    const out: Record<string, unknown> = {};
    if (draft.model.trim()) out.model = draft.model.trim();
    if (draft.temperature.trim()) out.generation = { temperature: Number(draft.temperature) };
    if (draft.maxAttempts.trim() || draft.minReviewScore.trim()) {
      out.retry = {
        ...(draft.maxAttempts.trim() ? { maxAttempts: Number(draft.maxAttempts) } : {}),
        ...(draft.minReviewScore.trim() ? { minReviewScore: Number(draft.minReviewScore) } : {}),
      };
    }
    return out;
  };

  return {
    schemaVersion: "1",
    experimentId: form.experimentId.trim(),
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    base: {
      storyConfig: {
        config_version: "1",
        title: form.title.trim(),
        genre: form.genre.trim(),
        premise: form.premise.trim(),
        target_words: Number(form.targetWords),
      },
      beatPlanMode: form.beatPlanMode,
      ...(form.beatPlanMode === "fixed" && form.beatPlanJson.trim()
        ? { beatPlan: JSON.parse(form.beatPlanJson) as unknown }
        : {}),
      ...(form.model.trim() ? { modelConfig: { model: form.model.trim() } } : {}),
      ...(form.temperature.trim() ? { generationParameters: { temperature: Number(form.temperature) } } : {}),
      ...(form.maxAttempts.trim() || form.minReviewScore.trim()
        ? {
            retryPolicy: {
              ...(form.maxAttempts.trim() ? { max_attempts: Number(form.maxAttempts) } : {}),
              ...(form.minReviewScore.trim() ? { min_review_score: Number(form.minReviewScore) } : {}),
              retry_on_validation_failure: true,
              enable_repair: true,
              max_repairs_per_attempt: 1,
            },
          }
        : {}),
    },
    variants: variants.map((draft, index) => ({
      id: draft.id.trim() || `variant-${index + 1}`,
      name: draft.name.trim() || `变体 ${index + 1}`,
      overrides: overridesOf(draft),
    })),
    repetitions: Number(form.repetitions),
  };
}

export default function ExperimentsPage() {
  const [items, setItems] = useState<ExperimentListItemApi[] | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [variants, setVariants] = useState<VariantDraft[]>([{ ...EMPTY_VARIANT }]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetchExperiments()
      .then(setItems)
      .catch((e) => {
        setItems([]);
        toast.error(e instanceof RunApiError ? e.message : "读取实验列表失败");
      });
  };
  useEffect(load, []);

  const patch = (part: Partial<FormState>) => setForm((prev) => ({ ...prev, ...part }));

  const patchVariant = (index: number, part: Partial<VariantDraft>) =>
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...part } : v)));

  // 与服务端同一个校验函数：前端先答一遍，用户不必等一次往返才知道哪里写错了
  const preview = useMemo(() => {
    try {
      return { definition: validateExperimentDefinition(definitionOf(form, variants)), problem: null as string | null };
    } catch (e) {
      return { definition: null, problem: e instanceof Error ? e.message : String(e) };
    }
  }, [form, variants]);

  const totalRuns = preview.definition ? preview.definition.variants.length * preview.definition.repetitions : 0;

  const submit = async () => {
    setBusy(true);
    try {
      const created: ExperimentDefinitionApi = await createExperiment(definitionOf(form, variants));
      toast.success(`实验 ${created.experimentId} 已创建（尚未运行）`);
      setForm(emptyForm());
      setVariants([{ ...EMPTY_VARIANT }]);
      setProblem(null);
      load();
    } catch (e) {
      const message = e instanceof RunApiError ? e.message : "创建实验失败";
      setProblem(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Experiments</h1>
            <p className="text-xs text-muted-foreground mt-1">
              固定一份输入，只改动少数几个变量，重复跑几次，把结果按变体分组摆出来
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">已有实验</h2>
          {items === null ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-center">
              <FlaskConical className="h-5 w-5 mx-auto text-muted-foreground" />
              <p className="text-xs text-muted-foreground mt-2">还没有实验。在下面建一个：至少一个变体、至少跑一次。</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur overflow-hidden">
              {items.map((item, i) => {
                const row = experimentListRow(item);
                return (
                  <Link
                    key={item.experimentId}
                    href={`/experiments/${encodeURIComponent(item.experimentId)}`}
                    className={`flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 hover:bg-muted/60 transition-colors ${i > 0 ? "border-t border-border" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{row.title}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">{item.experimentId}</div>
                      <div className="text-[11px] text-muted-foreground">{row.subtitle}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {item.successCount} 成功 / {item.failureCount} 失败
                      </span>
                      <Badge variant={row.status.tone === "good" ? "default" : row.status.tone === "bad" ? "destructive" : "secondary"}>
                        {row.status.label}
                      </Badge>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-bold tracking-tight">新建实验</h2>
            <p className="text-[11px] text-muted-foreground mt-1">
              定义落盘后不可变：想改条件就换一个 experimentId 再建一份。已跑过的实验不能再跑第二次。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">experimentId（目录名）</Label>
              <Input value={form.experimentId} onChange={(e) => patch({ experimentId: e.target.value })} placeholder="model-ab-001" className="h-10 font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">名称</Label>
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="换模型会不会更好读" className="h-10" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">说明（可选）</Label>
            <Textarea value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={2} placeholder="这次想验证什么" />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">标题</Label>
              <Input value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="消失的目击者" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">题材</Label>
              <Input value={form.genre} onChange={(e) => patch({ genre: e.target.value })} placeholder="悬疑" className="h-10" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">故事核心设定（premise）</Label>
            <Textarea value={form.premise} onChange={(e) => patch({ premise: e.target.value })} rows={3} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">目标字数</Label>
              <Input value={form.targetWords} onChange={(e) => patch({ targetWords: e.target.value })} inputMode="numeric" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">repetitions（每个变体跑几次，1 ~ {REPETITIONS_LIMIT.max}）</Label>
              <Input value={form.repetitions} onChange={(e) => patch({ repetitions: e.target.value })} inputMode="numeric" className="h-10" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">BeatPlan</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {BEAT_PLAN_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => patch({ beatPlanMode: mode.value })}
                  className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                    form.beatPlanMode === mode.value ? "border-violet-500/50 bg-violet-500/5" : "border-border bg-background/40"
                  }`}
                >
                  <div className="text-xs font-medium">{mode.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{mode.hint}</div>
                </button>
              ))}
            </div>
            {form.beatPlanMode === "fixed" && (
              <Textarea
                value={form.beatPlanJson}
                onChange={(e) => patch({ beatPlanJson: e.target.value })}
                rows={4}
                placeholder='{"beat_plan_version":"1","beats":[…]}'
                className="font-mono text-[11px]"
              />
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Base Model（留空用服务端默认）</Label>
              <Input value={form.model} onChange={(e) => patch({ model: e.target.value })} className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Base Temperature</Label>
              <Input value={form.temperature} onChange={(e) => patch({ temperature: e.target.value })} inputMode="decimal" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Max Attempts</Label>
              <Input value={form.maxAttempts} onChange={(e) => patch({ maxAttempts: e.target.value })} inputMode="numeric" className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Min Review Score</Label>
              <Input value={form.minReviewScore} onChange={(e) => patch({ minReviewScore: e.target.value })} inputMode="numeric" className="h-10" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-muted-foreground">Variants（最多 {VARIANTS_LIMIT.max} 个；全留空 = 与 Base 相同）</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={variants.length >= VARIANTS_LIMIT.max}
                onClick={() => setVariants((prev) => [...prev, { ...EMPTY_VARIANT }])}
              >
                <Plus className="h-3.5 w-3.5" />
                加一个变体
              </Button>
            </div>
            {variants.map((variant, index) => (
              <div key={index} className="rounded-xl border border-border bg-background/40 p-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr] items-end">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">id</Label>
                  <Input value={variant.id} onChange={(e) => patchVariant(index, { id: e.target.value })} placeholder={`variant-${index + 1}`} className="h-9 font-mono text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">名称</Label>
                  <Input value={variant.name} onChange={(e) => patchVariant(index, { name: e.target.value })} placeholder={`变体 ${index + 1}`} className="h-9 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Model</Label>
                  <Input value={variant.model} onChange={(e) => patchVariant(index, { model: e.target.value })} className="h-9 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Temperature</Label>
                  <Input value={variant.temperature} onChange={(e) => patchVariant(index, { temperature: e.target.value })} inputMode="decimal" className="h-9 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Max Attempts</Label>
                  <Input value={variant.maxAttempts} onChange={(e) => patchVariant(index, { maxAttempts: e.target.value })} inputMode="numeric" className="h-9 text-xs" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="space-y-1 flex-1">
                    <Label className="text-[10px] text-muted-foreground">Min Score</Label>
                    <Input value={variant.minReviewScore} onChange={(e) => patchVariant(index, { minReviewScore: e.target.value })} inputMode="numeric" className="h-9 text-xs" />
                  </div>
                  {variants.length > 1 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9"
                      onClick={() => setVariants((prev) => prev.filter((_, i) => i !== index))}
                      aria-label="删除这个变体"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-muted-foreground">
              将产生 <span className="font-mono">{totalRuns}</span> 条样本 Run（上限 {TOTAL_RUNS_LIMIT}）
            </p>
            <Button size="sm" onClick={submit} disabled={busy || problem !== null}>
              <FlaskConical className="h-3.5 w-3.5" />
              {busy ? "创建中…" : "创建实验"}
            </Button>
          </div>
          {problem !== null && (
            <p className="text-[11px] text-destructive">还不行：{problem}</p>
          )}
        </section>
      </div>
    </div>
  );
}
