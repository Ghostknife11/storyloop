import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENV_KEYS,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_TEMPERATURE,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  appSettings,
  llmSettings,
} from "@/lib/app-config";

/**
 * §4/§5/§6 配置收口：四类配置各自只有一个来源，优先级固定为
 * 请求覆盖 > 环境变量 > 默认值；API Key 不在配置层出现（§7）。
 */

const MANAGED_KEYS = ["LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT", "LOG_LEVEL", "RUNS_DIR"] as const;

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
  vi.unstubAllEnvs();
});

/** 设一个环境变量，并记住原值以便恢复。 */
function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

describe("§5 环境变量命名", () => {
  it("五个变量名固定，且全部 UPPER_SNAKE_CASE", () => {
    expect(ENV_KEYS).toEqual({
      llmBaseUrl: "LLM_BASE_URL",
      llmModel: "LLM_MODEL",
      llmTimeout: "LLM_TIMEOUT",
      logLevel: "LOG_LEVEL",
      runsDir: "RUNS_DIR",
    });
    for (const name of Object.values(ENV_KEYS)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("§7 API Key 不是配置层变量：配置接口里拿不到它", () => {
    setEnv("LLM_API_KEY", "sk-test-1234567890");
    const settings = llmSettings();
    expect(JSON.stringify(settings)).not.toContain("sk-test");
    expect(JSON.stringify(appSettings())).not.toContain("sk-test");
    expect(Object.keys(settings).some((k) => k.toLowerCase().includes("key"))).toBe(false);
    expect(Object.keys(appSettings()).some((k) => k.toLowerCase().includes("key"))).toBe(false);
  });
});

describe("Application Settings", () => {
  it("环境变量都缺省时用内置默认值", () => {
    for (const key of MANAGED_KEYS) delete process.env[key];
    expect(appSettings()).toEqual({
      runsDir: "runs",
      logLevel: DEFAULT_LOG_LEVEL,
      llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });
  });

  it("RUNS_DIR / LOG_LEVEL / LLM_TIMEOUT 来自环境变量", () => {
    setEnv("RUNS_DIR", " /tmp/storyloop-runs ");
    setEnv("LOG_LEVEL", "DEBUG");
    setEnv("LLM_TIMEOUT", "5000");
    expect(appSettings().runsDir).toBe("/tmp/storyloop-runs");
    expect(appSettings().logLevel).toBe("debug");
    expect(appSettings().llmTimeoutMs).toBe(5000);
  });

  it("LOG_LEVEL 无法识别时回落 INFO，不猜测", () => {
    for (const bad of ["verbose", "", "  ", "TRACE"]) {
      setEnv("LOG_LEVEL", bad);
      expect(appSettings().logLevel).toBe("info");
    }
    setEnv("LOG_LEVEL", "warning");
    expect(appSettings().logLevel).toBe("warning");
  });

  it("四个等级名固定且顺序为严重度递增", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warning", "error"]);
  });

  it("LLM_TIMEOUT 非正整数时回落默认值", () => {
    for (const bad of ["0", "-1", "abc", "1.9e"]) {
      setEnv("LLM_TIMEOUT", bad);
      expect(appSettings().llmTimeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
    }
    setEnv("LLM_TIMEOUT", "60000.7");
    expect(appSettings().llmTimeoutMs).toBe(60000);
  });

  it("§21 每次调用都重新读环境变量，不缓存", () => {
    delete process.env.RUNS_DIR;
    expect(appSettings().runsDir).toBe("runs");
    setEnv("RUNS_DIR", "elsewhere");
    expect(appSettings().runsDir).toBe("elsewhere");
  });
});

describe("§6 LLM Settings 优先级", () => {
  it("没有环境变量、没有覆盖 → 默认值", () => {
    for (const key of MANAGED_KEYS) delete process.env[key];
    expect(llmSettings()).toEqual({
      baseUrl: DEFAULT_LLM_BASE_URL,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });
  });

  it("环境变量高于默认值", () => {
    setEnv("LLM_BASE_URL", "https://example.invalid/v1");
    setEnv("LLM_MODEL", "story-model");
    setEnv("LLM_TIMEOUT", "1234");
    const s = llmSettings();
    expect(s.baseUrl).toBe("https://example.invalid/v1");
    expect(s.model).toBe("story-model");
    expect(s.timeoutMs).toBe(1234);
  });

  it("请求覆盖高于环境变量", () => {
    setEnv("LLM_BASE_URL", "https://env.invalid/v1");
    setEnv("LLM_MODEL", "env-model");
    setEnv("LLM_TIMEOUT", "1000");
    const s = llmSettings({ baseUrl: "https://req.invalid/v1", model: "req-model", timeoutMs: 2000, temperature: 0.3 });
    expect(s.baseUrl).toBe("https://req.invalid/v1");
    expect(s.model).toBe("req-model");
    expect(s.timeoutMs).toBe(2000);
    expect(s.temperature).toBe(0.3);
  });

  it("空白字符串覆盖视为没提供，继续往下找", () => {
    setEnv("LLM_MODEL", "env-model");
    expect(llmSettings({ model: "   " }).model).toBe("env-model");
    expect(llmSettings({}).model).toBe("env-model");
  });

  it("非正数的超时覆盖被忽略，用环境变量值", () => {
    setEnv("LLM_TIMEOUT", "1000");
    expect(llmSettings({ timeoutMs: 0 }).timeoutMs).toBe(1000);
    expect(llmSettings({ timeoutMs: -5 }).timeoutMs).toBe(1000);
    expect(llmSettings({ timeoutMs: Number.NaN }).timeoutMs).toBe(1000);
  });

  it("temperature 只来自请求覆盖，环境变量不能改它", () => {
    for (const key of MANAGED_KEYS) delete process.env[key];
    expect(llmSettings().temperature).toBe(DEFAULT_TEMPERATURE);
    expect(llmSettings({ temperature: 0 }).temperature).toBe(0);
  });
});
