# Run 产物契约

> 本文件是 v1.0.0 冻结的 Run 产物布局：目录层级、文件名、每层 metadata 的字段集。
> 1.x 版本不得改名、不得删文件、不得改变字段语义；扩展只能是新增文件或新增可选字段。
>
> 实现：`src/core/pipeline.ts` + `src/storage/artifact-store.ts`
> 契约测试：`tests/test_contract_artifacts.test.ts`（存在性与必填字段）、
> `tests/test_contract_docs_sync.test.ts`（本文件的字段表 ↔ 真实产物逐字段一致）
> 仓库样例：`examples/example_run/`

## 目录布局

```text
runs/
└── <run_id>/                          # run_id = YYYYMMDD_HHMMSS_<6位随机>
    ├── config.json                    # 本次 Run 使用的 StoryConfig（归一化后）
    ├── beats.json                     # 本次 Run 使用的 BeatPlan
    ├── story.md                       # 最终入选正文（# 标题 + 空行 + 正文）
    ├── validation.json                # 入选 Attempt 的首次校验结果
    ├── review.json                    # 入选 Attempt 的首次审阅结果
    ├── metadata.json                  # 运行级 metadata
    └── attempts/
        └── 01/                        # 第 1 次尝试，两位数字
            ├── story.md               # 该次尝试的最终正文（有修订时为修订后）
            ├── validation.json        # 该次尝试的首次校验结果
            ├── review.json            # 该次尝试的首次审阅结果
            ├── metadata.json          # attempt 级 metadata
            ├── initial_story.md       # 只在发生过修订时出现（修订前的原文）
            └── repairs/               # 只在发生过修订时出现
                └── 01/                # 第 1 轮修订
                    ├── story.md       # 修订后的正文
                    ├── validation.json # 修订后的校验结果
                    ├── review.json    # 修订后的审阅结果
                    ├── request.json   # 修订请求（repair_number / issue_type / issue_message）
                    └── metadata.json  # repair 级 metadata
```

固定规则：

- attempt 与 repair 目录名都是两位数字 `01`、`02`…（上限 99）
- 运行级目录里除了 `attempts/` 只有那六个文件，没有别的
- `validation.json` / `review.json` 可能缺失：校验或审阅自身出错时 Pipeline 只写 metadata，
  不写这两个文件（对应 API 响应里字段为 `null`、`*_status` 为 `failed`）
- 一切都是 UTF-8 文本；`.md` 是 Markdown，其余是 JSON
- 写盘是「先写 `.名字.tmp` 再 rename」的原子操作：写失败可能留下 `.metadata.json.tmp`
  这样的临时文件，读产物的一方应当忽略

## 字段集

每层 metadata 写的都是「那一刻已知的状态」，所以同一个字段在不同路径里可能出现、也可能
不出现。下面三张表按「该文件最终留下什么」列全字段，出现条件一栏标出差异；
合同测试 `tests/test_contract_docs_sync.test.ts` 会把这三张表与真实产物逐个字段双向比对，
多写、漏写、改名都会让测试红。

### 运行级 metadata.json

| 字段 | 类型 | 出现条件 | 说明 |
|---|---|---|---|
| `run_id` | string | 必有 | 目录名，同时是 API 里的标识 |
| `project_version` | string | 必有 | 仓库版本号，与 `VERSION` 文件一致 |
| `status` | string | 必有 | 运行阶段：`planning` / `generating` / `saving` / `validating` / `reviewing` / `repairing` / `revalidating` / `rereviewing` / `completed` / `failed` |
| `current_stage` | string | 必有 | 写这份 metadata 时正处于的阶段，比 `status` 更细（例如 `Attempt 2 — Repairing`）；失败时 `status` 是 `failed`，这里留着失败发生的阶段 |
| `started_at` / `finished_at` | string (ISO 8601) | `started_at` 必有；`finished_at` 只在 `completed` / `failed` | 起止时间 |
| `model` | string | 必有 | 本次真正生效的模型名（请求覆盖 → 环境变量 → 缺省值） |
| `max_attempts` / `min_review_score` / `enable_repair` / `max_repairs_per_attempt` | number / number / boolean / number | 必有 | 本次生效的重试与修订策略快照，中断后也看得出当时允不允许修 |
| `attempt_count` | number | 重试循环结束后 | 实际跑了几次尝试 |
| `repair_count` | number | 重试循环结束后 | 全部 Attempt 的修订总轮数 |
| `selected_attempt` | number | 重试循环结束后 | 入选正文来自第几次尝试；全部未达标时是最后一次 |
| `quality_status` | string | 重试循环结束后 | `accepted` / `exhausted` |
| `validation_status` / `review_status` | string | 对应阶段跑到过 | `not_started` / `validating` / `reviewing` / `completed` / `failed` |
| `validation_passed` | boolean | 入选版本有校验结论 | 硬性规则是否全过 |
| `validation_issue_count` | number | 入选版本有校验结论 | 问题条数 |
| `review_score` | number | 入选版本有审阅结论 | 审阅总分 |
| `validation_error` / `review_error` | string | 校验或审阅自身抛异常 | 组件自身失败的原因（已过 `safe-text`）；正文不达标不算 |
| `error` | string | Run 失败 | Run 级失败原因，已过 `safe-text`；成功时整个字段不出现 |
| `artifacts` | object | 必有 | 文件名索引：`config` / `beat_plan` / `story` / `metadata`，有结论时再加 `validation` / `review` |

运行级 `metadata.json` 是**整体快照**：每次阶段推进都整份重写，不与上一次合并。因此在中断
现场读到的 metadata 还可能带着过程态字段（例如 Attempt 刚开始时的 `attempt_number`），
上表是 Run 走到 `completed` / `failed` 之后的字段集。

### attempt 级 metadata.json

| 字段 | 类型 | 出现条件 | 说明 |
|---|---|---|---|
| `attempt_number` | number | 必有 | 第几次尝试 |
| `accepted` | boolean | 必有 | 这一次是否满足 RetryPolicy 并入选 |
| `retry_reason` | string \| null | 必有 | `generation_error` / `validation_failed` / `review_score_below_threshold`；入选时是 `null` |
| `validation_passed` | boolean \| null | 必有 | **修订后**的硬性规则结论；没跑到校验就是 `null` |
| `review_score` | number \| null | 必有 | **修订后**的审阅分；没跑到审阅就是 `null` |
| `validation_status` / `review_status` | string | 必有 | 同上，对应那一路的阶段状态 |
| `repair_count` | number | 必有 | 这次 Attempt 里的修订轮数 |
| `repairs` | RepairRecord[] | 必有 | 每轮修订的记录；没有修订时是空数组 |
| `error` | string \| null | 必有 | 这次尝试的失败原因；没出错是 `null`（v1.0.0 固定语义） |
| `validation_error` / `review_error` | string | 校验或审阅自身抛异常 | 只在该路组件失败时出现，内容同运行级同名字段 |

`repairs[]` 的每个元素比 `repairs/NN/metadata.json` 多三个字段：`issue_message`（问题原文）、
`before_validation` 与 `after_validation`（完整的校验结论，不只是布尔值）；另外两个
`*_validation_passed` 布尔值是由这两个对象派生的，只出现在 `repairs/NN/metadata.json` 里。

### repair 级 metadata.json

| 字段 | 类型 | 出现条件 | 说明 |
|---|---|---|---|
| `repair_number` | number | 必有 | 第几轮修订 |
| `issue_type` | string | 必有 | 这次修订针对的问题类型，六类之一 |
| `success` | boolean | 必有 | 修订后重新校验 + 审阅是否满足策略；修订调用本身没跑通也是 `false` |
| `before_review_score` / `after_review_score` | number \| null | 必有 | 修订前后的审阅分；那一轮没有审阅结论就是 `null` |
| `before_validation_passed` / `after_validation_passed` | boolean \| null | 必有 | 修订前后的硬性规则结论；那一轮没校验就是 `null` |

同目录的 `request.json` 是修订请求，字段为 `repair_number` / `issue_type` / `issue_message`
三个——`issue_message` 属于 `request.json`，不写进 `metadata.json`。

### 首次结论与修订后结论（刻意的不对称）

**这是 0.x 留下的行为，v1.0.0 选择保持现状，不属于需要修的不一致：**

- `metadata.json` 里的 `validation_passed` / `validation_issue_count` / `review_score`
  取**修订后**的结论（修订彻底失败时退回到修订前那一轮）；
- 而各级目录下的 `validation.json` / `review.json` 文件是**首次**结论——修订后的那份
  写在 `repairs/NN/validation.json` 与 `repairs/NN/review.json`；
- `story.md` 则是修订后的版本，修订前的原文另外留在 `attempts/NN/initial_story.md`。

所以「同一次 Attempt 里 `metadata.json` 的 `review_score` 与 `review.json` 的 `score` 可能不同」
是**设计如此**，仓库样例 `examples/example_run/` 就是这个形态（metadata 记修订后的分数，
`review.json` 是修订前那次审阅）。1.x 内不改这个语义，详见
[compatibility.md](./compatibility.md) 的「已知的不对称」。

## 安全约定

- 产物里不写 API Key、不写 Bearer token
- 错误文本会过 `src/lib/safe-text.ts`：本机绝对路径替换为 `<path>`、凭据样式的字符串打码
- `runs/` 与 `outputs/` 在 `.gitignore` 里，不进仓库；仓库里只有 `examples/example_run/` 这个合成样例

## 不做什么

- 不做跨 Run 的版本库、不做产物 diff、不做 run 重放（`ExperimentRunner` 一类能力保留给后续版本）
- 不做失败归因统计与因果图（`FailureAttribution` / `CausalGraph` 同理）
- 不写 `.tmp` 之外的中间文件（原子写入产生的临时文件见上面的「固定规则」）

## 相关

- [StoryConfig v1 契约](./story-config.md)
- [BeatPlan v1 契约](./beat-plan.md)
- [API 契约](./api.md)
- [升级说明](./upgrade.md)
