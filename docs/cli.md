# CLI 契约

> 本文件是 v1.0.0 冻结的命令行接口：命令、参数、退出码、输出位置。
> 1.x 版本不得删命令、改参数名或改变退出码含义。
>
> 实现：`scripts/generate-cli.ts`（`runCli` / `parseArgs`）
> 契约测试：`tests/test_contract_cli.test.ts`
> 启动方式：`npx tsx scripts/generate-cli.ts <command> [options]`

## 退出码

| 退出码 | 含义 | 例子 |
|---|---|---|
| `0` | 正常结束 | 成功跑完；`--help`；修订跑完但 `success=false` |
| `1` | 运行时失败 | LLM 超时 / 请求失败、Pipeline 抛错 |
| `2` | 参数或配置不合法 | 未知命令、未知 flag、缺必填项、数值越界、配置文件读不了 |

分界线：**调用方改命令行就能解决的算 2，改不了的算 1**。
没配 `LLM_API_KEY` 也是 2（配置问题）。

## 命令

```text
storygen run       StoryConfig → Plan → Attempt（Generate → Validate → Review → Repair? → Decide）→ Retry?
storygen plan      只产出 BeatPlan，供 run --beats 使用
storygen review    对已有正文单独审阅
storygen validate  对已有正文单独跑硬性规则（不调模型）
storygen repair    对已有正文定点修订一次
```

每个命令都支持 `--help` / `-h`：用法打到**标准输出**，退出码 0。
不带子命令时主用法打到**标准错误**，退出码 2。

### run

```text
storygen run --config <story.json> [--beats <beats.json>] [--model M] [--temperature T]
       [--max-attempts 1..5] [--min-score 0..100] [--no-retry-on-validation-failure]
       [--enable-repair | --no-repair] [--max-repairs 0..3]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--config` | 是 | StoryConfig JSON 文件 |
| `--beats` | 否 | 给了就是手动模式：用编辑过的 BeatPlan 直接生成 |
| `--model` / `--base-url` / `--temperature` | 否 | 覆盖服务端 LLM 设置 |
| `--max-attempts` | 否 | 1~5，缺省 2 |
| `--min-score` | 否 | 0~100，缺省 70 |
| `--no-retry-on-validation-failure` | 否 | 硬性规则不过也继续，不整篇重生 |
| `--enable-repair` / `--no-repair` | 否 | 定点修订开关，二选一 |
| `--max-repairs` | 否 | 0~3，缺省 1；0 等于关闭修订 |

开启自动重试或修订时，CLI 会先打一行提示说明这会增加 API 调用与费用。

### plan

```text
storygen plan --config <story.json> [--out <beats.json>] [--model M] [--temperature T]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--config` | 是 | StoryConfig JSON 文件 |
| `--out` | 否 | BeatPlan 输出路径，缺省 `plan_<时间戳>.beats.json` |

### review

```text
storygen review --config <story.json> --story <story.md> [--model M] [--temperature T]
```

只审阅，不重试、不写盘。`--story` 是 `putStory` 写的「`# 标题` + 空行 + 正文」格式，
CLI 会去掉 H1 标题行再送审。

### validate

```text
storygen validate --config <story.json> --story <story.md>
```

不调用模型，因此**不需要** `LLM_API_KEY`——这是唯一例外。只跑硬性规则。

### repair

```text
storygen repair --config <story.json> --beats <beats.json> --story <story.md>
         --issue-type <type> --issue-message <text> [--out <story.md>] [--model M] [--temperature T]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--config` / `--beats` / `--story` | 是 | 修订只改正文，Plan 只作上下文 |
| `--issue-type` | 是 | `length` / `ending` / `character_presence` / `continuity` / `structure` / `general` |
| `--issue-message` | 是 | 要修的问题原文 |
| `--out` | 否 | 把修订后的正文写文件；缺省只打到标准输出 |

## 参数解析规则

- 只认 `--flag value` 与布尔开关两种形式；未知 flag 一律算参数错误（退出码 2）
- 数值型 flag 解析不出有限数就是参数错误（例如 `--temperature abc`），不会静默用缺省值
- 布尔开关：`--help`、`-h`、`--enable-repair`、`--no-repair`、`--no-retry-on-validation-failure`

## 配置来源

`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT` / `LOG_LEVEL` / `RUNS_DIR`，
从 `.env` 或进程环境读取；API Key 只来自服务端 .env，不进任何产物。

CLI 与 Web UI 共用同一套 service 层：CLI 不复制业务逻辑，也不自己决定重试策略。

## 不做什么

- 不做交互式询问、不做配置文件之外的持久化偏好
- 不做彩色进度条 / 实时输出（输出是一次性的行）
- 不做 `--watch`、`--serve` 之类的常驻模式（Web UI 由 `npm run dev` 负责）

## 相关

- [API 契约](./api.md)
- [Run 产物契约](./run-artifacts.md)
- [兼容性策略](./compatibility.md)
