"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { BookOpen, Copy, Download, Eye, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { generateStory, previewPrompt, type GenerateApiResult } from "@/lib/api";
import { useSettings } from "@/lib/settings-store";
import {
  GENRE_PRESETS, STYLE_PRESETS, STORY_CONFIG_VERSION, TARGET_WORDS_DEFAULT,
  type StoryConfig,
} from "@/types/story-config";

type Phase = "idle" | "generating" | "success" | "error";

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

export default function GeneratePage() {
  const [settings] = useSettings();
  const [form, setForm] = useState<ConfigForm>(EMPTY_FORM);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GenerateApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const busyRef = useRef(false);

  const set = (p: Partial<ConfigForm>) => setForm(prev => ({ ...prev, ...p }));

  async function handleGenerate() {
    if (busyRef.current) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    busyRef.current = true;
    setPhase("generating");
    setErrorMsg("");
    setPreview(null);
    try {
      const config = formToConfig(form);
      const data = await generateStory(config, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      });
      setResult(data);
      setPhase("success");
      toast.success("生成完成，已保存 Markdown + Config 快照");
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
      setPreview(await previewPrompt(formToConfig(form)));
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

  const fieldCls = "h-9";
  const generating = phase === "generating";

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto p-3 sm:p-4 gap-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* 配置区 */}
        <section className="flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft p-4 sm:p-5 gap-4 min-h-[320px]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-violet-500 shadow-glow" />
            <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Story Config</h2>
          </div>

          {/* §41 Basic */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Story Title</Label>
              <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="消失的目击者" maxLength={120} disabled={generating} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Target Words</Label>
              <Input type="number" min={500} max={30000} step={100} value={form.targetWords}
                onChange={(e) => set({ targetWords: Number(e.target.value) })} disabled={generating} className={fieldCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Genre</Label>
              <select value={form.genre} onChange={(e) => set({ genre: e.target.value })} disabled={generating}
                className="w-full h-9 rounded-xl border border-white/10 bg-zinc-800/60 px-3 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-500/30">
                {GENRE_PRESETS.map((g) => <option key={g} value={g} className="bg-zinc-900">{g}</option>)}
              </select>
            </div>
            {form.genre === "其他" && (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">自定义题材</Label>
                <Input value={form.customGenre} onChange={(e) => set({ customGenre: e.target.value })} placeholder="黑色幽默荒诞职场" disabled={generating} className={fieldCls} />
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
                disabled={generating} className="min-h-[64px] resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Setting（故事背景，可选）</Label>
              <Input value={form.setting} onChange={(e) => set({ setting: e.target.value })}
                placeholder="现代一线城市，商业贿赂案庭审前夜。" disabled={generating} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Conflict（主要冲突，可选）</Label>
              <Input value={form.conflict} onChange={(e) => set({ conflict: e.target.value })}
                placeholder="女主必须在嫌疑人销毁证据之前找到失踪证人。" disabled={generating} className={fieldCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Stakes（失败代价，可选）</Label>
                <Input value={form.stakes} onChange={(e) => set({ stakes: e.target.value })}
                  placeholder="证人缺席将导致案件失败。" disabled={generating} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Ending（结局方向，可选）</Label>
                <Input value={form.ending} onChange={(e) => set({ ending: e.target.value })}
                  placeholder="留空由模型决定" disabled={generating} className={fieldCls} />
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
                  placeholder="陈岚" disabled={generating} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Identity（可选）</Label>
                <Input value={form.protagonistIdentity} onChange={(e) => set({ protagonistIdentity: e.target.value })}
                  placeholder="刑警" disabled={generating} className={fieldCls} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Goal（可选）</Label>
              <Input value={form.protagonistGoal} onChange={(e) => set({ protagonistGoal: e.target.value })}
                placeholder="在开庭前找到证人" disabled={generating} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Motivation（可选）</Label>
              <Input value={form.protagonistMotivation} onChange={(e) => set({ protagonistMotivation: e.target.value })}
                placeholder="她负责证人的保护工作" disabled={generating} className={fieldCls} />
            </div>
          </div>

          {/* §41 Style */}
          <div className="rounded-2xl border border-white/5 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Style</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Style（可选）</Label>
              <Input value={form.style} onChange={(e) => set({ style: e.target.value })} placeholder="冷峻、节奏紧凑"
                list="style-presets" disabled={generating} className={fieldCls} />
              <datalist id="style-presets">
                {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Extra Requirements（可选）</Label>
              <Textarea value={form.extraRequirements} onChange={(e) => set({ extraRequirements: e.target.value })}
                placeholder={"不要使用超自然元素。\n结尾需要完整解释失踪原因。"} disabled={generating} className="min-h-[56px] resize-none" />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleGenerate} disabled={generating}
              className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60">
              {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="h-4 w-4" /> Generate Story</>}
            </Button>
            <Button variant="outline" disabled={generating || previewing} onClick={handlePreview}
              className="h-10 rounded-full text-xs" title="预览渲染后的最终 Prompt（不调用 LLM）">
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} Preview
            </Button>
          </div>
        </section>

        {/* 结果区 */}
        <section className="flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft min-h-[320px] overflow-hidden">
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
              </div>
            )}
          </div>

          {phase === "error" && (
            <div className="m-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm">
              <div className="font-medium text-red-500">Generation failed.</div>
              <div className="text-muted-foreground mt-1 text-xs break-all">{errorMsg}</div>
            </div>
          )}

          {preview && (
            <details className="mx-4 mt-3 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3" open>
              <summary className="text-[11px] font-mono tracking-wide text-violet-300 cursor-pointer">FINAL PROMPT（preview）</summary>
              <pre className="mt-2 text-[11px] leading-5 text-zinc-300 whitespace-pre-wrap max-h-52 overflow-auto">{preview}</pre>
            </details>
          )}

          <div className="flex-1 min-h-0 overflow-hidden">
            {phase === "generating" ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="h-7 w-7 animate-spin text-violet-400" />
                <span className="text-xs font-mono tracking-wide">Generating...</span>
              </div>
            ) : phase === "success" && result ? (
              <ScrollArea className="h-full">
                <div className="p-4 sm:p-6">
                  <h1 className="text-2xl font-bold tracking-tight mb-1">{result.title}</h1>
                  <div className="text-[11px] text-muted-foreground font-mono mb-4">
                    {result.request.genre} · 约 {result.request.target_words} 字 · model: {result.model} · {new Date(result.created_at).toLocaleString()}
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
                <p className="text-[13px]">填写 StoryConfig，点击 Generate Story；Save/Load 可复用配置</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
