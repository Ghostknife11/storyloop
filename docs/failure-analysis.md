# Run 失败分析（v1.9.0）

v1.9.0 冻结的契约：每次 Run 收尾时，在 `metadata.json` 旁多落一份
`runs/<run_id>/failure-analysis.json`，把「这个 Run 失败了」结构化成三件事——
**它属于哪一类失败、第一次失败发生在哪个阶段、有哪些直接证据支持这个判断**。

本文档写死字段、类别、判定顺序与边界。字段级对照表同时被
`tests/test_contract_docs_sync.test.ts` 双向钉住（文档多写、漏写、改名都会红）。

## 它是什么，不是什么

| | |
|---|---|
| 是 | 对**已经存在的事实**做确定性分类：错误码、状态、结论文件、计数 |
| 不是 | 归因：不回答「为什么会失败」，不推断「哪个组件最可能出问题」 |
| 不是 | 控制：没有任何代码读它来决定重试、修订、采纳或下一步怎么跑 |
| 不是 | 诊断报告：不整合多 Run、不统计趋势、不排名 |

输入只有三类来源，全部**只读**（§3）：已经落盘的产物与遥测（metadata / Manifest /
telemetry / beat-validation / validation / review / commercial-review / quality）、
Retry 与 Repair 的真实计数与上限、以及运行阶段异常链上采集到的稳定错误码。
分析器不重新跑任何一步，不调用任何模型（§50：同步纯函数，无网络、无 LLM）。

## failure-analysis.json 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 本文件 schema 版本，当前 `"1"` |
| `runId` | string | 这次 Run 的 `run_id` |
| `status` | string | `none` / `detected` / `partial` / `unknown` |
| `primaryCategory` | string \| null | 主要失败类别；`status` 为 `none` 时必为 `null` |
| `secondaryCategories` | string[] | 其余类别，按同一优先级排序；不含 `primaryCategory` |
| `summary` | string | 一句事实陈述（成功时固定为 `No run-level failure detected.`） |
| `signals` | FailureSignal[] | 观察到的信号；没有失败证据时是空数组 |
| `evidence` | FailureEvidence[] | 与信号对应的证据；同样可空 |
| `firstFailureStage` | string \| null | 第一次失败发生在哪个阶段；不知道就是 `null` |
| `terminalState` | string \| null | `metadata.status`，其次遥测的 `status`；都没有就是 `null` |

`status` 四个取值的含义：

- `none`：没有任何失败证据——`signals` 与 `evidence` 都是空数组，`primaryCategory` 是 `null`；
- `detected`：有失败证据，且全部归进了已知类别；
- `partial`：有失败证据，一部分归进了类别，另一部分来自未登记的错误码（原始码仍然留在信号里）；
- `unknown`：有失败证据，但一条都归不进已知类别——这一版选择说「不知道」，不猜。

## 失败类别与优先级

类别是固定集合，只能追加，不能改名或改含义（`src/types/failure-analysis.ts` 的
`FAILURE_CATEGORIES`）。**顺序即 Primary 优先级，数字越小越优先**：

| # | 类别 | 什么时候归它 |
|---|---|---|
| 0 | `SECURITY` | 安全策略阻止了操作（地址校验拒绝等）。只说「被阻止」，不说「被攻击」 |
| 1 | `CONFIGURATION` | 这次 Run 在开始之前就不该被接受（配置非法、版本不支持等） |
| 2 | `STORAGE` | 产物没落稳（写入失败、路径非法） |
| 3 | `PLANNING` | 剧情骨架没立起来（骨架结构校验 error、规划输出不可用） |
| 4 | `GENERATION` | 正文模型这一跳本身没成（超时、请求失败、空响应、生成失败） |
| 5 | `VALIDATION` | StoryValidator 的硬性结论（正文校验 issue）。组件自身失败也归这里，但信号会写明「是组件失败，不是正文有问题」 |
| 6 | `REVIEWER` | 审阅环节自身失败（输出不可解析、组件异常）。**不等于故事质量差** |
| 7 | `RETRY_EXHAUSTION` | Attempt 数达到上限且最终没有被采纳 |
| 8 | `REPAIR_EXHAUSTION` | 修订轮数达到上限且目标问题仍然存在 |
| 9 | `QUALITY` | 整体质量分低于策略阈值。这是观测，不是失败判定 |
| 10 | `COMMERCIAL` | 商业可读性低。同样是评价结论，不是技术失败 |
| 11 | `UNKNOWN` | 有失败迹象，但归不进任何已知类别 |

Primary / Secondary 的判定（§21/§22）：

1. 收集信号，每条信号可能带 0..n 条证据；
2. 按类别分组证据，类别键按上表的优先级排序（优先级相同按类别名字母序，保证确定性）；
3. `primaryCategory` 取第一个；其余进 `secondaryCategories`，顺序同样确定。

同样的输入跑两遍，结论逐字节相同——分析器没有随机数、没有时钟、没有遍历顺序依赖。

## 信号与证据

`FailureSignal`：`{ code, source, severity, message }`。

- `code` 是稳定标识（API / UI / 实验聚合只用它）。未知码**原样保留**（§41）
  ——信号码 `UNRECOGNIZED_FAILURE_CODE` 的消息里带着那个原始码，同时如果失败阶段已知，
  仍按该阶段归大类；阶段也不知道就归 `UNKNOWN`。
- `source` 只能是 `metadata` / `telemetry` / `beat-validation` / `story-validation` /
  `quality-review` / `commercial-review` / `retry` / `repair` / `storage` / `security`。
- `severity`：`info` 背景、`warning` 薄弱项、`error` 硬失败。

`FailureEvidence`：`{ sourceArtifact?, sourceField?, stage?, attempt?, repair?, code?, value?, note? }`。
每条证据都指回这份 Run 自己目录里的一个文件、一个字段，读者打开就能对上（§48）：

| 证据指向 | 说明 |
|---|---|
| `validation.json` + `issues[].code` | 正文校验的具体 issue code |
| `beat-validation.json` + `issues[].code` | 骨架结构校验的具体 issue code |
| `metadata.json` + `attempt_count` / `quality_status` | 重试耗尽的两个事实（真数出来的 Attempt 数、最终采纳结论） |
| `metadata.json` + `repair_count` | 修订耗尽时的真实修订轮数 |
| `run-manifest.json` + `repairs[].succeeded` | 每一轮修订的成败 |
| `telemetry.json` + `failureCode` / `failureStage` | 失败阶段与稳定错误码 |
| 仅有 `code` 与 `note` | 来自异常链的码，没有可指的文件 |

产物存在性只能作辅助观察，**不单独决定失败类别**（§42）：没有 `commercial-review.json`
不代表商业可读性有问题，只代表这一步没跑。

## 重试 / 修订耗用的判定

- **Retry Exhaustion（§38）**：`attempt_count >= max_attempts`、且没有任何一次 Attempt 被采纳、
  且最终采纳结论不是 `accepted`。`retries > 0` 本身不算耗尽。
- **Repair Exhaustion（§39）**：`enable_repair` 为真、`max_repairs_per_attempt >= 1`、
  `repair_count >= max_repairs_per_attempt`，且目标问题仍然存在（最终校验未通过，或
  最终质量分低于阈值，或最后一轮修订本身没跑成）。关掉 Repair 时永远不是修订耗尽——
  那时一次修订都没发生过。

两条判定都只用真实计数与上限，不做趋势判断、不预测「再试一次会不会过」。

## 保存、读取与接口

Run 收尾时（成功与失败两条路径都会）写这份文件；成功 Run 得到 `status: "none"`
（§28）。三层读取容错与其它产物一致：文件不存在 → `null`、JSON 坏 → `null`、
形状不对 → 归一成 `null`，都不抛异常，也**不会往磁盘补写**。

| 接口 | 行为 |
|---|---|
| `GET /api/runs/<run_id>/failure-analysis` | `{failureAnalysis: <分析> \| null}`；旧 Run 是 200 + `null` |
| `GET /api/runs/<run_id>` | Run Detail 多一个 additive 字段 `failureAnalysis` |
| Run 详情页 | 「失败分类」面板；没有这个字段时整个隐藏 |
| 实验详情页 | 「失败类别分布」按 Variant 汇总每个样本的**主要**类别 |

metadata 多两个 additive 摘要字段（§30）：`failure_analysis_status` 与
`primary_failure_category`。后者**只在确实分出了类别时出现**，`none` 与 `unavailable`
都不写——不拿一个类别占位。

分析器自己出错或写盘失败时（§29）：只留一条 warning，`failure_analysis_status` 记
`unavailable`，磁盘上不会有这份文件，**一次成功的 Run 不会因此变失败**。

## 安全边界

- 落盘的分析里**没有** API Key、`Authorization` 头、Cookie、环境变量原文、
  带账号口令的 URL，也没有原始异常正文。异常只收敛成一个稳定错误码。
- 没有服务器绝对路径（净化规则与其它响应共用 `src/lib/safe-text.ts`）。
- URL 地址守卫（v1.1.0 起）拦下的操作归 `SECURITY`，只说「被策略阻止」。

## 不做什么

- **不推断根因**：不回答「为什么会失败」，不判断「哪个组件最可能出问题」，
  不产出因果图、不产出「很可能是因为 Prompt 太长 / 模型能力不足 / 温度不合理」这类结论。
- **不自动动作**：不改重试策略、不改修订策略、不改提示词、不重新规划、不重跑。
  分类结果只被读取与展示。
- **不跨 Run 聚合结论**：实验页只数「每个样本的主要类别」这一个事实，
  不排名、不比较、不推断哪一组更好。
- **不迁移旧 Run**：1.9.0 之前生成的 Run 没有这个文件，读作 `null`，磁盘上不会被补写。
- **不替代遥测**：`telemetry.json` 仍然是执行事实的唯一来源（哪个阶段、几次调用、
  失败阶段与错误码）；失败分析只在这些事实之上做分类。
