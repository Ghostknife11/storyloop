import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_VERSION } from "@/lib/version";
import { repoRoot, repoVersion } from "./helpers/fixtures";

/**
 * v1.0.0 发布门禁（TASK §31/§32/§33/§34/§35/§70）。
 *
 * 这一份测试把「文档与版本必须对得上」变成机器检查：README 必备章节、
 * docs/ 必备文件、CHANGELOG 有当前版本条目、版本号只有一个来源、
 * 以及「不许把 v1.1.0+ 的能力写进 README」的防泄漏守卫。
 */

/** §31 README 必备章节（按顺序出现的锚文本）。 */
const README_SECTIONS = [
  "快速开始",
  "架构",
  "StoryConfig",
  "BeatPlan",
  "Run",
  "RetryPolicy",
  "API",
  "CLI",
  "环境变量",
  "已知限制",
  "升级说明",
  "兼容性",
] as const;

/** docs/ 必备文件：每份对应一个冻结契约。 */
const DOCS = [
  "beat-plan.md",
  "story-config.md",
  "run-artifacts.md",
  "api.md",
  "cli.md",
  "upgrade.md",
  "compatibility.md",
] as const;

/**
 * §63/§64 保留给 v1.4.0+ 的能力：任何版本树里都不该宣称已经具备。
 * v1.3.0 已经交付基础质量四维度（MultiDimensionalReviewer），所以它从这里移出——
 * 但 35 维审阅、按维度阈值重试、商业审阅一类仍然是本版本不做的事。
 */
const RESERVED_CAPABILITIES = [
  "BeatValidator",
  "CommercialReviewer",
  "ExperimentRunner",
  "BenchmarkRunner",
  "AdvancedObservability",
  "FailureAttribution",
  "CausalGraph",
  "AdaptiveGeneration",
  "SelfOptimization",
] as const;

/** v1.3.0 明确不做的事：README 必须把边界写清楚，不许含糊其辞。 */
const DIMENSION_BOUNDARIES = [
  "维度是评价输出，不是行动依据",
  "不新增阈值",
  "不触发重试或修订",
] as const;

function read(rel: string): string {
  return readFileSync(join(repoRoot(), rel), "utf8");
}

describe("v1.0.0 发布门禁 — 版本唯一来源", () => {
  it("VERSION / package.json / FALLBACK_VERSION / CHANGELOG 全部指向当前版本", () => {
    const version = repoVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read("package.json")).version).toBe(version);
    expect(FALLBACK_VERSION).toBe(version);
    expect(read("CHANGELOG.md")).toContain(`## [${version}]`);
  });

  it("源码里不再有别的硬编码版本字符串", () => {
    const version = repoVersion();
    const forbidden = new Set(["0.9.1", "0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0", "0.0.1"]);
    forbidden.delete(version);
    const sources = ["src", "scripts", "configs"].flatMap((dir) => walk(join(repoRoot(), dir)));
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const stale of forbidden) {
        expect(text, `${file} 不应再出现旧版本号 ${stale}`).not.toContain(`"${stale}"`);
      }
    }
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(next));
    else if (/\.(ts|tsx|json|md)$/.test(entry.name)) out.push(next);
  }
  return out;
}

describe("v1.0.0 发布门禁 — README 结构", () => {
  it("README 必备章节一个都不少", () => {
    const readme = read("README.md");
    const missing = README_SECTIONS.filter((section) => !readme.includes(section));
    expect(missing, `README 缺少必备章节：${missing.join(" / ")}`).toEqual([]);
  });

  it("README 标题写明这是稳定生成引擎，不再是原型", () => {
    const readme = read("README.md");
    expect(readme.toLowerCase()).toContain("stable");
    expect(readme).not.toMatch(/原型|prototype/i);
  });

  it("README 不宣称保留能力，也不含本机绝对路径", () => {
    const readme = read("README.md");
    for (const capability of RESERVED_CAPABILITIES) {
      expect(readme, `README 不应宣称已具备 ${capability}`).not.toContain(capability);
    }
    expect(readme).not.toMatch(/[A-Za-z]:\\/);
    expect(readme).not.toMatch(/(^|\s)\/(?:home|Users)\//);
  });

  it("README 写清维度的边界：是评价输出，不新增阈值、不驱动重试或修订", () => {
    const readme = read("README.md");
    for (const boundary of DIMENSION_BOUNDARIES) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
  });

  it("README 里的环境变量与 .env.example 对得上", () => {
    const example = read(".env.example");
    const documented = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(documented.length, ".env.example 至少列出一个变量").toBeGreaterThan(0);
    const readme = read("README.md");
    for (const name of documented) {
      expect(readme, `README 应说明 ${name}`).toContain(name);
    }
  });
});

describe("v1.0.0 发布门禁 — docs 与示例", () => {
  it("docs/ 下每个冻结契约都有对应文档", () => {
    const missing = DOCS.filter((file) => !existsSync(join(repoRoot(), "docs", file)));
    expect(missing, `docs/ 缺少：${missing.join(" / ")}`).toEqual([]);
  });

  it("每份契约文档都标注了版本与冻结状态", () => {
    for (const file of DOCS) {
      const text = read(join("docs", file));
      expect(text, `${file} 应说明自己冻结的是哪个版本`).toMatch(/v1(\.\d+)*/);
      expect(text.length, `${file} 不能是空壳`).toBeGreaterThan(200);
    }
  });

  it("升级说明覆盖从 0.9.x 到当前版本的差异", () => {
    const upgrade = read("docs/upgrade.md");
    expect(upgrade).toContain(repoVersion());
  });

  it("示例配置在仓库里，且能被当前版本解析", () => {
    const path = join(repoRoot(), "configs", "example_story.json");
    expect(existsSync(path), "configs/example_story.json 缺失").toBe(true);
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(config.config_version).toBe("1");
  });
});
