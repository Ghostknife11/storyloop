"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PROVIDERS } from "@/lib/constants";
import {
  MAX_ATTEMPTS_RANGE,
  MAX_REPAIRS_RANGE,
  MIN_SCORE_RANGE,
  useSettings,
} from "@/lib/settings-store";

/**
 * `/settings`（TASK §26/§30/§31/§34）：model / base_url / temperature + 自动重试 + 定点修订。
 * API Key 不进浏览器（§24）——只存服务端 .env。
 * §66 自动重试只暴露 Max Attempts / Minimum Review Score / Retry on Validation Failure；
 * §34/§63 定点修订只暴露 Enable Targeted Repair / Max Repairs Per Attempt——
 * 没有修复策略排序、问题定向扩展、失败归因、自适应策略入口。
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

        <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-4">
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

        <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Automatic Retry</h2>
            <p className="text-[11px] text-muted-foreground leading-5">
              重新生成整篇小说——使用同一份 StoryConfig 与 BeatPlan，不做局部修复。
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Enable Automatic Retry</Label>
              <p className="text-[10px] text-muted-foreground">关闭后每次 Run 只生成一次</p>
            </div>
            <Switch
              checked={mounted ? settings.retryEnabled : true}
              onCheckedChange={(v) => update({ retryEnabled: v })}
              aria-label="Enable Automatic Retry"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Max Attempts</Label>
              <p className="text-[10px] text-muted-foreground">
                含首次生成，{MAX_ATTEMPTS_RANGE.min} ~ {MAX_ATTEMPTS_RANGE.max} 次
              </p>
            </div>
            <Input
              type="number"
              min={MAX_ATTEMPTS_RANGE.min}
              max={MAX_ATTEMPTS_RANGE.max}
              step={1}
              value={mounted ? settings.maxAttempts : 2}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= MAX_ATTEMPTS_RANGE.min && n <= MAX_ATTEMPTS_RANGE.max) {
                  update({ maxAttempts: n });
                }
              }}
              className="h-9 w-20 text-center font-mono"
              aria-label="Max Attempts"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Minimum Review Score</Label>
              <p className="text-[10px] text-muted-foreground">
                低于该总分即重试，{MIN_SCORE_RANGE.min} ~ {MIN_SCORE_RANGE.max}
              </p>
            </div>
            <Input
              type="number"
              min={MIN_SCORE_RANGE.min}
              max={MIN_SCORE_RANGE.max}
              step={1}
              value={mounted ? settings.minReviewScore : 70}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= MIN_SCORE_RANGE.min && n <= MIN_SCORE_RANGE.max) {
                  update({ minReviewScore: n });
                }
              }}
              className="h-9 w-20 text-center font-mono"
              aria-label="Minimum Review Score"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Retry on Validation Failure</Label>
              <p className="text-[10px] text-muted-foreground">硬性校验未通过时也重新生成</p>
            </div>
            <Switch
              checked={mounted ? settings.retryOnValidationFailure : true}
              onCheckedChange={(v) => update({ retryOnValidationFailure: v })}
              aria-label="Retry on Validation Failure"
            />
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-muted-foreground leading-5">
            <RotateCcw className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 inline-block align-[-2px] mr-1.5" />
            Increasing max attempts may increase API usage and cost.
          </div>
        </div>

        {/* §34 Targeted Repair：先修现有 Story，修不动才整篇重生。 */}
        <div className="rounded-2xl border border-border bg-muted/40 backdrop-blur p-4 sm:p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Targeted Repair</h2>
            <p className="text-[11px] text-muted-foreground leading-5">
              针对某一条明确的校验 / 审阅问题修订现有正文（结局、篇幅、主角在场、连贯、结构），
              修订后会重新校验与审阅；修不动才整篇重生。
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Enable Targeted Repair</Label>
              <p className="text-[10px] text-muted-foreground">关闭后不合格就直接整篇重写（v0.7.0 行为）</p>
            </div>
            <Switch
              checked={mounted ? settings.repairEnabled : true}
              onCheckedChange={(v) => update({ repairEnabled: v })}
              aria-label="Enable Targeted Repair"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label className="text-[11px] text-muted-foreground">Max Repairs Per Attempt</Label>
              <p className="text-[10px] text-muted-foreground">
                同一次生成内最多修订几次，{MAX_REPAIRS_RANGE.min} ~ {MAX_REPAIRS_RANGE.max}
              </p>
            </div>
            <Input
              type="number"
              min={MAX_REPAIRS_RANGE.min}
              max={MAX_REPAIRS_RANGE.max}
              step={1}
              value={mounted ? settings.maxRepairsPerAttempt : 1}
              disabled={!settings.repairEnabled}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= MAX_REPAIRS_RANGE.min && n <= MAX_REPAIRS_RANGE.max) {
                  update({ maxRepairsPerAttempt: n });
                }
              }}
              className="h-9 w-20 text-center font-mono"
              aria-label="Max Repairs Per Attempt"
            />
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-muted-foreground leading-5">
            <RotateCcw className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 inline-block align-[-2px] mr-1.5" />
            Each repair is one extra LLM call. v0.8.0 uses simple issue categories and does not
            diagnose why a story failed.
          </div>
        </div>

        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 flex gap-3">
          <KeyRound className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground leading-5">
            <span className="text-amber-600 dark:text-amber-300 font-medium">API Key 不在浏览器保存。</span>
            请在服务端 <code className="font-mono text-foreground">.env</code> 中配置
            <code className="font-mono text-foreground mx-1">LLM_API_KEY</code>（另可配置
            <code className="font-mono text-foreground mx-1">LLM_BASE_URL</code> /
            <code className="font-mono text-foreground mx-1">LLM_MODEL</code> 作为默认值）。
            参考项目根目录的 <code className="font-mono text-foreground">.env.example</code>。
          </div>
        </div>
      </div>
    </div>
  );
}
