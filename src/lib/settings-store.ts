"use client";

import { useEffect, useState } from "react";
import { DEFAULT_GENERATION_PARAMS } from "@/lib/constants";

export interface AppSettings {
  baseUrl: string;
  model: string;
  temperature: number;
}

const DEFAULTS: AppSettings = {
  baseUrl: "",
  model: "",
  temperature: DEFAULT_GENERATION_PARAMS.temperature,
};

const STORAGE_KEY = "storyloop-settings-v1";

/**
 * v0.0.1 设置：仅 model / base_url / temperature（§26）。
 * API Key 不进浏览器（§24）——只放服务端 .env。
 */
function load(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULTS.baseUrl,
        model: typeof parsed.model === "string" ? parsed.model : DEFAULTS.model,
        temperature:
          typeof parsed.temperature === "number" && Number.isFinite(parsed.temperature)
            ? parsed.temperature
            : DEFAULTS.temperature,
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function saveSettings(s: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function useSettings(): [AppSettings, (p: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  useEffect(() => { setSettings(load()); }, []);
  const update = (p: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...p };
      saveSettings(next);
      return next;
    });
  };
  return [settings, update];
}
