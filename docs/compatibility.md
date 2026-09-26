# 兼容性策略

> 本文件说明 storyloop 在 1.x 系列里对「什么算破坏性变更」的判定标准，
> 以及各类契约的扩展方式。对应 [upgrade.md](./upgrade.md) 的升级说明。

## 版本号语义

遵循 [SemVer](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订版本`。

| 变更类型 | 版本号 | 说明 |
|---|---|---|
| 破坏性变更 | 主版本 +1 | 需要使用者改代码 |
| 向后兼容的新能力 | 次版本 +1 | 旧用法全部照旧工作 |
| 向后兼容的问题修复 | 修订版本 +1 | 同次版本内的累积修复 |

Git tag 不带 `v` 前缀（`0.9.1`、`1.0.0`）；GitHub Release 标题带 `v` 前缀
（`v1.0.0 — Stable Generation Engine`）。这是刻意的：tag 列表按字面排序时
`0.9.1` 这样的纯数字版本顺序才稳定。

## 1.x 的承诺

**不会**做的事：

- 不会删 StoryConfig / BeatPlan / ValidationResult / ReviewResult / RepairResult 的既有字段
- 不会改字段名、字段类型或字段语义（同一个字段在不同版本含义不同也算破坏）
- 不会删 HTTP 路由、不会改既有路由的请求/响应字段、不会改错误码与状态码的对应关系
- 不会删 CLI 命令或参数、不会改变退出码含义
- 不会改 Run 产物目录布局、文件名、metadata 既有字段的含义
- 不会让 `.gitignore` 之外的路径突然开始写文件（`runs/`、`outputs/` 维持忽略）

**可以**做的事：

- 追加可选字段（请求体可不传、响应体可能多出键）
- 追加可选的环境变量与 CLI 参数
- 追加新路由
- 在既有错误码之外追加新错误码
- 修 bug：把「偶发失败」变成「稳定行为」不算破坏
- 改善文案——但错误 response 的 message 只保证「给人看的一句话」，不做机器可读承诺；
  下游请只依赖 `error.code` 与 HTTP 状态码

## 各类契约的扩展方式

| 契约 | 主版本内如何扩展 |
|---|---|
| StoryConfig / BeatPlan | 追加可选字段；`config_version` / `beat_plan_version` 保持 `"1"`，直到主版本 +1 才升到 `"2"` |
| ValidationResult / ReviewResult | 追加可选字段；`issues[].code` 可以新增取值 |
| BeatValidationResult（v1.4.0） | 追加可选字段；新文件 `beat-validation.json`，`issues[].code` 可以新增取值 |
| Run 产物 | metadata 可以新增字段；文件名与目录层级不变 |
| QualityResult（v1.2.0） | 追加可选字段；`quality.json` 是新增文件，不影响既有文件 |
| RunManifest（v1.6.0） | 追加可选字段；靠自带 `schemaVersion` 走自己的演进节奏，与 snake_case 的 metadata 契约不混用 |
| HTTP API | 追加路由；既存路由只加字段 |
| CLI | 追加命令与参数；既存参数语义不变 |
| 环境变量 | 追加变量；既有变量含义不变 |

## 已知的不对称（刻意保留）

这些是 0.x 时期留下的行为，v1.0.0 选择**保持现状**而不是改掉，避免造成无谓的破坏：

1. `POST /api/plan` 只接受「整个请求体就是 StoryConfig」，不支持 `{ "config": {...} }` 包装；
   其它 POST 路由两种写法都接受（不包装时会把遗留字段 `prompt` 提升为 `premise`）。
2. `retry_policy` 只被 `/api/runs`、`/api/runs/from-plan`、`/api/generate` 读取；
   其它路由静默忽略，不校验也不报错。
3. `/api/validate` 收到空字符串 `story` 返回 200 且 `passed: false`（交给规则判 `EMPTY_CONTENT`），
   而不是 400；`/api/review` 则是缺 `story` 就 400。
4. Run 不存在与 Attempt 不存在共用 `RUN_NOT_FOUND` 这个错误码，只能靠 message 区分。
5. 发生过修订时，「首次结论」与「修订后结论」落在不同地方：各级目录下的
   `validation.json` / `review.json` 存**首次**结论，修订后的那份在
   `attempts/NN/repairs/MM/` 里；而 `metadata.json` 的 `validation_passed` /
   `validation_issue_count` / `review_score`（以及 API 里对应字段）取**修订后**的结论。
   因此同一层里「metadata 的分数」与「`review.json` 的 score」可能不同——这不是数据损坏，
   也不在校正范围内：两边各自语义固定，1.x 内都不会改。
   v1.2.0 的 `quality.json` 与它派生的 `overall_score` / `quality_issue_count`
   一律取**修订后**的结论（与 metadata、与最终采用的 `story.md` 同口径）；
   修订目录 `attempts/NN/repairs/MM/` 里**没有** `quality.json`。

以上五条都有合同测试看守，改动它们属于破坏性变更。

## v1.1.0 的安全收紧（为什么没先「只告警」）

v1.1.0 收紧了请求体 `baseUrl` 覆盖的取值：只允许 http/https 公网地址，本机、环回、私网、
链路本地与保留段一律在发出请求前按 400 `CONFIG_INVALID` 拒掉（完整规则见 [api.md](./api.md)
的「`baseUrl` 覆盖的地址限制」）。

按上面「破坏性变更怎么发布」的第 3 条，本该先发一个只告警的次版本。这次没有照做，理由是
告警版本会让一条**当前可用的凭据外泄路径**多活一个发布周期：服务端是拿着 `LLM_API_KEY`
去请求这个地址的，地址本身又是请求方定的，告警挡不住外泄，只是让外泄多打一行日志。
权衡之后选了两边都小的做法——立刻收紧，但把迁移成本压到一处配置：

- 受影响的是「用请求体 `baseUrl` 指向本地 mock」的联调用法；改成在服务端 `LLM_BASE_URL`
  里配同一个地址即可，服务端配置属于受信输入，不受这套规则约束
- 没有任何字段、路由、错误码、状态码对应关系或产物布局发生变化，只是可接受的输入变窄了
- 域名解析失败按拒绝处理，因此收紧后每一次合法覆盖都多一次 DNS 查询（可接受）

主版本内不会再往这个方向加码：要么维持现状，要么（若确有必要）按上面的流程走 2.0.0。

## v1.1.1 对同一道关卡的修正

v1.1.1 是一次修订版本：没有新能力，只把 v1.1.0 那道关卡自身的三处问题修掉。规则方向不变，
变的是「判得准」与「入口一致」。

- **CLI 的 `--base-url` 不再被自己挡。** v1.1.0 把关卡接到了服务层四个入口上，CLI 的
  `plan` 因为没有走服务层而绕过了它，`run` / `review` / `repair` 又都走了——同一条命令集里
  三个子命令拦、一个不拦。v1.1.1 明确 CLI 与 `LLM_BASE_URL` 同级（都是本机受信配置），
  四个子命令统一按受信输入处理，请求体里不再带 `baseUrl`。受影响的是「CLI 指向本地假模型」
  的联调用法，现在恢复可用。
- **内嵌 IPv4 的 IPv6 地址按内嵌地址判。** v1.1.0 里匹配点分文本的那个分支因为 WHATWG URL
  会把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]` 而永远走不到：环回是被后一个分支的
  fail-closed 挡下的（行为安全），但合法的公网 mapped 地址也被一起误拒。
  v1.1.1 改为从地址最后两段取内嵌 IPv4，`::ffff:0:0/96` 与 NAT64 `64:ff9b::/96` 都按它判，
  另补上 `fec0::/10`（站点本地）与 `2002::/16`（6to4 中继）两段。
- **错误名与类名一致。** `UnsafeRequestUrlError` 不再借用 `RequestValidationError` 这个名字
  出现在日志里。对外的 `error.code`（`CONFIG_INVALID`）与 HTTP 状态码（400）没有任何变化。

已知限制（重定向、DNS rebinding）原文写在 [api.md](./api.md) 的「`baseUrl` 覆盖的地址限制」末尾，
v1.1.1 没有改动这两条的行为，只是把它们写明。

## v1.2.0 的统一质量层（纯 additive）

v1.2.0 新增的是「怎么把已有的质量结论汇到一起」，不是新的打分能力：`QualityAssembler`
不调用模型、不重新打分、没有 PASS/FAIL 阈值。它读的三样东西
（校验结论、审阅结论、采纳结论）v1.2.0 之前就全都在产物里了。

因此这一版按纯 additive 发布，逐条对上「1.x 的承诺」的「可以做的事」：

- **新增文件，不改既有文件。** `quality.json` 出现在 Run 根与 `attempts/NN/` 两处；
  既有的 `story.md` / `config.json` / `beat_plan.json` / `validation.json` / `review.json` /
  `metadata.json` 一个字节都没动。
- **既有字段一个没删没改。** `ReviewResult` 只多了一个可选 `suggestions`；
  缺失时响应与落盘结构里这个键整个不出现，与 v1.0 / v1.1 逐字一致。
- **既有路由只加字段。** Run 类入口、Run 详情、Attempt 详情都只多一个 `quality`
  （`QualityResult | null`）；错误码、状态码、路由集不变。
- **旧 Run 不需要迁移。** 没有 `quality.json` 的 Run（v1.2.0 之前生成的全部 Run）在读取时
  按同一套确定性规则**临时装配**，读响应、读详情都不会因此失败；也不会回写 `quality.json`。
- **`quality.json` 坏了不会连累 Run。** 解析失败或字段不合规时退回临时装配，
  退化的 worst case 是 `quality: null`（面板整体隐藏），不是 500。

一处需要写明的取舍：`quality.json` 取**修订后**的结论，而同目录的 `review.json` 是**首次**
结论。这让快照与 metadata 的 `overall_score` / `quality_issue_count`、与最终采用的 `story.md`
三者同口径（`overall_score` 就是那一版正文的审阅分）。代价是同一层里两个文件的分数可能不同
——这与上方第 5 条已有的「metadata vs `review.json`」不对称同源，刻意保留，1.x 内不改。

## v1.2.1 对同一条口径的修正（仍然纯 additive）

v1.2.0 落盘的 `quality.json` 取修订后的结论，可**临时装配**那条路（v1.2.0 之前没有这个文件的
Run）读的却是 attempt 目录下的**首次**结论。于是同一个发生过修订的旧 Run 会自相矛盾：

- `metadata.json` 的 `review_score` 是 82、`repairs[].after_review_score` 是 82，
  读接口给的 `quality.overall_score` 却是 41（修订前那版正文的审阅分）；
- Run 根目录那份 `quality.json` 丢了、而 attempt 那份还在时，Run 详情与 Attempt 详情
  还会给出两个不同分数。

v1.2.1 把临时装配改成与落盘同口径，三级兜底，每一级都是「这次尝试最终留下的那一版正文」：

1. `runs/<run_id>/quality.json`
2. 入选 Attempt 自己的 `attempts/<NN>/quality.json`
3. 前两级缺失或形状不认识时，从最终结论装配：发生过修订时取最后一次**真正跑过校验 / 审阅**
   的 `repairs/<MM>/` 里的那两份（修订调用本身失败时不会写这两个文件，所以继续往前找），
   一次修订都没跑通才回落到 attempt 目录下的首次结论

这仍然是一条纯 additive 的修正：

- 没有新增文件、没有改字段、没有改路由、没有改错误码；
- v1.2.0 落盘过 `quality.json` 的 Run 读取结果一个字节都没变（第 1 / 2 级优先）；
- 受影响的是 v1.2.0 之前生成的 Run 的 `quality` 字段，与同一次尝试的
  `metadata.json` / `repairs[]` 对齐——修的是 v1.2.0 自己引入的口径不一致；
- 读接口依旧不写盘、依旧不 500，`quality` 最差是 `null`。

## v1.3.0 的四个基础维度（纯 additive）

v1.3.0 让审阅者在整体分之外多给四个基础维度（连贯性 / 叙事 / 人物 / 因果）各打一个
0–100 分并附一句短评。它仍然是纯 additive：

- **`ReviewResult` 多一个可选 `dimensions`。** 缺失时响应与 `review.json` 里这个键整个不出现，
  与 v1.0 ~ v1.2.x 逐字一致；`dimensions` 显式为 `null` 时同样按缺失处理。
- **`QualityResult` 多一个可选 `dimensions`。** 由 `ReviewResult.dimensions` 原样搬运，
  装配逻辑没有新增判断。
- **`overall_score` 的口径收紧，不是新分数。** 有维度时整体分 = 四维均分（四舍五入到
  1 位小数，纯算术），没有维度时仍然等于 `review.score`。各级 metadata 的
  `review_score` / `before_review_score` / `after_review_score` 与它同一个口径。
- **旧 Run 不需要迁移。** 没有 `dimensions` 的 Run（1.3.0 之前生成的全部 Run）读出来与
  当年一致：`quality` 里没有这个键，前端不渲染维度那一节，整体分按老口径给。
- **坏维度不会连累 Run。** `quality.json` 里 `dimensions` 形状不对（缺维度、多维度、
  分数越界、短评为空）时按「没有维度」处理，快照其余字段照常返回，不是 500；
  但审阅阶段拿到形状不对的 `dimensions` 是**解析失败**（`REVIEW_FAILED`），
  因为那一刻必须选一个诚实答案：补一个 0 分会被当成真实评价参与展示。

两条边界必须写死在这里：维度**不新增阈值**，`RetryPolicy` 里仍然只有 `min_review_score`
一个总分门槛（比的还是整体分）；维度也**不驱动修订**，`RepairStrategy` 仍然只按问题类别
选一次要改的地方。换句话说，多出四个维度只改变「看得见多少」，不改变「怎么决策」。

## v1.4.0 的 BeatPlan 结构校验（additive，但生成链路多一道门）

v1.4.0 在 Planning 之后、第一个 Attempt 之前加了一道 BeatPlan 结构校验：
`BeatValidator` → `BeatValidationResult` → `beat-validation.json`，另有
`POST /api/validate-beats` 与前端 Beat Validation 面板。对外契约仍是 additive：

- **`BeatValidationResult` 是新结构，不动旧结构。** `StoryConfig` / `BeatPlan` /
  `ValidationResult` / `ReviewResult` / `QualityResult` 一个字段都没改，
  `beat_plan_version` 仍是 `"1"`。
- **Run 产物多一个新文件。** `beat-validation.json` 只在骨架结构校验真正跑过且成功时
  落在 Run 根，文件名与既有文件不冲突；校验器自身抛异常或没注入校验器时这个文件不存在，
  metadata 的 `beat_validation_*` 按缺失处理。
- **既有路由只加字段。** Run 类入口多 `beat_validation` / `beat_validation_status` /
  `beat_validation_error`，Run 详情多 `beat_validation` / `beat_validation_status`，
  `artifacts` 可能在成功时多一个 `beat_validation` 键；错误码多一个
  `BEAT_VALIDATION_FAILED`（502）。既有字段、路由、状态码含义全都没动。
- **旧 Run 不需要迁移。** 1.4.0 之前的 Run 没有 `beat-validation.json`，读回时
  `beat_validation` 是 `null`、`beat_validation_status` 是 `not_started`，与当年逐字一致。

但有**一处行为变化**必须写清楚：骨架结构带 `error` 级 issue 时，Run 会在写正文之前结束
（`status: "failed"`、`current_stage: "validating_beat_plan"`、产物只有 `config.json` /
`beats.json` / `beat-validation.json` / `metadata.json`）。这类 Run 在 1.3.x 会一路生成到
Attempt 阶段。**warning 级 issue 不算不通过**，`passed` 仍为 `true`，生成链路照常往下走。

这道门仍然遵守「只报告，不修复」：校验结论里没有 `fixed_beats` / `rewritten_plan` /
`suggested_plan` 这类字段，不会自动改写、重排、补拍任何一拍，也不会据此重新规划；
骨架怎么改由使用者决定。`POST /api/validate-beats` 也不读不写 `run_id`——
外部调用不该改动 Pipeline 自己落盘的那份结论。

## v1.4.1 的修订（口径对齐与读回容错，仍然纯 additive）

v1.4.1 没有新能力、没有新文件、没有新路由。核对 1.0.0 ~ 1.4.0 时发现的问题分成三类：
「文档写了但实现没做到」、「实现把上一版已经定好的口径走偏了」、「坏数据能一路带到
响应体里」。逐条对上「1.x 的承诺」：

- **`attempt` 摘要的分改回定好的口径。** `AttemptSummary.review_score` 取的是
  `review.score` 原值，而 v1.3.0 起整体分的唯一实现是 `reviewOverallScore`（有维度时取
  四维均分）。于是同一个 Run 里，摘要显示 90、`quality.overall_score` 显示 83、
  RetryPolicy 拿 83 去比门槛。v1.4.1 起三处是同一个数——**没有维度时逐字不变**，
  只有「模型给了维度」这一种情况下摘要才从 `review.score` 变成四维均分。
- **读回容错。** 落盘的结论文件（`review.json` / `validation.json` / `quality.json` /
  `beat-validation.json`，Run 根与 attempt 级都算）形状不认识时按「没有结论」处理：
  响应体对应字段是 `null`、读接口仍然 200，不是 500，也不把坏数据原样带出去。
  这与 v1.2.0「`quality.json` 坏了不会连累 Run」是同一条原则，v1.4.1 把它推广到其余
  三类结论文件。**它不改变「解析失败」的既有判定**：审阅阶段拿到形状不对的结论仍是
  `REVIEW_FAILED`，那一刻必须选一个诚实答案。
- **`beat_validation_error` 现在真的会返回。** [api.md](./api.md) 的 Run 响应表从
  v1.4.0 起就写了这个字段，`GenerationResult` 却没有它：校验器自身抛异常时 HTTP 层
  看不到这段文字。v1.4.1 补上，并与 `validation_error` / `review_error` 同一口径
  （有错误才带这个键）。
- **原子落盘。** `promoteAttempt` 与 `putText` 改成「同目录临时文件 + rename」，
  中断时不会留下半份 `story.md`；临时文件只多一个前导点、落在它自己那一层，不会挤到
  Run 根目录冒充产物。既有文件名与目录层级一个都没变。
- **CLI 的温度口径讲清楚了。** `--temperature` 只驱动规划与生成，审阅固定 `0.3`、
  修订固定 `0.5`（Beat 结构校验固定 `0.2`），这本来就是既成事实（README 与
  [api.md](./api.md) 一直这么写）；v1.4.0 的 `plan` 子命令漏了把它放进请求体，
  命令行上给了温度，规划却照旧用默认值。v1.4.1 补上透传，并让 `review` / `repair`
  收到 `--temperature` 时明确打一行「已忽略」——文档怎么说就怎么做，不静默收下。

三处纯前端修正，都只影响「当前展示的那一版」：Review Again / Validate Again 现在针对
当前展示的正文重新出结论（只有当前展示的正是 Run 落盘那一版时，才覆盖 run 目录里的
结论）；复制 / 下载导出的是当前展示的正文；`artifacts` 里的 `attempts/NN/` 前缀只加在
attempt 级的四类文件上，run 级文件不带前缀。另外 `--help` 出现在无法识别的参数之后也
照样给用法（退出码 0），切换 attempt 时的过期响应不再回写正文。

以上全部只改「读到的内容」与「写盘方式」：没有新增字段、没有删除字段、没有改路由、
没有改错误码、没有新文件。1.4.0 及以前生成的全部 Run 读出来逐字一致，唯一例外是
「模型给了维度」的 attempt 摘要分数——而那正是 v1.3.0 文档承诺的口径。

## v1.8.0 的 Run 可观测性（纯 additive）

v1.8.0 新增 `telemetry.json`、一条只读路由 `GET /api/runs/<run_id>/telemetry`、Run 详情响应里的
一个可选字段 `telemetry`、实验汇总里每个变体的一个可选块 `efficiency`，以及 `metadata.json`
的两个转述字段 `duration_ms` / `llm_call_count`。没有删字段、没有改字段名、没有改路由与错误码，
三层 metadata 契约、`quality.json` 装配口径、CLI 与既有响应字段逐字未动。

- **新文件只在运行级一份。** `telemetry.json` 与 `metadata.json` / `run-manifest.json`
  并列写在 Run 根目录；`attempts/` 与 `repairs/` 下一份都没有。运行级固定文件数从十个变十一个。
- **自带 `schemaVersion`，字段是 camelCase。** 与 snake_case 的 metadata 契约物理隔离，
  与 camelCase 的 run-manifest 同向——两份新文件都不需要解释「为什么改了一个既有字段的含义」。
- **只记过程，不记内容。** 阶段起止与耗时、每次模型调用的模型 / 耗时 / 结局、Attempt /
  retries / repairs 计数、失败阶段与稳定错误码。正文、Prompt、用户输入一个字都不进；
  `llmCalls[].provider` 恒为 `null`（run-manifest 连 baseUrl 原文都不存，这里同样不抄部署信息）。
- **拿不到就是没有。** Provider 没给 usage 时 token 三项是 `null`，一次都没给时这三个键整个
  不出现；成本只在金额与币种同时真实可得时才记。没有可信价格信息时成本是 `null`——
  「没有数字」和「数字是零」在遥测里永远是两件事，界面对应位置显示 `—`。
- **失败 Run 也保存遥测。** 跑到一半失败时已发生的阶段照常落盘，`status: "failed"`。
  写遥测这一步自身失败只记一行 warning，故事、校验、审阅、质量一个结论都不受影响。
- **读不到就是 `null`。** 1.8.0 之前生成的 Run 没有这个文件，路由返回
  `{telemetry: null}`（HTTP 200）、Run 详情的 `telemetry` 是 `null`、面板整个隐藏，
  磁盘上不会被补写——与 `quality.json`、`commercial-review.json`、`run-manifest.json`
  同一套规则。实验里 1.8.0 之前跑出来的那格，`efficiency` 各项是
  `{mean: null, sampleCount: 0}`。

它明确**不是**观测平台：不做跨 Run 聚合、不设阈值、不出告警、不做失败归因与根因分析、
不跑基准、不做自适应调参。遥测只回答「这次怎么跑的」，不回答「为什么失败」，
也没有任何代码读它来决定重试、修订或采纳。

## v1.6.0 的 Run 出身清单（纯 additive）

v1.6.0 新增 `run-manifest.json` 与两个响应字段 `manifest`，没有删任何字段、没有改字段名、
没有改路由与错误码。三层 metadata 契约、`quality.json` 装配口径、CLI 与既有响应字段逐字未动。

- **新文件只在运行级一份。** `run-manifest.json` 与 `metadata.json` 并列写在 Run 根目录；
  `attempts/` 与 `repairs/` 下都没有它。运行级固定文件数从九个变十个，两层子目录的文件数不变。
- **自带 `schemaVersion`，字段是 camelCase。** 与 v1.0.0 冻结的 snake_case metadata 契约
  物理隔离，因此扩展清单不需要解释「为什么改了一个既有字段的含义」。
- **清单不搬运内容。** 只记元数据：代码版本与 commit、模型名 / provider / baseUrl 分类、
  各阶段 temperature 与 RetryPolicy 快照、六个提示词的版本与内容摘要、每次 Attempt 的结局、
  登记产物的 SHA-256。正文、审阅结论的任何文字都不进清单。
- **凭据不进清单。** baseUrl 原文不落盘（只留「服务器配置 / 请求公有覆盖」这个分类）；
  `topP` / `maxTokens` 这类本次客户端没有下发的参数一律不写；`project.commit` 只在环境真的
  给出 git SHA 时才有，从不为了填满字段去跑 git。
- **写清单失败不让 Run 失败。** 这一步抛异常时只记一行 warning 并把 `manifest` 置为 `null`，
  故事、校验、审阅、质量一个结论都不受影响。
- **读不到就是 `null`。** v1.6.0 之前生成的 Run 没有这个文件，`manifest` 返回 `null`、
  Run Provenance 面板整个隐藏，磁盘上不会被补写——与 `quality.json`（1.2.0）与
  `commercial-review.json`（1.5.0）同一套规则。

它明确**不是**实验框架：不做跨 Run 对比、不跑基准、不统计成功率、不做自适应调参
（`BenchmarkRunner` / `AdaptiveGeneration` / `SelfOptimization` 一类能力保留给后续版本）。
清单只为一次 Run 自证出身。

## v1.5.2 的界面修订（只换样式类名，零数据影响）

v1.5.2 没有新能力、没有新字段、没有新路由，改的是 `src/**/*.tsx` 里的样式类名。
`src/core`、`src/lib`、`src/storage`、`src/app/api`、`scripts/` 一行没动，
产物布局与字段集与 1.5.1 逐字一致，1.5.1 与 1.5.2 写的 Run 可以互相读，也不存在任何迁移。

- **Story Config 外框不再让内容溢出到边框外。** 两列布局补 `min-h-0`，左右两列都加
  `min-h-0` + `overflow-y-auto`。此前配置列作为 grid 子项被拉到整行高（1440×900 下 737px）
  而自身内容有 1110px，父级 `overflow: visible`，多出的部分直接渲染在圆角边框外面。
- **写死的颜色换成主题 token。** `border-white/*`、`border-border/50` 一律换成
  `border-border`；`bg-white/[0.02-0.04]`、`bg-white/5`、`bg-white/10`、`bg-black/20`
  换成 `bg-muted/40` / `bg-muted/50` / `bg-muted`；`text-zinc-200` / `text-zinc-300`
  换成 `text-foreground`；`bg-zinc-800/60` / `bg-zinc-900` 换成 `bg-input` / `bg-card`。
  `bg-black/*` 只保留在整屏遮罩上（弹窗遮罩与移动端菜单遮罩），那是它的正当用途。
- **侧栏不再为深色单独覆盖一层。** 删掉 `dark:bg-zinc-900/70` 与 `dark:border-white/10`：
  `--border` 与 `--card` 在 `globals.css` 里已经是浅色 / 深色两套值，再盖一层只会让两边都不对。
- **原生 `<select>` 的边框在浅色模式下不再隐形。** 浅色主题里 `--border` 与 `--input`
  是同一个值（`oklch(0.92 0.01 280)`），`bg-input` 的底与 `border-input` 的线互相抵消。
  题材下拉与 Targeted Repair 的 Issue Type 下拉改成与 `ui/input.tsx` 完全一致的输入态：
  `border-input` 配 `bg-transparent`、仅深色下 `dark:bg-input/30`，焦点环用
  `focus-visible:ring-ring/50` 取代写死的 `focus:ring-violet-500/30`，option 用 `bg-card`。
- **右列结果区从「滚不动」变成可以滚到底。** 「生成结果」面板由 `flex-1 min-h-[280px]`
  改为 `grow shrink-0`（`flex-basis` 回到 `auto`），并去掉正文 `<ScrollArea>` 上写死的
  `h-full`。此前右列 `scrollHeight == clientHeight`，Attempts / Quality / Validation /
  Review / Commercial Review 渲染在框外且不可达；现在右列只有一个滚动面，内容超高就在
  自己的圆角框内滚动，与左列一致。
- **嵌套圆角与强调色成对写法。** 外层 `rounded-3xl` 内的三块子面板由 `rounded-2xl`
  改为 `rounded-lg`（内圆角小于「外圆角减内缩量」）；300/400 档强调色改成「浅色 600 档、
  深色 `dark:`300 档」的成对写法。

这些改动只影响渲染结果，不影响任何接口与产物。新增的
`tests/test_ui_theme_tokens.test.ts`（13 个用例）把上述规则钉在源码级断言上，防止回退；
拿 1.5.1 的源码跑这批断言会红 37 处。

## v1.5.1 的修订（失败路径说真话，仍然纯 additive）

v1.5.1 没有新能力，只修 1.5.0 引入的两处「文档承诺与实现对不上」：

- **失败的 Run 不再把 `commercial_review_status` 谎写成 `not_started`。** 1.5.0 的失败路径
  无条件写 `not_started`，于是「第一次尝试商业审阅跑成了、第二次尝试生成失败」的 Run，
  metadata 声称这一步从没跑过，而 `attempts/01/commercial-review.json` 就在磁盘上。
  1.5.1 起写真实状态：跑成了是 `completed`、这一步自己失败了是 `failed`、
  一次都没跑到才是 `not_started`（与 `beat_validation_status` 同一套口径）。
- **结论本体仍然不写。** 失败路径从不执行 promote，运行根目录没有
  `commercial-review.json`，所以失败路径只写 `commercial_review_status` 与
  `commercial_review_error`，不带 `commercial_review`。由此 `commercial_score` 与
  `artifacts.commercial_review` 在失败路径上依旧缺席——不会为了「说真话」而索引一个
  不存在的文件。
- **读侧随之变化。** Run 详情的 `commercial_review_status` 本来就读 metadata，
  所以「Attempt 跑成过这一步之后 Run 才失败」现在读回 `completed` 配
  `commercial_review: null`；`not_started` 只留给真的从没跑到的那一类（含 1.5.0 之前的老 Run，
  它们没有这个字段，读接口兜底 `not_started`，磁盘不补写）。

产物布局、字段集、路由、错误码与 CLI 参数一个都没动：`commercial_review_status` 一直是
运行级 metadata 的既有字段，1.5.1 改的只是失败路径写进它的值。1.5.0 与 1.5.1 写的 Run
可以互相读。

## v1.5.0 的商业可读性审阅（additive，两套审阅并行）

v1.5.0 加了第二个审阅者：`CommercialReviewer` 从「读者会不会继续读下去」的角度看同一篇
正文，给 Hook / Pacing / Engagement / Payoff 四个固定维度各打 0~100 分并附一句短评，
结论落成 `commercial-review.json`、API 的 `commercial_review` 字段与前端 Commercial
Review 面板三处。对外契约仍然纯 additive：

- **`StoryConfig` / `BeatPlan` / `ValidationResult` / `ReviewResult` / `QualityResult`
  一个字段都没改。** 商业可读性是并列的第二个结论，不是 `ReviewResult` 的新维度——
  两个审阅者各自的提示词、parser 与产物文件，绝不合成一个「八维大 Prompt」。
- **Run 产物多两个新文件。** `commercial-review.json` 在 Run 根（由入选 attempt 提升而来，
  与入选正文严格同版）与每个 attempt 目录（该次尝试最终那一版正文的结论）各一份；
  `repairs/` 下**没有**——一次修订只跑一次商业审阅。这一步被跳过或自身失败时文件不存在。
- **既有路由只加字段。** Run 类入口与 Run 详情多 `commercial_review` /
  `commercial_review_status` / `commercial_review_error`，Attempt 详情多 `commercial_review`，
  `artifacts` 可能在成功时多一个 `commercial_review` 键；错误码多一个
  `COMMERCIAL_REVIEW_FAILED`（502）。既有字段、路由、状态码含义全都没动。
- **旧 Run 不需要迁移。** v1.5.0 之前的 Run 没有 `commercial-review.json`，读回时
  `commercial_review` 是 `null`、`commercial_review_status` 是 `not_started`，与当年逐字一致，
  读接口也不会把磁盘「补写」成新版结构。

三条边界必须写死在这里：商业可读性分数**不驱动重试**（`RetryPolicy` 里仍然只有
`min_review_score` 一个总分门槛，比的还是结构审阅的整体分）、**不驱动修订**
（`RepairStrategy` 仍然只看问题类别）、**不进 `QualityResult`**（质量快照仍然只有
Co/N/C/Ca 四个维度）。低商业分是一次诚实的业务结果，不是错误，也不会改变 attempt 的
采纳结论。它同样**不预测市场表现**：没有「爆款概率」「必火」「市场成功率」一类的字段或
文案，分数描述的是文本本身可观察的事实。

失败隔离沿用既有约定：这一步自身失败（模型超时、输出非法）只把
`commercial_review_status` 置为 `failed`、记下 `commercial_review_error`，Run 照常继续，
正文 / `validation.json` / `review.json` / `quality.json` 与采纳结论一个都不受影响。

## 破坏性变更怎么发布

1. 在 `CHANGELOG.md` 里单独开一个条目，写清楚「旧行为 → 新行为 → 怎么改」
2. 在 `docs/upgrade.md` 写迁移步骤
3. 先发一个带废弃警告的次版本（在响应里带 warning 或文档标注），下一个主版本再真正移除
4. 主版本发布时同步更新本文件与 README 的兼容性章节

## 相关

- [升级说明](./upgrade.md)
- [API 契约](./api.md)
- [Run Telemetry 契约（v1.8.0）](./telemetry.md)
- [CLI 契约](./cli.md)
- [Run 产物契约](./run-artifacts.md)
