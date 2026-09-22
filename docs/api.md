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
| `CONFIG_INVALID` | 400 | StoryConfig / BeatPlan / retry_policy / issue_type 不合法，或请求体不是合法 JSON |
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
| `artifacts` | object | 见下 |
| `quality_status` | string | `accepted` / `exhausted` |
| `attempt_count` | number | 尝试次数 |
| `selected_attempt` | number | 入选的是第几次 |
| `repair_count` | number | 修订总轮数 |
| `attempts` | AttemptSummary[] | 每次尝试的摘要 |

`artifacts` 恒含 `config` / `beat_plan` / `story` / `metadata` 四个键（值是文件名），
校验或审阅成功时追加 `validation` / `review`。

`AttemptSummary`：`attempt_number`、`accepted`、`retry_reason`（`null` 或原因）、
`review_score`（可为 `null`）、`validation_passed`（可为 `null`）、`repair_count`、`repairs`。

### `GET /api/runs/<run_id>`

`RunDetail`，与 Run 入口不同：**没有** `beat_plan` 与 `artifacts`，
多了策略回显字段 `max_attempts` / `min_review_score` / `enable_repair` / `max_repairs_per_attempt`。
`run_id` 为 `""`、`.`、`..` 或含路径分隔符时 400；Run 不存在 404 `RUN_NOT_FOUND`。

### `GET /api/runs/<run_id>/attempts/<attempt_number>`

`AttemptDetail`：`run_id`、`attempt_number`、`accepted`、`retry_reason`、`selected`、
`story`、`initial_story`（没发生修订时是 `null`）、`repair_count`、`repairs`（`RepairDetail[]`）、
`validation`、`review`。
Run 不存在与 Attempt 不存在共用 `RUN_NOT_FOUND` 这个 code，只能靠 message 区分；
`attempt_number` 不是 1~99 的整数时 400。

### `POST /api/review` 与 `POST /api/validate`

顶层直接是 `ReviewResult`（`score` / `summary` / `strengths` / `problems`）或
`ValidationResult`（`passed` / `issues`）。两者都要求 `story` 非空字符串（`/api/review`）
或字符串（`/api/validate`，空串会以 `EMPTY_CONTENT` 规则正常返回 200 `passed: false`）。
带 `run_id` 且该 Run 不存在时 404，**不会**调用模型。

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
