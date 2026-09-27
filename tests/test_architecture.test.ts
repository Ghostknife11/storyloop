/**
 * v2.0.0 架构门禁（TASK §39/§71/§72/§74）。
 *
 * 做法：读源码、剥掉注释、抽出 import 的模块名，再按目录判定层。只做静态扫描，
 * 不 import 任何业务代码——门禁自己不参与被检查的依赖图，也不会因为 import 了
 * 被测模块而把真实的依赖关系掩盖掉。
 *
 * 为什么先剥注释：v2.0.0 改造初期出现过一次误报——一段说明文字里提到
 * "infrastructure" 这个词，就被当成了真实依赖。注释与字符串都不是依赖，
 * 只有 import 语句里的模块名算。
 *
 * 门禁分两类：
 *   1. 硬规矩（§12/§33/§39/§71/§72）：一处违反就红，没有例外条目；
 *   2. 已记录的债（引擎层的 infrastructure 接缝）：白名单写死在本文件里，
 *      想多碰一个模块就得先来这里加理由——债可以还，不能偷偷长大。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const SCRIPTS = resolve(process.cwd(), "scripts");

/** src/ 下的一级目录就是一层的名字。 */
const LAYERS = [
  "domain",
  "engine",
  "analysis",
  "application",
  "ports",
  "infrastructure",
  "composition",
  "interface",
  "components",
  "app",
] as const;

type Layer = (typeof LAYERS)[number];

/** 界面层：组件、页面与服务端入口都在这里，规则比内层宽松但不许碰存储实现。 */
const INTERFACE_DIRS = ["interface", "components", "app"] as const;

function isLayer(value: string): value is Layer {
  return (LAYERS as readonly string[]).includes(value);
}

/** 递归列出目录下所有 .ts / .tsx（跳过 node_modules 与 .next）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 剥掉块注释与行注释（保留换行，行号不错位），字符串原样留下。 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      out += source.slice(i, end < 0 ? source.length : end + 2).replace(/[^\n]/g, " ");
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === char) break;
        j += 1;
      }
      out += source.slice(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** import / export ... from "x"、bare import "x"、动态 import("x") 三种写法。 */
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(source: string): string[] {
  const cleaned = stripComments(source);
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of cleaned.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

let cachedFiles: string[] | null = null;
function allFiles(): string[] {
  if (cachedFiles === null) {
    cachedFiles = walk(SRC)
      .map((f) => f.replace(/\\/g, "/").slice(SRC.length + 1))
      .sort();
  }
  return cachedFiles;
}

/** 模块名解析成 src/ 下的相对路径；解析不到（外部包）返回 null。 */
function resolveModule(fromFile: string, specifier: string): string | null {
  let candidate: string | null = null;
  if (specifier.startsWith("@/")) candidate = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = resolve(join(fromFile, ".."), specifier);
  if (candidate === null) return null;
  const rel = candidate.slice(SRC.length + 1).replace(/\\/g, "/");
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const withExt = rel + suffix;
    if (allFiles().includes(withExt)) return withExt;
  }
  return null;
}

function layerOfFile(relPath: string): Layer | null {
  const top = relPath.split("/")[0];
  return isLayer(top) ? top : null;
}

interface Dep {
  from: string;
  to: string;
  specifier: string;
}

let cachedScan: Dep[] | null = null;
function deps(): Dep[] {
  if (cachedScan === null) {
    const out: Dep[] = [];
    for (const rel of allFiles()) {
      if (layerOfFile(rel) === null) continue;
      const source = readFileSync(join(SRC, rel), "utf8");
      for (const specifier of specifiersOf(source)) {
        const target = resolveModule(join(SRC, rel), specifier);
        if (target === null) continue;
        out.push({ from: rel, to: target, specifier });
      }
    }
    cachedScan = out;
  }
  return cachedScan;
}

/** (层 → 层) 的边：只记「有没有」，不记几条。 */
function layerEdges(): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const dep of deps()) {
    const from = layerOfFile(dep.from);
    const to = layerOfFile(dep.to);
    if (from === null || to === null || from === to) continue;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  }
  return edges;
}

function filesForEdge(from: Layer, to: Layer): string[] {
  return [
    ...new Set(deps().filter((d) => layerOfFile(d.from) === from && layerOfFile(d.to) === to).map((d) => d.from)),
  ].sort();
}

// ---------------------------------------------------------------------------
// §12 依赖方向：Interface → Application → Domain/Engine/Analysis → Ports ← Infrastructure
// ---------------------------------------------------------------------------

describe("扫描器自己得是真的在扫", () => {
  it("扫到了上百条内部依赖，且几条已知的边确实在里面", () => {
    // 没有这一条，下面所有「禁止边」断言都可能只是对着空集合通过
    expect(deps().length).toBeGreaterThan(100);
    const edges = layerEdges();
    expect([...(edges.get("analysis") ?? [])]).toContain("domain");
    expect([...(edges.get("engine") ?? [])]).toContain("ports");
    expect([...(edges.get("infrastructure") ?? [])]).toContain("domain");
    expect([...(edges.get("app") ?? [])]).toContain("composition");
  });
});

describe("§12 依赖方向 — 禁止的边一条都不能有", () => {
  const FORBIDDEN: Array<[Layer, Layer[], string]> = [
    ["domain", ["engine", "analysis", "application", "ports", "infrastructure", "composition", "interface", "components", "app"], "Domain 是最底层：不 new 存储、不发请求、不 import 框架"],
    ["ports", ["engine", "analysis", "application", "infrastructure", "composition", "interface", "components", "app"], "Ports 只引用 Domain 的类型，谁也不该实现它"],
    ["analysis", ["application", "composition", "interface", "components", "app"], "Analysis 不许 import Application（§72），也不许碰 UI"],
    ["engine", ["analysis", "application", "composition", "interface", "components", "app"], "Engine 不许 import 路由 / React / Next.js（§25/§39）"],
    ["application", ["interface", "components", "app"], "Application 不许 import React / Next.js（§12/§39）"],
    ["infrastructure", ["interface", "components", "app"], "Infrastructure 不许 import 界面层——方向只能是界面层用它"],
    ["composition", ["interface", "components", "app"], "组合根给上层用，上层不回头 import 它"],
  ];

  for (const [from, tos, why] of FORBIDDEN) {
    it(`${from} 不依赖 ${tos.join(" / ")} — ${why}`, () => {
      const actual = layerEdges().get(from) ?? new Set<string>();
      for (const to of tos) {
        expect([...actual], `${from} → ${to} 不该存在：${filesForEdge(from, to as Layer).join(", ")}`).not.toContain(to);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §39  Domain 纯度
// ---------------------------------------------------------------------------

describe("§39 Domain 纯度", () => {
  it("Domain 不 import Next.js / React / 任何 node: 内置模块", () => {
    const offenders: string[] = [];
    for (const rel of allFiles().filter((f) => f.startsWith("domain/"))) {
      for (const specifier of specifiersOf(readFileSync(join(SRC, rel), "utf8"))) {
        if (specifier === "next" || specifier.startsWith("next/")) offenders.push(`${rel} → ${specifier}`);
        if (specifier === "react" || specifier.startsWith("react/")) offenders.push(`${rel} → ${specifier}`);
        if (specifier.startsWith("node:")) offenders.push(`${rel} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Domain 里没有 fetch / process.env —— 它连网络和环境变量都不该看见", () => {
    const offenders: string[] = [];
    for (const rel of allFiles().filter((f) => f.startsWith("domain/"))) {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      if (/\bfetch\s*\(/.test(source)) offenders.push(`${rel} 调用了 fetch`);
      if (/process\.env/.test(source)) offenders.push(`${rel} 读了 process.env`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §39  Interface hygiene：界面层不许直接 new 存储 / 引擎 / 客户端实现
// ---------------------------------------------------------------------------

describe("§39 界面层不直接实例化基础设施实现", () => {
  const CONSTRUCTIONS: RegExp[] = [
    /\bnew\s+ArtifactStore\b/,
    /\bnew\s+FileArtifactStore\b/,
    /\bnew\s+ExperimentStore\b/,
    /\bnew\s+TelemetryCollector\b/,
    /\bnew\s+GenerationPipeline\b/,
    /\bnew\s+StoryGenerator\b/,
    /\bnew\s+OpenAICompatibleLLMClient\b/,
  ];

  it("interface / components / app 里没有 new 存储或引擎实现", () => {
    const offenders: string[] = [];
    for (const dir of INTERFACE_DIRS) {
      for (const rel of allFiles().filter((f) => f.startsWith(`${dir}/`))) {
        const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
        for (const pattern of CONSTRUCTIONS) {
          if (pattern.test(source)) offenders.push(`${rel} ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("界面层不 import node: 内置模块（文件系统只属于基础设施）", () => {
    const offenders: string[] = [];
    for (const dir of INTERFACE_DIRS) {
      for (const rel of allFiles().filter((f) => f.startsWith(`${dir}/`))) {
        for (const specifier of specifiersOf(readFileSync(join(SRC, rel), "utf8"))) {
          if (specifier.startsWith("node:")) offenders.push(`${rel} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §16/§37  路由与 CLI 都从组合根拿用例
// ---------------------------------------------------------------------------

describe("§16/§37 每个入口都从组合根取用例", () => {
  it("src/app/api 下每个 route.ts 都 import @/composition", () => {
    const routes = allFiles().filter((f) => f.startsWith("app/api/") && f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(0);
    const offenders = routes.filter(
      (rel) => !specifiersOf(readFileSync(join(SRC, rel), "utf8")).includes("@/composition"),
    );
    expect(offenders).toEqual([]);
  });

  it("CLI 也 import 组合根，且自己不 new 引擎 / 存储", () => {
    const source = readFileSync(join(SCRIPTS, "generate-cli.ts"), "utf8");
    expect(specifiersOf(source)).toContain("@/composition");
    const cleaned = stripComments(source);
    for (const pattern of [/\bnew\s+ArtifactStore\b/, /\bnew\s+GenerationPipeline\b/, /\bnew\s+StoryGenerator\b/]) {
      expect(pattern.test(cleaned), `${pattern} 出现在 CLI 里`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §33  环境变量只在一处读
// ---------------------------------------------------------------------------

describe("§33 环境变量只在一处读", () => {
  it("src/ 内除 infrastructure 外没有 process.env", () => {
    const offenders: string[] = [];
    for (const rel of allFiles()) {
      if (rel.startsWith("infrastructure/")) continue;
      if (/process\.env/.test(stripComments(readFileSync(join(SRC, rel), "utf8")))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("CLI 也不直接读 process.env（问同一个凭据探针）", () => {
    const source = stripComments(readFileSync(join(SCRIPTS, "generate-cli.ts"), "utf8"));
    expect(/process\.env/.test(source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §24  URL 关卡只有一个实现
// ---------------------------------------------------------------------------

describe("§24 URL 关卡单一实现", () => {
  it("assertPublicBaseUrl 只有一处定义", () => {
    const definitions = allFiles().filter((rel) =>
      /export\s+(?:async\s+)?function\s+assertPublicBaseUrl\b/.test(readFileSync(join(SRC, rel), "utf8")),
    );
    expect(definitions).toEqual(["infrastructure/security/url-guard.ts"]);
  });
});

// ---------------------------------------------------------------------------
// §43  端口在场，且没有泛型仓储
// ---------------------------------------------------------------------------

describe("§43 端口在场，没有 GenericRepository", () => {
  it("三个端口文件都在：LLMClient / ArtifactStore(RunRepository) / ExperimentRepository", () => {
    for (const port of ["ports/llm-client.ts", "ports/artifact-store.ts", "ports/experiment-store.ts"]) {
      expect(allFiles(), port).toContain(port);
    }
  });

  it("src/ 里没有 GenericRepository / Repository<T> 这样的通用仓储", () => {
    // 剥注释后比：端口文件里有句「没有 GenericRepository<T>」的解释文字，
    // 那不是声明，是说明
    const offenders = allFiles().filter((rel) =>
      /GenericRepository|Repository\s*</.test(stripComments(readFileSync(join(SRC, rel), "utf8"))),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §25/§28/§72  已记录的债：引擎层允许碰的基础设施模块（白名单，只能缩小不能变大）
// ---------------------------------------------------------------------------

describe("引擎层的 infrastructure 接缝是白名单里的旧债", () => {
  const WHITELIST = [
    // §28 遥测采集器按任务书就放在 Infrastructure，引擎只是把事件交给它
    "@/infrastructure/telemetry/telemetry-collector",
    // 生成过程要用的三样平台事实：服务端配置、版本号、run_id 生成
    "@/infrastructure/config/app-config",
    "@/infrastructure/config/version",
    "@/infrastructure/id/run-id",
    // 工程日志（端口已在 ports/logger.ts，实现尚未下沉成注入）
    "@/infrastructure/logging/logger",
    // Manifest 组装（含 project-snapshot / prompt-registry / digest / PROVIDERS）
    "@/infrastructure/tracking/manifest-builder",
  ];

  it("engine → infrastructure 只碰白名单里的模块", () => {
    const engineToInfra = deps().filter((d) => layerOfFile(d.from) === "engine" && layerOfFile(d.to) === "infrastructure");
    const unexpected = [...new Set(engineToInfra.map((d) => d.specifier))].filter((s) => !WHITELIST.includes(s)).sort();
    expect(unexpected, `引擎层多碰了基础设施模块：${unexpected.join(", ")}——要么加端口，要么来白名单写理由`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §71/§72  没有循环依赖
// ---------------------------------------------------------------------------

describe("§71/§72 没有循环依赖", () => {
  it("文件级 import 图无环", () => {
    const graph = new Map<string, string[]>();
    for (const dep of deps()) {
      if (!graph.has(dep.from)) graph.set(dep.from, []);
      graph.get(dep.from)!.push(dep.to);
    }

    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const cycles: string[][] = [];

    // 迭代式 DFS：深递归在 140 个文件的图上没意义，还容易爆栈
    for (const start of graph.keys()) {
      if (color.get(start) === BLACK) continue;
      const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
      const path: string[] = [start];
      color.set(start, GREY);
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const next = (graph.get(top.node) ?? [])[top.index];
        if (next === undefined) {
          color.set(top.node, BLACK);
          stack.pop();
          path.pop();
          continue;
        }
        top.index += 1;
        const state = color.get(next) ?? WHITE;
        if (state === GREY) {
          cycles.push([...path.slice(path.indexOf(next)), next]);
          continue;
        }
        if (state === WHITE) {
          color.set(next, GREY);
          stack.push({ node: next, index: 0 });
          path.push(next);
        }
      }
    }

    expect(cycles.map((c) => c.join(" → "))).toEqual([]);
  });
});
