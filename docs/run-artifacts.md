# Run 产物契约

> 本文件是 v1.0.0 冻结的 Run 产物布局：目录层级、文件名、每层 metadata 的字段集。
> 1.x 版本不得改名、不得删文件、不得改变字段语义；扩展只能是新增文件或新增可选字段。
>
> 实现：`src/core/pipeline.ts` + `src/storage/artifact-store.ts`
> 契约测试：`tests/test_contract_artifacts.test.ts`
> 仓库样例：`examples/example_run/`

## 目录布局

```text
runs/
└── <run_id>/                          # run_id = YYYYMMDD_HHMMSS_<6位随机>
    ├── config.json                    # 本次 Run 使用的 StoryConfig（归一化后）
    ├── beats.json                     # 本次 Run 使用的 BeatPlan
    ├── story.md                       # 最终入选正文（# 标题 + 空行 + 正文）
    ├── validation.json                # 最终入选版本的校验结果
    ├── review.json                    # 最终入选版本的审阅结果
    ├── metadata.json                  # 运行级 metadata
    └── attempts/
        └── 01/                        # 第 1 次尝试，两位数字
            ├── story.md               # 该次尝试的最终正文（有修订时为修订后）
            ├── validation.json
            ├── review.json
            ├── metadata.json          # attempt 级 metadata
            ├── initial_story.md       # 只在发生过修订时出现（修订前的原文）
            └── repairs/               # 只在发生过修订时出现
                └── 01/                # 第 1 轮修订
                    ├── story.md       # 修订后的正文
                    ├── validation.json # 修订后的校验结果
                    ├── review.json    # 修订后的审阅结果
                    ├── request.json   # 修订请求（issue_type / issue_message）
                    └── metadata.json  # repair 级 metadata
```

固定规则：

- attempt 与 repair 目录名都是两位数字 `01`、`02`…（上限 99）
- 运行级目录里除了 `attempts/` 只有那六个文件，没有别的
- `validation.json` / `review.json` 可能缺失：校验或审阅自身出错时 Pipeline 只写 metadata，
  不写这两个文件（对应 API 响应里字段为 `null`、`*_status` 为 `failed`）
- 一切都是 UTF-8 文本；`.md` 是 Markdown，其余是 JSON

## 字段集

### 运行级 metadata.json

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | 目录名，同时是 API 里的标识 |
| `project_version` | string | 仓库版本号，与 `VERSION` 文件一致 |
| `status` | string | `completed` / `failed` … |
| `quality_status` | string | `accepted` / `exhausted` |
| `started_at` / `finished_at` | string (ISO 8601) | 起止时间 |
| `model` | string | 本次真正生效的模型名，始终存在 |
| `attempt_count` | number | 实际跑了几次尝试 |
| `selected_attempt` | number | 入选正文来自第几次尝试 |
| `validation_status` / `review_status` | string | `not_started` / `validating` / `completed` / `failed` |
| `repair_count` | number | 全部尝试的修订总轮数 |
| `artifacts` | object | 文件名索引：`config` / `beat_plan` / `story` / `metadata` / `validation` / `review` |

`model` 与 attempt 级的 `error` 是 v1.0.0 新固定下来的字段：以前「没有就不写」，
下游无法区分「没这个字段」和「值为空」。现在 `model` 始终是解析后的生效模型
（请求覆盖 → 环境变量 → 缺省值），attempt 的 `error` 没有错误时是 `null`。

### attempt 级 metadata.json

| 字段 | 类型 | 说明 |
|---|---|---|
| `attempt_number` | number | 第几次尝试 |
| `accepted` | boolean | 是否入选 |
| `retry_reason` | string \| null | `generation_error` / `validation_failed` / `review_score_below_threshold`；入选时是 `null` |
| `validation_passed` | boolean \| null | 硬性规则是否全过 |
| `review_score` | number \| null | 审阅分 |
| `repair_count` | number | 这次尝试里的修订轮数 |
| `repairs` | RepairRecord[] | 每轮修订的摘要记录 |
| `error` | string \| null | 这次尝试的失败原因；没出错是 `null` |

### repair 级 metadata.json

| 字段 | 类型 | 说明 |
|---|---|---|
| `repair_number` | number | 第几轮修订 |
| `issue_type` | string | 修订针对的问题类型 |
| `issue_message` | string | 问题原文（Validation issue 或 Reviewer problem） |
| `success` | boolean | 修订是否跑通 |
| `before_review_score` / `after_review_score` | number \| null | 修订前后审阅分 |
| `before_validation_passed` / `after_validation_passed` | boolean \| null | 修订前后硬性规则是否全过 |

## 安全约定

- 产物里不写 API Key、不写 Bearer token
- 错误文本会过 `src/lib/safe-text.ts`：本机绝对路径替换为 `<path>`、凭据样式的字符串打码
- `runs/` 与 `outputs/` 在 `.gitignore` 里，不进仓库；仓库里只有 `examples/example_run/` 这个合成样例

## 不做什么

- 不做跨 Run 的版本库、不做产物 diff、不做 run 重放（`ExperimentRunner` 一类能力保留给后续版本）
- 不做失败归因统计与因果图（`FailureAttribution` / `CausalGraph` 同理）
- 不写 `.tmp` 之外的中间文件；写盘是「先写临时文件再改名」的原子操作，失败会留下 `.<文件名>.tmp`

## 相关

- [StoryConfig v1 契约](./story-config.md)
- [BeatPlan v1 契约](./beat-plan.md)
- [API 契约](./api.md)
- [升级说明](./upgrade.md)
