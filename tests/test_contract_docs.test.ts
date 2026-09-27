import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_VERSION } from "@/infrastructure/config/version";
import { FAILURE_CATEGORIES } from "@/domain/failure-analysis";
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
  // v2.0.0：平台架构的契约（六层职责、依赖方向、组合根、端口与适配器、安全边界）
  "architecture.md",
  // v2.1.0：统一质量视图的契约（QualityDiagnostic 字段、三份 category 白名单、质量栈边界）
  "quality-stack.md",
  // v2.2.0：创作者工作区的契约（projects/ 布局、StoryDocument 字段、十二条路由、健康信号）
  "workspace.md",
  // v2.3.0：Benchmark Platform 的契约（Suite / 协议 / 预检 / 指标 / 不可变性 / 导出 / 路由）
  "benchmark.md",
  // v2.3.0：Benchmark 题库的来源与许可（发布那份 storyloop-core、什么内容永不进 Benchmark）
  "benchmark-data.md",
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
 * v2.3.0 已经交付 Benchmark Runner（固定 Suite + 固定协议 + 复用生产 Pipeline），
 * 所以它们逐个从这里移出。
 *
 * 仍然不做的是：自动改写拍子、高级规划器、伏笔规划、商业分驱动重试 / 自动修订、
 * 高级可观测性、失败归因、因果图、自适应生成、自优化。这些一个都不许出现。
 */
const RESERVED_CAPABILITIES = [
  "AutomaticBeatRepair",
  "BeatRegenerationPolicy",
  "AdvancedBeatPlanner",
  "ForeshadowPlanner",
  "CommercialRetryPolicy",
  "AutomaticCommercialRepair",
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
      expect(text, `${file} 应说明自己冻结的是哪个版本`).toMatch(/v\d+(\.\d+)*/);
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

/**
 * §51 不许宣传的能力：README 一个都不许出现（英文原词，与 §50 的清单对应）。
 *
 * v2.3.0 把「Benchmark」从这里移出：这一版交付的就是 Benchmark Platform，
 * 而它只测量、不控制——README 必须写明这句话（TASK §118），
 * 所以这个词以「Benchmark measures the system」的形式出现恰恰是合规的。
 * 这里不再拦它，改由 docs/benchmark.md 与 README 的边界句承担「不许说它会优化自己」。
 */
const TELEMETRY_FORBIDDEN = [
  "Root Cause Analysis",
  "Automatic Optimization",
  "Alerting",
  "Distributed Tracing",
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

/** §60 禁止宣传的能力：README 一个都不许出现（「Benchmark」同 §51 的理由，v2.3.0 起移出）。 */
const FAILURE_FORBIDDEN = [
  "Root Cause Analysis",
  "Causal Failure Attribution",
  "Automatic Remediation",
  "Adaptive Retry",
  "Causal Graph",
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

/**
 * v2.3.0 发布门禁——Benchmark 边界（TASK §117/§118/§119/§120）。
 *
 * 这一版交付的是「能反复测量自己的平台」，README 必须把两件事都写清：
 * 它能干什么（§119 十一项能力，英文原词），以及它绝不干什么（§120 九项禁止宣传 +
 * 既有的保留能力清单）。少写任一边都会把边界说糊。
 */
/** §119 可宣传的十一项能力（英文原词，README 里要真的出现）。 */
const BENCHMARK_CAPABILITIES = [
  "Versioned Benchmark Suites",
  "Benchmark Runner",
  "Fixed Protocols",
  "Benchmark History",
  "Quality Metrics",
  "Commercial Metrics",
  "Reliability Metrics",
  "Failure Distribution",
  "Efficiency Metrics",
  "CSV / JSON Export",
  "Benchmark Dashboard",
] as const;

/** §120 禁止宣传的能力：README 一个都不许出现。 */
const BENCHMARK_FORBIDDEN = [
  "Adaptive Generation",
  "Automatic Model Selection",
  "Automatic Prompt Selection",
  "Recommendation Engine",
  "Policy Learning",
  "Causal Graph",
  "Failure Attribution Engine",
  "Self Optimization",
] as const;

describe("v2.3.0 发布门禁 — Benchmark 边界", () => {
  it("README 写清 Benchmark 定位：只测量，不控制", () => {
    const readme = read("README.md");
    // §117 定位句（中文那一版的关键片段）
    expect(readme).toContain("Benchmark Platform");
    expect(readme).toContain("同一套 Production Pipeline");
    expect(readme).toContain("失败分布与效率指标");
    // §118 两句必须逐字出现
    expect(readme).toContain("Benchmark measures the system.");
    expect(readme).toContain("Benchmark does not control the system.");
    expect(readme).toContain("同样配置并不保证模型输出逐字节一致。");
    // 五条「不」也要在 README 里，写松了就等于宣称它会自己改自己
    for (const boundary of ["不推荐", "不适应", "不优化", "不学策略", "不改生成行为"]) {
      expect(readme, `README 应写明「${boundary}」`).toContain(boundary);
    }
    // §119 十一项能力要真的在 README 里
    for (const capability of BENCHMARK_CAPABILITIES) {
      expect(readme, `README 应宣传「${capability}」`).toContain(capability);
    }
    // §120 与保留能力清单一个都不许出现
    for (const forbidden of [...BENCHMARK_FORBIDDEN, ...RESERVED_CAPABILITIES]) {
      expect(readme, `README 不应宣称「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it("README 点到 Benchmark 的产物、路由与错误码", () => {
    const readme = read("README.md");
    for (const token of [
      "benchmarks/suites",
      "benchmarks/executions",
      "execution.json",
      "samples.json",
      "aggregate.json",
      "suite.json",
      "/api/benchmarks/suites",
      "/api/benchmarks/executions",
      "/api/benchmarks/history",
      "BENCHMARK_INVALID",
      "BENCHMARK_NOT_FOUND",
      "BENCHMARK_CONFLICT",
      "BENCHMARK_WRITE_FAILED",
      "docs/benchmark.md",
      "docs/benchmark-data.md",
    ]) {
      expect(readme, `README 应提到 ${token}`).toContain(token);
    }
  });

  it("README 写清 Benchmark 的边界：阈值只来自 Suite、不编时间序列、不排名", () => {
    const readme = read("README.md");
    expect(readme).toContain("Benchmark 不是排行榜");
    expect(readme).toContain("Benchmark 不做显著性检验");
    expect(readme).toContain("Benchmark 不改任何行为");
    expect(readme).toContain("不编时间序列");
    expect(readme).toContain("71");
  });

  it("docs/benchmark.md 写死协议、指标口径、不可变性与输出边界", () => {
    const text = read("docs/benchmark.md");
    for (const token of [
      "suite.json",
      "execution.json",
      "samples.json",
      "aggregate.json",
      "repetitions",
      "plannerMode",
      "acceptedMetrics",
      "failureHandling",
      "passThreshold",
      "beatPlanRef",
      "suiteDigest",
      "protocolDigest",
      "BENCHMARK_WRITE_FAILED",
      "不补 0",
      "不编时间序列",
      "同样配置并不保证模型输出逐字节一致。",
      "Benchmark measures the system.",
      "Benchmark does not control the system.",
    ]) {
      expect(text, `docs/benchmark.md 应包含 ${token}`).toContain(token);
    }
    // 22 个指标的口径要写出来：界面上那个「3/4」的分母怎么来的
    expect(text).toContain("22");
    expect(text).toContain("count");
  });

  it("docs/benchmark-data.md 写死来源、许可与「什么内容永不进 Benchmark」", () => {
    const text = read("docs/benchmark-data.md");
    for (const token of [
      "storyloop-core",
      "1.0.0",
      "CC0-1.0",
      "original",
      "license",
      "再分发",
      "crawler.py",
      "novel_dataset",
    ]) {
      expect(text, `docs/benchmark-data.md 应包含 ${token}`).toContain(token);
    }
    // 四条硬约束要在文档里逐条出现
    for (const boundary of ["不夹带正文", "不夹带提示词原文", "不夹带凭据与地址", "不夹带爬来的作品"]) {
      expect(text, `docs/benchmark-data.md 应写明「${boundary}」`).toContain(boundary);
    }
  });

  it("发布的那一份 Suite 真的在仓库里，且自带来源与许可", () => {
    const suite = JSON.parse(
      read("benchmarks/suites/storyloop-core/1.0.0/suite.json"),
    ) as Record<string, unknown>;
    expect(suite.id).toBe("storyloop-core");
    expect(suite.version).toBe("1.0.0");
    expect(Array.isArray(suite.cases)).toBe(true);
    expect((suite.cases as unknown[]).length).toBeGreaterThan(0);
    const source = suite.source as Record<string, unknown>;
    expect(source.origin).toBe("original");
    expect(String(source.license ?? suite.license ?? "")).toContain("CC0");
    const protocol = suite.protocol as Record<string, unknown>;
    expect(typeof protocol.passThreshold).toBe("number");
    // 固定骨架那道题的骨架文件必须真的躺在 Suite 目录里
    for (const raw of suite.cases as Record<string, unknown>[]) {
      if (raw.beatPlanMode === "fixed") {
        expect(existsSync(join(repoRoot(), "benchmarks", "suites", "storyloop-core", "1.0.0", String(raw.beatPlanRef)))).toBe(true);
      }
    }
  });
});
