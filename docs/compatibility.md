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
| Run 产物 | metadata 可以新增字段；文件名与目录层级不变 |
| QualityResult（v1.2.0） | 追加可选字段；`quality.json` 是新增文件，不影响既有文件 |
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
不调用模型、不引入新分数、没有多维、没有 PASS/FAIL 阈值。它读的三样东西
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

## 破坏性变更怎么发布

1. 在 `CHANGELOG.md` 里单独开一个条目，写清楚「旧行为 → 新行为 → 怎么改」
2. 在 `docs/upgrade.md` 写迁移步骤
3. 先发一个带废弃警告的次版本（在响应里带 warning 或文档标注），下一个主版本再真正移除
4. 主版本发布时同步更新本文件与 README 的兼容性章节

## 相关

- [升级说明](./upgrade.md)
- [API 契约](./api.md)
- [CLI 契约](./cli.md)
- [Run 产物契约](./run-artifacts.md)
