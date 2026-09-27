# Benchmark Platform（测量平台）

> 本文件是 v2.3.0 交付的 Benchmark 契约：Suite 结构、执行协议、指标口径、聚合规则、
> 不可变性与输出边界。对应实现：`src/domain/benchmark-suite.ts`、`src/domain/benchmark-result.ts`、
> `src/domain/benchmark-metric.ts`、`src/analysis/benchmark-runner.ts`、
> `src/analysis/benchmark-aggregator.ts`、`src/analysis/benchmark-comparator.ts`、
> `src/analysis/benchmark-export.ts`、`src/application/benchmark-use-cases.ts`。
>
> 契约测试：`tests/test_benchmark_suite.test.ts`、`tests/test_benchmark_runner.test.ts`、
> `tests/test_benchmark_store.test.ts`、`tests/test_benchmark_export.test.ts`、
> `tests/test_benchmark_comparator.test.ts`、`tests/test_benchmark_view.test.ts`、
> `tests/test_benchmark_api.test.ts`、`tests/test_benchmark_dataset.test.ts`。

## 一句话定位

**Benchmark measures the system. Benchmark does not control the system.**

它按固定协议反复测量这条流水线的表现，把数字、失败分布与历史摆出来；
它不推荐、不适应、不优化、不学策略、不改生成行为。要改行为，请去改配置再跑一次测量。

## 目录与产物

```
benchmarks/
  suites/<suite_id>/<version>/           # 入库的题库原文（来源与许可见 docs/benchmark-data.md）
    suite.json                           # 题面 + 协议 + 来源
    cases/<case_id>/beat-plan.json       # 固定骨架题目的骨架（可选）
  executions/<benchmark_id>/             # 每次测量的产物，不入库
    execution.json                       # 执行头：状态 + 跑之前定下的快照
    samples.json                         # 每条样本一行（只存 runId 引用）
    aggregate.json                       # 汇总数字（没跑完就是 null）
```

一次 Run 仍然是正常的 Run：Benchmark 样例就是一次次 `pipeline.run()` / `runWithPlan()`，
产物落在 `runs/<run_id>/`，正文、提示词、遥测一个字都不搬到 Benchmark 这边。
Benchmark 只留 `runId` 这一根指针。

## Suite 与协议

一份 Suite = 若干 Case + 一份 Protocol：

| Protocol 字段 | 含义 |
| --- | --- |
| `repetitions` | 每道题跑几次（样本数 = 题数 × 次数） |
| `plannerMode` | `normal` | `fixed-plan`（固定骨架模式） |
| `acceptedMetrics` | 这次测量采纳哪些指标 |
| `failureHandling` | `include`（失败样本计入分母）\| `exclude-with-count` |
| `passThreshold` | PASS 切线，**只对 `overall_quality` 生效**，且只能来自这份 Suite |

PASS 阈值没有任何代码默认值：71 只是发布那份 `storyloop-core` 的选择。
换一份 Suite 就该是另一个数，界面上那一行永远带着这个数本身（`3 过 / 0 未过 / 1 未测量（阈值 71）`），
没有「提高阈值试试」这类入口。

Case 的 `beatPlanMode` 二选一：`regenerate`（每个样本自己规划）或 `fixed`（共用一份骨架，
`beatPlanRef` 必须指向 Suite 目录里真实存在的文件）。

Suite 与协议各有一个内容摘要：`suiteDigest`（含题面与协议的那一版原文）与 `protocolDigest`
（只算协议本身）。两者都由内容现算，写进执行头——一次执行跑的是哪一版题库、哪一份协议，
事后查得到，改旧文件等于改已经跑过的测量的口径。

## 执行与预检

`BenchmarkRunner.preflight()` 在任何一次 LLM 请求之前查完这些，逐条给出可执行的原因：

1. 服务端配了模型与密钥（Benchmark 不接受从请求里覆盖模型、地址或密钥）；
2. Suite 本身合法（结构、来源、许可）；
3. 固定骨架题目的骨架文件都在；
4. 提示词角色齐全；
5. 样本数在安全线内：超过 30 条要显式 `allowLargeBenchmark: true`，硬上限 200 条。

预检通过后才开跑，顺序恒定：**Suite 声明顺序 × 重复次数升序**（case-a#1, case-a#2, case-b#1, …），
不按任何成绩重排。跑之前先落一份 `running` 的执行头，之后每个样本落一行、跑完落汇总、最后翻到终态。
中途被杀留下的 `partial` 会如实落盘，不谎报 `completed`。

每条样本的 Manifest 里带 Benchmark provenance：`benchmarkId` / `suiteId` / `suiteVersion` /
`suiteDigest` / `caseId` / `repetition`。反过来说，一个 Run 是被哪次测量、哪道题、第几次跑出来的，查得到。

## 指标与聚合

22 个指标，按注册表顺序分五组（质量 / 商业可读性 / 可靠性 / 失败 / 效率），
界面与导出的顺序都跟注册表一致——顺序不是排名。

- 均值只对「真的有值」的样本求；`count` 是有值样本数，**不是样本总数**（分母在界面上写清：`82.5 · 3/4`）。
- 没有的数就是没有：null 在界面上是 `—`，在导出里是空串，**不补 0**。
- `failure_rate` 不来自任何产物，来自「这条样本跑成没有」这个事实本身。
- 同样配置重复跑，数字不会逐字节一致：**同样配置并不保证模型输出逐字节一致。**
  Benchmark 给的是可复现的协议与可比较的事实，不是恒等的输出。

## 不可变性（硬约束）

- 执行落到终态（`completed` / `partial` / `failed`）之后，**任何再写入都拒绝**
  （`BenchmarkWriteError` → 500 `BENCHMARK_WRITE_FAILED`）。历史结果不许被后续一次运行覆盖。
- 跑的过程中照常更新，否则 `partial` 的进度留不下来。
- Suite 要改就开新版本号：历史执行记的是 `suiteId@suiteVersion` 与 `suiteDigest`。

## 比较与历史

- 比较（`?compare=<另一个执行 id>`）只给两侧各自算出的事实与差值，**不解释差异为什么发生**——
  协议固定的是输入条件，不是因果设计。要因果结论请走受控实验（见 `docs/experiments.md`）。
- 一侧没有某个指标（协议不同）时整行不出现，不补 null 当差值；`base` 为 0 时相对差值是 null。
- 历史图（`/benchmarks/history`）每次执行摊成四个点：整体质量 / 商业可读性 / 失败率 / 平均耗时。
  点从盘上真实读出来的执行来，一个都没有就是空图——**不编时间序列**。
- Baseline 只是会话期标签，不参与任何排序与计算。

## 导出

`GET /api/benchmarks/executions/:id/export?format=json|csv`

- CSV：一行一个 Case × Repetition，8 个身份列 + 22 个指标列，CRLF + UTF-8 BOM。
- JSON：`executionSnapshot` / `aggregate` / `sampleMetrics` / `runReferences` 四块 +
  引用的那一版 Suite + 22 条指标口径说明。
- 两种格式都**不含生成正文、提示词原文、baseUrl 与任何凭据**；提示词只留版本号与 SHA-256 摘要，
  模型只留模型名与地址类别。同一份执行导出两次，字节一致。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/benchmarks/suites` | 全部已存 Suite 的摘要（含来源与许可） |
| GET | `/api/benchmarks/suites/:id` | 某一版 Suite 全文；`?version=` 指定版本 |
| GET | `/api/benchmarks/executions` | 执行列表；`?suiteId=` 只看一份 Suite 的历史 |
| POST | `/api/benchmarks/executions` | 跑完一次执行（请求体只有 `suiteId` / `suiteVersion` / `label` / `allowLargeBenchmark`） |
| GET | `/api/benchmarks/executions/:id` | 执行详情；`?compare=` 带逐指标比较 |
| GET | `/api/benchmarks/executions/:id/export` | 导出（`?format=json\|csv`） |
| POST | `/api/benchmarks/executions/:id/baseline` | 标记 / 取消标记基线（会话期标签） |
| GET | `/api/benchmarks/history` | 历史图取数；`?suiteId=` 只看一份 Suite |

### 错误码

| HTTP | code | 什么时候 |
| --- | --- | --- |
| 400 | `BENCHMARK_INVALID` | 请求体不合法、Suite 不合法、骨架缺文件、没配凭据、格式不认 |
| 404 | `BENCHMARK_NOT_FOUND` | 没有这个 Suite / 这次执行 |
| 409 | `BENCHMARK_CONFLICT` | 同一版本正在跑；样本数超过安全线且没显式确认 |
| 500 | `BENCHMARK_WRITE_FAILED` | Benchmark 数据写不进去（终态再写、目录不可写、磁盘满） |

界面在 `/benchmarks`、`/benchmarks/<id>`、`/benchmarks/history` 三页；图表只有柱状、折线与分布三类，
没有饼图、没有雷达图、没有加权总分。
