# Storyloop · AI 短篇生成引擎

> 一个稳定的 AI 短篇小说生成引擎：剧情规划、硬性校验、基础审阅、确定性自动重试与定点修订。
> A stable pipeline-based AI short-story generator: beat planning, hard validation, basic review,
> deterministic automatic retry, and targeted story repair.
>
> **v1.0.0 是冻结版本（Stable Generation Engine）。** 它没有新增智能能力，
> 而是把已经能跑的每一条契约写成公开承诺：StoryConfig v1、BeatPlan v1、Run 产物布局、
> HTTP API、CLI、运行时默认值、错误 schema，并用合同测试看守，用文档固定下来。
> 从这里开始，「能用什么」和「不能用什么」都有明确答案。

## 快速开始

```bash
node --version       # 需要 >= 20.9.0
npm install
cp .env.example .env # 填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev          # http://localhost:3000
```

命令行生成、校验与审阅（与 UI / API 共用同一条 GenerationPipeline）：

```bash
# 一次完整 Run：StoryConfig → Plan → Generate → Save Story → Validate → Review（自动重试最多再生成一次）
npx tsx scripts/generate-cli.ts run --config configs/example_story.json

# 手动模式：先单独规划，人工编辑 beats.json 后再生成
npx tsx scripts/generate-cli.ts plan --config configs/example_story.json --out beats.json
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats beats.json

# 自定义重试策略：最多 3 次尝试、总分阈值 80、校验失败不重试
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --max-attempts 3 --min-score 80 --no-retry-on-validation-failure

# 开启定点修订：Attempt 不过时先按具体问题修订，再重新校验 / 审阅，修订失败才整篇重生
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --enable-repair --max-repairs 2

# 只校验一段已有正文（不生成、不审阅）
npx tsx scripts/generate-cli.ts validate --config configs/example_story.json --story story.md
```

退出码固定为三个值：`0` 正常结束（含校验不通过与 `exhausted`）、`1` 运行时失败、
`2` 参数或配置不合法。每个子命令都有自己的 `--help`。
想看清产物长什么样，看仓库里的 [examples/example_run/](examples/example_run/)——那是用假模型跑出来的一次完整 Run。

## 当前能力

一次完整生成就是一个 **Run**，固定顺序：

```text
StoryConfig → Planning →〔Attempt 1..max_attempts: Generate → Save Story → Validate → Review → Repair? → Decide〕→ Finalize
```

- **AI Beat Planning**：先生成剧情骨架（BeatPlan），再据此写正文；骨架可手动编辑后进入生成
- **Story Validator（硬性有效性检查）**：正文落盘后立即跑一遍确定性规则，回答「这篇正文基本可用吗」
- **Basic AI Reviewer**：每次生成的正文自动获得一次基础审阅，产出 0–100 单一总分
- **Automatic Retry（自动重试）**：生成失败、校验不通过或总分低于阈值时按确定性策略重新生成
- **Targeted Story Repair（定点修订）**：Attempt 不通过时先按具体问题类别改写这篇正文，
  修订后再校验、再审阅；修订彻底失败才退回整篇重新生成
- **Run Artifacts**：产物统一落在 `runs/<run_id>/`，每次 Attempt、每次修订单独归档
- **现代 Web UI**：六阶段进度、Attempt 计数、修订明细、Validation / Review 面板、Run ID 与产物清单
- **OpenAI-compatible LLM**：OpenAI / DeepSeek / 硅基流动 / 任意兼容端点
- **可编辑 Prompt 模板**：`prompts/*.txt` 直接改，重启生效
- **稳定 CLI**：`run` / `plan` / `review` / `validate` / `repair` 五个命令，与 API 共用同一套逻辑

> **Validator 与 Reviewer 是两件事**：
>
> | | Story Validator | Basic Reviewer |
> |---|---|---|
> | 回答的问题 | 「这篇正文基本可用吗」 | 「这篇故事写得好吗」 |
> | 实现 | 确定性规则，不调用 LLM | LLM 审阅，主观评价 |
> | 产出 | `ValidationResult`（`passed` + `issues`） | `ReviewResult`（`score` + `summary` + `strengths` + `problems`） |
> | 判定性质 | 硬性：`error` 即不通过 | 软性：分数只做反馈 |
>
> 两者互不影响：**Review 分数不参与 Validation 判定**——哪怕 Review 打 0 分，校验该过还是过。

> **定点修订在整篇重试之前**：修订策略是纯函数（问题类别只由校验 issue code 或审阅问题文本推出，
> 没有模型参与、没有打分、没有择优），重试同样由确定性策略驱动，没有学习、没有自适应：
> 同样的输入得到同样的重试次数。修订只回答「这篇正文哪里不对、按类别改一次」，不回答「为什么会失败」。
>
> 后端没有任何为未实现能力预留的隐藏接口——没有的功能就没有入口。

## 架构

```
┌──────────────────────────────────────────┐
│  横切：app-config · logger · api-error    │  配置单一来源 · 带 run_id 的结构化日志 · 统一错误形状
└──────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│  UI ／ CLI           │  StoryConfig 表单 + Save / Load / New · generate-cli run
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Run API            │  POST /api/runs · POST /api/runs/from-plan · POST /api/validate · POST /api/review
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────┐
│  generate-service                        │  CLI 与 API 共用同一批函数，不重复实现业务逻辑
└──────────┬───────────────────────────────┘
           ▼
┌──────────────────────┐
│  GenerationPipeline  │  固定顺序：Config → Planning →〔Attempt 1..max_attempts: Generate → Save Story → Validate → Review → Repair? → Decide〕→ Finalize
│  · run()             │  StoryConfig → BeatPlan → Story → ValidationResult → ReviewResult
│  · runWithPlan()     │  用户编辑后的 BeatPlan 直接进入生成
│  · RetryPolicy       │  max_attempts / min_review_score / retry_on_validation_failure / enable_repair / max_repairs_per_attempt
│  · RepairLoop        │  定点修订在整篇重试之前：Repair → Re-validate → Re-review → 仍不达标才重试
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   RunContext         │  run_id + status + current_stage + error
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  BeatPlanner         │  prompts/beat_planner.txt → LLM → BeatPlan（可手动编辑）
│  StoryGenerator      │  prompts/story.txt 渲染（含 Beat Plan）
│  StoryValidator      │ 确定性硬性规则 → ValidationResult（不调用 LLM，只检查，不改写）
│  BasicReviewer       │  prompts/reviewer.txt → LLM → ReviewResult（只评价，不改写）
│  StoryRepairer       │  prompts/repair.txt → LLM → 修订后正文（可选，不注入则无修订能力）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│      LLM Client      │  OpenAI-compatible（system + user）· 单次超时 LLM_TIMEOUT · transport retry 硬上限 2 次
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    ArtifactStore     │  原子写入 runs/<run_id>/ 下的产物，写失败抛 ArtifactWriteError
└──────────────────────┘
```

正文先落盘再校验、再审阅：即使 Validator 自身抛异常或 Reviewer 调用失败 / 输出非法，
`story.md` 与整个 Run 都保持成功，只有对应的 `validation_status` / `review_status` 变为 `failed` 并记录原因。

一次 Attempt 之后的 RetryDecision 只由确定性规则给出：(1) 生成失败且还有次数 → 重试；
(2) 校验不通过且策略允许 → 重试；(3) 审阅成功但总分低于 `min_review_score` → 重试；否则接受该次尝试。
第 (1) 种情况若已到达最后一允许的 Attempt，整个 Run 以 `generating` 阶段失败结束；
第 (2)(3) 种情况到达上限则 Run 以 `exhausted` 正常收尾，`selected_attempt` 指向最后一次尝试的正文。

`enable_repair` 打开时，(2)(3) 两种情况会先走定点修订：Repair → Revalidate → Rereview，
修订成功且达标即接受该次尝试，不再整篇重生。修订阶段的进度记在 `current_stage`
（`repairing` / `revalidating` / `rereviewing`），修订本身失败不会让 Run 失败——
正文保留修订前那一版，Run 按重试策略继续走。

## StoryConfig

配置格式版本 `config_version` 与项目 VERSION 是两回事：前者描述 JSON 结构，后者描述软件版本。

| Field | Type | Required | Description |
|---|---|---|---|
| `config_version` | string | no（缺省 `"1"`） | 配置格式版本 |
| `title` | string | yes | 故事标题（trim 后非空，≤ 120 字） |
| `genre` | string | yes | 题材（自由文本，不设枚举） |
| `premise` | string | yes | 核心设定 |
| `setting` | string | no | 故事背景 |
| `protagonist` | object | no | 主角（`name` 必填，`identity`/`goal`/`motivation` 可选） |
| `conflict` | string | no | 主要冲突 |
| `stakes` | string | no | 失败代价 |
| `ending` | string | no | 结局方向 |
| `target_words` | integer | yes | 目标字数（500 ~ 30000） |
| `style` | string | no | 写作风格 |
| `extra_requirements` | string | no | 附加要求 |

完整示例见 [configs/example_story.json](configs/example_story.json)，字段级契约见
[docs/story-config.md](docs/story-config.md)。校验通过的返回值是归一化后的新对象：
字段顺序固定、缺失的可选字段不出现、未知字段一律丢弃。

## BeatPlan

阶段一产出剧情骨架，阶段二据此写正文。格式版本 `beat_plan_version` 与 `config_version`、项目 VERSION 各自独立。

| Field | Type | Required | Description |
|---|---|---|---|
| `beat_plan_version` | string | no（缺省 `"1"`） | BeatPlan 格式版本 |
| `summary` | string | no | 整体规划摘要 |
| `beats` | array | yes | 非空；`id` 从 1 连续且唯一 |
| `beats[].id` | integer | yes | 序号（正整数） |
| `beats[].purpose` | string | yes | 这一拍的结构作用 |
| `beats[].event` | string | yes | 这一拍实际发生的事件 |
| `beats[].characters` | array | yes | 出场人物（可为空数组） |
| `beats[].conflict` | string | no | 本拍局部冲突 |
| `beats[].expected_outcome` | string | no | 本拍结束后故事状态的变化 |

字段级契约、编号规则与 JSON 示例见 [docs/beat-plan.md](docs/beat-plan.md)。
生成失败或计划非法时，Storyloop 只报告错误并保留你已编辑的 BeatPlan：自动重试只会带着同一份
BeatPlan 整篇重新生成，不会改写它。

## Run 与产物

一次完整生成就是一个 **Run**。Run ID 形如 `20260920_101530_k3f9aq`（本地时间戳 + 6 位随机字符），
由服务端生成，不依赖用户输入，可安全用作目录名。

```text
runs/
└── <run_id>/
    ├── config.json      # 本次运行使用的 StoryConfig
    ├── beats.json       # 实际采用的 BeatPlan（多次 Attempt 复用同一份）
    ├── story.md         # 被选中那一次 Attempt 的正文（发生过修订时为修订后的版本）
    ├── validation.json  # 被选中那一次 Attempt 的首次硬性校验结果
    ├── review.json      # 被选中那一次 Attempt 的首次审阅结果
    ├── metadata.json    # 运行级 metadata
    └── attempts/
        ├── 01/
        │   ├── story.md          # 该次尝试的正文（发生过修订时为修订后的版本）
        │   ├── initial_story.md  # 修订前的正文（只有发生过修订时才存在）
        │   ├── validation.json   # 该次尝试的首次校验结论
        │   ├── review.json       # 该次尝试的首次审阅结论
        │   ├── metadata.json     # attempt 级 metadata
        │   └── repairs/
        │       ├── 01/
        │       │   ├── story.md        # 这次修订产出的正文
        │       │   ├── request.json    # issue_type / issue_message / 修订请求三要素
        │       │   ├── validation.json # 修订后重新校验的结论
        │       │   ├── review.json     # 修订后重新审阅的结论
        │       │   └── metadata.json   # repair 级 metadata
        │       └── 02/
        └── 02/
```

`runs/` 与 `outputs/` 已加入 `.gitignore`，产物只落在本地；仓库里只有
[examples/example_run/](examples/example_run/) 这个合成样例。

运行级 `metadata.json` 的字段：`run_id`、`project_version`、`status`、`current_stage`、
`started_at`、`finished_at`、`model`、`error`、`artifacts`、`validation_status`、
`validation_passed`、`validation_issue_count`、`validation_error`、`review_status`、
`review_score`、`review_error`、`max_attempts`、`min_review_score`、
`attempt_count`、`selected_attempt`、`quality_status`、`enable_repair`、
`max_repairs_per_attempt`、`repair_count`。
`model` 始终是「本次真正生效的模型」（请求覆盖 → 环境变量 → 缺省值），attempt 级的 `error`
没有错误时是 `null`——这两条是 v1.0.0 固定下来的字段语义。

发生过修订时有一处**刻意的不对称**：运行级 `metadata.json` 里的 `validation_*` / `review_score`
取自入选 Attempt **修订后**的结论，而同目录的 `validation.json` / `review.json`（以及
`attempts/NN/` 下的同名文件）是**首次**结论，修订后的那份在 `attempts/NN/repairs/MM/` 里。
因此两处分数可能不同（`examples/example_run/` 就是这个样子）。1.x 内保持这个语义不变。

**校验不通过不是 Run 失败**：`status` 仍为 `completed`，`validation_passed` 为 `false`，
此时会按策略定点修订或自动重试。**校验器自身崩溃也不是 Run 失败**：`validation_status` 为 `failed`，
`validation_error` 记录原因，此时不写 `validation.json`，也不会触发修订或重试。
自动重试达到上限同样不是 Run 失败：`quality_status` 为 `exhausted`，所有产物都保留。
只有连正文都拿不到时，Run 才以 `generating` 阶段失败结束。

完整的字段表与「什么情况下缺文件」见 [docs/run-artifacts.md](docs/run-artifacts.md)。

## RetryPolicy

重试策略是一个扁平结构，只有五个字段，全部有默认值：

| Field | Type | Default | Description |
|---|---|---|---|
| `max_attempts` | integer 1 ~ 5 | `2` | 尝试次数上限，**含第一次生成**；2 = 初次生成 + 最多 1 次自动重试 |
| `min_review_score` | number 0 ~ 100 | `70` | 单一总分阈值，达到即满足 |
| `retry_on_validation_failure` | boolean | `true` | 校验不通过是否值得重试 |
| `enable_repair` | boolean | `true` | 是否开启定点修订（Repair-before-Retry） |
| `max_repairs_per_attempt` | integer 0 ~ 3 | `1` | 同一次 Attempt 内最多修订几次；0 表示这次尝试不做任何修订 |

`max_repairs_per_attempt` 是「每次尝试」的上限，不是整次 Run：第 2 次 Attempt 仍然有同样的修订预算。

每次尝试记作一个 `GenerationAttempt`，也只有固定字段：`attempt_number`、`story`、`validation`、
`review`、`accepted`、`retry_reason`（取值 `generation_error` / `validation_failed` /
`review_score_below_threshold`）、`repair_count`、`repairs[]`、`error`。

RetryDecision 按固定顺序判断，没有权重、没有随机、没有模型参与：
(1) 生成失败且还有剩余次数 → `generation_error`；(2) 校验不通过且
`retry_on_validation_failure` 为 true → `validation_failed`；(3) 审阅成功但
`review.score < min_review_score` → `review_score_below_threshold`；(4) 以上都不命中 → 接受当前尝试。

两个组件自身异常的处理：Reviewer 调用失败 / 输出非法只让该次尝试拿不到分数，**不会**触发重试；
Validator 自身异常只作废「校验不通过」这一格判据，不会把正文判为失败。
到达 `max_attempts` 后硬停止——不存在「不过就无限重生」的循环。

`quality_status` 是 Run 级结论，只有两种取值：`accepted` 与 `exhausted`。
系统不会在多次尝试里挑一个「最好的」——没有 Best-of-N 择优，也没有重试统计与归因。

### 超时与重试（两层，互不混淆）

| | Transport Retry | GenerationAttempt Retry |
|---|---|---|
| 重试什么 | 同一次 HTTP 请求原样重发 | 带着同一份 StoryConfig / BeatPlan 整篇重新生成 |
| 发生在哪 | `src/lib/llm.ts` 内部 | `GenerationPipeline` + `RetryPolicy` |
| 触发条件 | timeout / 429 / 临时 5xx（500 / 502 / 503 / 504） | 生成失败且还有次数、校验不通过且策略允许、审阅总分低于阈值 |
| 上限 | 硬上限 2 次，即一次 LLM 调用最多 3 个请求 | `max_attempts`（默认 2，含第一次生成） |

Transport Retry **绝不无限重试**：上限是常量 `MAX_TRANSPORT_RETRIES = 2`。
单次请求超时由 `LLM_TIMEOUT` 控制，缺省 `180000` 毫秒；超时耗尽后抛出 `LLMTimeoutError`，
映射为 `LLM_TIMEOUT` + HTTP 504。

## ValidationResult

| Field | Type | Description |
|---|---|---|
| `passed` | boolean | `true` 当且仅当没有 `severity: "error"` 的 issue |
| `issues` | ValidationIssue[] | 问题清单（可为空数组） |

`ValidationIssue` 也只有三个字段：`code`（稳定问题码）、`severity`（`warning` / `error`，
只有两级）、`message`（人类可读说明）。

| Code | Severity | 触发条件 |
|---|---|---|
| `EMPTY_CONTENT` | error | 正文为空或全是空白字符 |
| `INVALID_OUTPUT` | error | 拿到的是错误 JSON / API 错误串 / 明显错误对象，而不是小说正文 |
| `TOO_SHORT` | error | `实际字数 < max(300, target_words × 0.15)` |
| `POSSIBLE_TRUNCATION` | error | 启发式判定疑似截断：引号未闭合，或结尾停在句子中间 |
| `MISSING_ENDING` | warning | 结尾缺少终止标点，看起来没有完整收束 |
| `MISSING_PROTAGONIST` | error | 配置了 `protagonist.name` 但正文中找不到该名字 |

字数统计对中文与英文一视同仁：CJK 字符逐个计数，连续的拉丁字母 / 数字算一个词，
标点与空白不计入。规则刻意保持宽松，宁可漏报也不误报。

没有角色一致性分析、动机分析、故事弧检查、Beat 校验、商业可行性评审——
Validator 只回答「基本可用吗」，不回答「写得好不好」。

## ReviewResult

| Field | Type | Description |
|---|---|---|
| `score` | number | 总分 0 ~ 100（整数或小数，越界即拒绝） |
| `summary` | string | 一段总体评价 |
| `strengths` | string[] | 优点列表（可为空数组，条目会 trim） |
| `problems` | string[] | 问题列表（可为空数组，条目会 trim） |

没有多维评分、严重度、证据定位、置信度，也没有 PASS / FAIL 判定——审阅只提供反馈。
审阅用的温度固定为 `0.3`，与生成温度相互独立。

## 定点修订（Targeted Repair）

请求五个字段：`config`、`beat_plan`、`story`、`issue_type`、`issue_message`。
结果：`repaired_story`、`issue_type`、`success`、`notes`——没有 diff、没有 patch、没有评分。

问题类别只有六个，由 `RepairStrategy` 按固定规则推出（纯函数，无 LLM、无学习、无分类模型）：
先看校验结论（按固定优先级取一个 error 级问题），没有可修的再看审阅问题（关键词命中第一个算数）。

| issue_type | 典型触发 |
|---|---|
| `length` | 校验码 `TOO_SHORT`；审阅问题命中「字数 / 太短 / too short / brief」 |
| `ending` | 校验码 `MISSING_ENDING`、`POSSIBLE_TRUNCATION`；审阅问题命中「结尾 / 结局 / 收束 / abrupt」 |
| `character_presence` | 校验码 `MISSING_PROTAGONIST`；审阅问题命中「主角 / 人物缺席」 |
| `continuity` | 审阅问题命中「矛盾 / 前后 / 连贯 / 脱节 / contradict」 |
| `structure` | 审阅问题命中「结构 / 中段 / 断层 / pacing」 |
| `general` | 审阅问题一个关键词都没命中时的兜底类别 |

一次只修一个主要问题；拿不准就不猜：校验码 `EMPTY_CONTENT` / `INVALID_OUTPUT`
被认为「整篇不可用」，不尝试修订，直接整篇重生。修订拿不到非空正文时返回 200 但
`success` 为 `false`——「没修好」是一次诚实的业务结果，不当成 502 报错。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/runs` | `{config, retry_policy?}` → 自动模式完整 Run |
| POST | `/api/runs/from-plan` | `{config, beat_plan, retry_policy?}` → 手动模式 Run（跳过规划） |
| POST | `/api/plan` | StoryConfig → BeatPlan（只规划，不生成正文） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/review` | `{config, story}`（+可选 `run_id`）→ 单独审阅正文 |
| POST | `/api/validate` | `{config, story}`（+可选 `run_id`）→ 单独校验正文 |
| POST | `/api/repair` | `{config, beat_plan, story, issue_type, issue_message}` → 单独定点修订 |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt，不调模型 |
| GET | `/api/runs/<run_id>` | 读回一次 Run 与它的 Attempt 摘要 |
| GET | `/api/runs/<run_id>/attempts/<n>` | 读回某一次 Attempt 的详情 |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "<VERSION 文件内容>"}` |

`retry_policy` 可省略，省略时用默认值。它不属于 StoryConfig，不会写进 `config.json`，
只会记录在 Run 的 `metadata.json` 里。非法值返回 400，Run 不会开始。
`artifacts` 是产物文件名映射（`config` / `beat_plan` / `story` / `metadata`，
校验、审阅成功时追加 `validation` / `review`），响应中不会返回服务器绝对路径。

**校验不通过不会让 Run 失败**——`story` 与 `status: "completed"` 照常返回，`validation.passed` 为 `false`，
HTTP 状态码仍然是 200（这是一次成功的业务结果，不是错误）。

失败响应统一为一个形状，`code` 是稳定枚举，`message` 是给人看的一句话：

```json
{
  "error": {
    "code": "CONFIG_INVALID",
    "message": "StoryConfig 校验失败：target_words 必须是整数。",
    "run_id": "20260922_101500_ab12cd",
    "stage": "config"
  }
}
```

| code | HTTP | 什么时候出现 |
|---|---|---|
| `CONFIG_INVALID` | 400 | 请求体 / StoryConfig / BeatPlan / RetryPolicy / 修订类别非法 |
| `RUN_NOT_FOUND` | 404 | `run_id` 不存在或格式非法 |
| `LLM_TIMEOUT` | 504 | 单次请求超时，且 transport retry 已用尽 |
| `LLM_REQUEST_FAILED` | 502 | 模型接口返回错误（401 / 429 / 5xx 等）或传输层失败 |
| `PLANNER_INVALID_OUTPUT` | 502 | 规划阶段拿不到合法 BeatPlan |
| `GENERATION_FAILED` | 502 | 生成阶段失败（含连正文都没拿到的最后一次 Attempt） |
| `REVIEW_FAILED` | 502 | 单独审阅入口的模型输出非法 |
| `REPAIR_FAILED` | 502 | 单独修订入口的模型输出非法 |
| `VALIDATION_FAILED_INTERNAL` | 500 | Validator 自身崩溃（不是「校验不通过」） |
| `ARTIFACT_WRITE_FAILED` | 500 | 产物写入失败（磁盘 / 权限 / 目录被占用） |
| `INTERNAL_ERROR` | 500 | 未预期异常；message 固定为「服务器内部错误」 |

用户错误一律 4xx，运行时错误 5xx。响应里永远不出现堆栈与服务器绝对路径：异常文本会先过
`src/lib/safe-text.ts`（绝对路径替换为 `<path>`、凭据打码），堆栈只进服务端日志。
curl 示例与逐字段说明见 [docs/api.md](docs/api.md)。

## CLI

```text
storygen run       StoryConfig → Plan → Attempt（Generate → Validate → Review → Repair? → Decide）→ Retry?
storygen plan      只产出 BeatPlan
storygen review    对已有正文单独审阅
storygen validate  对已有正文单独跑硬性规则（不调模型，不需要 API Key）
storygen repair    对已有正文定点修订一次
```

| 参数 | 命令 | 说明 |
|---|---|---|
| `--config` | 全部 | 必填：StoryConfig JSON 文件 |
| `--beats` | run / repair | 手动模式用编辑过的 BeatPlan 直接生成 |
| `--story` | review / validate / repair | 要处理的正文文件 |
| `--model` / `--base-url` / `--temperature` | 全部（validate 除外） | 覆盖服务端 LLM 设置 |
| `--max-attempts` / `--min-score` | run | 1~5 / 0~100 |
| `--enable-repair` / `--no-repair` / `--max-repairs` | run | 定点修订开关与上限 0~3 |
| `--issue-type` / `--issue-message` / `--out` | repair | 修订类别 / 问题原文 / 输出路径 |

`--help` / `-h` 在任何位置都认：用法打到标准输出，退出码 0。
参数解析不出数字（如 `--temperature abc`）按参数错误处理，退出码 2，不会静默用缺省值。
完整契约见 [docs/cli.md](docs/cli.md)。

## 环境变量

四类配置互不越界，各自只有一个来源，优先级固定为「请求覆盖 > 环境变量 > 默认值」：

| 配置 | 来源 | 说明 |
|---|---|---|
| **Application Settings** | 环境变量 + 默认值 | `RUNS_DIR` / `LOG_LEVEL` / `LLM_TIMEOUT`；与模型无关，不是每请求可调的 |
| **LLM Settings** | 请求覆盖 > 环境变量 > 默认值 | `LLM_BASE_URL` / `LLM_MODEL` / `temperature` / `timeoutMs`，全部非敏感 |
| **StoryConfig** | 请求体 / `configs/*.json` | 故事内容与创作目标 |
| **RetryPolicy** | 请求体可选 `retry_policy` | 五项策略，见上 |

| 变量 | 缺省 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | 兼容 OpenAI 的接口地址（含 `/v1`） |
| `LLM_API_KEY` | 空 | API Key；留空时调用真实 LLM 的接口返回可读错误，而不是静默失败 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `LLM_TIMEOUT` | `180000` | 单次 LLM 请求超时（毫秒）；transport retry 共用这一个上限 |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR`；无法识别的值回落到 `INFO` |
| `RUNS_DIR` | `runs` | Run 产物根目录（相对仓库根或绝对路径） |

**API Key 只存在于服务端**：`LLM_API_KEY` 只在 `src/lib/llm.ts` 里从服务端环境读取一次，
不进请求覆盖、不进任何返回值、不进任何产物、不进浏览器。`.env` 已被 `.gitignore` 忽略，
仓库里只有空模板 `.env.example`。

## 已知限制

这些是**刻意不做**的，不是待修的缺陷。每一条都有对应说明：

- **没有多维评审**：Review 只有一个 0–100 总分，没有分维度打分、没有严重度、没有证据定位
- **没有 Best-of-N 择优**：取第一个满足策略的 Attempt，不会在多次尝试里挑「最好的」
- **没有质量门禁**：没有 PASS / FAIL 判定，`quality_status` 只有 `accepted` / `exhausted` 两种
- **没有商业审阅**：不评估市场适配、读者预期或商业可行性
- **没有实验框架与基准测试**：没有 A/B、没有评分回归集、没有模型对比工具
- **没有高级可观测性**：只做工程日志（等级 + `run_id` / `attempt` / `repair` 上下文 + 脱敏），
  没有 Metrics / Trace / Prometheus / OpenTelemetry / Dashboard
- **没有失败归因与因果图**：修订只按类别改一次，不回答「为什么会失败」、
  不推断「哪个组件最可能出问题」
- **没有自适应生成与自优化**：同样的输入得到同样的重试次数与同样的修订类别
- **没有 Beat 质量校验**：BeatPlan 只做结构校验，不评价规划质量
- **没有工作流引擎 / DAG / Stage Registry**：阶段顺序固定，不能任意跳段
- **没有鉴权、限流、批量与流式**：API 没有用户体系，也没有 SSE / WebSocket
- **`target_words` 是目标不是保证**：实际输出长度受模型能力与上下文窗口影响
- **只支持 OpenAI-compatible 端点**：没有 Provider Registry / Model Router / Fallback

## 升级说明

v1.0.1 没有行为变更：只修文档与产物不符的地方，并补一道「文档字段表 ↔ 真实产物」的对照测试。
从 1.0.0 升到 1.0.1 不需要改任何代码；v1.0.0 相对于 0.9.x 也**几乎没有破坏性变更**，
需要留意的只有两条：运行级 metadata 的 `model` 现在始终存在（以前按条件写），
attempt 级 metadata 的 `error` 没有错误时是 `null`（以前按条件写）。
两者都是「字段从可能没有变成一定有」，不会让旧读取方崩掉。

```bash
git fetch && git checkout 1.0.1     # tag 不带 v 前缀
npm install
cp .env.example .env
npx tsx scripts/generate-cli.ts run --config configs/example_story.json
```

完整迁移步骤与回滚说明见 [docs/upgrade.md](docs/upgrade.md)。
版本策略见 [docs/compatibility.md](docs/compatibility.md)：主版本内不改字段名与语义、
不删路由与命令，扩展只能追加可选字段；Git tag 不带 `v` 前缀，GitHub Release 标题带。

## 测试

```bash
npm test              # 全部测试
npm run lint          # eslint
node node_modules/typescript/bin/tsc --noEmit   # 类型检查
node node_modules/next/dist/bin/next build       # 生产构建
```

测试分两类。**行为测试**用注入的假 Generator / Validator / Reviewer 驱动 Pipeline，
覆盖重试路径、修订路径、`exhausted` 路径与各条边界路径。
**合同测试**（v1.0.0 新增，v1.0.1 补了产物对照）把公开契约钉死，改一个字段名就红：

| 合同测试 | 钉住什么 |
|---|---|
| `tests/test_contract_story_config.test.ts` | StoryConfig v1 字段集、缺省值、未知字段不穿透 |
| `tests/test_contract_beat_plan.test.ts` | BeatPlan v1 字段集、编号规则、文档内 JSON 示例合法 |
| `tests/test_contract_artifacts.test.ts` | Run 产物布局与三层 metadata 字段集 |
| `tests/test_contract_api.test.ts` | 路由清单、请求/响应字段、错误码与状态码映射 |
| `tests/test_contract_cli.test.ts` | CLI 命令、参数、退出码、帮助输出位置 |
| `tests/test_contract_docs.test.ts` | README 必备章节、docs/ 完整性、版本号唯一来源、防泄漏守卫 |
| `tests/test_contract_docs_sync.test.ts` | 文档字段表 ↔ 真实产物逐字段一致（多写、漏写、改名都红） |

所有测试都不调用真实 LLM：LLM 由注入的桩对象或 `FakeLLM` 替代（`tests/helpers/fixtures.ts`），
`fetch` 也被桩掉。重试相关断言同样只用桩，从不触发真实模型调用。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

| 文档 | 内容 |
|---|---|
| [docs/story-config.md](docs/story-config.md) | StoryConfig v1 字段级契约 |
| [docs/beat-plan.md](docs/beat-plan.md) | BeatPlan v1 字段级契约 |
| [docs/run-artifacts.md](docs/run-artifacts.md) | Run 产物布局与 metadata 字段集 |
| [docs/api.md](docs/api.md) | HTTP API 路由、字段、错误码 |
| [docs/cli.md](docs/cli.md) | CLI 命令、参数、退出码 |
| [docs/upgrade.md](docs/upgrade.md) | 从 0.9.x / 1.0.0 升级到当前版本 |
| [docs/compatibility.md](docs/compatibility.md) | 兼容性策略与扩展方式 |
| [examples/example_run/](examples/example_run/) | 一次完整 Run 的合成样例产物 |
| [configs/example_story.json](configs/example_story.json) | 覆盖全部可选字段的示例配置 |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史 |

可直接阅读的实现（无外部依赖）：

- `src/core/retry-policy.ts`：重试策略与 RetryDecision 的实现
- `src/lib/validation-rules.ts`：六条硬性校验规则的实现
- `src/lib/api-error.ts`：稳定错误码与状态码映射
- `src/lib/safe-text.ts`：错误文本的净化规则（绝对路径替换、凭据打码），只此一份
- `src/lib/version.ts`：版本号单一真源
- `tests/helpers/fixtures.ts`：共享样例数据与 `FakeLLM`
