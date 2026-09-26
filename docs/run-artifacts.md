# Run 产物契约

> 本文件是 v1.0.0 冻结的 Run 产物布局：目录层级、文件名、每层 metadata 的字段集。
> 1.x 版本不得改名、不得删文件、不得改变字段语义；扩展只能是新增文件或新增可选字段。
>
> v1.2.0 在这一约束下新增了 `quality.json`（Run 根 + 每个 attempt）与三个 metadata 字段：
> `quality_assembly_status` / `overall_score` / `quality_issue_count`。都是纯新增，
> 没有任何旧字段改名或改语义。
>
> v1.3.0 在原有约束下给 `review.json` 与 `quality.json` 各多了一个**可选**字段：
> `dimensions`（四个基础维度的分数与短评）。审阅没给维度时整个键不出现，
> 没有维度的旧 Run 照常读取。
>
> v1.5.0 在这一约束下新增了 `commercial-review.json`（Run 根 + 每个 attempt）与三个
> 运行级 metadata 字段：`commercial_review_status` / `commercial_score` /
> `commercial_review_error`。商业可读性审阅与结构审阅是**两份独立的结论**，
> 不是 `review.json` 改名，也不改 `quality.json` 的任何一个字段。
>
> v1.6.0 在这一约束下新增了 `run-manifest.json`（只在 Run 根目录一份）与两个 API 字段
> `manifest`（POST /api/runs 与 GET /api/runs/{id} 各一个）。它是这次 Run 的**出身清单**，
> 自带 `schemaVersion`，用 camelCase——与 v1.0.0 冻结的 snake_case metadata 契约物理隔离，
> 改它不需要动任何既有字段的语义。
>
> v1.8.0 在这一约束下新增了 `telemetry.json`（只在 Run 根目录一份）与两个 API 字段
> `telemetry`（`GET /api/runs/<run_id>/telemetry` 与 Run 详情各一个），实验汇总里每个变体
> 另多一个 `efficiency`。它是这次 Run 的**执行过程**——阶段耗时、模型调用次数、Retry /
> Repair 计数、失败阶段、真实可得的 usage / cost。同样自带 `schemaVersion`、用 camelCase。
> 字段表、计数语义与「拿不到就是 null」的记法见 [telemetry.md](./telemetry.md)。
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
    ├── beat-validation.json           # BeatPlan 的结构校验结论（v1.4.0 新增；没跑到或校验器自身失败时缺失）
    ├── story.md                       # 最终入选正文（# 标题 + 空行 + 正文）
    ├── validation.json                # 入选 Attempt 的首次校验结果
    ├── review.json                    # 入选 Attempt 的首次审阅结果（v1.3.0 起可能带维度）
    ├── commercial-review.json         # 入选 Attempt 的商业可读性结论（v1.5.0 新增；跳过或审阅自身失败时缺失）
    ├── quality.json                   # 入选 Attempt 的统一质量快照（v1.2.0 新增）
    ├── metadata.json                  # 运行级 metadata
    ├── run-manifest.json               # 这次 Run 的出身清单（v1.6.0 新增；只在 Run 根目录一份）
    ├── telemetry.json                 # 这次 Run 的执行过程（v1.8.0 新增；只在 Run 根目录一份）
    └── attempts/
        └── 01/                        # 第 1 次尝试，两位数字
            ├── story.md               # 该次尝试的最终正文（有修订时为修订后）
            ├── validation.json        # 该次尝试的首次校验结果
            ├── review.json            # 该次尝试的首次审阅结果（v1.3.0 起可能带维度）
            ├── quality.json           # 该次尝试的统一质量快照（v1.2.0 新增）
            ├── commercial-review.json # 该次尝试最终那一版正文的商业可读性结论（v1.5.0 新增）
            ├── metadata.json          # attempt 级 metadata
            ├── initial_story.md       # 只在发生过修订时出现（修订前的原文）
            └── repairs/               # 只在发生过修订时出现
                └── 01/                # 第 1 轮修订
                    ├── story.md       # 修订后的正文
                    ├── validation.json # 修订后的校验结果
                    ├── review.json    # 修订后的审阅结果（v1.3.0 起可能带维度）
                    ├── request.json   # 修订请求（repair_number / issue_type / issue_message）
                    └── metadata.json  # repair 级 metadata
```

固定规则：

- attempt 与 repair 目录名都是两位数字 `01`、`02`…（上限 99）
- 运行级目录里除了 `attempts/` 只有那十一个文件，没有别的
- `run-manifest.json`（v1.6.0 新增）与 `telemetry.json`（v1.8.0 新增）都**只在 Run 根目录
  一份**：`attempts/` 与 `repairs/` 下都没有它们。清单里登记的产物路径可以指向这两层，
  但它自己不出现在自己登记的条目里（记不了自己的摘要），也不登记任何 `metadata.json`——
  那三层文件由 metadata 契约负责，清单只管「跑了什么」；遥测则反过来只管「怎么跑的」，
  不登记任何正文或提示词内容
- `beat-validation.json`（v1.4.0 新增）是**运行级独有**的一份：BeatPlan 在第一个 Attempt
  之前校验一次，`attempts/` 与 `repairs/` 下都没有它。骨架结构带 `error` 级 issue 时 Run
  在这里就结束了，此时运行级目录只有 `config.json` / `beats.json` /
  `beat-validation.json` / `metadata.json` 四个文件
- `validation.json` / `review.json` 可能缺失：校验或审阅自身出错时 Pipeline 只写 metadata，
  不写这两个文件（对应 API 响应里字段为 `null`、`*_status` 为 `failed`）。
`beat-validation.json` 同理：Beat 校验器自身抛异常时不写这个文件，但
`beat_validation_error` 会记下原因——**骨架不达标不算错误**，那种情况文件照常写。
`commercial-review.json`（v1.5.0 新增）同样如此：商业可读性审阅自身出错时只写
`commercial_review_error`，不写这个文件；正文、`validation.json` / `review.json`
与 v1.2.0 起新增的 `quality.json` 都不受这个影响：
装配只需要 validation 与采纳结论，Review 失败时照样落盘，只是 `overall_score` 与 `summary`
为 `null`
- 修订目录 `repairs/NN/` 固定五个文件，**不写** `quality.json`：attempt 级那份快照取的
  已经是修订后的结论，Revision 级的同一份内容没有读者（见下面「统一质量快照」）
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
| `status` | string | 必有 | v1.5.1 起按 `RunStatus` 逐字列全：`created` / `planning` / `validating_beat_plan` / `generating` / `saving` / `validating` / `reviewing` / `reviewing_commercial` / `repairing` / `revalidating` / `rereviewing` / `completed` / `failed`（此前漏了最前面两个，实际会出现在第一次推进阶段之前与 BeatPlan 结构校验期间） |
| `current_stage` | string | 必有 | 写这份 metadata 时正处于的阶段，比 `status` 更细（例如 `Attempt 2 — Repairing`）；失败时 `status` 是 `failed`，这里留着失败发生的阶段 |
| `started_at` / `finished_at` | string (ISO 8601) | `started_at` 必有；`finished_at` 只在 `completed` / `failed` | 起止时间 |
| `model` | string | 必有 | 本次真正生效的模型名（请求覆盖 → 环境变量 → 缺省值） |
| `max_attempts` / `min_review_score` / `enable_repair` / `max_repairs_per_attempt` | number / number / boolean / number | 必有 | 本次生效的重试与修订策略快照，中断后也看得出当时允不允许修 |
| `attempt_count` | number | 重试循环结束后 | 实际跑了几次尝试 |
| `repair_count` | number | 重试循环结束后 | 全部 Attempt 的修订总轮数 |
| `selected_attempt` | number | 重试循环结束后 | 入选正文来自第几次尝试；全部未达标时是最后一次 |
| `quality_status` | string | 重试循环结束后 | `accepted` / `exhausted` |
| `quality_assembly_status` | string | 装配出统一质量快照时 | v1.2.0 新增：`completed`。只表示快照装配完成，与 `quality_status` 的采纳结论是两件事，所以另起这个名字 |
| `overall_score` | number \| null | 同上 | v1.2.0 新增：统一快照里的总分，等于入选版本的整体分（v1.3.0 起审阅给了四个维度时就是四维均分）；没有审阅结论就是 `null`，不由代码自己补分 |
| `quality_issue_count` | number | 同上 | v1.2.0 新增：统一快照里 issues 的条数（校验问题 + 审阅问题） |
| `validation_status` / `review_status` | string | 对应阶段跑到过 | `not_started` / `validating` / `reviewing` / `completed` / `failed` |
| `validation_passed` | boolean | 入选版本有校验结论 | 硬性规则是否全过 |
| `validation_issue_count` | number | 入选版本有校验结论 | 问题条数 |
| `review_score` | number | 入选版本有审阅结论 | 审阅整体分：v1.3.0 起有维度时是四维均分，否则就是 `review.score`（与 `overall_score` 同一个口径） |
| `validation_error` / `review_error` | string | 校验或审阅自身抛异常 | 组件自身失败的原因（已过 `safe-text`）；正文不达标不算 |
| `beat_validation_status` | string | 必有 | v1.4.0 新增：`not_started` / `validating` / `completed` / `failed`。**始终落盘**——没注入校验器、或 Run 在写正文之前就失败时也是 `not_started`，读 metadata 就看出这一步到底跑没跑过（v1.5.1 修正此前「跑到过」的写法） |
| `beat_validation_passed` | boolean | 有结构校验结论 | v1.4.0 新增：结论里有没有 error 级问题（只有 warning 也算通过） |
| `beat_validation_issue_count` | number | 有结构校验结论 | v1.4.0 新增：命中了几条结构规则 |
| `beat_validation_error` | string | Beat 校验器自身抛异常 | v1.4.0 新增：校验器自身失败的原因；**骨架不达标不算错误**，那种情况 `beat_validation_passed` 是 `false`、这个字段不出现 |
| `commercial_review_status` | string | 必有 | v1.5.0 新增：`not_started` / `reviewing` / `completed` / `failed`。与 `review_status` 是两条独立的路，谁也不挡谁。**始终落盘**：这一步自己失败了是 `failed`、跑成了是 `completed`、一次都没跑到（没注入审阅者，或 Run 在正文之前就失败）才是 `not_started`——v1.5.1 修正了此前失败路径一律写成 `not_started` 的写法，那时连 attempts/01/ 里那份商业结论都会被这个字段否认 |
| `commercial_score` | number | 有商业可读性结论 | v1.5.0 新增：四个维度（Hook / Pacing / Engagement / Payoff）的均分，与 `commercial-review.json` 里的 `score`、API 的 `commercial_review.score` 同一个口径；这一步没跑成时整个字段不出现 |
| `commercial_review_error` | string | 商业审阅者自身抛异常 | v1.5.0 新增：这一步自身失败的原因；**商业分低不算错误**，那种情况结论照常落盘、这个字段不出现 |
| `error` | string | Run 失败 | Run 级失败原因，已过 `safe-text`；成功时整个字段不出现 |
| `duration_ms` / `llm_call_count` | number / number | Run 收尾后（`completed` 与 `failed` 都有） | v1.8.0 新增：从同一次 Run 的 `telemetry.json` 转述来的两个摘要数（全程毫秒数、逻辑 LLM 调用次数）。**主数据源是 telemetry.json**，这里只是转述；遥测本身不可用时这两个键不出现，绝不补 0 |
| `artifacts` | object | 必有 | 文件名索引，键序即 `artifactsOf` 的写入序：`config` / `beat_plan` / `story` / `metadata`，有结论时再加 `beat_validation` / `validation` / `review` / `quality` / `commercial_review`（v1.5.1 修正此前把 `commercial_review` 排在 `quality` 前的写法） |

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
| `review_score` | number \| null | 必有 | **修订后**的审阅整体分（同上口径）；没跑到审阅就是 `null` |
| `validation_status` / `review_status` | string | 必有 | 同上，对应那一路的阶段状态 |
| `repair_count` | number | 必有 | 这次 Attempt 里的修订轮数 |
| `repairs` | RepairRecord[] | 必有 | 每轮修订的记录；没有修订时是空数组 |
| `quality_assembly_status` | string | 该次尝试装配出快照时 | v1.2.0 新增：与运行级同名字段同口径，`completed` |
| `overall_score` / `quality_issue_count` | number \| null / number | 同上 | v1.2.0 新增：该次尝试的快照总分与问题条数，取**修订后**的结论 |
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
| `before_review_score` / `after_review_score` | number \| null | 必有 | 修订前后的审阅整体分（同上口径）；那一轮没有审阅结论就是 `null` |
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

### 统一质量快照（v1.2.0，v1.3.0 增加可选维度）

`quality.json` 是**新增的统一层**，不是 `review.json` 改名，也不替代任何已有产物。它由
`QualityAssembler` 从已有的「最终校验结论 + 最终审阅结论 + 采纳结论」确定性装配（「最终」=
这次尝试最后留下的那一版：发生过修订时取修订目录里的那份，见下面「快照取哪一轮的结论」），
不调用 LLM、不读文件系统、不引入新阈值——同一个输入永远得到同一份快照。字段为
`overall_score` / `validation_passed` / `accepted` / `issues` / `suggestions` / `summary`，
v1.3.0 起审阅给了四个基础维度时再多一个可选的 `dimensions`（由 `ReviewResult.dimensions`
原样搬运，不改分、不补维度），详见 [api.md](./api.md) 的 `quality` 字段。

维度只影响「看得见多少」，不影响「怎么决策」：`overall_score` 与各级 `review_score`
在有维度时一律取四维均分（同一个口径，见 [api.md](./api.md)），而 `RetryPolicy` 仍然只有
`min_review_score` 一个总分门槛，没有按维度设的阈值，也没有维度驱动的重试或修订。

快照取哪一轮的结论：

- 运行级与 attempt 级的 `quality.json` 记的是**修订后**的结论，与同目录 `metadata.json`
  的 `overall_score` / `quality_issue_count`、与最终入选的 `story.md` 严格对齐；
- 同目录的 `review.json` / `validation.json` 仍是**首次**结论（沿用上面的刻意不对称）。
  因此 Run 根目录可能出现「`review.json` 分数 41、`quality.json` 分数 82」——
  与「`metadata.json` 分数 82、`review.json` 分数 41」是同一条规则；
- 入选 Attempt 的 `quality.json` 通过 promote 流程复制到 Run 根目录（与 `story.md` 等
  同一套机制），所以根目录那份与入选正文一一对应；
- `repairs/NN/` 不写 `quality.json`：attempt 级那份已经是修订后的快照，再写一份内容相同
  的历史文件没有读者。

1.2.0 之前产生的 Run 没有 `quality.json`，读接口按同一套规则临时装配兜底（
[compatibility.md](./compatibility.md)），磁盘上不会补写。v1.2.0 的这个兜底原先取的是
attempt 目录下的**首次**结论，于是旧 Run 装配出的分数描述的是修订前那一版正文；1.2.1 起改成
与落盘口径一致的「最终那一版」，读到的 `quality` 与同一次尝试的 `metadata.json` 对齐。

### BeatPlan 结构校验结论（v1.4.0 新增）

`beat-validation.json` 记录 BeatPlan 在写正文之前那一道结构校验的结论，字段为
`passed` / `issues` / `summary`（`BeatValidationResult`）。它在 Run 根目录**只出现一次**：
BeatPlan 只校验一次，不随重试重跑，`attempts/` 与 `repairs/` 下都没有它。

`BeatValidationIssue`：`code`、`severity`（`warning` / `error`，只有两级）、`message`、
可选的 `beat_ids`（定位到哪些拍）。**没有任何与「怎么改」有关的字段**——
没有 `fixed_beats`、没有 `rewritten_plan`、没有 `suggested_plan`：校验只报告，不修复，
不改写、不重排、不补拍任何一拍。

`passed` 为 `true` 当且仅当没有 `severity: "error"` 的 issue，warning 级问题照样通过。
不通过时 Run 在写正文之前结束（`status: "failed"`、`current_stage: "validating_beat_plan"`），
此时运行级目录只有 `config.json` / `beats.json` / `beat-validation.json` /
`metadata.json` 四个文件——**没有** `story.md`，也**没有** `attempts/`。

结论对应的四个运行级 metadata 字段（`beat_validation_status` / `beat_validation_passed` /
`beat_validation_issue_count` / `beat_validation_error`）见上面「运行级 metadata.json」表；
注意 `beat_validation_error` 只在**校验器自身**抛异常时出现，骨架不达标不算错误。

### 商业可读性结论（v1.5.0 新增）

`commercial-review.json` 记录与结构审阅**并列的第二个独立结论**，字段为 `score` /
`summary` / `strengths` / `problems` / `suggestions` / `dimensions`。两个审阅者各自只干
一件事：结构审阅（`review.json`）看有效性与内在质量，商业审阅看读者的可读性（开篇抓力、
节奏、持续阅读动力、回报），互不合成、互不覆盖、也不引用对方的结论。

`dimensions` 固定四个键，缺一个就不是合法结论（读接口会当坏数据处理，返回 `null`）：

| 键 | 记号 | 看什么 |
|---|---|---|
| `hook` | H | 开篇抓力、冲突进入速度 |
| `pacing` | P | 阅读节奏、拖沓与推进速度 |
| `engagement` | E | 全篇持续的阅读动力 |
| `payoff` | Pf | 高潮与结尾对前文承诺的回报 |

每个维度是 `{score, summary}`，分数 0 ~ 100。`score`（整体分）= 四个维度的算术均分，
由代码按 `(H + P + E + Pf) / 4` 重算后落盘（四舍五入到一位小数）：模型必须自报一个 `score`
（缺了算格式错误），但**模型自报的数值不作为最终口径**——与 `review.json` 的
`reviewOverallScore` 同一套「重新聚合、不轻信模型」的规则。没有按题材 / 动态 / 学习权重
调过分，同一个输入永远得到同一个整体分。

落盘位置与生效规则：

- `attempts/NN/commercial-review.json` 描述**该次尝试最终留下的那一版 `story.md`**：
  发生过修订时就是修订后的版本（先修订、后商业审阅），不会留下描述旧正文的脏数据；
- 入选 Attempt 的那一份通过 promote 流程复制到 Run 根目录，与根目录 `story.md` 严格同版；
- `repairs/NN/` 下**没有** `commercial-review.json`：一次修订只跑一次商业审阅，
  修订目录里多一份内容相同的副本没有读者；
- 没有注入 `CommercialReviewer`（或这一步被跳过）时这一步等于不存在：不写文件、
  `commercial_review_status` 是 `not_started`，API 返回 `null`，UI 面板整个隐藏。

**商业分不驱动任何自动动作**：`RetryPolicy` 只有 `min_review_score` 一个门槛（只看结构
审阅分），`RepairStrategy` 也只依据校验与结构审阅结论选修订点。商业分低不会触发重试，
也不会触发定点修订——它只写在产物里、显示在 UI 上，供人判断。同理，产物与界面上的措辞
只描述可读性，没有任何「必火 / 爆款概率 / 市场成功率 / 签约概率 / 销量预测」一类市场化
预言。

v1.5.0 之前产生的 Run 没有 `commercial-review.json`：读接口返回 `null`、status 兜底
`not_started`，磁盘上不会补写（[compatibility.md](./compatibility.md)）。

### 运行级 run-manifest.json（v1.6.0 新增）

`run-manifest.json` 回答一个问题：**这份故事是拿什么跑出来的？** 它把一次 Run 的版本、
模型、参数、提示词、每次 Attempt 的结局与落盘产物的摘要汇成一份清单，放在 Run 根目录
（`metadata.json` 旁边，**只有一份**）。它是新增文件，不顶替 `metadata.json`，也不改
`metadata.json` 的任何一个字段——三层 metadata 契约一字未动。

清单自带 `schemaVersion`，字段是 camelCase——与 v1.0.0 冻结的 snake_case metadata
契约物理隔离，将来扩展清单不需要碰既有字段的语义。

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 清单元数据版本，当前为 `"1"` |
| `runId` | 与 `metadata.json` 的 `run_id` 一致 |
| `project` | `{version, commit}`：`version` 来自包版本，`commit` 只在能拿到 git SHA 时才有 |
| `models` | 本次 Run 实际用到的模型条目（generation / repair 等，按阶段） |
| `prompts` | 六个提示词文件各自的 `version` 与内容 `digest` |
| `parameters` | 各阶段 temperature 与本次生效的 `RetryPolicy` 参数 |
| `attempts` | 每次 Attempt 的编号、是否入选、重试原因，以及该次发生的修订 |
| `artifacts` | 清单登记的全部产物的路径与 SHA-256 摘要 |

三条硬规则：

- **不重复内容**：清单登记「跑了什么」，不搬运故事正文、审阅结论的任何文字。
- **不碰凭据**：只记模型名、provider 与 baseUrl 的分类（服务器配置 / 请求公有覆盖），
  **baseUrl 原文不落盘**；`topP` / `maxTokens` 这类本次客户端没有下发的字段一律不写。
- **不是实验框架**：清单只为一次 Run 自证出身，不做跨 Run 对比、不跑基准、不统计成功率。

读接口把 manifest 原样挂在 `manifest` 字段里（没有清单的旧 Run 返回 `null`），界面折叠成
一个面板，列出版本 / 模型 / 参数 / 每次 Attempt，摘要一律截断显示。

## 安全约定

- 产物里不写 API Key、不写 Bearer token
- 错误文本会过 `src/lib/safe-text.ts`：本机绝对路径替换为 `<path>`、凭据样式的字符串打码
- `runs/` 与 `outputs/` 在 `.gitignore` 里，不进仓库；仓库里只有 `examples/example_run/` 这个合成样例
- `run-manifest.json` 里的模型条目只含模型名 / provider / baseUrl 分类，没有 baseUrl 原文、
  没有 key、没有 Authorization 头；登记不到的产物不写占位行
- `telemetry.json`（v1.8.0 新增）里没有 API Key、没有 Authorization / Cookie / 原始请求头、
  没有 `process.env` 原文、没有正文与 Prompt；异常只降级成一个稳定 `errorCode`，
  异常原文一个字都不落盘（明细见 [telemetry.md](./telemetry.md)）

## 不做什么

- 不做跨 Run 的版本库、不做产物 diff、不做 run 重放（`ExperimentRunner` 一类能力保留给后续版本）
- 不做失败归因统计与因果图（`FailureAttribution` / `CausalGraph` 同理）
- `run-manifest.json` 不做基准对比、不统计成功率、不做自适应调参（`BenchmarkRunner` /
  `AdaptiveGeneration` / `SelfOptimization` 一类能力保留给后续版本）
- `telemetry.json`（v1.8.0 新增）不做跨 Run 聚合、不设阈值、不出告警，也不据此改变任何生成
  行为：它只回答「这次怎么跑的」，不回答「为什么失败」
- `quality.json` 只是把已有结论汇到一起：不额外打分、不设 PASS/FAIL 阈值、不做多维评分
- 不写 `.tmp` 之外的中间文件（原子写入产生的临时文件见上面的「固定规则」）

## 相关

- [StoryConfig v1 契约](./story-config.md)
- [BeatPlan v1 契约](./beat-plan.md)
- [API 契约](./api.md)
- [Run Telemetry 契约（v1.8.0）](./telemetry.md)
- [升级说明](./upgrade.md)
