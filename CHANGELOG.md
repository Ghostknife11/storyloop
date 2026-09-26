# Changelog

All notable changes to Storyloop.

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

---

> **2026-09-21 · 历史重建说明**：为形成真实的逐版本演进历史，本仓库于 2026-09-21 重建了全部 Git 历史
> （重新整理并标注各版本提交）；此前已发布的 tag 与 GitHub Release 均已失效并被替换。
> v0.0.1 内容与此前一致，v0.1.0 ~ v0.4.0 的提交序列与此前不同（内容以上各版本条目为准），
> v0.4.0 另补齐了进度 UI、CLI 走 Pipeline 与四组测试（见下）。

---

## [1.9.1] —— 2026-09-26

1.9.1 是 1.8.0 / 1.9.0 的补丁：把这两版发布后逐行读代码查出来的十处真问题修掉，
外加一批文档与实现不一致的地方。没有新能力、没有新语义、没有任何契约字段改名——
每一条修复都有回归测试钉住，修完之后 1.9.0 与 1.8.0 已冻结的产物字段逐字未动。

### Fixed

- **遥测不再把崩过的步骤记成 completed**：骨架校验 / 正文校验 / 审阅 / 商业审阅组件自身抛异常时
  （Run 照常继续的那一类），这一段现在记 `failed` + 一个稳定码，`failedStages` 不再恒为 0。
  码分别是 `BEAT_VALIDATION_COMPONENT_FAILED` / `VALIDATION_COMPONENT_FAILED` /
  `REVIEW_COMPONENT_FAILED` / `COMMERCIAL_REVIEW_COMPONENT_FAILED` / `GENERATION_FAILED`，
  异常原文一个字都不落盘
- **产物晋升失败时失败阶段指得对了**：`promoteAttempt` 抛错时 `failureStage` 与
  `current_stage` 现在都写 `artifact_promotion`——遥测这一段记 `failed` + 稳定错误码
  `ARTIFACT_WRITE_FAILED`，失败分析把它归进 `STORAGE` 类（码与类别是两件事）。
  修之前它指到上一个早就跑完的步骤，和遥测里 `artifact_promotion: failed` 两句话对不上
- **Run 级 `durationMs` 与每条阶段同一个口径**：单调时钟差值取整到毫秒，不再是带小数的数
- **读产物读不动时不再整套 500**：文件在但读不了（被换成同名目录、没有读权限、链接成环）
  v1.9.1 起按「没有这份产物」处理——`null`，与文件不存在 / JSON 坏同一个行为。
  写盘那侧的失败照旧抛 `ArtifactWriteError`，读的一侧不再把它放大
- **遥测拿不到时 metadata 不再写两个 null**：`duration_ms` / `llm_call_count` 两个转述键
  整个不出现，而不是写 `null` 冒充「有遥测但零毫秒」（1.8.0 文档就是这么承诺的）
- **跑成了的 Run 不再被判成 detected**：唯一一次 Attempt 的审阅或骨架校验组件崩过、Run 照常
  收尾的情况，失败分析现在是 `status: "none"`、信号与证据空数组、摘要
  `No run-level failure detected.`。修之前它会说「Run 在运行中未能完成」并给出类别
- **修订耗尽多了一道采纳闸门**：最终结论是 `accepted`（或某次 Attempt 被采纳过）时不算
  `REPAIR_EXHAUSTION`——问题最后是被修好了的，修订数到过上限只说明它试过
- **「最后一轮修订」取的是对的那一轮**：按「最后一次尝试过修订的那个 Attempt 的最后一轮」取，
  修之前按最大修订轮次号全局取，跨 Attempt 时会取到另一次 Attempt 的修订上
- **修订耗尽的文案说清两个口径**：「本次 Run 共 N 轮修订，每次 Attempt 上限 M 轮」，
  证据里也分别标注「Run 级合计」与「每次 Attempt 上限」。修之前拿 Run 级合计直接和
  每次的上限比，读起来像同一回事
- **证据不再指向盘上不存在的文件**：这次 Run 没有 `telemetry.json` 时，生成类与未知错误码
  的证据只留 `code` 与 `note`，`sourceArtifact` / `sourceField` 整个键不出现
- **证据带上了 attemptId 与 repairId**：修订证据现在填 `run-manifest.json` 里那一轮的
  `attemptId` / `repairId`（1.9.0 的结构里就有这两个字段，分析器一个都没填过，面板那一列
  永远是「—」）；旧 Run 的清单没有这两个键时它们照旧不出现

### Changed

- `FailureEvidence` 的可选字段由 `attempt` / `repair` 正名为 `attemptId` / `repairId`，
  与 `run-manifest.json` 里那一轮的键名一致；`FailureAnalysisRepair` 多一个可选 `repairId`，
  `FailureAnalysisAttempt` 多一个可选 `attemptId`
- `docs/api.md`、`docs/experiments.md`、`docs/telemetry.md`、`docs/run-artifacts.md`、
  `docs/failure-analysis.md`、`README.md`、`CHANGELOG.md` 与示例 Run 的 README 同步修正：
  修掉字段名写错（`created_at` → `createdAt`、`run_count` → `runCount`）、断掉的表格、
  与实现相反的声明（`counts` 键序、`provider` 恒为 null、artifact_promotion 不进
  `current_stage`、「被 test_contract_docs_sync 双向钉住」）与过期的版本号标题
- 新增一个测试文件 `tests/test_patch_1_9_1.test.ts`（22 个用例），上面十条修复逐条钉住

### Security

- 遥测与失败分析的安全边界逐字未动：异常仍然只收敛成稳定错误码，`safe-text.ts` 净化照旧，
  API Key 不进产物、不进响应，读路径的兜底也不会把本机绝对路径带出接口

### Not in this release

仍然是补丁：不新增类别、不新增接口、不做归因、不做 Remediation。1.9.0 的「不做什么」全部继续有效。

---

## [1.9.0] —— 2026-09-26

「这次 Run 失败了」从此不再是终点。v1.9.0 在现有 Artifact 与 Telemetry 之上新增一层
确定性的失败分析：把一次 Run 的失败归进固定 12 类清单里的主要 / 次要类别，配一组信号，
再为每个判断挂上直接证据（哪份文件的哪个字段、哪个 Attempt、哪一轮修订）。
它只分类，不归因：没有因果图、没有 Root Cause 字段、没有任何一处代码读它来改变生成行为。

### Added

- **Run 级 `failure-analysis.json`**：每次 Run 在 `metadata.json` 与 `telemetry.json` 旁多落一份，
  自带 `schemaVersion`（`"1"`），camelCase。字段集固定：`status` / `primaryCategory` /
  `secondaryCategories` / `summary` / `signals` / `evidence` / `firstFailureStage` /
  `terminalState`
- **固定 12 类清单（Structured Failure Categories）**：`SECURITY` / `CONFIGURATION` /
  `STORAGE` / `PLANNING` / `GENERATION` / `VALIDATION` / `REVIEWER` / `RETRY_EXHAUSTION` /
  `REPAIR_EXHAUSTION` / `QUALITY` / `COMMERCIAL` / `UNKNOWN`，优先级写死、不重排。
  清单与规则集中在 `src/lib/failure-rules.ts`，类别名在 `src/types/failure-analysis.ts`
- **Primary / Secondary 分类**：主要类别取优先级最高的那一个，其余按同一优先级进次要类别；
  证据不足时 `status` 是 `unknown`、`primaryCategory` 是 `null`，绝不用猜的类别填空位
- **Failure Signals**：每条信号有稳定 code、来源（metadata / telemetry / beat-validation /
  story-validation / quality-review / commercial-review / retry / repair / storage / security）
  与严重度；不属于清单的错误码保留原文进 `UNRECOGNIZED_FAILURE_CODE`，再按已知失败阶段降级
- **Evidence Linking**：每条信号指向真实产物与字段（`validation.json · issues[0].code` /
  `metadata.json · attempt_count` / `run-manifest.json · repairs[0].succeeded` /
  `telemetry.json · failureCode` 这类）。没有证据就没有类别
- **Retry / Repair 耗尽检测**：`RETRY_EXHAUSTION` / `REPAIR_EXHAUSTION` 由真实计数与
  `RetryPolicy` 上限判定（`attempt_count` 对 `max_attempts`、`repair_count` 对
  `max_repairs_per_attempt`），不靠推测
- **只读出口**：`GET /api/runs/<run_id>/failure-analysis`（没有这份文件时
  `{failureAnalysis: null}`，HTTP 200），Run 详情响应追加可选字段 `failureAnalysis`
- **失败分析 UI**：Run 详情页多一块「失败分类」面板——结论、主要 / 次要 / 首个失败阶段 /
  终态、信号表、证据表。只读：没有重试、没有重跑、没有「按建议修复」
- **实验级失败类别分布（Experiment Failure Distribution）**：实验汇总的每个 Variant 多一个
  `failures` 块（`analyzedCount` / `classifiedCount` / `counts`），界面在结果表下方多一张表。
  只按主要类别数样本；没有 `failure-analysis.json` 的样本不进分母（不当「没有失败」），
  1.9.0 之前跑的实验整段隐藏
- **`metadata.json` 的两个转述字段**：`failure_analysis_status` 与（确有类别时的）
  `primary_failure_category`
- **`docs/failure-analysis.md`**：字段表、类别优先级、证据指向、四种 `status` 记法与边界
- **八个测试文件**（`test_failure_models` / `test_failure_rules` / `test_failure_analyzer` /
  `test_failure_artifacts` / `test_failure_api` / `test_failure_ui` /
  `test_experiment_failure_distribution` / `test_client_bundle_boundary`）

### Changed

- **Run 详情现在能区分技术失败、规划 / 校验失败、质量偏低、审阅环节自身失败与耗尽状态**：
  它们本来都只表现为一个失败阶段加一个错误码
- **Analyzer 是纯确定性函数**：只读磁盘上已有的产物，不调用模型、不访问网络、不做任何新请求；
  同一份产物每次得到同一份分析
- **遥测仍是事实来源**：失败分析只对已观测到的证据做分类，不新增观测、不改遥测口径
- **旧 Run 依然可读**：1.9.0 之前生成的 Run 没有 `failure-analysis.json`，读作 `null`、
  面板整个隐藏、实验里的分布整段隐藏；不做迁移、不现算、不补零

### Security

- **`failure-analysis.json` 不落凭据**：API Key、`Authorization` 头、Cookie、原始请求 / 响应头、
  环境变量原文都不进这份文件；URL 一律过安全判定后才出现在证据里
- **异常只降级成稳定错误码与净化文本**：原始异常 payload 不落盘，路径走 `safeText` 净化
- **分析器自身失败不影响 Run**：分析抛异常或写盘失败时 Run 仍按原样结束，metadata 记
  `failure_analysis_status: "unavailable"`、不写类别，成功的 Run 不会因此变失败
- **v1.1.0 的地址关卡、v1.6.0 的 Run Manifest、v1.7.0 的实验框架边界、v1.8.0 的遥测边界
  全部原样保留**：这一层没有放松任何一处校验

### Not in this release

这一版刻意**不做**：因果归因与 Root Cause Analysis、自动 Remediation、Adaptive Retry、
任意可扩展失败模式注册、生成策略自优化。失败分析回答「这是哪一类、在哪个阶段、依据是什么」，
不回答「为什么会失败」，也不据此改变任何生成行为。

---

## [1.8.0] —— 2026-09-26

StoryLoop 不再只是保存「输入与结果」，而是能结构化记录一次 Run 的执行过程：哪些阶段运行了、
各自耗时多少、调用了多少次模型、发生了多少 Retry / Repair、失败发生在哪里，以及真实可得的
token / cost。系统开始看得见自己怎么运行，但还不会解释为什么失败，更不会根据这些数据自动改变行为。

### Added

- **Run 级 `telemetry.json`**：每次 Run 在 `metadata.json` 旁多落一份，与状态摘要、出身清单
  三者互不替代。自带 `schemaVersion`（`"1"`），与 run-manifest 的版本号相互独立
- **阶段计时**：每个阶段一次执行一条记录（`stage` / `status` / `startedAt` / `completedAt` /
  `durationMs` / 可选 `errorCode` / 可选 `attemptNumber`）。同一个阶段在一次 Run 里跑多次就记
  多次，不预先求平均；耗时取自单调时钟，不为负。`artifact_promotion` 是遥测独有的一步
- **结构化 LLM 调用遥测**：一次逻辑调用一条（`id` / `stage` / `model` / 起止 / `durationMs` /
  `status` / 真实 usage / 可选 cost / 可选 errorCode）。Transport Retry 算在同一次调用里，
  不拆成多条——否则「调用次数」会虚高
- **Attempt / retry / repair 计数器**：`attempts` 数组带每次尝试的各步骤调用数与修订次数，
  `repairs` 数组带每次修订的类别、结局、耗时与期间调用数；`totals.retries` 按
  `attempts - 1` 计，一次都没跑成是 0 而不是 -1
- **失败阶段记录**：`failureStage` + 稳定 `failureCode`。是位置与编码，不是原因
- **Provider usage 捕获**：只在 Provider 真实返回时记录；拿不到整项是 `null`，客户端一个数都不估
- **可选成本捕获**：只有 Provider 同时给出金额与币种才记 `{amount, currency}`；这个仓库没有
  版本化价格表，价格只可能来自 Provider 自己
- **失败 Run 也保存遥测**：跑到一半失败时已发生的阶段照常落盘，`status: "failed"`
- **Run 可观测性 UI**：Run 详情页多一块面板——总览（总时长 / 调用次数 / Attempt / 重试 /
  修订 / token，成本只在真实可得时出现）、阶段时间线、模型调用表、Attempt 列表。
  取不到的值一律显示 `—`，绝不显示成 0
- **只读路由 `GET /api/runs/<run_id>/telemetry`**：`{telemetry: ...}`；旧 Run 没有这个文件时
  返回 `{telemetry: null}`（HTTP 200）
- **Run 详情响应追加可选字段 `telemetry`**：与上面同一份内容，读接口顺手带上
- **实验效率指标**：实验汇总的每个 Variant 多一个 `efficiency` 对象，七项指标各是
  `{mean, sampleCount}`——`durationMs` / `llmCalls` / token 三项 / `retries` / `repairs`。
  只对真有值的样本求均值，一个都没有时是 `{mean: null, sampleCount: 0}`
- **`metadata.json` 的两个转述字段**：`duration_ms` 与 `llm_call_count`，不用再翻一个文件时的
  快捷方式。新增字段，`metadata.json` 契约本身 additive
- **`tests/test_telemetry.test.ts`**（34 条）：计时、计数 semantics、六类组件的调用计数、
  usage 可得性、成本不伪造、密钥不进产物、异常脱敏、旧 Run 兼容、实验子 Run 遥测

### Changed

- **LLM 调用经由共享采集路径插桩**：`LLMClient` 构造时可接一个 `LLMTelemetrySink`，
  Planner / Generator / BeatValidator / BasicReviewer / CommercialReviewer / StoryRepairer
  共用同一个客户端，于是调用数从同一个 wrapper 出来，不另起一套统计
- **`buildPipeline` 一个采集器两处接线**：同一个 `TelemetryCollector` 既给 Pipeline 也给它构造的
  共享客户端。注入进来的客户端是调用方自己的，不动它
- **Run 详情可暴露时长、调用数、usage 与失败阶段**；旧 Run 没有遥测时这些位置是 `null`，
  面板整个隐藏，磁盘上不会被补写
- **`docs/telemetry.md`**、`docs/api.md`、`docs/upgrade.md`、README 同步这一层契约

### Security

- **遥测序列化排除凭据与环境变量原文**：API Key、`Authorization` 头、`Cookie`、任何原始请求 /
  响应头、`process.env` 都不进 `telemetry.json`
- **错误遥测用稳定码而非原始异常**：异常只降级成 11 个固定错误码之一（`LLM_TIMEOUT` /
  `LLM_REQUEST_FAILED` / `LLM_EMPTY_RESPONSE` / `VALIDATION_COMPONENT_FAILED` /
  `REVIEW_COMPONENT_FAILED` / `BEAT_VALIDATION_COMPONENT_FAILED` /
  `COMMERCIAL_REVIEW_COMPONENT_FAILED` / `GENERATION_FAILED` / `BEAT_PLAN_REJECTED` /
  `ARTIFACT_WRITE_FAILED` / `RUN_FAILED`），文案写死在采集器里，不可能把路径或 query token
  带进产物
- **遥测里不落正文**：完整 Prompt、正文、用户输入都不进 `telemetry.json`；`llmCalls[].provider`
  恒为 `null`（run-manifest 连 baseUrl 原文都不存，这里同样不抄部署信息）
- **v1.1.0 的地址关卡、v1.6.0 的 Run Manifest、v1.7.0 的实验框架边界原样保留**：这一层没有
  放松任何一处校验

### Not in this release

这一版刻意**不做**：失败归因与根因分析、自动优化、告警、分布式追踪、基准平台、自适应生成。
遥测只回答「发生了什么」，不回答「为什么」，也不据此改变任何生成行为。

---

## [1.7.1] —— 2026-09-26

1.7.1 是对 1.7.0 的一次审查修订：把刚发布的实验框架读一遍，修掉三个真问题。
没有新能力、没有新路由、没有新字段语义，两个已有字段终于被填上。

### Fixed

- **样本行不再永远是「—」**：`results.json` 的 `runs` 数组现在逐条带上这条样本自己的
  `overallScore` 与 `commercialScore`（读自它自己的 `quality.json` / `commercial-review.json`，
  读不到是 `null`）。1.7.0 的 `referencesOf` 漏了这两个字段，于是详情页每一行样本都显示
  「整体 — · 商业 —」，分数明明就在各自的产物里。分数只读一次，引用与均值同源
- **同一个实验不会同时跑两遍**：`POST /api/experiments/<id>/run` 现在有一把进程内的锁，
  同一时间一条执行链；第二个请求直接 409 `EXPERIMENT_CONFLICT`（「正在运行中」）。
  1.7.0 只有「results.json 存在就 409」一道闸门，两个并发请求会双双通过预检，
  把整个实验跑两遍——两倍付费请求，两份 `runs.json` 互相覆盖
- **不像目录名的 id 一律 404**：`GET` / `POST run` 一个 `experiment_id` 之前先过
  `isExperimentId`。1.7.0 里 `exp/../../x` 这种输入会走到存储层的 containment 检查，
  抛出没有对应错误码的 `ExperimentWriteError`，最后变成 500；按契约「找不到」就该是 404。
  存储层的 containment 兜底也补上了「根目录自身不算实验目录」——`resolve(root, ".")`
  等于根，根目录不是实验目录

### Changed

- `run-manifest` 的出身面板多一行 `Experiment`：这条 Run 属于哪个实验、哪个变体、
  第几次 repetition。1.7.0 把 `experiment` 块写进了清单却没有在界面上摆出来；
  普通 Run 没有这个键，这一行也就不出现

### Docs

- `docs/api.md` 的实验入口一节按实现重写：响应体是 camelCase（不是 snake_case），
  `GET /api/experiments` 只返回 `{ experiments }`（没有 `total`，列表项没有 `has_result`，
  有 `status` / `successCount` / `failureCount`），详情的 `runs` 是
  `{ experimentId, totalRuns, entries[] }` 而不是数组，`POST .../run` 回传的就是
  `ExperimentResult` 本身。1.7.0 那一版把这三个形状都写错了
- `docs/experiments.md` 写明两件此前没写的事：中断后重跑从第一格开始（不做断点续跑），
  以及同一时间一个实验只允许一条执行链（进程内）
- README：409 的第二种含义、样本行现在有分数、已知限制补一条「实验没有断点续跑」
- 1.7.0 的条目本身也有一处笔误已就地订正：定义字段写成了 `hypothesis`，
  实现里从来没有这个字段，只有 `description`（同一个可选的 500 字内说明）

### Compatibility

- 1.7.0 → 1.7.1 无破坏性变更：没有删字段、没有改字段名、没有改路由。`result.runs`
  多出两个键（`overallScore` / `commercialScore`），旧实验的结果文件里没有它们，
  读到的就是 `null`，界面照老样子显示 `—`
- 1.7.0 已经跑完的实验不会因为升级而变成「能再跑一次」：`results.json` 还在，
  409 照旧
- **测试总量：1204 passed / 78 files**（1.7.0 为 1197 / 77）

---

## [1.7.0] —— 2026-09-26

v1.7.0 回答「如果只改模型、只改 prompt、只改 temperature，会发生什么？」。做法不是再做一套生成系统，
而是在 v1.6.0 的 Traceable Runs 之上加一层**受控实验框架**：一份定义、多个变体、变量写明白、
条件固定住，一次跑完全部格子，结果落成可以回看的 Experiment。它复用的还是那条
`buildPipeline`——每一次格子都是一次货真价实的 Run，有 run_id、有产物、有出身清单。

框架刻意停在「把数字摆出来」这一步。它不排名、不评赢家、不做显著性检验、不自动调参：
变量表是人填的，结论是人下的，工具只负责把跑出来的数收集齐、并且不替谁说话。

### Added

- **`experiments/` 目录与三个文件**（`src/lib/experiment-store.ts`）：`<runs>/../experiments/`
  下每个实验一个目录，含 `definition.json`、`runs.json`、`results.json`。实验只写自己那份
  目录，Run 一律照旧落在 `runs/` 下；`runs/` 与 `experiments/` 都不进 Git
- **`ExperimentDefinition` 模型与校验**（`src/core/experiment-config.ts`）：`schemaVersion` 恒为
  `"1"`，字段 camelCase。定义含 `name` / `description` / `base` / `variants`；`base` 是四个固定
  条件——`story_config`、`beat_plan` 与 `beatPlanMode`、`model_config`、`generation_parameters`
  与 `retry_policy`
- **四个可改变量，白名单合并**：`model`（`modelConfig.model`）、`generation.temperature`、
  `retry.maxAttempts`、`retry.minReviewScore`。合并走 `applyVariantOverrides`，**只碰这四个键**，
  其余字段逐字沿用 base；键不在白名单里 → 400 `EXPERIMENT_INVALID`
- **`experiments + repetitions` 展开**（`expandExperiment`）：变体数 1~4、重复次数 1~5、
  总样本 1~12，按定义顺序逐格生成执行计划
- **`ExperimentRunner`**（`src/core/experiment-runner.ts`）：逐格调用 `buildPipeline`，
  每格结束就把进度写回 `runs.json`（含 `run_id` / `status` / `failure`），全部跑完才写
  `results.json`。**单格失败不中断**——失败格带原因留在 `runs.json`，剩下的格子继续跑
- **基础聚合**（`summarizeExperiment`）：每变体一行的次数（`runCount` / `successCount` /
  `failureCount`）与均值（`meanOverallScore` / `meanCommercialScore`，以及 1.7.1 补上的
  质量四维 `meanCoherence` / `meanNarrative` / `meanCharacter` / `meanCausality`），
  按定义顺序排列。没有任何成功样本时均值是 `null` 而不是 `0`——**没有 winner、没有 rank、
  没有 p 值**
- **四个路由**：`POST` / `GET /api/experiments`、`GET /api/experiments/<id>`、
  `POST /api/experiments/<id>/run`
- **三个错误码**：`EXPERIMENT_INVALID`（400）、`EXPERIMENT_NOT_FOUND`（404）、
  `EXPERIMENT_CONFLICT`（409；id 已存在或实验已跑过——同一实验**不能跑第二次**）
- **实验界面**（`src/app/experiments/`、`src/components/experiment-*.tsx`）：列表页、
  创建页、详情页的变体卡片与结果表，Run 下钻复用既有 Run 详情入口
- **Run 出身的 `experiment` 块**：实验产生的 Run 的 `run-manifest.json` 多一个可选
  `experiment` 字段（`{ experimentId, variantId, repetition }`），纯追加；普通 Run 没有这一段
- 新文档 `docs/experiments.md`（契约、目录布局、错误码、样本上限与三条边界），
  `docs/api.md` 与 `docs/upgrade.md` 同步

### Changed

- `run-manifest` 的 `RunManifest` 多一个可选 `experiment` 字段，`validateRunManifest`
  对它做形状校验；没有这一段的老清单逐字读得通
- 前端「未来能力」守卫从禁止 `Experiment` 字样改为禁止 `Benchmark` / `CausalGraph` /
  `因果图` 等仍未发布的能力：实验框架从这一版起是已发布能力

### Security

- **实验定义不接受凭据**：`story_config` 之外任何位置出现凭据形状的字段 →
  400 `EXPERIMENT_INVALID`，错误信息不回显原文。API Key 只认服务端 `LLM_API_KEY`，
  定义里没有它、也没有 `baseUrl`
- 没有 `baseUrl` 意味着每个变体都走服务端配置的地址，**v1.1.0 起那道地址关卡因此对每一次
  格子都生效**，实验无法借「换个 baseUrl」绕过它
- 实验定义只登记，不含任何密钥；`runs.json` 与 `results.json` 里只有 run_id、状态、次数与均值

### Compatibility

- 1.6.0 → 1.7.0 无破坏性变更，也不需要迁移：没有删字段、没有改字段名，四条路由与三个错误码
  全是新增，`runs/` 布局、三层 metadata、`run-manifest.json` 既有字段、CLI 逐字未动
- 1.6.0 之前生成的 Run 的清单没有 `experiment` 段，读接口照常返回，UI 的 Provenance 面板行为
  与 1.6.0 一致
- 新增的 `experiments/` 目录在 `runs/` 旁边；老版本不认识它，回滚到 1.6.0 后这些目录只是躺着，
  不影响任何 1.6.0 行为
- **测试总量：1197 passed / 77 files**（1.6.0 为 1133 / 72）

---

## [1.6.0] —— 2026-09-25

v1.6.0 回答一个此前只能靠翻代码才能回答的问题：**这份故事是拿什么跑出来的？** 每次 Run 现在
除了 `metadata.json` 还多写一份 `run-manifest.json`——用哪个代码版本与 commit、哪个模型、
各阶段 temperature、六个提示词各自的版本与内容摘要、每次 Attempt 的结局，以及这批产物的
SHA-256 清单。它落在 Run 根目录，**只有一份**，`attempts/` 与 `repairs/` 下都没有。

它是新增文件，不顶替也不改 `metadata.json` 的任何一个字段：三层 metadata 契约、`quality.json`
装配口径、产物布局、路由、错误码、CLI 与已有响应字段全部逐字未动。清单自带 `schemaVersion`、
字段用 camelCase，与 v1.0.0 冻结的 snake_case metadata 契约物理隔离——将来扩展清单不需要
碰任何既有字段的语义。

这不是实验框架：不做跨 Run 对比、不跑基准、不统计成功率、不做自适应调参。清单只为一次 Run
自证出身，读接口把它原样挂在 `manifest` 字段上，界面折成一个面板。

### Added

- **`run-manifest.json`（运行级新增的第十个固定文件）**：一次 Run 的出身清单，与
  `metadata.json` 并列写在 Run 根目录。字段为 `schemaVersion` / `runId` / `project`（`version` + 可选
  `commit`）/ `models` / `prompts` / `parameters` / `attempts` / `artifacts`。写盘走
  `ArtifactStore.putManifest`，与其它产物同一套「先写 `.名字.tmp` 再 rename」的原子写入
- **`RunManifest` 模型与校验**（`src/types/run-manifest.ts`）：`schemaVersion` 恒为 `"1"`；
  `validateRunManifest` 对坏数据抛 `RunManifestError`，`runManifestOf` 返回 `null` 不抛——
  与 v1.0.0 起其它产物校验同一套「读坏 ≠ 500」的规则
- **`prompts` 小节**（`src/lib/tracking/prompt-registry.ts`）：六个提示词文件
  （`planner` / `generator` / `beat-validator` / `reviewer` / `commercial-reviewer` / `repairer`）
  各自的 `version` 与内容 SHA-256 `digest`。提示词在仓库里，所以摘要可复算；脏读取一律返回
  `null`，清单照样能写
- **`artifacts` 小节**（`src/lib/tracking/manifest-builder.ts`）：逐个登记真实存在的产物
  并回读文件算 SHA-256，**不存在的文件不写占位行**。清单自己不出现在自己登记的条目里
  （记不了自己的摘要），也不登记三层 `metadata.json`——那归 metadata 契约管
- **`models` 小节**：只记模型名、provider 与 baseUrl 分类（`server-configured` /
  `request-public-override`）。**baseUrl 原文不落盘**，也没有 key、没有 Authorization 头
- **写清单失败不让 Run 失败**（`src/core/pipeline.ts`）：`buildRunManifest` / `putManifest`
  抛异常时只 `logger.warning` 记一行并把 `manifest` 置为 `null`——故事、校验、审阅、质量
  一个结论都不受影响。这是「多一步 provenance」不该反过来决定 Run 成败的意思
- **两个 API 字段**：`POST /api/runs` 的 `RunOk.manifest` 与
  `GET /api/runs/<run_id>` 的 `RunDetail.manifest`，都是可选，缺清单时是 `null`
- **`Run Provenance` 面板**（`src/components/manifest-panel.tsx`）：折叠在 Run 结果下方，
  列 Project 版本 / commit、模型、六个提示词的版本与截断摘要、六项 temperature、
  `RetryPolicy` 快照、每次 Attempt 的结局与所在文件。没有清单的 Run 面板整个隐藏
- `examples/example_run/run-manifest.json`：样例 Run 的清单，17 个产物条目带真实
  SHA-256；根目录 `story.md` 与 `attempts/01/story.md` 摘要相同（promote 不变式的又一例证）

### Changed

- `examples/example_run/metadata.json` 的 `project_version` 跟进到 `1.6.0`（与 1.4.0 →
  1.5.0 加 `commercial-review.json` 时同一套做法）
- 样例 Run 的 `README.md` 说明 v1.6.0 布局，新增一节讲 `run-manifest.json`

### Security

- **清单里不写凭据**：模型条目只有模型名 / provider / baseUrl 分类，没有 baseUrl 原文、
  没有 API Key、没有 Authorization 头；`topP` / `maxTokens` 这类本次没有下发的参数一律不写
  （`LLMClient.generate` 只发 `{model, messages, temperature}`）
- `project.commit` 只在环境真的给出 git SHA 时才有，**从不为了填满字段去跑 git**

### Compatibility

- 1.5.2 → 1.6.0 无破坏性变更，也不需要迁移：没有删字段、没有改字段名、没有改路由与错误码。
  v1.6.0 之前生成的 Run 没有 `run-manifest.json`，读接口的 `manifest` 返回 `null`，面板隐藏，
  磁盘上不会被补写
- 运行级固定文件数从九个变成十个（多的是 `run-manifest.json`）；`attempts/` 与 `repairs/`
  一层文件都没多，老 Run 的每层文件数与 1.5.2 逐字一致
- **测试总量：1133 passed / 72 files**（1.5.2 为 1104 / 71）。新增
  `tests/test_run_manifest.test.ts` 29 条，全部只用假模型 / 假组件与合成样例，不调真实接口
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.5.2 升级到 1.6.0」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.6.0 的清单」

---

## [1.4.0] —— 2026-09-25

v1.4.0 在写正文之前加了一道 **BeatPlan 结构校验**：剧情骨架生成后先过一次结构检查——
四拍结构（建置 / 升级 / 高潮 / 收束）是否各有承担者、编号与顺序讲不讲得通、有没有哪一拍
靠没有铺垫的转折硬转、结局所需的条件是否在前文出现过。结论落成 `beat-validation.json`、
API 的 `beat_validation` 字段与前端 Beat Validation 面板三处。

这道校验仍然只报告、不修复：不改写任何一拍、不重排顺序、不自动补拍，也不据此重新规划——
发现问题后由使用者决定骨架怎么改。`passed` 为 `false`（有 `error` 级问题）时 Run 在写正文
之前结束，产物里**没有** `story.md`，也**没有** `attempts/`；`warning` 级问题不算不通过。
`BeatValidator` 是可选的第十一个 Pipeline 构造函数参数，不注入就完全没有这道校验，
流程与 v1.3.0 逐字一致。

### Added

- **`BeatValidationResult` / `BeatValidationIssue` 模型**（`src/types/beat-validation.ts`）：
  布尔结论 + 命中项列表 + 一句话摘要。`BeatValidationIssue` 只有四个字段：
  `code`、`severity`（`warning` / `error`，与 `ValidationResult` 同一套两级口径）、
  `message`、可选的 `beat_ids`。**没有分数、没有修复建议**——没有 `fixed_beats`、
  没有 `rewritten_plan`、没有 `suggested_plan`
- **十一个稳定问题码**：`EMPTY_PLAN` / `TOO_FEW_BEATS` / `MISSING_OPENING` /
  `MISSING_ESCALATION` / `MISSING_CLIMAX` / `MISSING_RESOLUTION` / `BROKEN_SEQUENCE` /
  `DUPLICATE_BEAT` / `CHARACTER_STATE_CONFLICT` / `UNSUPPORTED_TURN` / `ENDING_NOT_PREPARED`。
  白名单由 `BEAT_VALIDATION_ISSUE_CODES` 钉死，新增只能追加
- **规则层 `checkBeatPlanDeterministic`**（`src/lib/beat-validator.ts`）：不调模型就能判的
  四条（空骨架、拍数太少、编号重复、编号不连续）。规则层报出 `error` 时短路，不再花钱调模型
- **`BeatValidator`**（`src/lib/beat-validator.ts`）：StoryConfig + BeatPlan →
  `prompts/beat_validator.txt` → LLM → `BeatValidationResult`。温度固定 0.2，
  `passed` 由 `beatValidationPassed(issues)` 重新推导（不信模型自己说的 `passed`），
  规则层与模型层的重复命中按 `code + beat_ids` 去重。只读输入，不改写 BeatPlan
- **`parseBeatValidationResult`**（`src/lib/beat-validation-parser.ts`）：容错 code fence 与
  首尾空白，不做散文 scavenging；拿不到结构合法的 JSON 抛 `BeatValidationParseError`
- **Pipeline 新阶段 `validating_beat_plan`**（`src/core/pipeline.ts`）：BeatPlan 落盘后、
  第一个 Attempt 之前校验一次，进度写进 metadata；带 `error` 级问题时抛 `PipelineError`
  结束这次 Run
- **`beat-validation.json`**（`src/storage/artifact-store.ts`）：Run 根目录一份，
  `attempts/` 与 `repairs/` 下都没有——BeatPlan 只校验一次，不随重试重跑
- **四个运行级 metadata 字段**：`beat_validation_status`（四值，与 `validation_status` 同口径）、
  `beat_validation_passed`、`beat_validation_issue_count`、`beat_validation_error`。
  **骨架不达标不算错误**——只有校验器自己抛异常时才有 `beat_validation_error`
- **API 字段**：Run 类入口多 `beat_validation` / `beat_validation_status` /
  `beat_validation_error`，Run 详情多 `beat_validation` / `beat_validation_status`，
  `artifacts` 在校验成功时多一个 `beat_validation` 键；1.4.0 之前的 Run 读出
  `null` 与 `not_started`
- **`POST /api/validate-beats`**：`{config, beat_plan}` → 单独校验一份骨架，不写任何产物。
  不读也不写 `run_id`——外部调用不该改动 Pipeline 自己落盘的那份结论
- **新错误码 `BEAT_VALIDATION_FAILED`（502）**：骨架结构校验拿不到合法的 `BeatValidationResult`
- **前端 Beat Validation 面板**（`src/lib/beat-validation-view.ts` +
  `src/components/beat-validation-panel.tsx`）：状态 + 每个 issue 的 severity / code /
  message / 命中的拍（`Beat 3 / Beat 4` 这样的定位标签）。没有 Auto Fix / Rewrite /
  重新规划一类操作入口
- **`prompts/beat_validator.txt`**：十个模型侧检查项、各自的严重程度口径、
  「没有问题就返回空 issues，不要为了凑数编造问题」、以及「不重写任何一拍、不给分数」；
  规则层负责的两个码明确不让模型重复报告。占位符白名单不变，没有新增占位符

### Changed

- **生成链路多一道门**：BeatPlan 落盘后先校验。带 `error` 级结构问题的骨架，Run 在
  `status: "failed"` / `current_stage: "validating_beat_plan"` 结束，产物只有
  `config.json` / `beats.json` / `beat-validation.json` / `metadata.json` 四个文件。
  这类 Run 在 1.3.x 会一路生成到 Attempt 阶段；`warning` 级问题的行为完全不变
- **组件自身异常仍不连累 Run**：`BeatValidator` 抛异常时只把 `beat_validation_status`
  置为 `failed`、记下 `beat_validation_error`，Run 照常继续生成
- **examples/example_run/** 增加 `beat-validation.json` 与对应的 metadata 字段（一条
  `ENDING_NOT_PREPARED` warning + `passed: true`），样例 README 同步
- 版本号 1.3.0 → 1.4.0（`VERSION` / `package.json` / `package-lock.json` /
  `FALLBACK_VERSION`）

### Tests

- 新增 `tests/test_beat_validation.test.ts`（24 条）：模型与 schema 白名单、
  `passed` 推导、`beat_ids` 过滤、没有修复字段、解析容错（code fence / 首尾空白，
  不做散文 scavenging）、规则层四条判定、`BeatValidator`（温度、提示词、短路、
  重新推导 `passed`、去重、模板缺失即抛错、不改写输入）
- 新增 `tests/test_beat_validation_pipeline.test.ts`（11 条）：硬失败抛
  `PipelineError` 且只留四个产物、warning 放行正常生成、校验器在多次 Attempt 之间只跑一次、
  校验器自身异常不阻断 Run、不注入校验器时与 v1.3.0 逐字一致
- 新增 `tests/test_beat_validation_api.test.ts`（10 条）：新路由 happy path、
  400 / 502 分支、不写 `runs/` 与 `outputs/`、v1.3.0 的老 Run 读回
- 新增 `tests/test_beat_validation_ui.test.ts`（18 条）：请求形状（不带 `run_id`）、
  面板五种状态（含「骨架不过 ≠ 校验器失败」）、`beat_ids` 定位标签、没有修复 / 重规划入口
- 合同测试同步：`tests/test_contract_artifacts.test.ts` 的文件表加入
  `beat-validation.json`、metadata 必填字段加入 `beat_validation_status`；
  `tests/test_contract_api.test.ts` 的路由清单加入 `POST /api/validate-beats`；
  `tests/test_contract_docs.test.ts` 的保留能力清单移出 `BeatValidator`，并新增
  「Beat 校验只报告，不改写、不重排、不补拍」的边界断言
- **测试总量：986 passed / 65 files**（1.3.0 为 985 / 65——净增是 63 条 Beat 校验用例与
  1 条边界断言）。全部用例仍只用假模型 / 假组件，不调真实接口、不碰真实主机

### Compatibility

- 1.3.x → 1.4.0 无破坏性变更，也不需要迁移：既有字段、路由、错误码、CLI 参数与产物布局
  一个都没动，1.3.x 写的产物可以直接读（`beat_validation` 是 `null`、
  `beat_validation_status` 是 `not_started`），1.4.0 写的 Run 回落到 1.3.x 也只是多一份
  被忽略的文件与几个被忽略的 metadata 字段
- 唯一的行为变化是上面那道门：带 `error` 级结构问题的 BeatPlan 不再进入生成阶段
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.3.x 升级到 1.4.0」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.4.0 的 BeatPlan 结构校验」

---

## [1.4.1] —— 2026-09-25

v1.4.1 是**修订版本**：没有新能力、没有新文件、没有新字段、没有新路由。
回到 1.0.0 ~ v1.4.0 的每条承诺逐条核对，把「文档写了但实现没做到」与「上一版定好的口径
没走到底」的地方改回承诺的样子，外加两处让坏数据能一路带到响应体外面的读路径问题。

### Fixed

- **`attempt` 摘要的审阅分与门槛分、质量快照同口径。** v1.3.0 起整体分的唯一实现是
  `reviewOverallScore`（有维度时取四维均分），各级 metadata 与 `quality.overall_score`
  都走它；唯独 `AttemptSummary.review_score`（`src/core/generation-attempt.ts`）还在取
  `review.score` 原值。于是模型给了维度时，同一个 Run 里 Attempt 摘要显示 90、
  `quality.overall_score` 显示 83、`RetryPolicy` 拿 83 去比 `min_review_score`——
  三个本应相同的数字不一致。现在摘要也走 `reviewOverallScore`；**没有维度时逐字不变**
- **读回容错：坏结论文件不再让读接口 500。** `ArtifactStore` 的九个读方法
  （`readRepairValidation` / `readRepairReview` / `readAttemptValidation` /
  `readAttemptReview` / `readFinalValidation` / `readFinalReview` / `readFinalQuality` /
  `readFinalBeatValidation` / `readAttemptQuality`）原来直接把磁盘内容 `as` 成类型返回，
  一份被手改坏的 `review.json`（半份 JSON、缺一个维度、分数越界）会让 `GET /api/runs/<id>`
  抛到 500，或者把形状不对的对象原样带进响应体。v1.4.1 起读回一律先过 schema 归一化
  （新增 `reviewResultOf` / `validationResultOf` / `beatValidationResultOf`），
  不认识就按「没有结论」处理：字段是 `null`、接口仍然 200。这与 v1.2.0 起
  `quality.json` 的处理方式同一条原则。**不改变「解析失败」的既有判定**——审阅阶段拿到
  形状不对的结论仍是 `REVIEW_FAILED`，那一刻必须给一个诚实答案
- **`beat_validation_error` 现在真的会返回。** `docs/api.md` 的 Run 响应表从 v1.4.0 起就
  写了这个字段，`GenerationResult`（`src/core/pipeline.ts`）却没有它：`BeatValidator`
  自身抛异常时这段文字只落在 metadata 里，HTTP 层拿不到。现在补上，并与
  `validation_error` / `review_error` 同一套「有错误才带这个键」的约定
  （`src/lib/generate-service.ts` 的 `RunOk` 与 `src/lib/api.ts` 的 `RunOkApi` 同步）
- **CLI 的 `plan` 漏了透传 `--temperature`。** `run` / `review` / `repair` 都把运行时覆盖
  放进请求体，只有 `plan`（它不走服务层）把 `--temperature` 整个丢掉了：命令行上给了
  0.42，规划却照旧用默认的 0.7。现在四个子命令一致。同时 `review` / `repair` 收到
  `--temperature` 会明确打一行「已忽略」——它们用固定温度 0.3 / 0.5（Beat 结构校验固定
  0.2），这一点从 v1.0.0 起就没变，只是以前不说，看起来像参数被吞了
- **`--help` 被无法识别的参数挡住。** `storygen run --nonsense --help` 以前按参数错误收场
  （退出码 2、用法打到 stderr），因为解析在遇到第一个未知参数时就停了。现在先扫一遍有没有
  `--help` / `-h`：有就给用法、退出码 0，位置不再重要
- **「重新」操作可能作用在另一版正文上。** Review Again / Validate Again 原来固定重放
  Run 落盘的那一版，而当前展示的可能是某次 attempt 或修订后的正文——点一下「重新审阅」，
  面板里出现的结论描述的是另一段文字。现在以当前展示的正文为准；只有当当前展示的正是
  Run 落盘那一版时，才覆盖 run 目录里的 `review.json` / `validation.json`
  （`run_id` 才跟着传）。相应地，复制 / 下载导出的也是当前展示的正文，
  而不是切到修订版后仍然复制落盘那一版
- **产物清单给 run 级文件加了 attempt 前缀。** 查看第 2 次 attempt 时，`artifacts` 里的
  `config.json` / `beats.json` / `beat-validation.json` 也被拼成
  `attempts/02/config.json`，点进去只会 404。现在 `attempts/NN/` 前缀只加在 attempt 级的
  四类文件（`story` / `validation` / `review` / `quality`）上，run 级三项照旧不带前缀
  （新增纯函数 `attemptArtifactPath`，`src/lib/artifacts-view.ts`）
- **切换 attempt 时的过期响应会回写正文。** 连点两次「查看」，先发出的那次晚回来时会把
  已经切走的那一版正文写到当前视图上。现在每次请求带一个自增序号，回来时序号过期就丢弃
- **落盘不是原子的。** `promoteAttempt` 与 `putText` 直接写最终路径，写一半被中断
  （进程被杀、磁盘满）就留下半份 `story.md` / `review.json`，下一次读就是一个坏产物。
  改成「同目录临时文件 + rename」；临时文件只多一个前导点、落在它自己那一层
  （`.story.md.tmp` 与 `story.md` 同目录），不会挤到 Run 根目录冒充产物

### Security

- 本次改动没有扩大任何攻击面：读回容错只收紧已有的读路径（坏数据不再原样进响应体），
  原子写只是换了写盘顺序。请求体 `baseUrl` 的公网地址关卡（v1.1.0 / v1.1.1 的口径）
  原样未动，回归测试仍在；没有任何新增的外部输入路径，也没有引入凭据

### Tests

- `tests/test_generation_attempt.test.ts` 新增 1 条：有维度时摘要取四维均分（90 + 80/82/84/86
  → 83）、没有维度时取 `review.score`（74）
- `tests/test_artifact_store.test.ts` 新增 attempt 级临时文件位置、rename 失败时目标不被
  半份文件替换，以及 7 条读回容错（缺维度、顶层是数组、半份 JSON、坏问题码、坏 Beat 校验
  结论、坏 `quality.json`、attempt 级文件、以及「归一化后与写入时逐字相同」的对照）
- `tests/test_retry_api.test.ts` 新增 2 条：attempt 级 `review.json` 缺一个维度、
  Run 根 `validation.json` 是半份 JSON，读接口都是 200 且对应字段为 `null`
- `tests/test_cli.test.ts` 新增 3 条（`--temperature` 透传给规划、审阅 / 修订固定温度 +
  「已忽略」提示，断言落在真正发给模型的那次请求上）与 1 条（`--help` 在无法识别的参数之后
  照样给用法、退出码 0）
- `tests/test_beat_validation_pipeline.test.ts` 新增 1 条：校验器抛异常时
  `GenerationResult` 带 `beat_validation_error`，没异常与没注入时都没有这个键
- `tests/test_ui_artifacts.test.ts` 新增 4 条产物清单前缀用例与 2 条 `RunOk` 可选字段用例
- **测试总量：1012 passed / 66 files**（1.4.0 为 986 / 65）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机

### Compatibility

- 1.4.0 → 1.4.1 无破坏性变更，也不需要迁移：没有新字段、没有删字段、没有改路由、
  没有改错误码、没有新文件，1.4.0 写的产物可以直接读。读出来的结果也逐字一致，唯一例外是
  「模型给了维度」的 attempt 摘要分数——而那正是 v1.3.0 文档承诺的口径
- 回滚到 1.4.0 的代价只有这一处：带审阅维度时 attempt 摘要的分会退回 `review.score` 原值，
  与同一次尝试的 metadata / `quality.overall_score` 不再是同一个数
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.4.0 升级到 1.4.1」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.4.1 的修订」

---

## [1.5.0] —— 2026-09-25

v1.5.0 加了**商业可读性审阅**：与结构审阅（Co/N/C/Ca 四维）完全并列的第二个独立审阅者，
从「读者会不会继续读下去」的角度看同一篇正文，四个固定维度——**Hook（开篇抓力）**、
**Pacing（节奏）**、**Engagement（全篇持续阅读动力）**、**Payoff（回报）**，各自 0~100
分加一句短评。整体分是这四个维度的**确定性等权均分**（保留一位小数），没有题材权重、
没有动态权重、没有学习权重——纯算术，模型自报的 `score` 只作为形状校验的依据，落盘与
响应的永远是重算值。

两个审阅者绝不合成一个「八维大 Prompt」：`BasicReviewer` 与 `CommercialReviewer` 各自
独立的提示词、各自的 parser、各自的产物文件。商业可读性结论**不驱动任何决策**——
`RetryPolicy` 里仍然只有 `min_review_score` 一个总分门槛且只看结构审阅分，修订策略也不看它；
`QualityResult` 仍然只有 Co/N/C/Ca 四个维度，商业分不掺进去。它也不预测市场表现：
没有「爆款概率」「必火」「市场成功率」一类的字段或文案，分数描述的是文本本身可观察的事实。

### Added

- **`CommercialReviewResult` 模型**（`src/types/commercial-review.ts`）：`score`、`summary`、
  `strengths`、`problems`、`suggestions`（四个字符串数组）与 `dimensions`。`dimensions`
  固定四个键 `hook` / `pacing` / `engagement` / `payoff`，各自 `{score: number,
  summary: string}`；模型自己加减维度、分数越界、某个维度没有短评都算输出非法。
  `aggregateCommercialDimensions` 是唯一的分数字源
- **`CommercialReviewer`**（`src/lib/commercial-reviewer.ts`）：StoryConfig + 正文 →
  `prompts/commercial_reviewer.txt` → LLM → `CommercialReviewResult`。温度固定 0.3，
  与结构审阅的 0.3 同级、与生成温度独立。提示词写明「不是文学奖评审、不是结构 Validator、
  不是内容修改器」，四个维度各自的判定口径，以及 Hook ≠ Engagement、Pacing ≠ Narrative
  的边界——审的是读者体验，不断言结构成不成立，也不改写正文
- **`parseCommercialReviewResult`**（`src/lib/commercial-review-parser.ts`）：容错 code fence
  与首尾空白，不做散文 scavenging；拿不到结构合法的 JSON 抛 `CommercialReviewParseError`
- **Pipeline 新阶段 `reviewing_commercial`**（`src/core/pipeline.ts`）：结构审阅之后跑，
  与审阅 / 校验并列，进度写进 metadata
- **`commercial-review.json`**：Run 根目录一份、每个 attempt 目录一份（`repairs/` 下没有——
  一次修订只跑一次商业审阅，改完就取修订后那一版的结论）。运行根那一份由入选 attempt
  提升而来，与入选正文严格同版
- **三个运行级 metadata 字段**：`commercial_review_status`（`not_started` / `reviewing` /
  `completed` / `failed`，与 `review_status` 同口径）、`commercial_score`（四维均分）、
  `commercial_review_error`（**只在审阅者自身失败时**出现——商业分低不算错误）
- **API 字段**：Run 类入口与 Run 详情多 `commercial_review` / `commercial_review_status` /
  `commercial_review_error`，Attempt 详情多 `commercial_review`，`artifacts` 在商业审阅成功
  时多一个 `commercial_review` 键。v1.5.0 之前的 Run 没有这个文件，读出 `null` 与
  `not_started`，磁盘上不会被补写
- **`POST /api/review/commercial`**：与 `POST /api/review` 完全并列的第二个入口，
  请求体同为 `{config, story}`（可选 `run_id`）。带 `run_id` 且该 Run 不存在时 404，
  **不调用模型**、不写任何文件；成功时覆盖该 Run 根目录的 `commercial-review.json`，
  不建立 history
- **新错误码 `COMMERCIAL_REVIEW_FAILED`（502）**：商业可读性审阅拿不到合法的
  `CommercialReviewResult`。它与 `REVIEW_FAILED` 并列而不是合并——两条路各自的失败
  不该被描述成「审阅失败」
- **前端 Commercial Review 面板**（`src/lib/commercial-view.ts` +
  `src/components/commercial-panel.tsx`）：商业分、H/P/E/Pf 四个维度各自的分数与短评、
  优点 / 问题 / 建议三组清单，以及唯一的操作入口「Commercial Review Again」。
  没有 Fix / Retry / 重写一类按钮——这个分数不驱动任何事
- **`prompts/commercial_reviewer.txt`**：四个维度的定义、输出 JSON 的形状与四条硬规则
  （维度一个不能少也不许多、分数 0~100、三个列表必须是字符串数组、`score` 必须与四维
  一致），末尾明确「不要预测市场、销量、读者规模或商业结果」

### Changed

- **生成链路多一道独立的审阅**：结构审阅之后再跑一次商业可读性审阅。这一步自身失败
  （模型超时、输出非法）只把 `commercial_review_status` 置为 `failed`、记下
  `commercial_review_error`，**不写** `commercial-review.json`，也**不**影响正文、
  `validation.json` / `review.json` / `quality.json` 与采纳结论
- **`CommercialReviewer` 是可选的第十二个 Pipeline 构造函数参数**：不注入就完全没有这道
  审阅，`commercial_review_status` 是 `not_started`，流程与 v1.4.1 逐字一致
- **examples/example_run/** 增加两份 `commercial-review.json`（运行根 + `attempts/01/`，
  内容逐字相同）与对应的 metadata 字段（71.5 = (82 + 68 + 74 + 62) / 4），样例 README 同步

### Tests

- 新增 `tests/test_commercial_review.test.ts`（26 条）：schema 边界（缺维度、未知维度、
  分数越界、空短评、顶层 score 缺失或越界）、聚合计法（含 1.3 的四舍五入）、
  `commercialReviewResultOf`（缺文件 / 半份 JSON / 手改成 101 都是 `null`）、
  `parseCommercialReviewResult`（code fence、非 JSON → `CommercialReviewParseError`）、
  `CommercialReviewer`（提示词四个定义、温度 0.3、默认模板路径、模板缺失即抛错、不改输入）
- 新增 `tests/test_commercial_review_pipeline.test.ts`（16 条）：两份产物逐字相同、
  `commercial_score` 落在 metadata 与 artifacts 索引、审阅看到的是该次尝试自己的正文、
  修订后重跑、retry 路径不混用分数、失败隔离（正文 / 校验 / 审阅 / 质量全部保留）、
  非法输出同样隔离、**低商业分不触发重试也不触发修订**、`min_review_score` 只看结构分、
  不注入审阅者时与 v1.4.1 逐字一致
- 新增 `tests/test_commercial_review_ui.test.ts`（17 条）：面板五种状态、四个维度的
  H→P→E→Pf 顺序、只有一个操作入口、市场预测类词汇一个都不出现、`commercialPanelState`
  的百分比钳制、`page.tsx` 接线（重新审阅不带 `run_id` 除非当前展示的就是落盘那一版）
- 新增 `tests/test_commercial_api.test.ts`（14 条）：新路由 200 / 400 / 404 / 502 分支、
  模型自报 `score` 被重算值顶掉、覆盖 `commercial-review.json` 但不碰 `review.json`、
  v1.4.1 的老 Run 读回 `null` + `not_started`、Attempt 详情、`src/lib/api.ts` 客户端接线
- 合同测试同步：`tests/test_contract_artifacts.test.ts` 的文件表与 metadata 必填字段加入
  商业审阅三项；`tests/test_contract_api.test.ts` 的路由清单加入
  `POST /api/review/commercial`、错误码白名单加入 `COMMERCIAL_REVIEW_FAILED`；
  `tests/test_contract_docs.test.ts` 的保留能力清单移出 `CommercialReviewer`，
  并加入「商业分不驱动重试 / 修订」「没有市场预测文案」的边界断言
- **测试总量：1087 passed / 70 files**（1.4.1 为 1012 / 66）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机

### Compatibility

- 1.4.x → 1.5.0 无破坏性变更，也不需要迁移：既有字段、路由、错误码、CLI 参数与产物布局
  一个都没动（新增全是 additive），1.4.x 写的产物可以直接读（`commercial_review` 是
  `null`、`commercial_review_status` 是 `not_started`），1.5.0 写的 Run 回落到 1.4.x
  也只是多一份被忽略的文件与几个被忽略的 metadata 字段
- 没有新的重试或修订触发条件：`min_review_score` 仍然只看结构审阅分，商业可读性分数
  在任何版本都不会改变 attempt 的采纳结论
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.4.1 升级到 1.5.0」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.5.0 的商业可读性审阅」

---

## [1.5.1] —— 2026-09-25

v1.5.1 是一次修订：没有新能力、没有新文件、新字段或新路由，只把 1.5.0 里两处「文档承诺与
实现对不上」的地方改回文档承诺的样子，并修掉连带的文档错误。产物布局、API、CLI、错误码
与 1.5.0 逐字一致，1.5.0 与 1.5.1 写的 Run 可以互相读。

### Fixed

- **失败的 Run 不再谎称商业可读性审阅没跑过**（`src/core/pipeline.ts`）。1.5.0 的失败路径
  无条件写 `commercial_review_status: "not_started"`，于是「第一次尝试商业审阅跑成了、
  第二次尝试生成失败」的 Run，metadata 会声称这一步从没跑过——而
  `attempts/01/commercial-review.json` 就在磁盘上。用一个假状态掩盖已经发生过的一步，
  比少写一个字段更糟：读接口读的是这个字段，前端面板也据此整个隐藏。现在跨 Attempt 记住
  最后一次真实结果（与 v1.1.0 起 `beatCheck` 同一套可变持有者套路），这一步跑成了就是
  `completed`、它自己失败了就是 `failed`、一次都没跑到才是 `not_started`
- **结论本体仍然不写**：失败路径从不执行 promote，运行根目录没有 `commercial-review.json`，
  所以只写状态与错误原因，不带 `commercial_review`。由此 `commercial_score` 与
  `artifacts.commercial_review` 依旧缺席，不会出现「元数据索引一个不存在的文件」这种新谎
- **看非入选 Attempt 时，产物清单里的 `commercial_review` 指到 attempt 目录那份**
  （`src/lib/artifacts-view.ts`）。1.5.0 把 `commercial-review.json` 加进了 promote 清单
  （Run 根与各 attempt 目录各一份），但前端产物清单的前缀规则漏了这个键，于是看
  `attempts/03` 时清单会把入选 Attempt 的商业结论当成当前这一份显示。现在它与
  `story` / `validation` / `review` / `quality` 同一套规则

### Changed

- **`docs/run-artifacts.md` 的 `artifacts` 键序**改成与 `artifactsOf` 的写入序一致：
  `commercial_review` 排在 `quality` 之后，不是之前
- **`commercial_review_status` 与 `beat_validation_status` 的出现条件**改成「必有」：
  两者始终落盘，没跑到时是 `not_started`，不是只有「跑到过」才出现
- **`status` 的阶段清单**补上漏掉的 `created` 与 `validating_beat_plan`，与 `RunStatus`
  逐字一致
- **`docs/api.md` 写清 Run 详情的 `commercial_review_status` 语义**：v1.5.1 起一律取
  metadata 里的真话，「Attempt 跑成过这一步之后 Run 才失败」读回的是 `completed` 配
  `commercial_review: null`；`not_started` 只留给真的从没跑到的那一类 Run（含 1.5.0 之前
  的老 Run）

### Added

- 回归测试 4 条（`tests/test_commercial_review_pipeline.test.ts`，新建
  「失败路径：状态不许谎称这一步没跑过」小节）：跑成过又失败 → `completed` 且不写结论本体；
  商业审阅自身失败后又遇到生成失败 → `failed` 且错误保留；一个 Attempt 都没跑到就失败 →
  仍然是 `not_started`；失败路径的 `error` 文本同样过 safe-text
- `tests/test_ui_artifacts.test.ts` 补 2 条 `commercial_review` 的前缀断言
- [docs/upgrade.md](./docs/upgrade.md) 新增「从 1.5.0 升级到 1.5.1」；README 的升级说明
  与 [docs/compatibility.md](./docs/compatibility.md) 各加一节

### Compatibility

- 1.5.0 → 1.5.1 无破坏性变更，也不需要迁移：既有字段、路由、错误码、CLI 参数与产物布局
  一个都没动，1.5.0 写的产物可以直接读。只有 `metadata.json` 的
  `commercial_review_status` 在失败路径上可能读到不同值（从假的 `not_started` 变成真话），
  这是修 bug 而不是改契约
- **测试总量：1091 passed / 70 files**（1.5.0 为 1087 / 70）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.5.0 升级到 1.5.1」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.5.1 的修订」

---

## [1.5.2] —— 2026-09-25

v1.5.2 是一次界面修订：没有新能力、没有新文件、新字段或新路由，只看界面本身哪里不对。
全部改动集中在 `src/**/*.tsx` 与 `src/app/globals.css` 未涉及的主题 token 使用方式上——
产物布局、API、CLI、错误码与 1.5.1 逐字一致，1.5.1 与 1.5.2 写的 Run 可以互相读。

问题分三类。一类是**浅色模式下整个界面是坏的**：一部分颜色是写死给深色背景用的
（`border-white/10`、`bg-white/[0.03]`、`text-zinc-300`、`bg-zinc-800/60`），在浅色底上
面板边框看不见、卡片底色等于没有、正文浅灰压在近白底上读不清，题材下拉框直接是一块黑。
第二类是**外框不包裹内容**：Story Config 那一列作为 grid 子项被拉到整行高（实测 737px），
而它自己的内容有 1110px，父级又没有设 `overflow`，于是多出的 373px 直接渲染在圆角边框外面。
第三类是**右列根本滚不动**：右列里「生成结果」面板挂着 `flex-1`，在一个
`overflow-y-auto` 的容器里会拿到确定高度，它自己的内容溢出就永远不会变成该容器的滚动高度。
实测右列高 737px，而 Attempts / Quality / Validation / Review / Commercial Review
这些标题排到了 755～2629px——`scrollHeight` 等于 `clientHeight`，一像素都滚不动，
那几块面板渲染出来了却没人能看见。

### Fixed

- **Story Config 外框不再让内容溢出到边框外**（`src/app/page.tsx`）。两列布局改成
  `min-h-0`，左右两列都补 `min-h-0` + `overflow-y-auto`：配置列内容超高时在自己的圆角框内
  滚动，而不是继续往下长、把 CORE STORY / PROTAGONIST / STYLE 三块画到框外。原先右列写的是
  `min-h-[320px]` 且 `overflow: visible`，才会有「框看着只到一半、内容却拖到屏幕外」的效果
- **界面颜色统一改用主题 token，浅色与深色两套主题下都成立**。`border-white/5` /
  `border-white/10` / `border-border/50` 一律换成 `border-border`；`bg-white/[0.02-0.04]` /
  `bg-white/5` / `bg-white/10` / `bg-black/20` 换成 `bg-muted/40` / `bg-muted/50` / `bg-muted`；
  `text-zinc-200` / `text-zinc-300` 换成 `text-foreground`；`bg-zinc-800/60` / `bg-zinc-900`
  换成 `bg-input` / `bg-card`。侧栏也不再为深色单独盖一层 `dark:bg-zinc-900/70` 与
  `dark:border-white/10`——`--border` 与 `--card` 本身已经是两套主题各自的值，再覆盖一遍
  只会让两边都不对
- **原生 `<select>` 的边框在浅色模式下是隐形的**（`src/app/page.tsx`、`src/components/repair-panel.tsx`）。
  `globals.css` 里浅色主题的 `--border` 与 `--input` 是同一个值
  （`oklch(0.92 0.01 280)`），所以「`bg-input` 的底 + `border-input` 的线」这两层互相抵消，
  题材下拉与 Targeted Repair 的 Issue Type 下拉看起来没有边框、像贴在卡片上的一块。
  现在改成与 `src/components/ui/input.tsx` 完全一致的输入态：`border-input` 配
  `bg-transparent`、只在深色下垫 `dark:bg-input/30`，焦点环也从写死的
  `focus:ring-violet-500/30` 换成 `focus-visible:ring-ring/50`，不再跟主题打架
- **右列结果区现在能滚到底**（`src/app/page.tsx`）。「生成结果」面板从
  `flex-1 min-h-[280px]` 改成 `grow shrink-0`：`flex-basis` 回到 `auto`，按内容量出高度，
  没有结果时用 `grow` 把剩下的空间填满、不会塌成一条标题栏，有结果时靠 `shrink-0`
  顶住不被压缩——内容溢出右列的圆角框时由右列自己滚动，Attempts / Repair Applied /
  Manual Targeted Repair / Quality / Validation / Review / Commercial Review 全部可达。
  同时把正文那个 `<ScrollArea>` 上的 `h-full` 去掉，右列只保留一个滚动面，
  不再出现「外层滚不动、里层 156px 的小窗口里塞 2982px 内容」的双层滚动
- **嵌套圆角不再错档**。外层 `rounded-3xl`（33.6px）里套 `rounded-2xl`（27.2px）、而内缩只有
  20px——内圆角应当小于「外圆角减内缩量」，否则两段弧线在拐角处打架。CORE STORY /
  PROTAGONIST / STYLE 三块内嵌面板改为 `rounded-lg`，与 12px 的间距对齐
- **强调色的浅色档补上 dark: 前缀**。`text-violet-300` / `text-emerald-400` 一类 300/400 档
  在浅色底上对比不足，统一改成「浅色用 600 档、深色用 dark:300 档」的成对写法，与
  `globals.css` 的两套 token 对齐

### Added

- **新增回归测试 `tests/test_ui_theme_tokens.test.ts`**（13 个用例），把上面每一条钉住：
  源码里不许再出现写死的白 / 锌色边框与底色、`bg-black/*` 只允许出现在整屏遮罩上、
  300/400 档强调色必须带 `dark:` 前缀、两列主工作区必须同时有 `min-h-0` 与
  `overflow-y-auto`、三个内嵌面板必须用 `rounded-lg`、原生 select 必须用输入态 token
  （`border-input` 配 `bg-transparent`，浅色下不许出现 `bg-input`、「生成结果」面板必须是
  `grow shrink-0` 而不是 `flex-1`、正文滚动区不许写死高度）。
  拿 1.5.1 的源码跑这批断言会红 37 处，1.5.2 为 0

### Notes

- **测试总量：1104 passed / 71 files**（1.5.1 为 1091 / 70）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机
- 界面之外一行代码没动：`src/core`、`src/lib`、`src/storage`、`src/app/api`、`scripts/`
  与全部产物字段均与 1.5.1 一致，本次发布不涉及任何数据迁移
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.5.1 升级到 1.5.2」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.5.2 的界面修订」

---

## [1.3.0] —— 2026-09-24

v1.3.0 给审阅结论加了**四个基础质量维度**（连贯性 / 叙事 / 人物 / 因果），让同一篇正文的质量
不只由一个整体分表达。它仍然不新增任何决策：整体分在有维度时就是四维均分（纯算术、无权重），
`RetryPolicy` 里仍然只有 `min_review_score` 一个总分门槛，修订策略仍然只按问题类别改一次。
全部改动 additive：既有字段、路由、错误码、CLI 参数与产物布局一个都没动。

### Added

- **`QualityDimensions` 维度模型**（`src/types/quality-dimensions.ts`）：四个键
  `coherence` / `narrative` / `character` / `causality`，各自 `{score: number, summary: string}`，
  附中文标签与定义口径，以及确定性聚合 `aggregateDimensionScore`（四维均分，
  四舍五入到 1 位小数）。没有权重、没有模型调用、没有随机
- **`ReviewResult.dimensions`（可选）**：审阅者除了整体分，还给四个维度各打一个 0–100 分
  并附一句短评。一旦出现就必须四个齐全、各自 0–100 且带非空短评——缺维度、多维度
  （模型自己扩到 35 维也一样）、分数越界都按审阅输出非法处理（`REVIEW_FAILED`），
  不补 0、不挑一个先凑着。缺失或显式 `null` 时整个键不出现，与 v1.0 ~ v1.2.x 逐字一致
- **`QualityResult.dimensions`（可选）**：由 `ReviewResult.dimensions` 原样搬运到
  `quality.json`、Run / Attempt 读回接口与前端面板；装配逻辑不加判断、不重新打分
- **前端「维度评分」小节**（`src/lib/quality-view.ts` + `src/components/quality-panel.tsx`）：
  四个进度条 + 各自短评，固定顺序，与整体分同一个口径；没有维度（旧 Run）时整节不渲染
- **prompts/reviewer.txt 的四维要求**：四个维度的定义口径（含「连贯性管前后一致、
  因果管推得动」这条区分）、0–100 + 一句短评的输出格式、禁止增加第五个维度、
  禁止商业价值一类指标；占位符白名单不变，没有新增占位符

### Changed

- **`overall_score` 的口径**：有维度时等于四维均分，没有维度时仍等于 `review.score`。
  各级 metadata 的 `review_score` / `before_review_score` / `after_review_score` 与它同一个口径
  （`src/types/review-result.ts` 的 `reviewOverallScore` 是唯一实现），
  所以同一个 Run 在不同接口看到的整体分还是同一个数
- **重试门槛比的仍是整体分**（`src/core/retry-policy.ts`）：`min_review_score` 一个门槛，
  比的是 `reviewOverallScore`，不是任何一个单独维度；`RetryPolicy` 字段集不变，
  没有 `min_causality_score` 一类字段

### Tests

- 新增 `tests/test_quality_dimensions.test.ts`（34 条）：维度模型与四个键的固定顺序、
  确定性聚合（含 80/76/72/66 → 73.5 的例题）、可选维度与旧格式逐字兼容、缺维度 / 多维度 /
  越界 / 空短评全部按解析失败、解析路径（含 code fence）、`QualityAssembler` 透传、
  `quality.json` 容错（坏维度只丢维度不丢快照）、重试门槛只认整体分（70/68/67/67 → 68 < 70）、
  提示词口径（四维定义、连贯性≠因果、不新增占位符、禁商业词）、产物不回带路径或凭据
- 新增 `tests/test_quality_dimensions_pipeline.test.ts`（5 条）：维度在真实管道里一路带到
  `quality.json` 与 metadata（happy path / retry path / 修复路径），修订后取新的四个维度，
  没有维度时与 v1.2.x 逐字一致
- `tests/test_quality_ui.test.ts` 改写 §34 的防泄漏用例（改为拦趋势 / 雷达 / PASS·FAIL /
  基准 / 实验一类更远期能力，并补「面板上没有重试 / 修订入口」），新增维度渲染用例
- **测试总量：919 passed / 61 files**（1.2.1 为 875 / 59）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机

### Compatibility

- 1.2.x → 1.3.0 无破坏性变更，也不需要迁移：没有 `dimensions` 的 Run（1.3.0 之前生成的全部 Run）
  读出来与当年一致，多出来的字段会被 1.2.x 安全忽略；`quality.json` 里维度形状不对时按
  「没有维度」处理，不退化成 500
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.2.x 升级到 1.3.0」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.3.0 的四个基础维度」

---

## [1.2.1] —— 2026-09-24

v1.2.1 是**修订版本**：没有新能力、没有新文件、没有改字段、没有改路由、没有改产物布局。
修的是 v1.2.0 一处「同一口径没走到底」的问题，顺带订正三处文档与一处已发布 Release 的笔误。

### Fixed

- **旧 Run 的质量兜底装配改取修订后的结论**（与落盘的 `quality.json` 同口径）。v1.2.0 落盘的
  `quality.json` 取的是修订后那一轮，但**没有**这个文件的 Run（v1.2.0 之前生成的全部 Run）
  在读取时临时装配读的却是 attempt 目录下的首次结论。于是同一个发生过修订的旧 Run 自相矛盾：
  `metadata.json` 的 `review_score` 是 82、`repairs[].after_review_score` 是 82，
  接口给的 `quality.overall_score` 却是 41（描述的是修订前那版正文）。Run 根目录那份
  `quality.json` 丢了而 attempt 那份还在时，Run 详情与 Attempt 详情还会给出两个不同分数。
  v1.2.1 起三级兜底，每一级都是「这次尝试最终留下的那一版正文」：运行根的 `quality.json`
  → 入选 Attempt 自己的 `quality.json` → 从最终结论临时装配（发生过修订时取最后一次真正跑过
  校验 / 审阅的 `repairs/MM/` 里的那两份，修订调用本身失败时不写这两个文件，于是继续往前找，
  一次修订都没跑通才回落到 attempt 目录下的首次结论）。实现见
  `src/lib/generate-service.ts` 的 `finalCheckOf` 与 `ArtifactStore.readRepairValidation` /
  `readRepairReview`
- **`docs/run-artifacts.md` 的自相矛盾**：统一质量快照一段原先把快照写成由「首次校验结论 +
  首次审阅结论」装配，与同文件下一段「取修订后的结论」相反，已改为最终结论口径并写明兜底规则
- **测试文件数写错**：README、`CHANGELOG.md` 与 1.2.0 Release 的质量测试文件都写的五个，
  实际新增六个（漏了 `tests/test_quality_compat.test.ts`），三处一并订正；1.2.0 Release 只订正
  这一处表格，其余内容与测试总量数字不变

### Security

- 本次改动没有扩大任何攻击面：`quality.json` 与兜底装配都只读既有产物，不新增外部输入路径、
  不引入凭据。请求体 `baseUrl` 的公网地址关卡（v1.1.0 / v1.1.1 的口径）原样未动，回归测试仍在

### Tests

- `tests/test_quality_compat.test.ts` 新增 8 条回归：修订后那一轮的结论被用来装配（分数与
  `metadata.review_score` / `repairs[].after_review_score` 一致）、多轮修订取最后一次真正跑过
  校验 / 审阅的那一轮、修订彻底失败时回落首次结论、运行根快照缺失而 attempt 那份还在时
  Run 详情与 Attempt 详情一致、临时装配结果与 `QualityAssembler` 直接装配逐字节相同，
  以及 `quality.json` 语法坏 / 分数越界 / 顶层是数组 / 读接口不把服务器路径带进响应、
  不往磁盘补写文件
- **测试总量：875 passed / 59 files**（1.2.0 为 867 / 59）。全部用例仍只用假模型 / 假组件，
  不调真实接口、不碰真实主机

### Compatibility

- 1.2.0 → 1.2.1 无破坏性变更，也不需要迁移：v1.2.0 落盘过 `quality.json` 的 Run 读取结果
  一个字节都没变（前两级兜底优先）；受影响的只有旧 Run 的 `quality` 字段，改回 v1.2.0 承诺的
  口径。读接口依旧不写盘、不 500，`quality` 最差是 `null`
- 明细见 [docs/upgrade.md](./docs/upgrade.md) 的「从 1.2.0 升级到 1.2.1」与
  [docs/compatibility.md](./docs/compatibility.md) 的「v1.2.1 对同一条口径的修正」

---

## [1.2.0] —— 2026-09-24

v1.2.0 是**质量工程基础版本**：第一次把散落在 `validation.json` / `review.json` /
`metadata.json` / API 响应里的质量结论收口成一份统一快照。没有引入任何新的打分能力——
`QualityAssembler` 不调用模型、不产生新分数，读的三样东西（校验结论、审阅结论、采纳结论）
在 v1.2.0 之前就全都在产物里了。全部改动 additive：既有字段、路由、错误码、CLI 参数与
产物布局一个都没动。

### Added

- **`QualityResult` 统一质量模型**（`src/types/quality.ts`）：`overall_score`（单一整体分，
  取 `review.score`，没有审阅结论时为 `null`）、`validation_passed`（`true` / `false` /
  校验没跑时的 `null`）、`accepted`、`issues`（`QualityIssue[]`）、`suggestions`
  （`QualitySuggestion[]`）、`summary`。没有维度分、没有等级、没有 PASS/FAIL 阈值
- **`QualityAssembler`**（`src/core/quality-assembler.ts`）：纯函数，把校验结论、审阅结论与
  采纳结论确定性装配成 `QualityResult`；同一输入永远得到同一份 JSON，不调模型、无随机。
  问题 id 固定为 `validation-N` / `review-N` / `review-suggestion-N`（N 从 1 起按同类序号）
- **`quality.json` 产物**（Run 根与 `attempts/NN/` 各一份）：见 `ArtifactStore.putQuality` /
  `putAttemptQuality`，与 `validation.json` 等同为 UTF-8 JSON、两空格缩进；
  与同层 metadata 的 `overall_score` / `quality_issue_count` 同口径（都取**修订后**的结论，
  与最终采用的 `story.md` 对齐）。修订目录 `attempts/NN/repairs/MM/` 里**没有**这个文件
- **Run 与 Attempt metadata 的三个新字段**：`quality_assembly_status`（`completed`）、
  `overall_score`、`quality_issue_count`。刻意不复用 `quality_status`（那个字段已经表示
  accepted / exhausted），三个字段同样取修订后的结论
- **API 响应新增 `quality`**：Run 类入口（`/api/runs`、`/api/runs/from-plan`、`/api/generate`）、
  `GET /api/runs/<run_id>`、`GET /api/runs/<run_id>/attempts/<attempt_number>` 各加一个
  `QualityResult | null`；`artifacts` 在质量装配成功时追加 `quality` 键。其余字段逐字不变
- **`ReviewResult` 的可选 `suggestions`**（`prompts/reviewer.txt` 同步要求输出一组建议）：
  模型没给时响应与落盘里这个键整个不出现，与 v1.0 / v1.1 的结构逐字一致
- **前端 Quality Summary 面板**（`src/components/quality-panel.tsx` + `src/lib/quality-view.ts`）：
  总览一个整体分 + 校验状态 + 采纳状态 + 问题/建议计数，只做汇总，不带 Fix / Retry /
  重写一类操作入口；`quality` 缺失时整个区域不出现，不占位也不白屏
- **旧 Run 兼容读**：没有 `quality.json` 的 Run（v1.2.0 之前生成的全部 Run）读取时按同一套
  规则临时装配，读响应与读详情都不会因此失败，也不会回写文件；`quality.json` 解析失败或字段
  不合规时同样退回临时装配，退化的 worst case 是 `quality: null`
- **`examples/example_run/` 升级为 v1.2.0 布局**：运行根与 `attempts/01/` 各新增一份
  `quality.json`，metadata 补齐三个新字段；`attempts/01/review.json` 刻意保留 v1.1 的四键
  形状（没有 `suggestions`），用来演示「旧结论也能被装配」

### Changed

- 质量信息从「分散在三处、口径还不完全一致」改为**一个 additive 的统一模型**对外：
  响应读 `quality` 字段、磁盘读 `quality.json`，两者内容一致
- 入选 Attempt 的提升文件集合新增 `quality.json`（`promoteAttempt` 从三个文件变成四个）
- README 定位改为「从 v1.2.0 开始建立统一质量工程层」，并补 QualityResult 架构图与已知限制

### Security

- v1.1.0 / v1.1.1 的地址关卡（请求体 `baseUrl` 只允许公网地址、服务端与 CLI 按受信输入处理）
  在 v1.2.0 **原样保留**，并新增服务层回归测试：注入假组件的 `startRun` 对
  `http://127.0.0.1:9999/v1`、`http://localhost:9999/v1`、`http://192.168.1.10:9999/v1`
  一律 400（`tests/test_quality_api.test.ts`）。本次改动未扩大任何攻击面：`quality.json`
  只是既有结论的汇总，不含新的外部输入路径，也不含任何凭据

### Documentation

- `docs/run-artifacts.md`：新增 `quality.json` 两处布局、运行级与 attempt 级字段表各三行新字段，
  以及「统一质量快照（v1.2.0）」一节（说明为何取修订后结论、为何修订目录里没有它）
- `docs/api.md`：Run 类入口字段表新增 `quality`，补 `QualityResult` / `QualityIssue` /
  `QualitySuggestion` 与 `ReviewResult.suggestions` 的字段说明，并写明三处响应的分数口径
- `docs/compatibility.md`：新增「v1.2.0 的统一质量层（纯 additive）」，逐条对上 1.x 的承诺；
  已知不对称第 5 条补充 `quality.json` 的口径
- `docs/upgrade.md`：新增「从 1.1.x 升级到 1.2.0」，升级操作与回滚同步到 1.2.0

### Tests

- 新增六个测试文件（全部用假模型 / 假组件，不调真实接口）：
  - `tests/test_quality_assembler.test.ts`：四种装配情形、suggestions 映射、确定性（同输入
    JSON 逐字节相同）、不修改入参、键集固定且不含维度词
  - `tests/test_quality_models.test.ts`：`qualityResultOf` 的容错解析——只有
    `overall_score` / `validation_passed` / `accepted` 三个字段会让整份快照作废，
    `summary` / `issues` / `suggestions` 一律按丢弃处理
  - `tests/test_quality_compat.test.ts`：三类旧资产原样可读——没有 `suggestions` 的旧
    `review.json`、没有 `quality.json` 的旧 Run（v1.1.1 形状）、仓库里的
    `examples/example_run`；读接口不 500、不补写文件、不把服务器路径带进响应
  - `tests/test_quality_pipeline.test.ts`：落盘与内存返回值逐字节一致、多次运行 JSON 稳定、
    重试与修订路径的快照、组件自身异常时快照仍落盘
  - `tests/test_quality_api.test.ts`：Run / Run 详情 / Attempt 详情三处口径一致、旧 Run
    无 `quality.json` 时临时装配、`quality.json` 损坏或被删后的降级、地址关卡回归
  - `tests/test_quality_ui.test.ts`：QualitySummary 面板的状态推导（分数缺失、校验三种状态、
    采纳两态、`quality` 为 null 时整体隐藏），并断言不出现多维 / 趋势 / 等级一类措辞
- 存量合同测试同步 additive 字段：`artifacts` 键集、文件清单、metadata 键集与若干用例标题

### Compatibility

- 1.1.x → 1.2.0 无破坏性变更、无行为变更：v1.1.1 写的产物 v1.2.0 直接读；
  v1.2.0 写的 Run 回落到 1.1.x 也只是多一个被忽略的文件。详见 [docs/upgrade.md](./docs/upgrade.md)
- 一处刻意保留的不对称：`quality.json` 取**修订后**的结论，而同目录 `review.json` 是**首次**
  结论。这让快照与 metadata、与最终采用的正文同口径，代价是同一层里两个文件的分数可能不同。
  见 [docs/compatibility.md](./docs/compatibility.md) 已知不对称第 5 条

---

## [1.1.1] —— 2026-09-24

v1.1.1 是**修订版本**：没有新能力，只修 v1.1.0 那道地址关卡自身的问题。
约束方向不变（请求体 `baseUrl` 仍然只允许公网地址），产物布局、字段、错误码与 1.1.0 逐字一致。

### Fixed

- **CLI 的 `--base-url` 不再被自己挡**。v1.1.0 把关卡接到服务层的四个入口上，CLI 的 `plan`
  因为没走服务层而绕过了它，`run` / `review` / `repair` 却都被拦住——同一条命令集里三个子命令拦、
  一个不拦，而且 `docs/cli.md` 没写 `--base-url` 也受影响。现在 CLI 与 `LLM_BASE_URL` 同级
  （都是本机受信配置：能跑这条命令的人本来就读得到 `.env`），四个子命令统一按受信输入处理，
  请求体里不再带 `baseUrl`，客户端由唯一的 `cliClient` 构建。「CLI 指向本地假模型」恢复可用；
  走 HTTP 的调用方行为完全不变
- **内嵌 IPv4 的 IPv6 地址改判为按内嵌地址判**。v1.1.0 匹配点分文本的分支因为 WHATWG URL
  会把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]` 而永远走不到：环回是被后一个分支的
  fail-closed 挡下的（行为仍然安全），但合法的公网 mapped 地址也被一起误拒。
  现在从地址最后两段取内嵌 IPv4，`::ffff:0:0/96`（IPv4-mapped）与 `64:ff9b::/96`（NAT64）
  都按它判，另补上 `fec0::/10`（站点本地）与 `2002::/16`（6to4 中继）两段——禁令清单只增不减
- `UnsafeRequestUrlError` 不再借用 `RequestValidationError` 作为运行时 `name`（类名与日志里
  的错误名不一致）。对外的 `error.code`（`CONFIG_INVALID`）与 400 状态码不变

### Documentation

- `docs/api.md`：「`baseUrl` 覆盖的地址限制」补全 IPv6 规则，并新增「已知限制：校验只覆盖
  第一次解析」——**重定向**与 **DNS rebinding** 两条路径当前没有堵死，写清楚以免误以为已经堵上
- `docs/cli.md`：新增「`--base-url` 的信任级」，说明 CLI 与请求体的差别及回归测试位置
- `docs/compatibility.md`：新增「v1.1.1 对同一道关卡的修正」
- `docs/upgrade.md`：新增「从 1.1.0 升级到 1.1.1」

### Tests

- `tests/test_cli.test.ts` 新增「v1.1.1 CLI 入口的 baseUrl 信任级」：`plan` / `run` / `review`
  指向本机地址时结局一致（因为连不上而失败，而不是被地址关卡拒掉），并守住「客户端只有一个
  构建点、请求体不带 baseUrl」
- `tests/test_url_guard.test.ts` 补 mapped / NAT64 / 站点本地 / 6to4 四类地址的判定，
  以及「内嵌公网 IPv4 的 mapped 地址要放行」；错误名用例改为核对类名与 `name` 一致
- `tests/test_api_error.test.ts` 的用户错误名清单同步换成 `UnsafeRequestUrlError`

---

## [1.1.0] —— 2026-09-23

v1.1.0 是**安全收紧版本**：堵掉「请求体 `baseUrl` 覆盖」这条会把服务端 `LLM_API_KEY`
带出内网的路径。除此之外没有新增能力，产物布局、字段、CLI 与 1.0.1 逐字一致。

### Changed

- **请求体里的 `baseUrl` 覆盖现在只允许 http/https 的公网地址**（新增 `src/lib/url-guard.ts`）。
  服务端是拿着 `LLM_API_KEY` 作为 Bearer token 去请求这个地址的（`clientFromEnv`），
  而 `POST /api/plan`、Run 类入口、`/api/review`、`/api/repair`、`/api/prompt/preview` 都允许
  请求体覆盖它。地址不受限时，任何能访问到本服务的人都能让服务端把密钥发到任意主机，
  或者借本服务摸 `169.254.169.254` 一类的云元数据地址与 localhost 上的其它服务。
  放行前先校验：协议只允许 `http` / `https`；拒绝本机名（`localhost`、`*.localhost`、
  `.local`、`.internal`）、IPv4/IPv6 环回、三段私网、链路本地（含云元数据地址）与其它保留段；
  域名还要解析出地址后再判一遍，解析失败按拒绝处理（验不了就不放行）。
  不合法的值在**发出任何请求之前**返回 400 `CONFIG_INVALID`
- 组装 Pipeline 的 `buildPipeline` 变为 async（内部调用点同步调整；对外行为不变）

### Security

- **凭据外泄与 SSRF**：上述 `baseUrl` 覆盖原先可以指向任意主机，包括内网与云元数据地址。
  v1.0.0 / v1.0.1 里这把钥匙通常只是个 mock 值，所以长期没有暴露；一旦 `.env` 里配上真实
  `LLM_API_KEY`（本机已配），这条路径就是可用的凭据外泄通道，故在 1.1.0 收紧
- 服务端自己的 `LLM_BASE_URL` 是运维的受信配置，**不**受这套规则约束，
  「服务端指向本地假模型」的联调用法照旧可用；测试注入假 LLM 时这个字段根本不参与组网

### Added

- `tests/test_url_guard.test.ts`：27 条用例覆盖协议、本机名、环回、私网、保留段、
  IPv4-mapped IPv6、域名解析到私网、解析失败，以及服务层接线（拒绝时 `fetch` 一次都没被调用）。
  域名解析用注入的假解析器，不真的查 DNS，也不碰真实主机

### Compatibility

- 唯一的行为变化：请求体里带非公网 `baseUrl` 的请求，从 1.0.1 的「照常执行」变成 400。
  需要指向本地 mock 的话，把地址写在服务端 `LLM_BASE_URL` 里（`docs/api.md` 有迁移说明）
- 本次收紧按兼容性策略本该先发一个「只告警」的次版本，没有这么做：那会让一条可用的凭据外泄
  路径多活一个发布周期，代价比「少数联调用法要改一处配置」高。这条取舍记录在
  `docs/compatibility.md`

---

## [1.0.1] —— 2026-09-23

v1.0.1 是**文档订正版本**：不改任何运行行为，只把 1.0.0 的文档与真实产物对齐，
并补一道防止再次走样的门禁。能力边界、产物布局、API、CLI 与 1.0.0 逐字一致。

### Fixed

- **`docs/run-artifacts.md` 的三张 metadata 字段表不完整**：运行级只列了 13 个字段，
  实际落盘 24 个（缺 `current_stage`、四个策略回显字段、`validation_passed` /
  `validation_issue_count` / `review_score`、`validation_error` / `review_error`、`error`）；
  attempt 级漏了 `validation_error` / `review_error` 两个条件字段；
  repair 级多写了一个从不落盘的 `issue_message`（它属于同目录的 `request.json`）
- **`docs/run-artifacts.md` 对 `validation.json` / `review.json` 的标注不准确**：
  原文写「最终入选版本的校验 / 审阅结果」，实际这两份文件（各级目录下都是）是
  **首次**结论，修订后的那份在 `attempts/NN/repairs/MM/` 里；而 metadata 与 API 里的
  分数取**修订后**的结论。现在文档、README、`docs/api.md`、`docs/compatibility.md`
  都把这处刻意的不对称写清楚了
- **README 的运行级字段清单多了一个字段**：`retry_on_validation_failure` 是 RetryPolicy
  的字段，从不写进运行级 metadata，已从清单删除
- **`package-lock.json` 的根版本号还停在 `0.0.1`**（`packages[""].version`，v1.0.0 发布时
  只改了外层 `version`），已同步到 1.0.1
- **CLI 帮助横幅的版本号是写死的**：`scripts/generate-cli.ts` 现在与其它入口一样从
  `VERSION` 文件读（`projectVersion()`），改版本号不用再动源码

### Added

- **`tests/test_contract_docs_sync.test.ts`**：文档字段表 ↔ 真实产物的双向对照合同测试。
  跑五条真实路径的 Pipeline（成功 / 修订后接受 / 重试耗尽 / 生成失败 / 校验与审阅组件自身异常，
  只有 LLM 和这两个组件是假的），把各层 metadata 实际出现的键与文档表格逐个字段比对：
  文档多写、漏写、改名都会红，新增 metadata 字段也会因为「没写进文档」而红

### Compatibility

- 1.0.0 → 1.0.1 无破坏性变更，无行为变更；读到 1.0.0 与 1.0.1 产物的代码无需任何改动。
  详见 [docs/upgrade.md](./docs/upgrade.md)

---

## [1.0.0] —— 2026-09-22

v1.0.0 是**冻结版本**，不是功能版本：没有新增任何质量智能，能力边界与 v0.9.1 逐字一致。
它做的是把已有能力写成公开契约，并用合同测试与文档看守这些契约。

### Added

- **七份契约文档**（`docs/`）：`story-config.md`、`beat-plan.md`、`run-artifacts.md`、
  `api.md`、`cli.md`、`upgrade.md`、`compatibility.md`
- **`examples/example_run/`**：用假模型跑出的一次完整 Run 产物（时间戳写死），
  与线上布局逐字节同构，仓库里唯一入库的 Run 样例
- **六组合同测试**（合计 80+ 用例）：StoryConfig v1、BeatPlan v1、Run 产物布局与三层 metadata、
  HTTP API 路由清单与字段集、CLI 命令与退出码、README / docs / 版本一致性发布门禁
- **README 重定位**为稳定生成引擎：补「已知限制」「升级说明」「兼容性」章节，逐条列出刻意不做的事

### Changed

- 运行级 metadata 的 `model` **始终存在**（此前按请求是否显式传 `model` 而有无），
  值为「本次真正生效的模型」：请求覆盖 → 环境变量 → 缺省值
- attempt 级 metadata 的 `error` **始终存在**（此前按条件写），没有错误时是 `null`，
  让「缺字段」与「没错误」可以区分
- `src/lib/version.ts` 的 `FALLBACK_VERSION`、`package.json` 版本、CLI 横幅同步到 1.0.0，
  版本号仍然只有一个真源（`VERSION` 文件）

### Fixed

- CLI 的 `--temperature`（以及 `--max-attempts` / `--min-score` / `--max-repairs`）
  解析不出有限数时按参数错误处理（退出码 2），不再被静默丢掉后拖成运行时失败（退出码 1）

### Compatibility

- 0.9.x → 1.0.0 无破坏性变更；两条字段语义变化都是「从可能没有变成一定有」，
  旧读取方只会忽略新出现的字段。详见 [docs/upgrade.md](./docs/upgrade.md)

---

## [0.9.1] —— 2026-09-22

### Added

- 错误文本净化入口 `src/lib/safe-text.ts`：绝对路径替换为 `<path>`、凭据打码，规则只此一份，
  `src/lib/api-error.ts` 与 `src/core/pipeline.ts` 共用，不再各写一套正则（v0.9.0 两份正则不一致，
  其中一份还会误擦除相对文件名）
- 泄漏回归测试（`tests/test_safe_text.test.ts`、`tests/test_validation_api.test.ts` 等）：
  用一个真的会失败的写操作（把 `<run>/.validation.json.tmp` 占成目录）验证响应干净，
  不用 mock；全部断言落在原始 `message` 字符串上

### Fixed

- 【安全】`/api/validate` 与 `/api/review` 的失败响应泄漏服务器绝对路径：v0.9.0 让
  `ArtifactWriteError` 把 `cause.message` 原样拼进消息，而 node:fs 的异常文本带完整路径。
  现在这条消息只保留 Run 内相对文件名与 fs 失败码（如 `EACCES open`），不带路径。
  v0.9.0 的 CHANGELOG 声称「只带 Run 内相对文件名 / 不再让服务器绝对路径外泄」——那两句当时并不成立，
  本版本才真正做到
- 【安全】未预期异常的原文透出：`INTERNAL_ERROR` 此前把原始异常 message 拼进响应，
  现在固定为一句「服务器内部错误」，原始异常只进服务端技术日志
- 【正确】错误码被上层阶段信息覆盖：`toApiError` 把 `e instanceof PipelineError` 排在具体异常之前，
  主链路上抛的一切都先命中阶段壳，导致写盘失败报成 `GENERATION_FAILED`（502）而不是
  `ARTIFACT_WRITE_FAILED`（500），`BeatParseError` / `ReviewParseError` 的专属分支全是死码。
  分支顺序调整为「具体异常优先，阶段壳兜底」
- 【正确】错误文本净化误擦除相对文件名：旧正则任何 `x/y/z` 都匹配，
  `attempts/01/story.md` 被改成 `attempts<path>`。新正则要求绝对路径前面只能是
  空白 / 引号 / 括号 / 冒号 / 行首，紧跟普通字符的斜杠不再被当成路径分隔符
- 【测试】两个泄漏守卫测试是瞎的：它们断言 `JSON.stringify(body).not.toContain(path)`，
  而 stringify 会把路径里的 `\` 转义成 `\\`，待匹配字符串没转义，两边永远对不上——
  断言恒绿的同时响应里带着完整绝对路径。两处已改为断言原始 `message`

> **这是一个修订版本，不是功能版本。** v0.9.1 没有新增任何质量智能，也没有新增任何用户可见能力：
> 它只修 v0.9.0 自己引入的两处信息泄漏、一处错误码错判、一处正则误伤，以及一对恒绿的假守卫。
> 能力边界与 v0.9.0 完全一致，文档里早就写明的承诺（错误响应不带绝对路径、
> `ArtifactWriteError` 只带相对文件名）从这一版起由测试真正守护。

---

## [Unreleased]

### Changed

- 版本 tag 由 `v0.x.x` 改为 `0.x.x`（`0.0.1` ~ `0.6.0`）。GitHub Releases 页按 release 创建时间倒序排列，
  而创建时间取自 annotated tag 的 tagger 时间且无法通过接口修改；原 `v0.0.1` / `v0.2.0` 两个 tag 的
  tagger 时间晚于 `v0.4.0`，导致页面版本顺序错乱。改用新 tag 名并将各 tag 的 tagger 时间对齐到其
  commit 时间后，Releases 页顺序与版本号一致。Release 标题仍带 `v` 前缀（如 `v0.6.0 — Story Validator`）。
  Release URL 相应变为 `…/releases/tag/0.6.0`

### Fixed

- About 页版本说明仍写作「初始公开原型」并声称规划尚未包含，与 v0.3.0 起已具备的 Beat 规划不符；改为按当前版本实际能力描述（规划已具备，评审 / 校验 / 修复 / 重试 / 实验 / 基准 / 自适应尚未包含）
- About 页副标题与页面 metadata 的「生成原型」统一为「生成器」，与 README 一致

---

## [0.9.0] —— 2026-09-22

### Added

- Unified application configuration（`src/lib/app-config.ts`）：Application 与 LLM 两类设置各自单一来源，
  优先级固定为「请求覆盖 > 环境变量 > 默认值」，API Key 不出现在配置层
- Consistent runtime error responses（`src/lib/api-error.ts`）：全部 API 失败统一为
  `{error:{code,message,run_id?,stage?}}`，11 个稳定错误码，用户错误 4xx、运行时错误 5xx，响应不含堆栈
- Structured logging with Run IDs（`src/lib/logger.ts`）：DEBUG / INFO / WARNING / ERROR 四级，
  日志带 run / attempt / repair 上下文前缀，密钥自动脱敏；Pipeline 的散落 console 全部改为结构化日志
- Hardened LLM timeout and transport retry behavior：`LLMTimeoutError` / `LLMRequestError`，
  transport retry 硬上限 2 次（单次 LLM 调用最多 3 个请求），只重试 timeout / 429 / 临时 5xx
- Stable CLI behavior：`--help` / `-h`、退出码 0（业务收尾）/ 1（运行时失败）/ 2（参数或配置非法）、
  `repair` 子命令；CLI 只调用共享服务，不再有自己的重试 / 修订实现
- Shared test fixtures and FakeLLM support（`tests/helpers/fixtures.ts`）：样例配置 / BeatPlan / 正文 /
  审阅结论 + `FakeLLM` + `apiErrorOf` + `repoVersion` + `withTmpDir`
- End-to-end pipeline integration tests（`tests/test_pipeline_integration.test.ts`）：只桩掉 HTTP 传输层，
  真实跑完 StoryConfig → Plan → Generate → Validate → Review →（可选 Repair / Retry）→ 产物落盘
- Release-readiness and security checks：CLI 行为、metadata schema、前端加载 / 错误 / 禁用态测试

### Changed

- Standardized run, attempt and repair artifact metadata：run / attempt / repair 三层 metadata 字段收口，
  `project_version` 改由 VERSION 文件单一真源提供（`src/lib/version.ts`）
- Standardized artifact filenames and directory structure：选中 Attempt 的产物提升改为按固定文件名集合遍历，
  路径解析统一走 `resolveInRun`
- Consolidated frontend API error handling：`src/lib/api.ts` 全部导出函数收敛到单一 `requestJson` 出口，
  网络 / 超时 / 非法响应 / API 错误统一成 `RunApiError`（含 `kind`）
- Improved configuration validation：`ConfigValidationError` 与 JSON 解析失败分离，CLI 与 API 共用同一套解析
- Improved README and environment setup documentation：README 改为只描述当前版本真实具备的能力，
  `.env.example` 补齐 `LLM_TIMEOUT` / `LOG_LEVEL` / `RUNS_DIR`
- Reduced duplicate orchestration across API and CLI：CLI 的 run / plan / review / validate / repair
  全部走 `src/lib/generate-service.ts` 的同一批函数

### Fixed

- Inconsistent error handling across generation stages：各阶段异常统一收敛为带 stage 的安全错误信息，
  不再让堆栈或服务器绝对路径外泄
- Potential duplicate request actions in the UI：Generate / Plan / Validate / Review / Repair 的
  「正在请求」判断改用 ref 同步挡住，快速双击不会发出第二个请求
- Path and UTF-8 handling inconsistencies：产物读写全部显式 `utf8`，写入失败统一抛 `ArtifactWriteError`
  （只带 Run 内相对文件名），不再让磁盘错误以裸 `Error` 形式冒出去
- Run artifact edge cases：`mkdirSync` / `copyFileSync` / `renameSync` 失败与「产物目录不存在」被单独覆盖，
  失败时已写出的产物不被删除

> **这是一个加固版本，不是功能版本。** v0.9.0 没有新增任何质量智能：没有多维评审、没有 Beat 校验、
> 没有商业审阅、没有实验、没有基准、没有高级可观测性、没有失败归因、没有因果图、没有自适应生成、
> 没有自优化。变化全部落在横切工程能力上——已有模块更可靠、已有流程更一致、已有行为更可测试、
> 已有产物更稳定。能力边界与 v0.8.0 完全一致。

---

## [0.8.0] —— 2026-09-23

### Added

- Targeted story repair
- RepairRequest and RepairResult models
- RepairStrategy
- StoryRepairer
- Dedicated repair prompt
- Basic repair issue categories
- Repair-before-retry flow
- Repair artifacts
- Repair settings in the modern UI
- Manual repair endpoint
- Repair result inspection

### Changed

- Failed attempts can now be repaired before full regeneration
- GenerationPipeline now re-validates and re-reviews repaired stories
- Attempt artifacts preserve both the initial and repaired story when repair occurs

---

## [0.7.0] —— 2026-09-22

### Added

- `RetryPolicy`（`src/core/retry-policy.ts`）：`{max_attempts: 2, min_review_score: 70, retry_on_validation_failure: true}`，
  三项都可配，全部有默认值；`max_attempts` 含第一次生成（2 = 初次生成 + 最多 1 次自动重试）
- `RetryDecision`：`{should_retry, reason}`，reason 取值只有 `generation_error` /
  `validation_failed` / `review_score_below_threshold` 三种稳定值
- Retry 判定顺序固定：生成失败且还有次数 → 校验不通过且策略允许 → 审阅成功但总分低于阈值 → 接受。
  纯函数、无随机、无模型参与，同样的输入得到同样的重试次数
- `GenerationAttempt` 模型（`src/core/generation-attempt.ts`）：`attempt_number` / `story` / `validation` /
  `review` / `accepted` / `retry_reason` / `error`，正好七个字段；编号从 1 开始
- Pipeline 重试循环：一次 Run 可包含多次 Attempt，StoryConfig 与 BeatPlan 全部尝试共用一份，不重新规划
- Attempt 级产物：`runs/<run_id>/attempts/NN/{story.md, validation.json, review.json, metadata.json}`
- 选中 Attempt 的产物提升到 Run 根目录（复制而非符号链接，Windows 下同样可用）：
  根目录 `story.md` / `validation.json` / `review.json` 始终对应 `selected_attempt`
- Run metadata 新增 `attempt_count` / `selected_attempt` / `quality_status` / `max_attempts` /
  `min_review_score`；`quality_status` 只有 `accepted` / `exhausted` 两种取值
- Settings UI 四个自动重试字段：自动重试开关、最多尝试次数（1 ~ 5）、最低审阅分数（0 ~ 100）、
  校验失败也重试开关；关闭自动重试时 `max_attempts` 退化为 1，而不是造假阈值
- Attempt 面板：按编号罗列每次尝试的结论（Attempt 1: review 63 → retry 这样的单行），
  以及 `exhausted` 状态提示；没有比较表 / Score Delta / 排名
- `POST /api/runs` 与 `/api/runs/from-plan` 请求体支持可选 `retry_policy`（不属于 StoryConfig，
  不写进 `config.json`）；非法值返回 400，Run 不会开始
- Run 响应新增 `quality_status` / `attempt_count` / `selected_attempt` / `attempts[]`（只含摘要，不含正文）
- `GET /api/runs/<run_id>` 与 `GET /api/runs/<run_id>/attempts/<n>`：读回一次 Run 和一次 Attempt
- CLI `run` 子命令新增 `--max-attempts` / `--min-score` / `--no-retry-on-validation-failure`，
  结束时逐行打印每次 Attempt 的结论与 Quality Status / Selected Attempt
- Tests：retry-policy / generation-attempt / retry-pipeline / retry-api / ui-retry，
  以及 artifact-store 的 Attempt 产物覆盖

### Changed

- `GenerationPipeline.run()` 返回增加 `quality_status` / `attempt_count` / `selected_attempt` / `attempts`
- 固定阶段顺序改为 Config → Planning →〔Attempt n: Generate → Save Story → Validate → Review → RetryDecision〕→ Finalize；
  UI 仍是六阶段进度指示，另加 Attempt 计数
- `POST /api/runs` 系列响应新增四个重试字段；CLI `run` 的非零退出仍然只留给参数错误与真正的生成失败
- README 定位改为「具备剧情规划、正文生成、基础有效性检查、自动审阅与自动重试能力」，
  新增 `RetryPolicy` / `GenerationAttempt` 章节与 `attempts/NN/` 产物树

### Fixed

- Reviewer 调用失败 / 输出非法不再被当作重试理由：该次尝试因拿到审阅结论而被接受，
  与 v0.6.0「Review 失败不拖垮 Run」的语义一致
- Validator 自身异常只作废「校验不通过」这一格判据，不会把正文判成失败，也不会触发重试
- 生成失败在还有剩余次数时也按策略重试；只有最后一允许的 Attempt 仍拿不到正文才让整个 Run 以
  `generating` 阶段失败结束，已产出的 Attempt 产物不会被删除
- Attempt 存在性判断与产物提升不再有「顺手创建目录」的副作用，尝试编号上限固定为 99 以内

### Not Included

- 局部修复 / 针对问题定点改写 / 自动修 Ending 或 Character：本版本的重试只会带着同一份 BeatPlan
  重新生成整篇正文
- 多维评审阈值、Best-of-N 择优、重试统计与失败归因、PASS / FAIL 质量门禁、自适应生成

---

## [0.6.0] —— 2026-09-21

### Added

- Story Validator（`src/lib/story-validator.ts` + `src/lib/validation-rules.ts`）：正文落盘后的硬性有效性检查，
  回答「这篇正文基本可用吗」。不调用 LLM，纯确定性规则
- `ValidationResult` / `ValidationIssue` 模型与校验（`src/types/validation-result.ts`）：
  `{passed, issues}` 与 `{code, severity, message}`
- Severity 只有 `warning` / `error` 两级：任一 `error` 即 `passed: false`，只有 warning 或全无时 `passed: true`
- 六条稳定问题码的校验规则：`EMPTY_CONTENT` / `INVALID_OUTPUT` / `TOO_SHORT` /
  `POSSIBLE_TRUNCATION` / `MISSING_ENDING` / `MISSING_PROTAGONIST`
- 长度下限 `max(300, target_words × 0.15)`，配一视同仁的字数统计：CJK 字符逐个计数、连续拉丁字母 / 数字算一个词，
  标点与空白不计入（不用对中文失效的 `len(text.split())`）
- 截断启发式：引号未闭合、结尾停在句子中间、缺少终止标点——刻意宽松，宁可漏报不误报
- 主角存在性检查只在配置了 `protagonist.name` 时执行；没有角色一致性 / 动机 / 故事弧分析
- Validation JSON artifacts：`runs/<run_id>/validation.json`，重复校验时覆盖同一文件
- Validation stage in `GenerationPipeline`：Save Story 之后、Review 之前
- Validation status in run metadata：`validation_status` / `validation_passed` / `validation_issue_count` /
  `validation_error`；`validation_status` 区分「校验不通过」（`completed` + `passed: false`）
  与「校验器自身异常」（`failed`）
- Validation panel in the modern UI：独立于 Review 的校验区块，展示 Passed / Failed 与每条 Issue 的
  Code / Severity / Message，失败时保留正文并提供「Validate Again」
- Manual validation endpoint：`POST /api/validate`（`{config, story}`，可选 `run_id` 覆盖该 Run 的 validation.json）
- CLI `validate` 子命令，与 Pipeline 共用同一个 `StoryValidator`；`run` 结束时报 `Validation: PASSED|FAILED`
- Tests：validation-result / story-validator / validation-api / ui-validation

### Changed

- 固定阶段顺序由 Config → Planning → Generation → Save Story → Review → Save Review 扩展为
  Config → Planning → Generation → Save Story → **Validate → Save Validation** → Review → Save Review
- `RunStatus` 新增 `validating`；UI 进度指示由五阶段改为六阶段
- `POST /api/runs` 与 `/api/runs/from-plan` 的响应新增 `validation` / `validation_status` / `validation_error?`
- `GenerationPipeline` 构造参数新增 `StoryValidator`；`RunDeps` 新增可选 `validator`
- README 定位改为「具备剧情规划、正文生成、基础有效性检查和自动审阅能力」，并明确区分
  Validator（硬性 · 规则 · 可用吗）与 Reviewer（软性 · LLM · 写得好吗）

### Fixed

- `POST /api/validate` 曾把「有值但全是空白」的 `story` 当请求格式错误返回 400，使 `EMPTY_CONTENT`
  无法经由 API 触发；现在只有 `story` 缺失或类型不为字符串才返回 400，空白正文交由 `EMPTY_CONTENT` 规则报告
- 六条校验规则的提示信息原为英文，与项目其余部分的中文不一致；统一改为中文
- `tsx` 被 README 的 `npx tsx scripts/generate-cli.ts` 使用却未在 `package.json` 中声明，
  导致文档中的 CLI 命令无法直接运行

### Compatibility

- 校验不通过不会让 Run 失败：`story.md`、`validation.json` 与 `status: "completed"` 照常返回，
  `validation.passed` 为 `false`，HTTP 状态码仍为 200（这是一次成功的业务结果，不是错误）
- Validator 自身抛异常也不是 Run 失败：正文保留，`validation_status` 为 `failed` 并记录 `validation_error`，
  此时不写 `validation.json`；Story 非空时 Review 仍照常执行
- `EMPTY_CONTENT` 时跳过 Review（没有可审阅的正文），但空正文本身仍会落盘
- The validator reports only. It does not automatically regenerate, repair, extend or rewrite the ending.
- Review 分数不参与 Validation 判定：哪怕 Review 打 0 分，校验该过还是过；打 100 分，该不过还是不过

---

## [0.5.0] —— 2026-09-21

### Added

- Basic AI story reviewer（`BasicReviewer` + `prompts/reviewer.txt`）：对生成正文做一次基础审阅
- `ReviewResult` 模型与校验（`src/types/review-result.ts`）：`score` / `summary` / `strengths` / `problems`
- Overall 0–100 quality score：单一总分，越界（`< 0` 或 `> 100`）与非数字一律拒绝
- Review summary：一段总体评价
- Strengths and problems lists：两个字符串列表，条目 trim，允许为空数组
- Review parser（`src/lib/review-parser.ts`）：容忍 ``` 代码围栏与首尾空白，其余非法 JSON 抛 `ReviewParseError`
- Review JSON artifacts：`runs/<run_id>/review.json`，重复审阅时覆盖同一文件
- Review stage in `GenerationPipeline`：正文落盘之后才审阅
- Review status in run metadata：`review_status` / `review_error` / `review_score`
- Review panel in the modern UI：分数 / 摘要 / 优点 / 问题，失败时保留正文并提供「重新审阅」
- Manual review endpoint：`POST /api/review`（`{config, story}`，可选 `run_id` 覆盖该 Run 的 review.json）
- CLI `review` 子命令，与 Pipeline 共用同一个 `BasicReviewer`
- Tests：review-result / review-parser / basic-reviewer / ui-review

### Changed

- Complete generation runs now include post-generation review
- Run metadata now records review status and basic review score
- 固定阶段顺序由 Config → Planning → Generation → Persistence 扩展为
  Config → Planning → Generation → Save Story → Review → Save Review
- `RunStatus` 新增 `reviewing`；UI 进度指示由四阶段改为五阶段
- `POST /api/runs` 与 `/api/runs/from-plan` 的响应新增 `review` / `review_status` / `review_error`
- `GenerationPipeline` 构造参数新增 `BasicReviewer`；`RunDeps` 新增可选 `reviewer`
- README 定位改为「具备剧情规划、正文生成、Run 持久化和基础自动审阅能力」，并明确审阅只反馈不改写

### Fixed

- `src/lib/story-generator.ts` 中 `buildStoryPrompt` 的累加变量声明为 `let` 但从未重新赋值，触发 `prefer-const` lint 错误；改为 `const`

### Compatibility

- 审阅失败不会让 Run 失败：`story.md` 与 `status: "completed"` 照常返回，只有 `review_status` 为 `failed`
- 审阅温度固定为 `0.3`，与生成用的 `temperature` 相互独立
- The reviewer provides feedback only. It does not automatically regenerate or repair the story.
  没有 PASS / FAIL 阈值、没有多维评分、没有自动重试与自动修复。

---

## [0.4.0] —— 2026-09-20

### Added

- `GenerationPipeline`：一次完整故事生成 = 一个 Run，固定顺序 Config → Planning → Generation → Persistence
- `RunContext` + Run ID（本地时间戳 + 6 位随机字符），记录 status / current_stage / error
- `ArtifactStore`：产物统一写入 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `metadata.json`），原子写入
- `POST /api/runs`（自动模式）与 `POST /api/runs/from-plan`（手动模式）
- UI 四阶段进度指示、Run ID / 产物清单展示与失败阶段提示
- CLI `run` 子命令，与 UI / API 共用同一条 Pipeline
- Tests：generation-pipeline / run-context / artifact-store / run-api

### Changed

- `POST /api/generate` 改为兼容入口，等价于 `POST /api/runs/from-plan`
- 生成响应改为 `{run_id, status, story, beat_plan, artifacts}`，不再返回服务器文件绝对路径
- CLI 由 `plan` / `generate` 两阶段命令改为 `run`（`--beats` 可选）与 `plan`
- 产物目录由 `outputs/` 改为 `runs/<run_id>/`，并加入 `.gitignore`
- 失败时 metadata 记录失败阶段与安全错误信息（不含服务器绝对路径），已产出的文件不删除

### Removed

- `outputs/` 产物目录与 `src/lib/output.ts`（由 `ArtifactStore` 取代）

### Compatibility

- 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig；`POST /api/generate` 仍可携带 `{config, beat_plan}` 直接生成。
- 生成失败不会自动重试或自动改写，重试由你手动触发。

---

## [0.3.0] —— 2026-09-19

### Added

- Two-stage generation: StoryConfig → BeatPlanner → BeatPlan → StoryGenerator → Story
- BeatPlan model with schema validation (`types/beat-plan.ts`)
- External beat planning prompt template (`prompts/beat_planner.txt`)
- BeatPlan parser with markdown code-fence tolerance
- `POST /api/plan` API (stage one)
- Beat Plan panel in the UI with manual editing (add / delete / reorder)
- Outdated marker when StoryConfig changes after a plan was generated
- Prompt preview now includes the Beat Plan when one is available
- CLI `plan` and `generate` subcommands
- BeatPlan snapshot (`*.beats.json`) saved with story, config and metadata
- Beat count recorded in generation metadata and API response

### Changed

- `POST /api/generate` now requires `beat_plan` (400 when missing)
- Story prompt template now renders the Beat Plan section
- CLI is now two subcommands instead of a single `--config` run

### Compatibility

- Legacy `{title, prompt}` requests are still normalized to StoryConfig, but generation now requires a beat plan from `POST /api/plan`.

---

## [0.2.0] —— 2026-09-19

### Added

- Persistent StoryConfig model
- Story setting configuration
- Protagonist configuration
- Conflict and stakes fields
- Optional ending direction
- JSON StoryConfig save/load
- StoryConfig validation
- Example StoryConfig
- Config snapshot saved with generated stories
- CLI generation from StoryConfig when CLI is available

### Changed

- PromptBuilder now consumes StoryConfig
- Generate UI now edits reusable StoryConfig data
- Generation API now accepts StoryConfig-compatible input

### Removed

- Deprecated StoryRequest model superseded by StoryConfig

---

## [0.1.0] —— 2026-09-19

### Added

- Structured story generation request
- Genre selection
- Target word count configuration
- Writing style configuration
- Extra generation requirements
- External story prompt template
- PromptBuilder abstraction
- Prompt preview API（开发功能）
- Generation metadata JSON sidecar

### Changed

- Generation API now accepts structured story parameters
- Generate UI now exposes configurable story fields
- Prompt construction moved out of the request handler

### Compatibility

- Legacy `prompt` requests may still be mapped to `premise` during the v0.x transition.

---

## [0.0.1] —— 2026-09-19

### Added

- Initial short-story generation backend
- Modern web UI
- Story title and prompt input
- OpenAI-compatible LLM support
- Markdown story output
- Health and version APIs

---

*Format: [Semantic Versioning](https://semver.org/)*
