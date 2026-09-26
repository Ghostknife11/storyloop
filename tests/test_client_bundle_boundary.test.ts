import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/fixtures";

/**
 * v1.9.0 回归：浏览器包里不能出现服务端模块。
 *
 * 踩过的坑（这个版本自己踩的）：Run 面板要显示失败类别的中文标签，于是从
 * `lib/failure-rules.ts` 引了 `CATEGORY_LABELS`——而规则表为了 `instanceof PipelineError`
 * 把整条服务端链路（产物读写 → node:fs）拖进了客户端依赖图。症状是 `next build`
 * 报一句看不懂的 chunking 错误，页面根本构建不出来。
 *
 * 这里做个廉价的静态守卫：从所有客户端入口（app 下的页面与全部组件）出发，
 * 沿 `@/...` 导入走一圈，任何一处碰到 node 内置模块就失败。不跑真 bundler
 * （太慢、太脆），规则就是「客户端代码不许 import node 内置模块」。
 */

const SRC = join(repoRoot(), "src");

/** node 内置模块：客户端代码一个都不许碰。 */
const NODE_BUILTINS = /^node:(fs|fs\/promises|path|os|crypto|child_process|net|tls|dns|http|https|readline|worker_threads)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** 客户端入口：页面与组件。route.ts 是服务端路由处理器，不算。 */
function clientEntries(): string[] {
  return walk(SRC).filter((path) => {
    const rel = relative(SRC, path).replace(/\\/g, "/");
    if (rel.startsWith("app/api/")) return false;
    if (rel.startsWith("app/") && rel.endsWith("/route.ts")) return false;
    return rel.startsWith("app/") || rel.startsWith("components/");
  });
}

function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) found.add(match[1]);
  return [...found];
}

function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = resolve(SRC, specifier.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 从一个入口出发能静态到达的全部仓库内文件，以及路上撞见的 node 内置导入。 */
function reachableFrom(entry: string): { files: string[]; nodeImports: string[] } {
  const files: string[] = [];
  const nodeImports: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push(path);
    const source = readFileSync(path, "utf8");
    for (const specifier of specifiersOf(source)) {
      if (NODE_BUILTINS.test(specifier)) {
        nodeImports.push(`${relative(repoRoot(), path)} imports ${specifier}`);
        continue;
      }
      const target = resolveAlias(specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return { files, nodeImports };
}

describe("v1.9.0 §31 客户端依赖图不碰服务端模块", () => {
  const entries = clientEntries();

  it("扫到了客户端入口（守卫自己失效时这里先失败）", () => {
    const names = entries.map((p) => relative(SRC, p).replace(/\\/g, "/"));
    expect(names.length).toBeGreaterThan(0);
    // 这次踩坑涉及的两个页面必须在扫描范围里
    expect(names).toContain("app/page.tsx");
    expect(names).toContain("app/experiments/[experiment_id]/page.tsx");
  });

  it("从页面与组件出发，静态可达的文件里没有 node 内置模块导入", () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      offenders.push(...reachableFrom(entry).nodeImports);
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("失败类别标签来自共享类型模块，不再经过服务端规则表", () => {
    // 这条不是泛泛的「别 import node:fs」，而是把这次的修法钉住：
    // 展示标签放 types/，规则表（含 instanceof PipelineError）留在服务端。
    const labelImports = specifiersOf(readFileSync(join(SRC, "lib", "failure-view.ts"), "utf8"))
      .concat(specifiersOf(readFileSync(join(SRC, "lib", "experiment-view.ts"), "utf8")))
      .filter((s) => s.includes("failure"));
    expect(labelImports.sort()).toEqual(["@/types/failure-analysis", "@/types/failure-analysis"]);
    // 规则表自己也不再导出标签：它只管「码 → 类别」这一件事
    // （注释里提到这个名字不算——守的是导出）
    expect(readFileSync(join(SRC, "lib", "failure-rules.ts"), "utf8")).not.toContain(
      "export const CATEGORY_LABELS",
    );
  });

  it("规则表只留在服务端：分析器用它，界面不 import 它", () => {
    const { files } = reachableFrom(join(SRC, "app", "page.tsx"));
    expect(files).not.toContain(resolve(SRC, "lib/failure-rules.ts"));
    expect(files.some((f) => f.endsWith("failure-panel.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("failure-view.ts"))).toBe(true);
    // 服务端一侧确实还在用（守卫别误伤真正需要它的人）
    expect(readFileSync(join(SRC, "core", "failure-analyzer.ts"), "utf8")).toContain(
      'from "@/lib/failure-rules"',
    );
  });
});
