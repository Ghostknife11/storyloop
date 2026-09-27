# Benchmark 数据：题库、来源与许可

> 本文件随 v2.3.0 交付，说明随仓库发布的那一份 Benchmark 题库
> （`benchmarks/suites/storyloop-core/1.0.0/`）从哪里来、可以怎么用，
> 以及**什么内容永远不会进 Benchmark**。
> 对应实现：`src/domain/benchmark-suite.ts`（结构与校验）、`src/infrastructure/storage/benchmark-store.ts`、
> 测试：`tests/test_benchmark_dataset.test.ts`、`tests/test_benchmark_store.test.ts`。

## 为什么题库也要讲纪律

Benchmark 平台最容易被滥用的地方不是代码，是题库。把爬来的正文、别家模型生成的故事、
没有许可的素材塞进 Suite，整个平台的数字就都建在说不清来源的数据上——而这正是
Benchmark 要避免的那种「说不清」。所以这里的要求比代码更死：

1. **每道题都要有来源**（`source`）。没有来源的 Suite 根本读不进来
   （`validateBenchmarkSuite` 直接拒绝），不是「建议填」。
2. **每道题都要有非空题面**：题材、题面、目标字数。空题面会让测量变成空转——
   跑出来的不是表现，是报错。
3. **固定骨架必须真的躺在 Suite 目录里**。`beatPlanRef` 指向的文件读不到，
   这道题在预检阶段就会被挡住，不会等到开跑才发现。

## 发布的那一份：storyloop-core 1.0.0

| 项 | 值 |
| --- | --- |
| 位置 | `benchmarks/suites/storyloop-core/1.0.0/` |
| 题目数 | 3（悬疑 / 豪门 / 重生各一道，两个题材以上才有按题材分组可言） |
| 重复次数 | 2 → 一次执行 6 条样本 |
| 来源 | `origin: original` |
| 许可 | `CC0-1.0`，随 Suite 原文一起公开，任何人可原样再分发 |

三道题全部为本项目原创：题面、题材、人物、附加条款都是为这份 Suite 写的，
**没有从任何作品、模型输出、网络素材搬运**。`suite.json` 里的 `source.note` 把这件事写明了，
它和 `license` 一起出现在 `/benchmarks` 界面上——看数的人应该一眼看到数字建在什么数据上。

### 为什么只有三道题

这是刻意的：几十道题的题库会让一次执行的时间与费用成倍上涨，而 2.3.0 要的是
**能反复跑**，不是跑得多。三个题材 × 两次重复，足够覆盖

- 同一道题跑两次的差异（`repetitions`）；
- 不同流水线分支（`regenerate` 与 `fixed` 两种骨架模式各有一道）；
- 分组口径（按题材、按标签）。

要更大的题库，请在自己的部署里加 Suite，不要改这一份——见下。

## 什么内容永远不会进 Benchmark

这一节是硬约束，写在代码里比写在这里牢靠（`tests/test_benchmark_dataset.test.ts` 会逐条检查）：

- **不夹带正文**。Suite 文件里只有题面（StoryConfig）与协议，没有任何已生成的 story 正文。
  Benchmark 只存 Run 的 `runId` 引用；正文留在 `runs/`，导出文件里也只有指针。
- **不夹带提示词原文**。提示词不进 Suite；执行快照里只留角色 + 版本号 + SHA-256 摘要。
- **不夹带凭据与地址**。Suite 里没有 `apiKey`、`baseUrl` 这类字段；往里写凭据键的 Suite
  会被校验拒绝。Benchmark 测的是服务端当下这一套配置，不接受从请求里覆盖模型或密钥。
- **不夹带爬来的作品**。本仓库长期排除的爬虫产物（`crawler.py`、`novel_dataset/`）与
  Benchmark 是两回事，不会、也不应该被搬进来。

## 自己加一份 Suite

```
benchmarks/suites/<suite_id>/<version>/
  suite.json                        # 题库定义（题目 + 协议 + 来源）
  cases/<case_id>/beat-plan.json    # 固定骨架模式那道题的骨架（可选）
```

- `<suite_id>` 用小写字母 / 数字 / 连字符；`<version>` 形如 `1.0.0`（按数字段比大小，
  `1.10` 大于 `1.9`）。
- `source` 必填：`origin` 是 `original` / `public-domain` / `licensed` / `user-provided` 之一，
  `license` 不能为空。用自己的题面就照实写原创，用别人的素材就写清许可。
- 协议里的 `passThreshold` 来自你自己这一份 Suite。71 只是发布那份的选择，
  换一份 Suite 就该是另一个数——代码里没有任何写死的分数线。
- `benchmarks/executions/` 是测量的产物（每次执行一份），不入库；`benchmarks/suites/`
  是入库的题库原文。`.gitignore` 已经这么分开。

## 删除与追加

- Suite 追加：新开一个版本号（`1.1.0`），旧版本原样留着——历史执行记的是
  `suiteId@suiteVersion` 与 suiteDigest，改旧文件等于改已经跑过的测量的口径。
- Suite 删除：删目录即可。已经跑过的执行三件套在 `benchmarks/executions/` 下原样还在，
  详情页上「引用的那一版 Suite」会显示为查不到，但数字一个字都不少。
