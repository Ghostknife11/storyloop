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
