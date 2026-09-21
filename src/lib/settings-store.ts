"use client";

import { useEffect, useState } from "react";
import { DEFAULT_GENERATION_PARAMS } from "@/lib/constants";

export interface AppSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  /** §30 自动重试总开关（默认 ON）。 */
  retryEnabled: boolean;
  /** §30/§31：总尝试次数（含首次生成），1 ~ 5。 */
  maxAttempts: number;
  /** §30/§31：单一总分阈值，0 ~ 100。 */
  minReviewScore: number;
  /** §30：Validation Failed 是否也重试（默认 ON）。 */
  retryOnValidationFailure: boolean;
}

const DEFAULTS: AppSettings = {
  baseUrl: "",
  model: "",
  temperature: DEFAULT_GENERATION_PARAMS.temperature,
  retryEnabled: true,
  maxAttempts: 2,
  minReviewScore: 70,
  retryOnValidationFailure: true,
};

const STORAGE_KEY = "storyloop-settings-v2";

/** §31 与 RetryPolicy / API 同一套范围，避免不同入口结论不一致。 */
export const MAX_ATTEMPTS_RANGE = { min: 1, max: 5 } as const;
export const MIN_SCORE_RANGE = { min: 0, max: 100 } as const;

/** §31：越界一律夹回默认值，不让坏设置把 Run 变成无限重试。 */
function clampAttempts(raw: unknown): number {
  const n = typeof raw === "number" && Number.isInteger(raw) ? raw : DEFAULTS.maxAttempts;
  return Math.min(MAX_ATTEMPTS_RANGE.max, Math.max(MAX_ATTEMPTS_RANGE.min, n));
}

function clampScore(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULTS.minReviewScore;
  return Math.min(MIN_SCORE_RANGE.max, Math.max(MIN_SCORE_RANGE.min, n));
}

function boolOf(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * v0.0.1 设置：仅 model / base_url / temperature（§26）。
 * API Key 不进浏览器（§24）——只放服务端 .env。
 * v0.7.0 增加自动重试设置（§30）：只有四个字段，没有修复策略 / 维度阈值入口（§66）。
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
        retryEnabled: boolOf(parsed.retryEnabled, DEFAULTS.retryEnabled),
        maxAttempts: clampAttempts(parsed.maxAttempts),
        minReviewScore: clampScore(parsed.minReviewScore),
        retryOnValidationFailure: boolOf(parsed.retryOnValidationFailure, DEFAULTS.retryOnValidationFailure),
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

/**
 * §37 AppSettings → POST /api/runs 的 retry_policy。
 * 关闭自动重试时只保留一次尝试（max_attempts: 1），而不是把阈值改成不可能达成的值。
 */
export function retryPolicyOf(settings: AppSettings): {
  max_attempts: number;
  min_review_score: number;
  retry_on_validation_failure: boolean;
} {
  return {
    max_attempts: settings.retryEnabled ? clampAttempts(settings.maxAttempts) : 1,
    min_review_score: clampScore(settings.minReviewScore),
    retry_on_validation_failure: settings.retryOnValidationFailure,
  };
}
