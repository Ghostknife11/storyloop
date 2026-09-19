"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  BookOpen, Copy, Download, Eye, FilePlus2, FolderOpen, Loader2,
  Plus, Save, Sparkles, Trash2, ArrowUp, ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { generateStory, planStory, previewPrompt, type GenerateApiResult } from "@/lib/api";
import { configFilename, parseStoryConfig, serializeStoryConfig } from "@/lib/config-io";
import { useSettings } from "@/lib/settings-store";
import {
  GENRE_PRESETS, STYLE_PRESETS, STORY_CONFIG_VERSION, TARGET_WORDS_DEFAULT,
  validateStoryConfig, type StoryConfig,
} from "@/types/story-config";
import { validateBeatPlan, type BeatPlan, type StoryBeat } from "@/types/beat-plan";

type Phase = "idle" | "generating" | "success" | "error";
type PlanPhase = "idle" | "planning" | "success" | "error";

interface ConfigForm {
  title: string;
  genre: string;
  customGenre: string;
  premise: string;
  setting: string;
  protagonistName: string;
  protagonistIdentity: string;
  protagonistGoal: string;
  protagonistMotivation: string;
  conflict: string;
  stakes: string;
  ending: string;
  targetWords: number;
  style: string;
  extraRequirements: string;
}

const EMPTY_FORM: ConfigForm = {
  title: "", genre: "悬疑", customGenre: "", premise: "", setting: "",
  protagonistName: "", protagonistIdentity: "", protagonistGoal: "", protagonistMotivation: "",
  conflict: "", stakes: "", ending: "", targetWords: TARGET_WORDS_DEFAULT,
  style: "", extraRequirements: "",
};

/** §69 单一序列化层：表单 ↔ StoryConfig 的唯一转换点。 */
function formToConfig(f: ConfigForm): StoryConfig {
  const genre = (f.genre === "其他" ? f.customGenre : f.genre).trim();
  const config: StoryConfig = {
    config_version: STORY_CONFIG_VERSION,
    title: f.title.trim(),
    genre,
    premise: f.premise.trim(),
    target_words: f.targetWords,
  };
  if (f.setting.trim()) config.setting = f.setting.trim();
  if (f.protagonistName.trim()) {
    config.protagonist = {
      name: f.protagonistName.trim(),
      ...(f.protagonistIdentity.trim() ? { identity: f.protagonistIdentity.trim() } : {}),
      ...(f.protagonistGoal.trim() ? { goal: f.protagonistGoal.trim() } : {}),
      ...(f.protagonistMotivation.trim() ? { motivation: f.protagonistMotivation.trim() } : {}),
    };
  }
  if (f.conflict.trim()) config.conflict = f.conflict.trim();
  if (f.stakes.trim()) config.stakes = f.stakes.trim();
  if (f.ending.trim()) config.ending = f.ending.trim();
  if (f.style.trim()) config.style = f.style.trim();
  if (f.extraRequirements.trim()) config.extra_requirements = f.extraRequirements.trim();
  return config;
}

function configToForm(c: StoryConfig): ConfigForm {
  return {
    title: c.title,
    genre: GENRE_PRESETS.includes(c.genre as never) ? c.genre : "其他",
    customGenre: GENRE_PRESETS.includes(c.genre as never) ? "" : c.genre,
    premise: c.premise,
    setting: c.setting ?? "",
    protagonistName: c.protagonist?.name ?? "",
    protagonistIdentity: c.protagonist?.identity ?? "",
    protagonistGoal: c.protagonist?.goal ?? "",
    protagonistMotivation: c.protagonist?.motivation ?? "",
    conflict: c.conflict ?? "",
    stakes: c.stakes ?? "",
    ending: c.ending ?? "",
    targetWords: c.target_words,
    style: c.style ?? "",
    extraRequirements: c.extra_requirements ?? "",
  };
}

/** §37 前端校验（§70 Save 前也用它）：必填 + 范围。 */
function validateForm(f: ConfigForm): string | null {
  if (!f.title.trim()) return "请填写故事标题";
  if (f.title.trim().length > 120) return "标题不能超过 120 字";
  const genre = (f.genre === "其他" ? f.customGenre : f.genre).trim();
  if (!genre) return "请选择或填写题材";
  if (!f.premise.trim()) return "请填写故事核心设定（premise）";
  if (!Number.isInteger(f.targetWords)) return "目标字数必须是整数";
  if (f.targetWords < 500 || f.targetWords > 30000) return "目标字数必须在 500 ~ 30000 之间";
  return null;
}

/** §22 BeatPlan 过期判定：plan 生成后，这些 StoryConfig 字段再变就算过期。 */
const PLAN_RELEVANT_KEYS: Array<keyof StoryConfig> = [
  "premise", "setting", "protagonist", "conflict", "stakes", "ending",
];

/** 只快照与 BeatPlan 相关的字段：与 plan 无关的编辑（标题/风格）不应误标记过期。 */
function planRelevantSnapshot(config: StoryConfig): string {
  return JSON.stringify(PLAN_RELEVANT_KEYS.map((k) => config[k] ?? null));
}

/** §19 增删/移动后重新编号：id 必须从 1 连续，否则 validateBeatPlan 拒绝。 */
function renumberBeats(beats: StoryBeat[]): StoryBeat[] {
  return beats.map((b, i) => ({ ...b, id: i + 1 }));
}

/** characters 输入用中文顿号/逗号分隔，落回字符串数组。 */
function parseCharacters(text: string): string[] {
  return text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

export default function GeneratePage() {
  const [settings] = useSettings();
  const [form, setForm] = useState<ConfigForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<string>(serializeStoryConfig(formToConfig(EMPTY_FORM)));
  const [beatPlan, setBeatPlan] = useState<BeatPlan | null>(null);
  const [planBaseline, setPlanBaseline] = useState<string | null>(null);
  const [planPhase, setPlanPhase] = useState<PlanPhase>("idle");
  const [planError, setPlanError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GenerateApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadText, setLoadText] = useState("");
  const busyRef = useRef(false);
  const planBusyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (p: Partial<ConfigForm>) => setForm(prev => ({ ...prev, ...p }));
  const isDirty = serializeStoryConfig(formToConfig(form)) !== baseline;
  const dirtyLabel = isDirty ? "Modified" : "Saved";

  // §22：plan 生成后，plan 相关字段变化 → outdated
  const planOutdated =
    beatPlan !== null &&
    planBaseline !== null &&
    planRelevantSnapshot(formToConfig(form)) !== planBaseline;

  const applyConfig = (config: StoryConfig) => {
    setForm(configToForm(config));
    setBaseline(serializeStoryConfig(config));
    // 整份配置被替换：旧剧情骨架随之失效（§26 生成失败也不丢 config，但换配置要重新规划）
    setBeatPlan(null);
    setPlanBaseline(null);
    setPlanPhase("idle");
    setPlanError("");
    setResult(null);
    setPreview(null);
    setPhase("idle");
  };

  // §19 BeatPlan 手动编辑：改字段 / 增删 / 移动。编辑的是 plan 本身，不是 StoryConfig，
  // 因此 planOutdated 不变（§22 只由 StoryConfig 变化触发）。
  const patchBeat = (id: number, patch: Partial<StoryBeat>) =>
    setBeatPlan((prev) =>
      prev ? { ...prev, beats: prev.beats.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : prev,
    );

  const addBeat = () =>
    setBeatPlan((prev) => {
      if (!prev) return prev;
      const nextId = prev.beats.reduce((max, b) => Math.max(max, b.id), 0) + 1;
      return { ...prev, beats: [...prev.beats, { id: nextId, purpose: "", event: "", characters: [] }] };
    });

  const deleteBeat = (id: number) =>
    setBeatPlan((prev) =>
      prev ? { ...prev, beats: renumberBeats(prev.beats.filter((b) => b.id !== id)) } : prev,
    );

  const moveBeat = (index: number, delta: number) =>
    setBeatPlan((prev) => {
      if (!prev) return prev;
      const to = index + delta;
      if (to < 0 || to >= prev.beats.length) return prev;
      const beats = [...prev.beats];
      const [moved] = beats.splice(index, 1);
      beats.splice(to, 0, moved);
      return { ...prev, beats: renumberBeats(beats) };
    });

  // §29 Load：先完整解析 + 验证，全部成功才替换表单（§46 原子性）
  const loadFromText = (text: string) => {    try {
      const config = parseStoryConfig(text);
      applyConfig(config);
      setLoadOpen(false);
      setLoadText("");
      toast.success("Config 已加载");
    } catch (e) {
      // §27：失败时当前表单保持不变，给出具体原因
      toast.error(`Config load failed：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleLoadFile = (file: File) => {
    file.text().then(loadFromText).catch(() => toast.error("Config load failed：文件读取失败"));
  };

  // §28 Save：下载 sanitized_title.story.json
  const handleSave = () => {
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    const config = formToConfig(form);
    const blob = new Blob([serializeStoryConfig(config)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = configFilename(config.title);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setBaseline(serializeStoryConfig(config));
    toast.success(`Config 已保存：${configFilename(config.title)}`);
  };

  // §30 New：恢复默认值（dirty 时二次确认 §44）
  const handleNew = () => {
    if (isDirty && !window.confirm("You have unsaved changes. 确定新建配置？")) return;
    applyConfig(formToConfig(EMPTY_FORM));
    setForm(EMPTY_FORM);
    setBaseline(serializeStoryConfig(formToConfig(EMPTY_FORM)));
    toast.success("已新建配置");
  };

  // §9/§18 Generate Plan：StoryConfig → BeatPlanner → BeatPlan
  async function handlePlan() {
    if (planBusyRef.current) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    planBusyRef.current = true;
    setPlanPhase("planning");
    setPlanError("");
    try {
      const config = formToConfig(form);
      const plan = await planStory(config, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      });
      setBeatPlan(plan);
      setPlanBaseline(planRelevantSnapshot(config));
      setPlanPhase("success");
      toast.success(`剧情骨架已生成：${plan.beats.length} 个 Beat`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      setPlanError(msg);
      setPlanPhase("error");
      toast.error(msg);
    } finally {
      planBusyRef.current = false;
    }
  }

  async function handleGenerate() {
    if (busyRef.current) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    if (!beatPlan) { toast.error("Generate a beat plan first."); return; }
    // §47 手动编辑可能留下空字段：先本地校验，避免无谓请求
    try {
      validateBeatPlan(beatPlan);
    } catch (e) {
      toast.error(`BeatPlan 不合法：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (planOutdated && !window.confirm(
      "StoryConfig changed after this plan was generated.\n确定使用现有 BeatPlan 生成？（Use Existing Plan Anyway）",
    )) return;
    busyRef.current = true;
    setPhase("generating");
    setErrorMsg("");
    setPreview(null);
    try {
      const config = formToConfig(form);
      const data = await generateStory(config, beatPlan, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      });
      setResult(data);
      setPhase("success");
      toast.success("生成完成，已保存 Markdown + Config + Beats 快照");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      setErrorMsg(msg);
      setPhase("error");
      toast.error(msg);
    } finally {
      busyRef.current = false;
    }
  }

  async function handlePreview() {
    if (previewing) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    setPreviewing(true);
    try {
      setPreview(await previewPrompt(formToConfig(form), beatPlan ?? undefined));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "预览失败");
    } finally {
      setPreviewing(false);
    }
  }

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(`# ${result.title}\n\n${result.content}`).then(() => toast.success("Copied"));
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([`# ${result.title}\n\n${result.content}`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const handleDownloadConfig = () => {
    const blob = new Blob([serializeStoryConfig(formToConfig(form))], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = configFilename(formToConfig(form).title);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const fieldCls = "h-9";
  const generating = phase === "generating";
  const planning = planPhase === "planning";
  const busy = generating || planning;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto p-3 sm:p-4 gap-3">
      {/* §24 Step 1/2 — StoryConfig → Step 2/2 — Beats & Story（纯前端表现） */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className={planPhase === "success" ? "text-emerald-500" : ""}>Step 1 / 2 — StoryConfig</span>
        <span>→</span>
        <span className={planPhase === "success" ? "" : "opacity-40"}>Step 2 / 2 — Beats &amp; Story</span>
        {beatPlan && planOutdated && (
          <span className="ml-auto text-amber-500 border border-amber-500/30 bg-amber-500/10 rounded-full px-2.5 py-0.5">
            BeatPlan Outdated — StoryConfig changed. Regenerate the plan before generating the story.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* 配置区 */}
        <section className="flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft p-4 sm:p-5 gap-4 min-h-[320px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-violet-500 shadow-glow" />
              <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Story Config</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${isDirty ? "text-amber-500 border-amber-500/30 bg-amber-500/10" : "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"}`}>
                {dirtyLabel}
              </span>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleNew} title="New Config">
                <FilePlus2 className="h-3.5 w-3.5" /> New
              </Button>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={() => fileRef.current?.click()} title="Load Config（.json）">
                <FolderOpen className="h-3.5 w-3.5" /> Load
              </Button>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleSave} title="Save Config">
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLoadFile(f); e.target.value = ""; }} />
            </div>
          </div>

          {/* §41 Basic */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Story Title</Label>
              <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="消失的目击者" maxLength={120} disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Target Words</Label>
              <Input type="number" min={500} max={30000} step={100} value={form.targetWords}
                onChange={(e) => set({ targetWords: Number(e.target.value) })} disabled={busy} className={fieldCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Genre</Label>
              <select value={form.genre} onChange={(e) => set({ genre: e.target.value })} disabled={busy}
                className="w-full h-9 rounded-xl border border-white/10 bg-zinc-800/60 px-3 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-500/30">
                {GENRE_PRESETS.map((g) => <option key={g} value={g} className="bg-zinc-900">{g}</option>)}
              </select>
            </div>
            {form.genre === "其他" && (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">自定义题材</Label>
                <Input value={form.customGenre} onChange={(e) => set({ customGenre: e.target.value })} placeholder="黑色幽默荒诞职场" disabled={busy} className={fieldCls} />
              </div>
            )}
          </div>

          {/* §41 Core Story */}
          <div className="rounded-2xl border border-white/5 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Core Story</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Premise（核心设定）</Label>
              <Textarea value={form.premise} onChange={(e) => set({ premise: e.target.value })}
                placeholder="一名商业贿赂案的唯一证人在出庭前一天突然失踪，负责保护她的警员只离开了三分钟。"
                disabled={busy} className="min-h-[64px] resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Setting（故事背景，可选）</Label>
              <Input value={form.setting} onChange={(e) => set({ setting: e.target.value })}
                placeholder="现代一线城市，商业贿赂案庭审前夜。" disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Conflict（主要冲突，可选）</Label>
              <Input value={form.conflict} onChange={(e) => set({ conflict: e.target.value })}
                placeholder="女主必须在嫌疑人销毁证据之前找到失踪证人。" disabled={busy} className={fieldCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Stakes（失败代价，可选）</Label>
                <Input value={form.stakes} onChange={(e) => set({ stakes: e.target.value })}
                  placeholder="证人缺席将导致案件失败。" disabled={busy} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Ending（结局方向，可选）</Label>
                <Input value={form.ending} onChange={(e) => set({ ending: e.target.value })}
                  placeholder="留空由模型决定" disabled={busy} className={fieldCls} />
              </div>
            </div>
          </div>

          {/* §41 Protagonist */}
          <div className="rounded-2xl border border-white/5 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Protagonist</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Name</Label>
                <Input value={form.protagonistName} onChange={(e) => set({ protagonistName: e.target.value })}
                  placeholder="陈岚" disabled={busy} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Identity（可选）</Label>
                <Input value={form.protagonistIdentity} onChange={(e) => set({ protagonistIdentity: e.target.value })}
                  placeholder="刑警" disabled={busy} className={fieldCls} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Goal（可选）</Label>
              <Input value={form.protagonistGoal} onChange={(e) => set({ protagonistGoal: e.target.value })}
                placeholder="在开庭前找到证人" disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Motivation（可选）</Label>
              <Input value={form.protagonistMotivation} onChange={(e) => set({ protagonistMotivation: e.target.value })}
                placeholder="她负责证人的保护工作" disabled={busy} className={fieldCls} />
            </div>
          </div>

          {/* §41 Style */}
          <div className="rounded-2xl border border-white/5 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Style</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Style（可选）</Label>
              <Input value={form.style} onChange={(e) => set({ style: e.target.value })} placeholder="冷峻、节奏紧凑"
                list="style-presets" disabled={busy} className={fieldCls} />
              <datalist id="style-presets">
                {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Extra Requirements（可选）</Label>
              <Textarea value={form.extraRequirements} onChange={(e) => set({ extraRequirements: e.target.value })}
                placeholder={"不要使用超自然元素。\n结尾需要完整解释失踪原因。"} disabled={busy} className="min-h-[56px] resize-none" />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handlePlan} disabled={busy}
              className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60">
              {planning ? <><Loader2 className="h-4 w-4 animate-spin" /> Planning...</> : <><Sparkles className="h-4 w-4" /> Generate Plan</>}
            </Button>
            <Button variant="outline" disabled={busy || previewing} onClick={handlePreview}
              className="h-10 rounded-full text-xs" title="预览渲染后的最终 Prompt（不调用 LLM）">
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} Preview
            </Button>
          </div>
          {planPhase === "error" && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-3 text-xs">
              <span className="font-medium text-red-500">Planning failed.</span>
              <span className="text-muted-foreground ml-1">{planError}</span>
              <span className="text-muted-foreground ml-1">（StoryConfig 已保留，可再次点击 Generate Plan 手动重试）</span>
            </div>
          )}
        </section>

        {/* Beat Plan + 结果区 */}
        <section className="flex flex-col gap-3 min-h-[320px]">
          {/* §17 Beat Plan 区 */}
          <div className="rounded-3xl border border-white/10 bg-card/60 glass shadow-soft flex flex-col min-h-[200px] overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${beatPlan ? "bg-emerald-500" : "bg-zinc-600"}`} />
                <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">
                  Beat Plan {beatPlan ? `(${beatPlan.beats.length})` : ""}
                </h2>
                {beatPlan && planOutdated && <span className="text-[10px] text-amber-500 font-mono">OUTDATED</span>}
              </div>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={addBeat}
                disabled={!beatPlan || busy} title={beatPlan ? "在末尾追加一个 Beat" : "Generate a beat plan first."}>
                <Plus className="h-3.5 w-3.5" /> Add Beat
              </Button>
            </div>
            <ScrollArea className="max-h-[340px]">
              <div className="p-3 sm:p-4 space-y-2">
                {!beatPlan && !planning && (
                  <div className="py-10 text-center text-muted-foreground text-[13px]">
                    点击 Generate Plan 生成剧情骨架（可查看，然后再生成正文）
                  </div>
                )}
                {planning && (
                  <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
                    <span className="text-xs font-mono">Planning beats...</span>
                  </div>
                )}
                {beatPlan && (
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-muted-foreground">Summary（可选）</Label>
                    <Input value={beatPlan.summary ?? ""} placeholder="故事整体规划摘要"
                      onChange={(e) => setBeatPlan((prev) => (prev ? { ...prev, summary: e.target.value || undefined } : prev))}
                      disabled={busy} className={fieldCls} />
                  </div>
                )}
                {beatPlan?.beats.map((beat, index) => (
                  <div key={beat.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-bold text-violet-300">Beat {beat.id}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full" title="上移"
                          disabled={busy || index === 0} onClick={() => moveBeat(index, -1)}>
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full" title="下移"
                          disabled={busy || index === beatPlan.beats.length - 1} onClick={() => moveBeat(index, 1)}>
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full text-red-400 hover:text-red-300" title="删除这个 Beat"
                          disabled={busy || beatPlan.beats.length <= 1} onClick={() => deleteBeat(beat.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Purpose</Label>
                      <Input value={beat.purpose} placeholder="这一拍的结构作用，如：建立危机"
                        onChange={(e) => patchBeat(beat.id, { purpose: e.target.value })} disabled={busy} className={fieldCls} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Event</Label>
                      <Textarea value={beat.event} placeholder="这一拍实际发生的事件"
                        onChange={(e) => patchBeat(beat.id, { event: e.target.value })} disabled={busy} className="min-h-[56px] resize-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">Characters（顿号分隔）</Label>
                        <Input value={beat.characters.join("、")} placeholder="陈岚、周衡"
                          onChange={(e) => patchBeat(beat.id, { characters: parseCharacters(e.target.value) })} disabled={busy} className={fieldCls} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">Conflict（可选）</Label>
                        <Input value={beat.conflict ?? ""} placeholder="本拍局部冲突"
                          onChange={(e) => patchBeat(beat.id, { conflict: e.target.value || undefined })} disabled={busy} className={fieldCls} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Expected Outcome（可选）</Label>
                      <Input value={beat.expected_outcome ?? ""} placeholder="本拍结束后故事状态的变化"
                        onChange={(e) => patchBeat(beat.id, { expected_outcome: e.target.value || undefined })} disabled={busy} className={fieldCls} />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* 生成结果 */}
          <div className="flex-1 min-h-[280px] flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Generated Story</h2>
              </div>
              {phase === "success" && result && (
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleCopy}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleDownload}>
                    <Download className="h-3.5 w-3.5" /> Markdown
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleDownloadConfig}>
                    <Download className="h-3.5 w-3.5" /> Config
                  </Button>
                </div>
              )}
            </div>

            {phase === "error" && (
              <div className="m-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm">
                <div className="font-medium text-red-500">Generation failed.</div>
                <div className="text-muted-foreground mt-1 text-xs break-all">{errorMsg}</div>
                <div className="text-[11px] text-muted-foreground mt-1">BeatPlan 已保留，可直接再次点击 Generate Story。</div>
              </div>
            )}

            {preview && (
              <details className="mx-4 mt-3 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3" open>
                <summary className="text-[11px] font-mono tracking-wide text-violet-300 cursor-pointer">FINAL PROMPT（preview）</summary>
                <pre className="mt-2 text-[11px] leading-5 text-zinc-300 whitespace-pre-wrap max-h-52 overflow-auto">{preview}</pre>
              </details>
            )}

            <div className="flex-1 min-h-0 overflow-hidden">
              {generating ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="h-7 w-7 animate-spin text-violet-400" />
                  <span className="text-xs font-mono tracking-wide">Generating...</span>
                </div>
              ) : phase === "success" && result ? (
                <ScrollArea className="h-full">
                  <div className="p-4 sm:p-6">
                    <h1 className="text-2xl font-bold tracking-tight mb-1">{result.title}</h1>
                    <div className="text-[11px] text-muted-foreground font-mono mb-4">
                      {result.request.genre} · 约 {result.request.target_words} 字 · {result.request.beat_count} beats · model: {result.model} · {new Date(result.created_at).toLocaleString()}
                    </div>
                    <div className="prose prose-invert max-w-none prose-p:text-[15px] prose-p:leading-[26px]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
                    </div>
                  </div>
                </ScrollArea>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground px-6 text-center">
                  <div className="size-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                    <BookOpen className="h-6 w-6" />
                  </div>
                  <p className="text-[13px]">
                    {beatPlan ? "点击 Generate Story，根据剧情骨架写正文" : "先生成 Beat Plan（剧情骨架），再生成正文"}
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 sm:px-5 py-3 border-t border-white/5 shrink-0 flex gap-2">
              <Button onClick={handleGenerate} disabled={busy || !beatPlan}
                title={beatPlan ? "根据 Beat Plan 生成正文" : "Generate a beat plan first."}
                className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60">
                {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="h-4 w-4" /> Generate Story</>}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
