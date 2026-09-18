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
  buildRequestPayload,
  GENRE_PRESETS,
  STYLE_PRESETS,
  TARGET_WORDS_DEFAULT,
  type FormState,
} from "@/types/story-request";

type Phase = "idle" | "generating" | "success" | "error";

const INITIAL_FORM: FormState = {
  title: "",
  genre: "悬疑",
  customGenre: "",
  premise: "",
  targetWords: TARGET_WORDS_DEFAULT,
  style: "",
  extraRequirements: "",
};

/**
 * `/` Generate 页面 v0.1.0（TASK §5/§6）：Title / Genre / Premise / Target Words /
 * Style / Extra Requirements → 结构化 StoryRequest → /api/generate。
 */
export default function GeneratePage() {
  const [settings] = useSettings();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GenerateApiResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const busyRef = useRef(false);

  const set = (p: Partial<FormState>) => setForm(prev => ({ ...prev, ...p }));

  async function handleGenerate() {
    if (busyRef.current) return;
    const check = buildRequestPayload(form);
    if (!check.ok) { toast.error(check.error); return; }
    busyRef.current = true;
    setPhase("generating");
    setErrorMsg("");
    setPreview(null);
    try {
      const data = await generateStory(check.payload, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      });
      setResult(data);
      setPhase("success");
      toast.success("生成完成，已保存 Markdown + 元数据");
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
    const check = buildRequestPayload(form);
    if (!check.ok) { toast.error(check.error); return; }
    setPreviewing(true);
    try {
      setPreview(await previewPrompt(check.payload));
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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto p-3 sm:p-4 gap-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* 输入区 */}
        <section className="flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft p-4 sm:p-5 gap-3.5 min-h-[320px]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-violet-500 shadow-glow" />
            <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Generate</h2>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Story Title</Label>
            <Input
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="消失的目击者"
              maxLength={120}
              disabled={phase === "generating"}
              className="h-9"
            />
          </div>

          <div className="grid grid-cols-[1fr_130px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Genre</Label>
              <select
                value={form.genre}
                onChange={(e) => set({ genre: e.target.value })}
                disabled={phase === "generating"}
                className="w-full h-9 rounded-xl border border-white/10 bg-zinc-800/60 px-3 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
              >
                {GENRE_PRESETS.map((g) => <option key={g} value={g} className="bg-zinc-900">{g}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Target Words</Label>
              <Input
                type="number"
                min={500}
                max={30000}
                step={100}
                value={form.targetWords}
                onChange={(e) => set({ targetWords: Number(e.target.value) })}
                disabled={phase === "generating"}
                className="h-9"
              />
            </div>
          </div>
          {form.genre === "其他" && (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">自定义题材</Label>
              <Input
                value={form.customGenre}
                onChange={(e) => set({ customGenre: e.target.value })}
                placeholder="黑色幽默荒诞职场"
                disabled={phase === "generating"}
                className="h-9"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Premise（核心设定）</Label>
            <Textarea
              value={form.premise}
              onChange={(e) => set({ premise: e.target.value })}
              placeholder="一名商业贿赂案的唯一证人在出庭前一天突然失踪，负责保护她的警员只离开了三分钟。"
              disabled={phase === "generating"}
              className="min-h-[84px] resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Style（可选）</Label>
            <Input
              value={form.style}
              onChange={(e) => set({ style: e.target.value })}
              placeholder="冷峻、节奏紧凑"
              list="style-presets"
              disabled={phase === "generating"}
              className="h-9"
            />
            <datalist id="style-presets">
              {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Extra Requirements（可选）</Label>
            <Textarea
              value={form.extraRequirements}
              onChange={(e) => set({ extraRequirements: e.target.value })}
              placeholder={"不要使用超自然元素。\n结尾需要完整解释失踪原因。"}
              disabled={phase === "generating"}
              className="min-h-[64px] resize-none"
            />
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleGenerate}
              disabled={phase === "generating"}
              className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60"
            >
              {phase === "generating" ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
              ) : (
                <><Sparkles className="h-4 w-4" /> Generate Story</>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={phase === "generating" || previewing}
              onClick={handlePreview}
              className="h-10 rounded-full text-xs"
              title="预览渲染后的最终 Prompt（不调用 LLM）"
            >
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} Preview
            </Button>
          </div>
        </section>

        {/* 结果/预览区 */}
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
                <p className="text-[13px]">填写标题、题材与核心设定，点击 Generate Story</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
