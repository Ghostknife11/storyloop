# 受控实验框架（Experiment Framework）

> 本文件是 v1.7.0 冻结的契约：实验定义、执行顺序、聚合口径与三条硬边界。
> 对应实现：`src/types/experiment.ts`、`src/core/experiment-config.ts`、
> `src/core/experiment-runner.ts`、`src/storage/experiment-store.ts`、
> `src/lib/experiment-summary.ts`、`src/lib/experiment-service.ts`。
>
> 契约测试：`tests/test_experiment_models.test.ts`、`tests/test_experiment_config.test.ts`、
> `tests/test_experiment_runner.test.ts`、`tests/test_experiment_api.test.ts`、
> `tests/test_experiment_ui.test.ts`。

## 这个版本要回答的问题

「如果只改模型（或温度 / 重试策略），会怎样？」

做法是**固定条件、批量跑、把数字摆出来**：同一份 StoryConfig、同一份骨架、同一批环境，
跑多个 Variant 各若干次，最后按 Variant 汇总计数与均值。它是可控实验工具，
不是模型跑分平台——下面的「三条硬边界」是这份契约的一部分，不是补充说明。

## 三条硬边界

1. **不排名，不评选赢家**。结果表的行顺序永远是定义里的声明顺序，绝不按分数重排；
   没有 best/worst 标记，没有胜率，没有「推荐 Variant」。
2. **没有的数就是没有**。均值只对「真的有分数」的样本求，审阅失败的样本不参与均值，
   **也不被当成 0**（补 0 等于凭空制造一个差评）。界面显示 `—`。
3. **不自动调参**。实验只执行你写下来的条件：不尝试新的组合、不根据结果反推更好的参数、
   不据此改动下一次跑的条件。同一份定义重跑要被 409 挡住（定义与结果都不可变）。

顺手把「本版本不做」也写死：不是模型跑分平台、不做显著性检验、没有 p 值 / 置信区间 /
效应量、没有 leaderboard、没有跨实验统计口径、没有自动超参搜索、没有 Prompt 自动优化、
没有自适应生成。

## 目录布局

实验数据与 `runs/` 并列，落在 `<runs>/../experiments/`：

```text
experiments/
  <experimentId>/
    definition.json   不可变的实验定义（要改条件就复制成一个新实验）
    runs.json         展开后的格子 → 跑出哪个 runId；失败时记在哪一步
    results.json      按 Variant 分组的计数与均值
```

每个样本本身仍然是 `runs/<run_id>/` 下一次**完完整整的普通 Run**：自己的产物目录、
自己的 `metadata.json`、自己的 `run-manifest.json`。实验只往清单里多写一个 `experiment`
块（`experimentId` / `variantId` / `repetition`），不新建第二种 Run，不复制正文。

## ExperimentDefinition

字段用 camelCase，自带 `schemaVersion`（当前只有 `"1"`）。

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | 只支持 `"1"` |
| `experimentId` | string | 单层目录名，不允许 `.` / `..` / `/` / `\` |
| `name` | string | 给人看的名字 |
| `description` | string? | 可选说明 |
| `base` | object | 所有 Variant 共享的条件 |
| `variants` | array | 1 ~ 4 个 Variant；基准本身也是一个 Variant（「什么都没改」合法） |
| `repetitions` | integer | 1 ~ 5；总样本数（`variants × repetitions`）不得超过 **12** |
| `createdAt` | string | ISO 时间戳；不传则取服务器当前时间 |

`base`：

| Field | Type | Description |
|---|---|---|
| `storyConfig` | object | 与 StoryConfig 契约一致，一次实验只认这一份 |
| `beatPlanMode` | `fixed` \| `regenerate` | `fixed`：所有样本共用 `beatPlan`；`regenerate`：每个样本自己过 Planner |
| `beatPlan` | object? | `fixed` 时必须带上；`regenerate` 时不允许带 |
| `modelConfig` | object? | 只有 `model` 一个字段 |
| `generationParameters` | object? | 只有 `temperature` 一个字段 |
| `retryPolicy` | object? | 与 RetryPolicy 同字段 |

`variants[i].overrides` 只接受四个变量——它们是真的会改变一次请求的东西：

| 变量 | 说明 |
|---|---|
| `model` | 换模型（模型是烤进客户端的，所以每个 Variant 单独建一条 Pipeline） |
| `generation.temperature` | 0 ~ 2 |
| `retry.maxAttempts` | 1 ~ 5 |
| `retry.minReviewScore` | 0 ~ 100 |

**定义里不出现 `baseUrl`**：一条样本的地址永远来自服务端 `LLM_BASE_URL`，
于是 v1.1.0 的 SSRF 关卡（只允许公网 http/https）对每个 Variant 都照样生效，
实验没有第二条入口可以绕。

凭据 / 地址 / 原始提示词形状的键一律拒收：`rejectSecretBearingKeys` 递归扫描整份
定义，命中 `api_key` / `authorization` / `token` / `secret` / `headers` / `env` /
`systemprompt` 等一律 400，消息里给出完整路径。

**Prompt 不是变量**：每个阶段只读一份固定提示词文件，注册表里每个角色只有一个版本，
所以「换 Prompt 版本」在 v1.7.0 是一个不产生任何变化的变量。与其造一个假变量，
不如直接拒绝并在消息里说明原因（`topP` / `maxTokens` 同理：客户端从没下发过它们）。
要换提示词，请改 `prompts/*.txt` 后重启——那是运维动作，不是实验变量。

## 执行顺序

顺序执行，不并发：样本顺序是 **Variant 声明顺序 × repetition 1..n**，
也是 `runs.json` 与 `results.json` 里的顺序。每个样本：

1. 合并 base 与该 Variant 的 overrides（`mergeOverrides`），展开成一条格子计划；
2. 建一条 Pipeline，按 `beatPlanMode` 走 `runWithPlan`（fixed）或 `run`（regenerate）；
3. 成功 → 记 runId；失败 → 记下失败阶段与一句话摘要，**实验不中止**，剩下的样本接着跑。

每跑完一格就重写一次 `runs.json`：进程中途被杀，磁盘上已经留下「前几格跑出了哪些
runId、失败在哪一步」，`GET` 能如实显示 partial，而不是一片空白。

但**中断后重跑是从第一格重新开始**，不会接着剩下的格子跑：`results.json` 不存在时
预检照样放行，于是已经花过钱的样本会再跑一遍。这一版刻意不做断点续跑——它要为
「哪一格算跑完、复用时分数怎么算」再引入一套状态语义，那不是顺手能加对的东西。
要省钱就避免中途杀进程。

同一时间一个实验只允许一条执行链（进程内）：第二个 `POST .../run` 直接拿到
409 `EXPERIMENT_CONFLICT`，不会跟着一起烧钱。多进程部署（多个 worker）不在这把锁的
覆盖范围内——那种部署要的是共享存储上的锁，这一版没有。

整体状态（`statusOf`）：全部成功 → `completed`；有成有败 → `partial`；全部失败 → `failed`。

`results.json` 的 `runs` 数组逐条记下每个跑出 runId 的样本：`variantId` /
`repetition` / `runId` / `status`，外加这条样本自己的 `overallScore` 与
`commercialScore`——两者读自这条 Run 自己的 `quality.json` / `commercial-review.json`，
读不到就是 `null`。v1.7.0 漏了这两个字段，界面上每一行样本都显示「—」。

## 聚合口径

`ExperimentVariantSummary` 每个 Variant 一行，计数与均值两类，没有别的：

| 字段 | 说明 |
|---|---|
| `runCount` / `successCount` / `failureCount` | 这一组跑出了几个 Run、几个成功、几个失败 |
| `meanOverallScore` | 结构审阅整体分均值（只对有分的样本求，两位小数） |
| `meanCommercialScore` | 商业可读性分均值（同上） |
| `meanCoherence` / `meanNarrative` / `meanCharacter` / `meanCausality` | 四个质量维度均值 |
| `meanHook` / `meanPacing` / `meanEngagement` / `meanPayoff` | 四个商业维度均值 |
| `efficiency` | v1.8.0 新增：这一组的效率指标，见下 |

均值只从这次实验自己产出的 `quality.json` / `commercial-review.json` 读，不重跑、不推断、
不引用别的 Run。一个样本都没跑出来的 Variant 也会出现在结果里（各项 null、计数为 0），
否则读者会以为这次实验没有这一组。

### v1.8.0 效率指标

`efficiency` 有七项：`durationMs` / `llmCalls` / `inputTokens` / `outputTokens` /
`totalTokens` / `retries` / `repairs`。每项都是 `{ mean, sampleCount }` 两个数——均值与
「这个均值是从几个样本算出来的」必须一起读，否则 `4.2s` 是 2 条样本的平均还是 5 条的，
读的人无从判断。

数据源是每条样本自己的 `telemetry.json`（v1.8.0 起每个 Run 都有）。三条规则：

- 一个样本没有遥测（1.8.0 之前跑的、文件被手改坏、这一步整体缺失），它不进任何分母，
  也不被当成 0。所以 `sampleCount` 小于这一组的 `runCount` 是正常现象，不是数据丢了。
- Provider 一次都没返回 usage 时，三个 token 项的 `mean` 是 `null`、`sampleCount` 是 0，
  而 `llmCalls` 是真实次数——「调了 6 次但一次都没拿到 usage」与「一次都没调」是两件事。
- 没有 winner、没有 rank，也没有「这组更快所以更好」这类结论。效率只是效率。

字段含义见 [docs/telemetry.md](telemetry.md)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/experiments` | 建实验定义（201）。**不跑** |
| GET | `/api/experiments` | 列表：定义摘要 + 结果状态，不带样本详情 |
| GET | `/api/experiments/<experiment_id>` | 定义 + `runs.json` + `results.json`；没跑过时后两者是 `null` |
| POST | `/api/experiments/<experiment_id>/run` | 跑完整个实验，回传 `ExperimentResult` |

三种拒绝都发生在任何 LLM 请求之前：

| 情形 | code | HTTP |
|---|---|---|
| 定义结构不合法（含凭据形状的键） | `EXPERIMENT_INVALID` | 400 |
| 实验不存在——也包括 id 根本不是合法目录名（`exp/../../x` 这类） | `EXPERIMENT_NOT_FOUND` | 404 |
| 已存在同名实验 / 已经跑过 / 正在运行中 | `EXPERIMENT_CONFLICT` | 409 |
| 服务端没配 `LLM_API_KEY` 且没有注入客户端 | `EXPERIMENT_INVALID` | 400 |

单条样本失败用它在 Pipeline 里那个错误码（`LLM_REQUEST_FAILED` / `GENERATION_FAILED` …）
记进 `runs.json` 的 `failure` 字段，不让 API 层重新发明一套。

响应体与磁盘文件同一口径（camelCase），没有第二层字段翻译。响应里不出现服务器绝对路径，
也不出现任何凭据。

## 界面

`/experiments` 是列表与创建页，`/experiments/<experiment_id>` 是详情页：
变体卡片（改了哪些变量、从什么改成什么）、结果表（计数 + 均值，缺数显示 `—`）、
样本行（每个 runId 一条，可点进既有 Run 详情）。创建页用同一套 `validateExperimentDefinition`
做前端预检，非法时提交按钮直接禁用并说明原因。

界面只做上面三件边界允许的事：不重排结果、不给缺数补 0、不提供第二份正文查看器。
