import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_VERSION } from "@/lib/version";
import { FAILURE_CATEGORIES } from "@/types/failure-analysis";
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
  // v1.7.0：受控实验框架的契约（定义 / 执行 / 聚合 / 边界）
  "experiments.md",
  // v1.8.0：Run 级遥测的契约（telemetry.json 字段、计数语义、空值记法与边界）
  "telemetry.md",
  // v1.9.0：失败分析的契约（类别、优先级、证据指向、状态记法与边界）
  "failure-analysis.md",
] as const;

/**
 * v1.7.0 实验框架的边界：README 必须把「不做什么」写清楚（TASK §8/§26）。
 * 这些串对应 README 里 blockquote 的原话，写松了就等于宣称它会排名、会评比。
 */
const EXPERIMENT_BOUNDARIES = [
  "不排名",
  "不评选赢家",
  "不是模型跑分平台",
  "不做显著性检验",
  "不自动调参",
] as const;

/**
 * §63/§64 保留给 v1.5.0+ 的能力：任何版本树里都不该宣称已经具备。
 * v1.3.0 已经交付基础质量四维度（MultiDimensionalReviewer），v1.4.0 已经交付
 * BeatPlan 结构校验（BeatValidator），v1.5.0 已经交付独立的商业可读性审阅
 * （CommercialReviewer），v1.7.0 已经交付受控实验的执行链路（ExperimentRunner），
 * 所以它们从这里移出——但自动改写拍子、高级规划器、伏笔规划、模型跑分平台、
 * 以及「商业分驱动重试 / 自动修订」一类仍然是本版本不做的事。
 */
const RESERVED_CAPABILITIES = [
  "AutomaticBeatRepair",
  "BeatRegenerationPolicy",
  "AdvancedBeatPlanner",
  "ForeshadowPlanner",
  "CommercialRetryPolicy",
  "AutomaticCommercialRepair",
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

/**
 * v1.4.0 Beat 校验的边界：README 必须写明它「只报告，不修复」。
 * 这三句对应 blockquote 里的原话，写松了就等于宣称会自动改骨架。
 */
const BEAT_BOUNDARIES = [
  "不改写任何一拍",
  "不重排顺序",
  "不自动补拍",
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

  it("README 写清 Beat 校验的边界：只报告，不改写、不重排、不补拍", () => {
    const readme = read("README.md");
    for (const boundary of BEAT_BOUNDARIES) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
    expect(readme).toContain("Beat 校验只报告，不修复");
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

describe("v1.7.0 发布门禁 — 实验框架边界", () => {
  it("README 写清实验框架能改什么、不能做什么", () => {
    const readme = read("README.md");
    expect(readme).toContain("Experiment");
    expect(readme).toContain("experiments");
    for (const boundary of EXPERIMENT_BOUNDARIES) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
    // 实验入口只暴露四个变量，Prompt 不在其中
    expect(readme).toContain("ExperimentRunner");
    expect(readme).toContain("ExperimentStore");
  });

  it("docs/experiments.md 写死目录布局、错误码与样本上限", () => {
    const text = read("docs/experiments.md");
    for (const token of [
      "definition.json",
      "runs.json",
      "results.json",
      "EXPERIMENT_INVALID",
      "EXPERIMENT_NOT_FOUND",
      "EXPERIMENT_CONFLICT",
      "repetitions",
      "variants",
    ]) {
      expect(text, `docs/experiments.md 应包含 ${token}`).toContain(token);
    }
    // 同样的边界要在文档里再说一遍：文档比 README 细，不能只写在 README
    expect(text).toContain("不排名");
  });
});

/**
 * v1.8.0 Run 遥测的边界：README 必须把「只观察、不造假、不落敏感数据」写清楚
 * （TASK §49/§51/§62）。这些串对应 README 里 blockquote 的原话，写松了就等于
 * 宣称它会归因、会告警、会自动改生成策略。
 */
const TELEMETRY_BOUNDARIES = [
  "只观察，不控制",
  "没有就是没有",
  "不落正文、不落密钥、不落原始异常",
  "不会自动改变生成策略",
] as const;

/** §51 不许宣传的能力：README 一个都不许出现（英文原词，与 §50 的清单对应）。 */
const TELEMETRY_FORBIDDEN = [
  "Root Cause Analysis",
  "Automatic Optimization",
  "Alerting",
  "Distributed Tracing",
  "Benchmark",
  "Failure Attribution",
  "Adaptive Generation",
] as const;

describe("v1.8.0 发布门禁 — Run 遥测边界", () => {
  it("README 写清遥测记什么、不记什么", () => {
    const readme = read("README.md");
    for (const boundary of TELEMETRY_BOUNDARIES) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
    // §50 可宣传的八项能力要真的在 README 里
    for (const capability of [
      "Run Telemetry",
      "Stage Timing",
      "LLM Call Tracking",
      "Retry / Repair Counts",
      "Failure Stage",
      "Token Usage",
      "Optional Cost Tracking",
      "Experiment Efficiency Metrics",
    ]) {
      expect(readme, `README 应宣传「${capability}」`).toContain(capability);
    }
    // §51 禁止宣传的能力一个都不许出现
    for (const forbidden of TELEMETRY_FORBIDDEN) {
      expect(readme, `README 不应宣称「${forbidden}」`).not.toContain(forbidden);
    }
    // 路由与文件都要点到
    expect(readme).toContain("/api/runs/<run_id>/telemetry");
    expect(readme).toContain("telemetry.json");
  });

  it("docs/telemetry.md 写死字段表、计数语义与空值记法", () => {
    const text = read("docs/telemetry.md");
    for (const token of [
      "telemetry.json",
      "TELEMETRY_SCHEMA_VERSION",
      "durationMs",
      "failureStage",
      "usageSampleCount",
      "llmCalls",
      "attempts",
      "repairs",
      "artifact_promotion",
    ]) {
      expect(text, `docs/telemetry.md 应包含 ${token}`).toContain(token);
    }
    // 三条边界要在文档里再说一遍：文档比 README 细，不能只写在 README
    expect(text).toContain("只观察，不控制");
    expect(text).toContain("绝不补 0");
    expect(text).toContain("不做失败归因");
  });
});

/**
 * v1.9.0 失败分析的边界：README 必须把「只分类、不归因、不动手」写清楚
 * （TASK §58/§59/§60/§69/§70）。写松了就等于宣称它会找根因、会自动补救。
 */
const FAILURE_BOUNDARIES = [
  "只分类，不归因",
  "不确定就说不知道",
  "不自动重试",
  "不自动修订",
] as const;

/** §59 可宣传的六项能力（英文原词，README 里要真的出现）。 */
const FAILURE_CAPABILITIES = [
  "Structured Failure Categories",
  "Failure Signals",
  "Evidence Linking",
  "Primary / Secondary Failure Classification",
  "Retry / Repair Exhaustion Detection",
  "Experiment Failure Distribution",
] as const;

/** §60 禁止宣传的能力：README 一个都不许出现。 */
const FAILURE_FORBIDDEN = [
  "Root Cause Analysis",
  "Causal Failure Attribution",
  "Automatic Remediation",
  "Adaptive Retry",
  "Causal Graph",
  "Benchmark",
  "Self Optimization",
] as const;

describe("v1.9.0 发布门禁 — 失败分析边界", () => {
  it("README 写清失败分析分类什么、不推断什么", () => {
    const readme = read("README.md");
    // §58 定位：确定性分类层，且明说不宣称根因、不改变生成行为
    expect(readme).toContain("确定性");
    expect(readme).toContain("失败类别");
    for (const boundary of FAILURE_BOUNDARIES) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
    // §59 六项能力要真的在 README 里
    for (const capability of FAILURE_CAPABILITIES) {
      expect(readme, `README 应宣传「${capability}」`).toContain(capability);
    }
    // §60 禁止宣传的能力一个都不许出现
    for (const forbidden of FAILURE_FORBIDDEN) {
      expect(readme, `README 不应宣称「${forbidden}」`).not.toContain(forbidden);
    }
    // §69/§70：界面上也不许出现这类词（中文措辞）
    expect(readme).not.toContain("根因");
    expect(readme).not.toContain("真正原因");
    // 路由、文件与两个类别表都要点到
    expect(readme).toContain("/api/runs/<run_id>/failure-analysis");
    expect(readme).toContain("failure-analysis.json");
    expect(readme).toContain("RETRY_EXHAUSTION");
    expect(readme).toContain("REPAIR_EXHAUSTION");
  });

  it("docs/failure-analysis.md 写死类别表、优先级、证据指向与状态记法", () => {
    const text = read("docs/failure-analysis.md");
    for (const token of [
      "failure-analysis.json",
      "schemaVersion",
      "primaryCategory",
      "secondaryCategories",
      "firstFailureStage",
      "terminalState",
      "SECURITY",
      "PLANNING",
      "GENERATION",
      "VALIDATION",
      "REVIEWER",
      "RETRY_EXHAUSTION",
      "REPAIR_EXHAUSTION",
      "UNKNOWN",
      "UNRECOGNIZED_FAILURE_CODE",
      "attempt_count",
      "repair_count",
      "issues[].code",
    ]) {
      expect(text, `docs/failure-analysis.md 应包含 ${token}`).toContain(token);
    }
    // 四条边界要在文档里再说一遍：文档比 README 细，不能只写在 README
    expect(text).toContain("不推断根因");
    expect(text).toContain("不自动动作");
    expect(text).toContain("不迁移旧 Run");
    expect(text).toContain("不替代遥测");
  });

  it("失败分析的文档与真实类别清单一致（多一个类别就红）", () => {
    const text = read("docs/failure-analysis.md");
    for (const category of FAILURE_CATEGORIES) {
      expect(text, `docs/failure-analysis.md 应列出类别 ${category}`).toContain(category);
    }
  });
});
