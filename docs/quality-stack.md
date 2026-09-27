# 统一质量视图 quality-stack.json（v2.1.0）

> 本文件是 v2.1.0 新增的 `quality-stack.json` 契约：三套质量结论如何合成一页、统一的
> `QualityDiagnostic` 长什么样、哪些字段是新增的、哪些边界没有变。
> 契约测试：`tests/test_quality_diagnostic.test.ts`、`tests/test_quality_stack_*.test.ts`、
> `tests/test_quality_center.test.ts`、`tests/test_quality_stack_compat.test.ts`、
> `tests/test_quality_stack_security.test.ts`。

## 它是什么，不是什么

一次 Run 会在 `runs/<run_id>/` 下留下四份互不替代的质量侧文件：

| 文件 | 回答的问题 |
|---|---|
| `beat-validation.json` | 这份剧情骨架撑不撑得起一个完整短篇（v1.4.0） |
| `review.json` | 这篇故事写得好不好：Co/N/C/Ca 四维与 0–100 整体分 |
| `commercial-review.json` | 读者会不会继续读下去：H/P/E/Pf 四维与 0–100 整体分 |
| `quality-stack.json` | **这三套结论合起来看到什么**：统一诊断清单与 severity 计数（v2.1.0） |

`quality-stack.json` **不是第四套评价**。它不调用模型、不重新评分、不新增分数、不补维度，
只是把上面三份已经跑完的结论放到一张表里看，并给它们一套共同的诊断语言。
四份文件里任何一份被旧版本读取都只是「多一个不认识的键」，不影响任何既有行为。

三套结论各自内部也没有变：`Co/N/C/Ca` 与 `H/P/E/Pf` 的维度名、均分口径、
0–100 范围、`review.score` / `commercial_review.score` / `beat_validation.issues`
这些既有字段逐字保留（v1.x 客户端照原样读得到）。变的是它们**另外**还产出结构化诊断。

## 三个不可协商的边界

1. **诊断只说明，不驱动。** `QualityDiagnostic` 不携带 rootCause / confidenceProbability /
   repairPolicy / adaptiveWeight / causalNodeId / evidenceLedgerId / characterDecisionId，
   也没有任何代码读它来决定重试、修订、采纳、换模型或换 Prompt。同样的输入仍然得到
   同样的重试次数与同样的修订类别——诊断条数从 1 条变 12 条，RetryPolicy 的判定一字不变。
2. **没有结论就不占位。** 某套结论没跑出来（组件自身失败、没跑到那一步、v2.0.0 及更早的
   Run），`quality-stack.json` 里对应的键**整个不出现**，Run 详情接口的 `qualityStack` 读作
   `null`，界面上的 Quality Center 整个区域隐藏——不白屏、不补 0、不编一份「0 条诊断」。
3. **不落敏感数据。** 诊断只走既有的 secret-safe 平台边界序列化：
   `quality-stack.json` 里没有 API Key、没有 `Authorization` / `Cookie` 头、没有原始环境变量、
   没有带密钥的 URL。

## QualityDiagnostic：三套组件共用的诊断语言

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定标识。由校验方按输出顺序指派（`<source>-<序号>`），**不让模型自己编**——模型编的 id 会随输出顺序漂移，去重、UI 定位与失败分析的证据指向都会对不上 |
| `source` | string | 谁说的：`beat-validator` / `quality-reviewer` / `commercial-reviewer`。由解析方给定，不从模型输出里读 |
| `category` | string | 稳定问题码，按来源各认各的白名单（见下） |
| `severity` | string | `info` / `warning` / `error`，三个组件共用同一套口径 |
| `target` | string | 这条诊断说的是哪一部分，见下 |
| `message` | string | 人类可读说明，不能为空 |
| `suggestion` | string? | 可选的非空建议；没给就不出现这个键 |
| `relatedBeatIds` | number[]? | 可选：涉及哪几拍（正整数）。给了但全是非法值的键不出现 |

severity 语义（三套组件同一口径）：

| severity | 含义 |
|---|---|
| `info` | 可优化，但不是明显问题 |
| `warning` | 明显影响质量，但通常不阻止 Pipeline |
| `error` | 结构性或硬性问题，可阻止当前阶段继续 |

`target` 只有七个值：`beat-plan` / `story` / `opening` / `middle` / `ending` /
`character` / `global`。

### category 白名单（按来源各认各的）

| source | 允许的 category |
|---|---|
| `beat-validator` | 直接沿用 v1.4.0 的十一个稳定 Code：`EMPTY_PLAN` / `TOO_FEW_BEATS` / `BROKEN_SEQUENCE` / `DUPLICATE_BEAT` / `MISSING_OPENING` / `MISSING_ESCALATION` / `MISSING_CLIMAX` / `MISSING_RESOLUTION` / `CHARACTER_STATE_CONFLICT` / `UNSUPPORTED_TURN` / `ENDING_NOT_PREPARED` |
| `quality-reviewer` | `continuity_break` / `setting_conflict` / `character_state_conflict` / `goal_unclear` / `motivation_weak` / `character_inconsistency` / `narrative_stall` / `repetition` / `unsupported_turn` / `causal_gap` / `weak_climax` / `weak_resolution` |
| `commercial-reviewer` | `weak_opening` / `late_conflict` / `slow_pacing` / `repetitive_middle` / `low_information_gain` / `weak_engagement` / `tension_drop` / `weak_payoff` / `unresolved_promise` / `overlong_resolution` |

故事质量诊断写进商业类别、或反过来，一律按非法输出处理——两套评价体系不做换算
（与 v1.5.0 起「Co/N/C/Ca 与 H/P/E/Pf 不互相驱动」同一条边界）。
首版刻意保持少而稳定，category 不允许无限扩张。

## quality-stack.json 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 本文件自身的 schema 版本，当前恒为 `"1"`；与 run-manifest / telemetry 的版本号相互独立 |
| `status` | string | `complete` / `partial` / `failed`，见下 |
| `beatValidation` | object? | Beat Validator v2 结论（`passed` / `diagnostics` / `summary`）。没跑出来时整键不出现 |
| `qualityReview` | object? | Quality Reviewer v2 结论（`score` / `dimensions` / `diagnostics` / `summary`）。同上 |
| `commercialReview` | object? | Commercial Reviewer v2 结论（`score` / `dimensions` / `diagnostics` / `summary`）。同上 |
| `diagnostics` | QualityDiagnostic[] | 三套诊断按 骨架 → 故事质量 → 商业可读性 顺序合并后轻量去重的结果 |
| `summary` | object | severity 计数，见下 |

`status` 是一个确定性换算，按「有几套结论在位」定，不猜某一套为什么不在：

| status | 条件 |
|---|---|
| `complete` | 三套结论都在 |
| `partial` | 至少一套在、但不是全套（某一套失败时保留具体模块状态：Run 照常完成，其它结论一份不少） |
| `failed` | 一套都没有 |

`summary` 由 `diagnostics` 现算，不是另一份人工记账：`totalDiagnostics` / `errors` /
`warnings` / `info`。写盘前会把它与 diagnostics 重新对账，对不上就是被人改过，整份作废。

去重是**轻量**的：只按 `source + category + target + message` 四者完全相同判重，
同一来源对同一处说的同一句话只留第一条。没有 embedding 聚类、没有语义合并模型。

## 只落在 Run 根目录一份

`quality-stack.json` 与 `run-manifest.json` / `telemetry.json` / `failure-analysis.json`
一样**只在 Run 根目录一份**：`attempts/` 与 `repairs/` 下都没有它。运行级固定文件数从
v2.0.0 的十二个变成十三个，上面每一个文件都原样保留。

读盘的宽容规则与其它产物一致：文件缺失、JSON 坏、形状不对（`schemaVersion` 不符、
`status` 与在位模块对不上、`summary` 与 diagnostics 计数不符、某条诊断非法）
都归一成「没有这一份」，绝不补一份假的质量总览占位。

## 出口：API 与界面

| 出口 | 形状 |
|---|---|
| `GET /api/runs/<run_id>/quality-stack` | `{qualityStack: {status, diagnostics, summary} \| null}`。Run 不存在是 404，没有这份文件是 `{qualityStack: null}` |
| Run 详情响应 `GET /api/runs/<run_id>` | 多一个可选字段 `qualityStack`，形状同上；三套结论的本体仍在 `review` / `beat_validation` / `commercial_review` 各就各位，不在这里重复一遍 |
| Run 详情页 | 多一块「Quality Center」面板：Overview 三行（Planning / Story Quality / Commercial）+ 按 severity 分组的诊断清单 + 四类筛选（来源 / severity / target / category，同时生效） |

界面筛选选项只列这一次真的出现过的值，顺序固定（来源按 beat → quality → commercial、
severity 按 error → warning → info、target 与 category 按字典序）——不按诊断出现顺序，
否则同一次 Run 里选项顺序会飘。

## 失败分析可以读它，但不会因此变成归因

`failure-analysis.json`（v1.9.0）可以把结构化诊断当**证据**用：某条信号指向哪份文件的
哪个字段、哪条诊断。它仍然只分类、不推断原因，没有因果图、没有原因字段，
也没有任何代码读诊断来决定重试、修订或采纳。

## 不做什么

- **不重新评分**：三套结论一分不改、一个维度不补；`overall_score` 仍只由 Co/N/C/Ca 均分而来
- **不做语义合并**：去重只有字符串相等，没有聚类、没有相似度模型
- **不驱动任何决策**：Retry / Repair / Model Switch / Prompt Switch 一概不读诊断
- **不迁移旧 Run**：v2.0.0 及更早的 Run 没有这个文件，磁盘上不会被补写
- **不替代三份结论本体**：`review.json` / `commercial-review.json` / `beat-validation.json`
  一个字段都没少，旧客户端的读法逐字不变

## 相关

- [architecture.md](architecture.md)：六层边界与产物归属
- [run-artifacts.md](run-artifacts.md)：Run 产物布局与 metadata 字段集
- [failure-analysis.md](failure-analysis.md)：失败分类契约（诊断只是它的证据之一）
- [api.md](api.md)：路由与响应字段
- [compatibility.md](compatibility.md)：主版本内只追加可选字段
