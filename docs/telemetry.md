# Run Telemetry（v1.8.0）

> 本文件是 v1.8.0 新增的 `telemetry.json` 契约：它记录什么、不记录什么、空值怎么写。
> 契约测试：`tests/test_telemetry.test.ts`（TASK §35–§44 的验收要求逐条落在测试里）

## 它是什么，不是什么

一次 Run 会在 `runs/<run_id>/` 下留下三份互相不可替代的文件：

| 文件 | 回答的问题 |
|---|---|
| `metadata.json` | 这次跑到哪一步、结论是什么（状态摘要） |
| `run-manifest.json` | 这次跑在什么配置、什么版本上（出身清单） |
| `telemetry.json` | 这次**怎么跑的**：各阶段耗时、调了几次模型、重试修订几次、在哪一步失败 |

`telemetry.json` 只记录执行过程。它有三个不可协商的边界，下面每一个字段为什么长这样都由它们决定：

1. **只观察，不控制。** 遥测里没有一个字段是给重试、修订或接受判定用的。`TelemetryCollector`
   读得到流程状态，但它对流程没有任何写入口——同样的数据不会因为记录过就改变生成行为。
2. **拿不到就是没有，绝不补 0。** Provider 没返回 usage 时 token 三个值是 `null`，
   成本整行不出现。补一个 0 等于凭空捏造一次「这次调用没花 token」。
3. **不落正文、不落密钥、不落原始异常。** 完整 Prompt、正文、用户输入在别的产物里，
   遥测里只有指标；异常只降级成一个稳定 `errorCode`，异常原文一个字都不进。

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 遥测自身的 schema 版本，当前恒为 `"1"`（`TELEMETRY_SCHEMA_VERSION`）；与 run-manifest 的版本号相互独立 |
| `runId` | string | Run 标识 |
| `startedAt` | string | Run 开始的墙上时间（ISO 8601） |
| `completedAt` | string \| null | Run 结束的墙上时间；Run 自身崩溃时为 `null` |
| `durationMs` | number \| null | 本次 Run 的总时长。取自单调时钟，不可能为负；没记到就是 `null` |
| `status` | string | `completed` / `failed`，与 `metadata.json` 的 `status` 同一口径 |
| `failureStage` | string \| null | 失败发生在哪个阶段（阶段名，见下）。**不是原因**，也不允许从它推断原因 |
| `failureCode` | string \| null | 稳定错误码，见「错误码」 |
| `stages` | StageTelemetry[] | 按发生顺序，一行一次执行 |
| `llmCalls` | LLMCallTelemetry[] | 按发生顺序，一条一次逻辑调用 |
| `attempts` | AttemptTelemetry[] | 按发生顺序 |
| `repairs` | RepairTelemetry[] | 按发生顺序 |
| `totals` | TelemetryTotals | Run 级汇总 |

## 阶段名

阶段名**以真实 Pipeline 的阶段命名为准**，不另起一套漂亮名字：

```text
planning              validating_beat_plan   generating   saving
validating            reviewing              repairing    revalidating
rereviewing           reviewing_commercial   artifact_promotion
```

`completed` / `failed` 是 Run 状态，不是阶段名。`artifact_promotion`（把入选 Attempt 的产物
复制到运行根）是遥测独有的一步——它是真实发生的一步，值得单独计时，但它不是 RunStatus，
所以不进 `metadata.json` 的 `current_stage`。

同一个阶段在一次 Run 里可能跑多次（`validating` 在每个 Attempt 都出现），所以 `stages`
记的是**发生次数**，不是「这个阶段的平均值」。求和、找最慢这类聚合是读的一侧的事；
采集器不预先汇总——预先汇总就把「跑了三次」和「跑了一次但很慢」混成一个数了。

## StageTelemetry

| 字段 | 类型 | 说明 |
|---|---|---|
| `stage` | string | 阶段名 |
| `status` | string | `pending` / `running` / `completed` / `failed` / `skipped` |
| `startedAt` | string \| null | 这一段开始的墙上时间；跑完的阶段必有 |
| `completedAt` | string \| null | 这一段结束的墙上时间；跑完的阶段必有 |
| `durationMs` | number \| null | 这一段耗时，单调时钟，`>= 0` |
| `errorCode` | string \| null | 稳定错误码；失败时必有，成功时这个键不出现 |
| `attemptNumber` | number \| null | 这一段属于第几次 Attempt；Attempt 之外的阶段没有这个键 |

`skipped` 表示「这一步这一版没接 / 没跑到」（例如没注入 `BeatValidator` 就没有
`validating_beat_plan`），与 `failed` 是两件事。

## LLMCallTelemetry

一条 = 调用方眼中的**一次**逻辑调用。Transport Retry（超时、429、临时 5xx 最多重试两次）
算在同一次调用里，不拆成多条——否则「调用次数」这个数会虚高。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 本次 Run 内唯一；落盘时缺失会补成 `call-001` 这样的序号 |
| `stage` | string | 这次调用发生在哪个阶段 |
| `model` | string \| null | 本次真正生效的模型；没记到是 `null` |
| `provider` | string \| null | **恒为 `null`。** 这个仓库不在任何地方记录 Provider 名（run-manifest 连 `baseUrl` 原文都不存），可观测不等于把部署信息抄进产物 |
| `startedAt` / `completedAt` | string | 起止墙上时间 |
| `durationMs` | number \| null | 耗时，单调时钟，`>= 0` |
| `status` | string | `completed` / `failed` |
| `inputTokens` / `outputTokens` / `totalTokens` | number \| null | Provider **真实返回**的 usage，不给就是 `null`，客户端自己一个数都不估 |
| `cost` | object \| null | `{amount, currency}`；只有 Provider 真给（金额与币种同时在）才有，否则整个键不出现 |
| `errorCode` | string \| null | 稳定错误码；失败时必有 |

`totalTokens` 缺省时由 `inputTokens + outputTokens` 相加得出，两个都有才算；缺一个就不猜。

## AttemptTelemetry

| 字段 | 类型 | 说明 |
|---|---|---|
| `attemptId` | string | 本次 Run 内唯一 |
| `index` | number | 第几次 Attempt，从 1 开始 |
| `status` | string | `accepted` / `retried` / `failed` |
| `durationMs` | number \| null | 这一次 Attempt 的耗时 |
| `generationCalls` | number | 这一次里的正文生成调用次数 |
| `reviewCalls` | number | 这一次里的结构审阅调用次数（含修订后的重新审阅） |
| `commercialReviewCalls` | number | 这一次里的商业可读性审阅调用次数 |
| `repairCount` | number | 这一次里发生的定点修订次数 |

`failed` 指「这一次自身就失败了」（例如生成阶段抛异常）；`retried` 指「没过，且后面还有
Attempt」。**次数用尽**由 Run 级表达（`quality_status: exhausted`），不把最后一次标成 failed。

## RepairTelemetry

| 字段 | 类型 | 说明 |
|---|---|---|
| `repairId` | string | 本次 Run 内唯一 |
| `attemptId` | string | 属于哪一次 Attempt |
| `category` | string \| null | 修的是哪一类问题；RepairStrategy 没给出归类时是 `null` |
| `status` | string | `success` / `failed` |
| `durationMs` | number \| null | 这次修订的耗时 |
| `llmCalls` | number | 修订期间的全部模型调用（含修完之后的重新校验 / 重新审阅） |

## TelemetryTotals

| 字段 | 类型 | 说明 |
|---|---|---|
| `durationMs` | number \| null | Run 总时长，与顶层同一个数 |
| `llmCalls` | number | 真实逻辑调用次数。一次都没调过是 `0` |
| `inputTokens` / `outputTokens` / `totalTokens` | number \| null | 「有值的那些调用」之和 |
| `usageSampleCount` | number | 上面三项的分母：至少带一个 token 字段的调用数 |
| `retries` | number | §12 语义：`attempts = 3 → retries = 2`；一次都没跑成时是 `0`，不是 `-1` |
| `repairs` | number | 定点修订总次数（修订不新增 Attempt） |
| `failedStages` | number | `status` 为 `failed` 的阶段数 |

**「调了 6 次但一次都没拿到 usage」与「一次都没调」必须是两件事**：前者 `llmCalls: 6`、
`usageSampleCount: 0`、三个 token 键整个不出现；后者 `llmCalls: 0`。写盘时 `null` 会被丢掉，
所以 Provider 一次都没给 usage 时三个 token 键**不出现**，而不是写成 `null`——
两种记法一致，读的时候都用「键在不在」判断。

## 错误码

异常原文一个字都不落盘，只留一个稳定码。文案在 `src/core/telemetry-collector.ts` 里写死，
不可能把路径或凭据带进产物。

| code | 固定文案 |
|---|---|
| `LLM_TIMEOUT` | 模型调用超时 |
| `LLM_REQUEST_FAILED` | 模型调用失败（网络或服务端返回错误） |
| `LLM_EMPTY_RESPONSE` | 模型返回内容为空 |
| `VALIDATION_COMPONENT_FAILED` | 正文校验组件自身失败 |
| `REVIEW_COMPONENT_FAILED` | 质量审阅组件自身失败 |
| `BEAT_VALIDATION_COMPONENT_FAILED` | 骨架校验组件自身失败 |
| `COMMERCIAL_REVIEW_COMPONENT_FAILED` | 商业可读性审阅组件自身失败 |
| `GENERATION_FAILED` | 正文生成失败 |
| `BEAT_PLAN_REJECTED` | 骨架结构校验未通过 |
| `ARTIFACT_WRITE_FAILED` | 产物写入失败 |
| `RUN_FAILED` | Run 失败（未归类） |

拿不准的异常退到 `RUN_FAILED`，不是把原文抄下来。遥测里不会出现：API Key、
`Authorization` 头、`Cookie`、任何原始请求 / 响应头、`process.env` 原文、完整 Prompt、
正文、用户输入原文、带 query token 的 URL 原文。

## 保存与读取

- **保存**：Pipeline 收尾时写 `runs/<run_id>/telemetry.json`，写盘前过一遍
  `validateRunTelemetry`——采集器是本仓库自己的代码，但「观测数据本身」也要防一手。
- **失败 Run 也保存**：跑到一半失败时，遥评分带着已经发生过的阶段落盘，`status: failed`。
  想看一次失败的 Run 到底走到哪，读它自己的 `telemetry.json` 即可。
- **读取**：三级兜底，任何一级都不抛给调用方——文件缺失、JSON 坏、形状不认识，一律归一成
  `null`（与 `runManifestOf` 同一约定）。**磁盘上不会被补写。**
- **旧 Run**：1.8.0 之前的 Run 没有这个文件，读出来是 `null`，接口返回
  `{telemetry: null}`（HTTP 200），UI 面板整个隐藏。缺的是观测数据，不是这个 Run。

## 接口与界面

- `GET /api/runs/<run_id>/telemetry` → `{telemetry: RunTelemetry | null}`，见 [api.md](./api.md)
- Run 详情响应追加一个可选字段 `telemetry`（与上面同一份内容，读接口顺手带上）
- Run 详情页的「可观测性」面板：总览七项 + 阶段时间线 + 模型调用表 + Attempt 列表；
  取不到的值一律显示 `—`，绝不显示成 `0`
- 实验详情：每个变体多一组效率指标（`durationMs` / `llmCalls` / token 三项 / `retries` /
  `repairs` 的均值与有值样本数），同样只对真有的样本求，一个都没有时是 `null`
- `metadata.json` 的 `duration_ms` / `llm_call_count` 是这里的转述，不用再翻一个文件时的快捷方式

## 不做什么

- **不做失败归因、不做根因分析**：遥测只回答「失败发生在哪个阶段、错误码是什么」，
  「为什么」不在遥测里，也不许从这些数推出来
- **不做告警、不做分布式追踪、不做全局 APM Dashboard**：一次 Run 一份文件，没有跨 Run 的
  聚合视图，没有阈值判断，没有「慢」「快」这类结论——本版本不设基线
- **不做基准平台、不排名**：实验里的效率指标只描述这一组样本自己，没有赢家、没有显著性检验
- **不自动改生成策略**：没有任何代码读遥测来决定重试、修订或接受判定
- **没有隐藏的后端 / 接口**：上面列的路由与字段就是全部
