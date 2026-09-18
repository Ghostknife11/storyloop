"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { BookOpen, Copy, Download, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useSettings } from "@/lib/settings-store";

type Phase = "idle" | "generating" | "success" | "error";

interface GenerateResult {
  title: string;
  content: string;
  model: string;
  created_at: string;
}

/**
 * `/` Generate 页面（TASK §6-§10）。
 * 状态机仅 idle / generating / success / error（§28）。
 * 连续点击被 disabled + busyRef 双重拦截（§40 Case D）。
 */
export default function GeneratePage() {
  const [settings] = useSettings();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const busyRef = useRef(false);

  async function handleGenerate() {
    if (busyRef.current) return;
    if (!title.trim()) { toast.error("请填写故事标题"); return; }
    if (!prompt.trim()) { toast.error("请填写故事需求"); return; }
    busyRef.current = true;
    setPhase("generating");
    setErrorMsg("");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          prompt: prompt.trim(),
          model: settings.model || undefined,
          baseUrl: settings.baseUrl || undefined,
          temperature: settings.temperature,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `生成失败（HTTP ${res.status}）`);
      }
      setResult(data as GenerateResult);
      setPhase("success");
      toast.success("生成完成，已保存 Markdown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      setErrorMsg(msg);
      setPhase("error");
      toast.error(msg);
    } finally {
      busyRef.current = false;
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
        <section className="flex flex-col rounded-3xl border border-white/10 bg-card/60 glass shadow-soft p-4 sm:p-5 gap-4 min-h-[320px]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-violet-500 shadow-glow" />
            <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Generate</h2>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Story Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="消失的目击者"
              disabled={phase === "generating"}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5 flex-1 flex flex-col">
            <Label className="text-[11px] text-muted-foreground">Story Request</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={"写一篇都市悬疑短篇小说。\n\n女主是一宗商业贿赂案唯一证人，\n在出庭前一天突然消失。"}
              disabled={phase === "generating"}
              className="flex-1 min-h-[140px] resize-none"
            />
          </div>
          <Button
            onClick={handleGenerate}
            disabled={phase === "generating"}
            className="h-11 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60"
          >
            {phase === "generating" ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
            ) : (
              <><Sparkles className="h-4 w-4" /> Generate Story</>
            )}
          </Button>
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
                    model: {result.model} · {new Date(result.created_at).toLocaleString()}
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
                <p className="text-[13px]">填写标题与故事需求，点击 Generate Story</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
