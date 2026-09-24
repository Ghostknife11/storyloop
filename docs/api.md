# API 契约

> 本文件是 v1.0.0 冻结的 HTTP API：路径、方法、请求体、响应字段、错误码与状态码。
> 1.x 版本不得删路由、改字段名、改状态码含义；扩展只能是新增路由或新增可选字段。
>
> 契约测试：`tests/test_contract_api.test.ts`（同时守护路由清单本身）

## 通用约定

- 所有请求与响应都是 JSON，UTF-8
- API Key **只**来自服务端环境变量 `LLM_API_KEY`；请求头里的凭据不会被读取，也不会出现在任何响应里
- 失败响应形状恒定：

```json
{ "error": { "code": "CONFIG_INVALID", "message": "标题不能为空", "run_id": "可选", "stage": "可选" } }
```

### 错误码

| code | HTTP | 何时出现 |
|---|---|---|
| `CONFIG_INVALID` | 400 | StoryConfig / BeatPlan / retry_policy / issue_type 不合法，请求体不是合法 JSON，或请求体里的 `baseUrl` 指向不允许的地址 |
| `RUN_NOT_FOUND` | 404 | Run 或 Attempt 不存在 |
| `LLM_TIMEOUT` | 504 | 单次 LLM 请求超时 |
| `LLM_REQUEST_FAILED` | 502 | LLM 请求失败（网络、鉴权、限流） |
| `PLANNER_INVALID_OUTPUT` | 502 | 规划输出解析不出合法 BeatPlan |
| `GENERATION_FAILED` | 502 | 生成阶段失败 |
| `REVIEW_FAILED` | 502 | 审阅输出解析失败 |
| `REPAIR_FAILED` | 502 | 修订输出解析失败 |
| `VALIDATION_FAILED_INTERNAL` | 500 | 校验器自身出错 |
| `ARTIFACT_WRITE_FAILED` | 500 | 产物写盘失败 |
| `INTERNAL_ERROR` | 500 | 未预期异常；message 固定为「服务器内部错误」，不带堆栈与原始异常文本 |

用户错误（改请求就能解决）一律 4xx，运行时错误 5xx。响应里永远不出现堆栈、
本机绝对路径或凭据：异常文本会先过 `src/lib/safe-text.ts`。

### 共享的请求体字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `config` | StoryConfig | 可选；不传时整个请求体当 StoryConfig（但 `POST /api/plan` 不支持包装） |
| `model` / `baseUrl` / `temperature` | string / string / number | 可选，覆盖服务端 LLM 设置 |
| `retry_policy` | object | 可选；**只被 `/api/runs`、`/api/runs/from-plan`、`/api/generate` 读取**，其它路由静默忽略 |

`retry_policy` 字段：`max_attempts`（整数 1~5，缺省 2）、`min_review_score`（0~100，缺省 70）、
`retry_on_validation_failure`（boolean，缺省 true）、`enable_repair`（boolean，缺省 true）、
`max_repairs_per_attempt`（整数 0~3，缺省 1）。越界一律 400。

#### `baseUrl` 覆盖的地址限制

服务端是拿着 `LLM_API_KEY` 去请求 `baseUrl` 的（密钥作为 Bearer token 发出），所以请求体里
带的值会在**发出任何请求之前**先过一遍地址校验（`src/lib/url-guard.ts`），不合法 → 400
`CONFIG_INVALID`：

- 只允许 `http` / `https`
- 不允许指向本机与环回：`localhost`、`*.localhost`、`.local`、`.internal`、`127.0.0.0/8`、`::1`
- 不允许指向私网、链路本地与保留段：`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（含云元数据
  地址）、`100.64/10`、组播与广播段等
- IPv6 同理：`fe80::/10`、`fec0::/10`、`fc00::/7`、`2001:db8::`、`2002::/16`（6to4 中继）；
  内嵌 IPv4 的 `::ffff:0:0/96`（IPv4-mapped）与 `64:ff9b::/96`（NAT64）按内嵌的那个 IPv4 判——
  `[::ffff:127.0.0.1]` 与 `[64:ff9b::7f00:1]` 都会被拒，内嵌公网地址的合法 mapped 地址仍然放行
- 域名要解析出地址后再判一遍：解析到上面任一非公网地址的域名同样拒绝；解析失败也按拒绝处理
  （验不了就不放行）

不传 `baseUrl`（或传空串）＝用服务端 `LLM_BASE_URL`，那是运维的受信配置，不受这套规则约束——
服务端指向本地假模型的联调用法仍然可用。同理，测试里注入假 LLM 时这个字段根本不参与组网，
也不会被校验。CLI 的 `--base-url` 与 `LLM_BASE_URL` 同级，按本机受信配置处理，见
[cli.md](./cli.md)。

#### 已知限制：校验只覆盖第一次解析

关卡挡的是「直接拿请求体里的地址打内网」，以下两条是当前**没有**堵死的路径，写在这里以免
误以为已经堵上：

1. **重定向。** LLM 请求本身用默认的 `fetch` 行为（跟随 3xx）。一个合法公网地址先放行、
   然后 302 到内网地址时，请求会跟着过去。按 fetch 规范，跨源重定向不会带上 Authorization，
   所以「密钥被转到内网」这条基本被挡；但请求确实发了出去，内网的响应也会被读回生成流程。
2. **DNS rebinding。** 校验时解析一次域名，`fetch` 建连时还会再解析一次。控制这个域名 DNS
   的人可以让两次解析给出不同答案。彻底堵上要么在拿到 IP 后自己建连，要么给 `fetch` 固定
   目标，改动面远超一次安全收紧，v1.1.x 只把这个事实写明。

## 路由清单

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康检查，无失败路径 |
| GET | `/api/version` | 返回 `{ "version": "..." }`，与 `VERSION` 文件一致 |
| POST | `/api/plan` | StoryConfig → BeatPlan |
| POST | `/api/runs` | Automatic Run：Config → Plan → Attempt → Retry? |
| POST | `/api/runs/from-plan` | Manual Run：用给定 BeatPlan 直接生成（`beat_plan` 必填） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/review` | 对一段已有正文单独审阅（不重试、不写盘；带 `run_id` 时覆盖该 Run 的 `review.json`） |
| POST | `/api/validate` | 对一段已有正文单独跑硬性规则（不调模型） |
| POST | `/api/repair` | 对一段已有正文定点修订一次 |
| GET | `/api/runs/<run_id>` | Run 详情 |
| GET | `/api/runs/<run_id>/attempts/<attempt_number>` | 单次尝试详情 |
| POST | `/api/prompt/preview` | 看将要发给模型的 prompt 长什么样，不调模型 |

## 响应字段

### `POST /api/plan`

顶层就是 BeatPlan 本体：`beat_plan_version`、`summary`（可选）、`beats`。
注意它**不支持** `{ "config": {...} }` 包装——包装后会因为找不到 `title` 直接 400。

### Run 类入口（`/api/runs`、`/api/runs/from-plan`、`/api/generate`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | Run 标识 |
| `status` | string | 恒为 `completed`（失败走错误响应） |
| `story` | string | 入选正文（不含 H1 标题行） |
| `beat_plan` | BeatPlan | 本次使用的骨架 |
| `validation` | ValidationResult \| null | 校验器自身出错时为 `null` |
| `validation_status` | string | `not_started` / `validating` / `completed` / `failed` |
| `validation_error` | string | 可选，仅在出错时出现 |
| `review` | ReviewResult \| null | 审阅失败时为 `null` |
| `review_status` | string | 同上四值 |
| `review_error` | string | 可选，仅在出错时出现 |
| `quality` | QualityResult \| null | v1.2.0 新增：统一质量快照，见下 |
| `artifacts` | object | 见下 |
| `quality_status` | string | `accepted` / `exhausted` |
| `attempt_count` | number | 尝试次数 |
| `selected_attempt` | number | 入选的是第几次 |
| `repair_count` | number | 修订总轮数 |
| `attempts` | AttemptSummary[] | 每次尝试的摘要 |

`artifacts` 恒含 `config` / `beat_plan` / `story` / `metadata` 四个键（值是文件名），
校验、审阅或质量装配各自成功时追加 `validation` / `review` / `quality`。

`QualityResult`（v1.2.0 新增，纯 additive）：`overall_score`（有维度时是四维均分，否则是
`review.score`，没有审阅结论时是 `null`）、`validation_passed`（`true` / `false` /
校验没跑时的 `null`）、`accepted`、`issues`（`QualityIssue[]`）、`suggestions`（`QualitySuggestion[]`）、
`summary`，以及 v1.3.0 新增的可选 `dimensions`。
它由 `QualityAssembler` 从已有的校验结论、审阅结论与采纳结论确定性装配，不调用模型、
不重新打分（维度也只是从审阅结论原样搬过来）。

- `QualityIssue`：`id`（`validation-1` / `review-1`…）、`source`（`validation` / `review`）、
  `category`（校验侧是 issue code，审阅侧统一 `review_problem`）、`message`、可选的 `severity`
- `QualitySuggestion`：`id`、`source`（`review`；`system` 保留给后续版本，v1.2.0 不产出）、
  `message`
- `dimensions`（v1.3.0，可选）：四个键 `coherence` / `narrative` / `character` / `causality`，
  各自 `{score: number, summary: string}`。审阅没给维度（1.3.0 之前的 Run、或模型输出里
  没有这四个键）时响应里整个 `dimensions` 键不出现，其余字段与当年逐字一致

`ReviewResult` 的 `suggestions` 是 v1.2.0 新增的可选字段：缺失时响应里整个键不出现，
与 v1.0 / v1.1 的落盘结构逐字一致。`dimensions` 同理（v1.3.0）。

`AttemptSummary`：`attempt_number`、`accepted`、`retry_reason`（`null` 或原因）、
`review_score`（可为 `null`）、`validation_passed`（可为 `null`）、`repair_count`、`repairs`。

**发生过修订时，这几处的分数来源不同**（与 [run-artifacts.md](./run-artifacts.md) 的产物语义一致）：

- Run 类入口（`/api/runs`、`/api/runs/from-plan`、`/api/generate`）的 `review` / `validation`
  是内存返回值，取**最终**结论（修订后重新校验 / 审阅过的那一轮），与 `quality` 同口径；
- 读接口的 `review` / `validation` 来自磁盘：Run 详情读 Run 根目录那两份（由入选 Attempt 提升
  而来），Attempt 详情与 Run 摘要的 `attempts[]` 读 attempt 目录那两份——都是**首次**结论，
  修订后的分数看 `repairs[].before_review_score` / `after_review_score` 的变化；
- 而三处响应的 `quality` 一律取**最终**结论（与最终采用的 `story` 对齐）：v1.2.0 之后读
  `quality.json`，旧 Run 没有这个文件（或被手改坏）时按同一套规则临时装配。

所以同一个 Attempt 在不同接口看到不同分数不是 bug：写盘的那两份结论与内存返回值本来就不同源，
这是 v1.0.0 冻结产物布局时定下的不对称，详见
[compatibility.md](./compatibility.md) 的「已知的不对称」。

### `GET /api/runs/<run_id>`

`RunDetail`，与 Run 入口不同：**没有** `beat_plan` 与 `artifacts`，
多了策略回显字段 `max_attempts` / `min_review_score` / `enable_repair` / `max_repairs_per_attempt`。
`run_id` 为 `""`、`.`、`..` 或含路径分隔符时 400；Run 不存在 404 `RUN_NOT_FOUND`。

`quality` 按三级兜底取，三级都是同一版正文（入选 Attempt 最终留下的那一版）：

1. `runs/<run_id>/quality.json`（运行根那份，v1.2.0 起由 promote 流程写入）
2. 入选 Attempt 自己的 `attempts/<NN>/quality.json`
3. 前两级都没有或形状不认识时，用同一套确定性规则从**最终结论**临时装配——发生过修订时取
   最后一次真正跑过校验 / 审阅的 `repairs/<MM>/` 里的那两份，一次修订都没跑通才回落到
   attempt 目录下的首次结论

读取在任何一级都不失败：`quality` 最差是 `null`，不是 500，磁盘上也不会被补写。
第 3 级这套「往前找最后一次真正跑过校验 / 审阅的修订目录」是 v1.2.1 定的口径，
v1.2.0 直接读 attempt 目录，于是旧 Run 装配出的分数描述的是修订前那版正文。

### `GET /api/runs/<run_id>/attempts/<attempt_number>`

`AttemptDetail`：`run_id`、`attempt_number`、`accepted`、`retry_reason`、`selected`、
`story`、`initial_story`（没发生修订时是 `null`）、`repair_count`、`repairs`（`RepairDetail[]`）、
`validation`、`review`、`quality`（v1.2.0 新增，取该次尝试修订后的快照）。
Run 不存在与 Attempt 不存在共用 `RUN_NOT_FOUND` 这个 code，只能靠 message 区分；
`attempt_number` 不是 1~99 的整数时 400。
`quality` 先读 `attempts/<NN>/quality.json`，缺失或被改坏时按上面第 3 级同一套规则装配。

### `POST /api/review` 与 `POST /api/validate`

顶层直接是 `ReviewResult`（`score` / `summary` / `strengths` / `problems`，v1.3.0 起可能还有
`dimensions`）或 `ValidationResult`（`passed` / `issues`）。两者都要求 `story` 非空字符串
（`/api/review`）或字符串（`/api/validate`，空串会以 `EMPTY_CONTENT` 规则正常返回 200 `passed: false`）。
带 `run_id` 且该 Run 不存在时 404，**不会**调用模型。

审阅者输出里的 `dimensions` 一旦出现就必须四个键齐全、各自 0~100 且带非空短评；
少一个、多一个（模型自己扩到 35 维也一样）、分数越界，都算审阅输出非法，
按 `REVIEW_FAILED` 502 返回，不会补 0 也不会挑一个先凑着。

### `POST /api/repair`

顶层是 `repaired_story` / `issue_type` / `success` / `notes`。
没有 `diff` 或 `patch` 字段。`issue_type` 必须是
`length` / `ending` / `character_presence` / `continuity` / `structure` / `general` 之一。

### `POST /api/prompt/preview` 与 `GET /api/health`

前者只返回 `{ "prompt": "..." }`；后者只返回 `{ "status": "ok" }`。

## 不做什么

- 不做鉴权、不限流：API Key 只是给 LLM 用的，路由本身没有用户体系
- 不做 SSE / WebSocket 流式输出
- 不做批量接口
- 没有 middleware 改响应、没有全局 error handler：每个路由自己负责把 service 的结果转成响应

## 相关

- [StoryConfig v1 契约](./story-config.md)
- [BeatPlan v1 契约](./beat-plan.md)
- [Run 产物契约](./run-artifacts.md)
- [CLI 契约](./cli.md)
