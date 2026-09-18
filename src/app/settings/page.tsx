"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { PROVIDERS } from "@/lib/constants";
import { useSettings } from "@/lib/settings-store";

/**
 * `/settings`（TASK §26）：最低配置 model / base_url / temperature。
 * API Key 不进浏览器（§24）——只存服务端 .env。
 */
export default function SettingsPage() {
  const [settings, update] = useSettings();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const allModels = Object.values(PROVIDERS).flatMap((p) => p.models);

  const handleSave = () => {
    toast.success("设置已保存（浏览器本地，非密钥项）");
  };

  return (
    <div className="h-full overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground mt-1">模型与生成参数 · 保存于浏览器本地</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 sm:p-5 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Base URL（留空则使用服务端 .env 的 LLM_BASE_URL）</Label>
            <Input
              value={mounted ? settings.baseUrl : ""}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Model（留空则使用服务端 .env 的 LLM_MODEL）</Label>
            <Input
              value={mounted ? settings.model : ""}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="deepseek-chat"
              list="model-options"
              className="h-10"
            />
            <datalist id="model-options">
              {allModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-muted-foreground">Temperature：{settings.temperature.toFixed(2)}</Label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={mounted ? settings.temperature : 0.8}
              onChange={(e) => update({ temperature: Number(e.target.value) })}
              className="w-full accent-violet-500"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSave} className="rounded-full bg-violet-600 hover:bg-violet-500 text-white">
              <Save className="h-4 w-4" /> 保存设置
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 flex gap-3">
          <KeyRound className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground leading-5">
            <span className="text-amber-300 font-medium">API Key 不在浏览器保存。</span>
            请在服务端 <code className="font-mono text-zinc-300">.env</code> 中配置
            <code className="font-mono text-zinc-300 mx-1">LLM_API_KEY</code>（另可配置
            <code className="font-mono text-zinc-300 mx-1">LLM_BASE_URL</code> /
            <code className="font-mono text-zinc-300 mx-1">LLM_MODEL</code> 作为默认值）。
            参考项目根目录的 <code className="font-mono text-zinc-300">.env.example</code>。
          </div>
        </div>
      </div>
    </div>
  );
}
