# Storyloop · AI 故事工场

> 一个具备剧情规划、自动审阅、基础验证、自动重试和定点修订能力的 AI 短篇小说生成器。
> A pipeline-based AI short-story generator with validation, review, automatic retry, and targeted story repair.

## 功能（当前版本 v0.8.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- **AI Beat Planning**：先生成剧情骨架（BeatPlan），再据此写正文
- **BeatPlan 手动编辑**：增删 Beat、上下移动排序，生成前可反复调整
- StoryConfig 在规划后发生变化时，BeatPlan 标记为 Outdated
- **可编辑的外部 Prompt 模板**（`prompts/beat_planner.txt`、`prompts/story.txt`、`prompts/reviewer.txt`、`prompts/repair.txt`）
- **GenerationPipeline**：一次完整生成 = 一个 Run，固定顺序 Config → Planning →〔Attempt 1: Generate → Save Story → Validate → Review → 重试判定〕→ Finalize；一次 Run 可包含多次 Attempt
- **RunContext + Run ID**：每次运行有唯一 `run_id`（时间戳 + 短随机）与状态 / 阶段记录
- **Run Artifacts**：产物统一落在 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `validation.json` / `review.json` / `metadata.json`），每次 Attempt 的产物另存 `attempts/NN/`，发生修订时还有 `attempts/NN/repairs/NN/`
- **Story Validator（硬性有效性检查）**：正文落盘后立即跑一遍确定性规则，回答「这篇正文基本可用吗」
- **Hard Failure Detection**：任一规则报 `error` 即 `passed: false`，规则、严重度与说明全部随 Run 返回
- **Validation JSON Artifact**：校验结果落盘为 `validation.json`，可再次校验覆盖
- **Basic AI Reviewer**：每次生成的正文自动获得一次基础审阅
- **Overall 0–100 Score**：单一总分（不含多维度评分）
- **Strengths & Problems**：优点与问题各一份字符串列表
- **Review JSON Artifact**：审阅结果落盘为 `review.json`，可再次审阅覆盖
- **Automatic Retry（自动重试）**：生成失败、校验不通过或总分低于阈值时按确定性策略重新生成，直到被接受或达到尝试次数上限
- **Targeted Story Repair（定点修订）**：Attempt 不通过时先按具体问题类别改写这篇正文（Repair-before-Retry），修订后再校验、再审阅；修订彻底失败才退回整篇重新生成
- **Basic Repair Issue Categories**：`length` / `ending` / `character_presence` / `continuity` / `structure` / `general` 六种简单问题类别，不涉及因果推断
- **RepairStrategy**：由校验 issue code 或审阅问题文本推出 `RepairTarget`（纯函数，无 LLM、无模型参与）
- **StoryRepairer**：`prompts/repair.txt` → LLM → 修订后正文，输入带原始 StoryConfig、BeatPlan、问题类别与问题说明
- **RetryPolicy**：`max_attempts`（默认 2，含首次生成）/ `min_review_score`（默认 70）/ `retry_on_validation_failure`（默认 true）/ `enable_repair`（默认 true）/ `max_repairs_per_attempt`（默认 1）五项，运行前可配置
- **GenerationAttempt**：每次尝试单独记录编号、正文、校验、审阅、是否接受与原因，产物落在 `attempts/01/`、`attempts/02/` …
- **quality_status**：Run 级结论只有 `accepted`（第一次满足策略的尝试被接受）与 `exhausted`（达到上限仍未满足）两种
- **Run 进度与结果 UI**：六阶段进度指示 + Attempt 计数 + 修订阶段（Repairing / Revalidating / Re-reviewing）+ Run ID / 产物清单 / Validation 面板 / Review 面板 / 修订记录 / 失败阶段
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 统一走同一条 Pipeline（`scripts/generate-cli.ts run` / `plan` / `review` / `validate`）
- 本地配置（模型 / Base URL / 温度 / 自动重试字段）

> **Validator 与 Reviewer 是两件事**：
>
> | | Story Validator | Basic Reviewer |
> |---|---|---|
> | 回答的问题 | 「这篇正文基本可用吗」 | 「这篇故事写得好吗」 |
> | 实现 | 确定性规则，不调用 LLM | LLM 审阅，主观评价 |
> | 产出 | `ValidationResult`（`passed` + `issues`） | `ReviewResult`（`score` + `summary` + `strengths` + `problems`） |
> | 判定性质 | 硬性：`error` 即不通过 | 软性：分数只做反馈 |
>
> 两者互不影响：**Review 分数不参与 Validation 判定**——哪怕 Review 打 0 分，校验该过还是过；
> 哪怕 Review 打 100 分，校验该不过还是不过。

> **定点修订在整篇重试之前**：Attempt 不通过时，系统先尝试 Targeted Repair——针对具体某一条校验问题
> 或审阅问题改写在手的这篇正文（同一个 StoryConfig、同一份 BeatPlan），修订后重新校验、重新审阅；
> 只有修订彻底失败或修订后仍不达标时，才带着同一份配置整篇重新生成。
> Targeted Repair revises an existing story in response to a specific validation or review issue
> before falling back to full regeneration.
> v0.8.0 uses simple issue categories and does not perform advanced causal diagnosis or failure attribution.
>
> 修订策略是纯函数：问题类别只由校验 issue code 或审阅问题文本推出，没有模型参与、没有打分、没有择优。
> 重试本身同样由确定性策略驱动，没有学习、没有自适应：同样的输入得到同样的重试次数。
> Reviewer 自身调用失败不是重试理由（这时该次尝试因拿到分数而被接受），Validator 自身异常也不算正文失败。
> 达到 `max_attempts` 后硬停止：Run 以 `exhausted` 结束，已产出的所有 Attempt 产物都保留
> （含每次修订前的 `initial_story.md` 与修订后的正文）。
>
> 本版本仍然没有：多维评审、Best-of-N 择优、PASS / FAIL 质量门禁、
> 商业审阅（Commercial Review）、实验（Experiment）、基准（Benchmark）、
> 因果归因（Failure Attribution）、自适应生成（Adaptive Generation）。
> 定点修订只回答「这篇正文哪里不对、按类别改一次」，不回答「为什么会失败」。
> 本版本也没有工作流引擎 / DAG / Stage Registry：阶段顺序固定，不能任意跳段。

## 架构

```
┌──────────────────────┐
│  UI ／ CLI           │  StoryConfig 表单 + Save / Load / New · generate-cli run
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Run API            │  POST /api/runs · POST /api/runs/from-plan · POST /api/validate · POST /api/review
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  GenerationPipeline  │  固定顺序：Config → Planning →〔Attempt 1..max_attempts: Generate → Save Story → Validate → Review → 重试判定 〕→ Finalize
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
│      LLM Client      │  OpenAI-compatible（system + user）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    ArtifactStore     │  原子写入 runs/<run_id>/ 下的产物
└──────────────────────┘
```

正文先落盘再校验、再审阅：即使 Validator 自身抛异常或 Reviewer 调用失败 / 输出非法，
`story.md` 与整个 Run 都保持成功，只有对应的 `validation_status` / `review_status` 变为 `failed` 并记录原因。
一次 Attempt 之后的 RetryDecision 只由确定性规则给出：(1) 生成失败且还有次数 → 重试；
(2) 校验不通过且策略允许 → 重试；(3) 审阅成功但总分低于 `min_review_score` → 重试；否则接受该次尝试。
第 (1) 种情况若已到达最后一允许的 Attempt，整个 Run 以 `generating` 阶段失败结束（与 v0.6.0 一致）；
第 (2)(3) 种情况到达上限则 Run 以 `exhausted` 正常收尾，`selected_attempt` 指向最后一次尝试的正文。

`enable_repair` 打开时，(2)(3) 两种情况会先走定点修订：Repair → Revalidate → Rereview，
修订成功且达标即接受该次尝试，不再整篇重生；修订失败或修订后仍不达标才继续重试判定。
修订阶段的进度记在 `current_stage`（`repairing` / `revalidating` / `rereviewing`），
修订本身失败不会让 Run 失败——正文保留修订前那一版，Run 按重试策略继续走。

## Run 与产物

一次完整生成就是一个 **Run**。Run ID 形如 `20260920_101530_k3f9aq`（本地时间戳 + 6 位随机字符），
由服务端生成，不依赖用户输入，可安全用作目录名。

`runs/` 目录已加入 `.gitignore`，产物只落在本地：

```
runs/
└── 20260920_101530_k3f9aq/
    ├── config.json      # 本次运行使用的 StoryConfig
    ├── beats.json       # 实际采用的 BeatPlan（多次 Attempt 复用同一份）
    ├── story.md         # 被选中那一次 Attempt 的正文（selected_attempt）
    ├── validation.json  # 被选中那一次 Attempt 的硬性校验结果
    ├── review.json      # 被选中那一次 Attempt 的审阅结果
    ├── metadata.json    # run_id / project_version / status / 阶段 / 时间 / 模型 / retry 字段 / attempt_count / repair_count 等
    └── attempts/        # 每次尝试单独归档（01 起，两位数字）
        ├── 01/
        │   ├── story.md       # 该次尝试的正文（发生过修订时为修订后的版本，与根目录 story.md 同为 `# 标题\n\n正文`）
        │   ├── initial_story.md  # 修订前的正文（只有发生过修订时才存在）
        │   ├── validation.json  # 该次尝试的首次校验结论（修订后的结论在 repairs/NN/ 下）
        │   ├── review.json      # 该次尝试的首次审阅结论
        │   ├── metadata.json    # attempt_number / accepted / retry_reason / review_score / validation_passed / repairs[] 等
        │   └── repairs/         # 每次定点修订单独归档（01 起，两位数字）
        │       ├── 01/
        │       │   ├── story.md       # 这次修订产出的正文
        │       │   ├── request.json   # issue_type / issue_message / 修订请求三要素
        │       │   ├── validation.json  # 修订后重新校验的结论
        │       │   └── review.json      # 修订后重新审阅的结论
        │       └── 02/
        │           └── ……
        └── 02/
            └── ……
```

根目录的 `story.md` / `validation.json` / `review.json` 始终对应**被选中的那一次 Attempt**
（第一个满足策略的尝试；全部未满足时取最后一次）。文件是复制，不是符号链接，Windows 下同样可用。
Attempt 发生过修订时，根目录对应的是修订后重新校验 / 重新审阅的结论，
修订前的首次结论始终留在 `attempts/NN/validation.json` 与 `attempts/NN/review.json`。

`metadata.json` 的字段：`run_id`、`project_version`、`status`（`created` / `planning` /
`generating` / `saving` / `validating` / `reviewing` / `repairing` / `revalidating` / `rereviewing` / `completed` / `failed`）、
`current_stage`、`started_at`、`finished_at`、
`error`、`model`、`artifacts`、`validation_status`（`validating` / `completed` / `failed`）、
`validation_passed`（布尔，`validation_status` 为 `completed` 时才有）、`validation_issue_count`、
`validation_error`（Validator 自身异常时记录）、`review_status`（`reviewing` / `completed` / `failed`）、
`review_error`、`review_score`，v0.7.0 新增的重试字段 `max_attempts`、`min_review_score`、
`retry_on_validation_failure`、`attempt_count`、`selected_attempt`、`quality_status`（`accepted` / `exhausted`），
以及 v0.8.0 新增的修订字段 `enable_repair`、`max_repairs_per_attempt`、`repair_count`（本次 Run 做过几次定点修订，含没修成的；一次修订到底成没成看 Attempt 里的 `repairs[].success`）。
失败时 `status` 为 `failed`，`error` 为安全错误信息（不含服务器绝对路径），
且已经写出的产物不会被删除。没有重试统计 / 归因字段——那些属于后续版本。

失败阶段可识别：`config` / `planning` / `generating` / `persistence`。
**校验不通过不是 Run 失败**：`status` 仍为 `completed`，`validation_status` 为 `completed`，
`validation_passed` 为 `false`，此时会按策略定点修订或自动重试。**校验器自身崩溃也不是 Run 失败**：
`validation_status` 为 `failed`，`validation_error` 记录原因，此时不写 `validation.json`，也不会触发修订或重试。
审阅失败同理，只影响 `review_status`。自动重试达到上限也不是 Run 失败：`status` 仍是 `completed`，
`quality_status` 为 `exhausted`，所有 Attempt 与修订产物都保留。只有连正文都拿不到时，
Run 才以 `generating` 阶段失败结束。

## ValidationResult

硬性校验的结果是一个扁平结构，只有一个结论和一份问题清单：

| Field | Type | Description |
|---|---|---|
| `passed` | boolean | `true` 当且仅当没有 `severity: "error"` 的 issue |
| `issues` | ValidationIssue[] | 问题清单（可为空数组） |

`ValidationIssue` 也只有三个字段：

| Field | Type | Description |
|---|---|---|
| `code` | string | 稳定问题码（见下表） |
| `severity` | `"warning"` \| `"error"` | 只有两级；`error` 会让 `passed` 变 `false` |
| `message` | string | 人类可读的具体说明 |

```json
{
  "passed": false,
  "issues": [
    { "code": "TOO_SHORT", "severity": "error", "message": "正文长度 312 明显短于目标字数（下限 750）。" }
  ]
}
```

内置规则与问题码：

| Code | Severity | 触发条件 |
|---|---|---|
| `EMPTY_CONTENT` | error | 正文为空或全是空白字符 |
| `INVALID_OUTPUT` | error | 拿到的是错误 JSON / API 错误串 / 明显错误对象，而不是小说正文 |
| `TOO_SHORT` | error | `实际字数 < max(300, target_words × 0.15)` |
| `POSSIBLE_TRUNCATION` | error | 启发式判定疑似截断：引号未闭合，或结尾停在句子中间 |
| `MISSING_ENDING` | warning | 结尾缺少终止标点，看起来没有完整收束 |
| `MISSING_PROTAGONIST` | error | 配置了 `protagonist.name` 但正文中找不到该名字 |

字数统计对中文与英文一视同仁：CJK 字符逐个计数，连续的拉丁字母 / 数字算一个词，
标点与空白不计入——不用 `len(text.split())` 那种对中文完全失效的方法。
规则刻意保持宽松，宁可漏报也不误报；`MISSING_PROTAGONIST` 只在配置了主角名时才检查。

没有角色一致性分析、动机分析、故事弧检查、Beat 校验、商业可行性评审——
Validator 只回答「基本可用吗」，不回答「写得好不好」。
再次校验会覆盖同一个 `validation.json`，不产生 `validation_v1.json` 或历史版本文件。

## ReviewResult

审阅结果是一个扁平结构，只有总分与两份列表：

| Field | Type | Description |
|---|---|---|
| `score` | number | 总分 0 ~ 100（整数或小数，越界即拒绝） |
| `summary` | string | 一段总体评价 |
| `strengths` | string[] | 优点列表（可为空数组，条目会 trim） |
| `problems` | string[] | 问题列表（可为空数组，条目会 trim） |

```json
{
  "score": 74,
  "summary": "悬念铺垫扎实，但结局揭示略显仓促。",
  "strengths": ["开篇即抛出失踪悬念", "人物动机清晰"],
  "problems": ["第三幕节奏偏快", "配角周衡的转变缺少铺垫"]
}
```

没有多维评分、严重度、证据定位、置信度，也没有 PASS / FAIL 判定——审阅只提供反馈。
再次审阅会覆盖同一个 `review.json`，不产生 `review_v1.json` 或历史版本文件。

## 定点修订（Targeted Repair）

一次修订 = 修一篇已有的正文。请求只有五个字段：

| Field | Type | Description |
|---|---|---|
| `config` | StoryConfig | 与生成时同一份配置（修订后的正文必须仍然符合它） |
| `beat_plan` | BeatPlan | 与生成时同一份剧情骨架 |
| `story` | string | 待修订的当前正文 |
| `issue_type` | string | 问题类别，见下表 |
| `issue_message` | string | 这一步要修什么的人类可读说明 |

结果主体是三个字段：`repaired_story`（修订后正文，失败时为空字符串）、
`issue_type`（原样回显）、`success`（是否拿到非空修订正文）。
失败时另有一个 `notes` 字符串说明原因；成功时 `notes` 为 `null`。
没有 diff、没有 patch、没有评分、没有「改了几处」的统计。

问题类别只有六个，由 `RepairStrategy` 按固定规则推出（纯函数，无 LLM、无学习、无分类模型）：
先看校验结论（按固定优先级取一个 error 级问题），没有可修的再看审阅问题（关键词命中第一个算数）。

| issue_type | UI 中文 | 典型触发 |
|---|---|---|
| `length` | 篇幅不足 | 校验码 `TOO_SHORT`；审阅问题命中「字数 / 太短 / too short / brief」 |
| `ending` | 结局问题 | 校验码 `MISSING_ENDING`、`POSSIBLE_TRUNCATION`；审阅问题命中「结尾 / 结局 / 收束 / abrupt」 |
| `character_presence` | 主角缺席 | 校验码 `MISSING_PROTAGONIST`；审阅问题命中「主角 / 人物缺席」 |
| `continuity` | 前后连贯 | 审阅问题命中「矛盾 / 前后 / 连贯 / 脱节 / contradict」 |
| `structure` | 结构断层 | 审阅问题命中「结构 / 中段 / 断层 / pacing」 |
| `general` | 综合问题 | 审阅问题一个关键词都没命中时的兜底类别（当次修订说明用原问题文本） |

一次只修一个主要问题；拿不准就不猜：校验码 `EMPTY_CONTENT` / `INVALID_OUTPUT`
被认为「整篇不可用」，不尝试修订，直接整篇重生；未登记的校验码也不会被硬套到某个类别上。
它只回答「这篇正文哪里不对、按类别改一次」，不回答「为什么会失败」：
没有因果推断、没有失败归因、没有「哪个组件最可能出问题」的打分。
修订后系统会重新校验、重新审阅；修订彻底失败时正文保留修订前那一版。

## RetryPolicy

重试策略是一个扁平结构，只有五个字段，全部有默认值：

| Field | Type | Default | Description |
|---|---|---|---|
| `max_attempts` | integer 1 ~ 5 | `2` | 尝试次数上限，**含第一次生成**；2 = 初次生成 + 最多 1 次自动重试 |
| `min_review_score` | number 0 ~ 100 | `70` | 单一总分阈值，达到即满足 |
| `retry_on_validation_failure` | boolean | `true` | 校验不通过是否值得重试 |
| `enable_repair` | boolean | `true` | 是否开启定点修订（Repair-before-Retry）；关闭时行为与 v0.7.0 逐字一致 |
| `max_repairs_per_attempt` | integer 0 ~ 3 | `1` | 同一次 Attempt 内最多修订几次；0 表示这次尝试不做任何修订 |

`max_repairs_per_attempt` 是「每次尝试」的上限，不是整次 Run：第 2 次 Attempt 仍然有同样的修订预算。

每次尝试记作一个 `GenerationAttempt`，也只有固定七个字段：

| Field | Type | Description |
|---|---|---|
| `attempt_number` | integer | 编号，从 1 开始，多次尝试单调递增 |
| `story` | string \| null | 这一次生成的正文（生成失败时为 `null`） |
| `validation` | ValidationResult \| null | 这一次的校验结论 |
| `review` | ReviewResult \| null | 这一次的审阅结论 |
| `accepted` | boolean | 是否满足策略并被选中 |
| `retry_reason` | string \| null | 未接受时的原因，取值只有 `generation_error` / `validation_failed` / `review_score_below_threshold` |
| `error` | string \| null | 阶段自身异常的安全说明（不含路径） |

一次 Run 里的 RetryDecision 按固定顺序判断，没有权重、没有随机、没有模型参与：

1. 生成失败且还有剩余次数 → `generation_error`；
2. 校验不通过且 `retry_on_validation_failure` 为 true → `validation_failed`；
3. 审阅成功但 `review.score < min_review_score` → `review_score_below_threshold`；
4. 以上都不命中 → 接受当前尝试。

`enable_repair` 打开时，第 2、3 种情况在整篇重试之前先试定点修订：
先由 `RepairStrategy` 推出问题类别（`length` / `ending` / `character_presence` / `continuity` / `structure` / `general`），
再由 `StoryRepairer` 改写这篇正文，然后重新校验、重新审阅——修订后达标即接受，不再整篇重生。
修订彻底失败（LLM 异常或返回空正文）时正文保留修订前那一版，直接走整篇重试。
修订本身不改变 `retry_reason` 的取值：一次「修完还是没到 70 分」的尝试，
理由仍然是 `review_score_below_threshold`。

两个组件自身异常的处理：Reviewer 调用失败/输出非法只让该次尝试拿不到分数，**不会**触发重试；
Validator 自身异常只作废「校验不通过」这一格判据，不会把正文判为失败。
到达 `max_attempts` 后硬停止——不存在 `while not accepted: regenerate()` 这种循环。

`quality_status` 是 Run 级结论，只有两种取值：`accepted`（第一次满足策略的尝试被接受）与
`exhausted`（达到上限仍未满足，此时 `selected_attempt` 指向最后一次尝试）。
系统不会在多次尝试里挑一个「最好的」——没有 Best-of-N 择优，也没有重试统计与归因。

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
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

# 只审阅已有正文（不生成；带 --run-id 时覆盖该 Run 的 review.json）
npx tsx scripts/generate-cli.ts review --config configs/example_story.json --story story.md
```

`run` 结束时会依次打印 Run ID / Status / 每次 Attempt 的结论（`Attempt 2: review 63 → retry` 这样的单行）、
Quality Status（`accepted` / `exhausted`）/ Selected Attempt / 正文路径 /
`Validation: PASSED|FAILED`（附每条 issue 的 severity、code 与 message）/ Review Score / Artifacts / Attempts 目录。
开启修订后，每次 Attempt 的结论会展开成修订明细：

```text
Attempt 1
Validation: FAILED (MISSING_ENDING)
Review: 64
Repair: ending
Revalidation: PASSED
Review after repair: 74
Attempt 1: review 74 → accepted
```

修订失败时 `Revalidation` 会明确写「not run」——正文保留修订前那一版，直接整篇重生，不会伪造一次修订后结论：

```text
Attempt 2
Validation: FAILED (EMPTY_CONTENT)
Review: —
Repair: length
Revalidation: not run（修订未成功，保留修订前结论，直接整篇重生）
Review after repair: —
Attempt 2: validation failed → retry
```
校验不通过不会让 CLI 以非零码退出——它是一次成功的业务结果，只是结论为不通过；
`exhausted` 同样正常退出（业务收尾，不是程序失败），只有生成失败或参数非法才返回非零码。

## StoryConfig

配置格式版本 `config_version` 与项目 VERSION 是两回事：前者描述 JSON 结构，后者描述软件版本。

| Field | Type | Required | Description |
|---|---|---|---|
| `config_version` | string | yes | 配置格式版本（当前 `"1"`） |
| `title` | string | yes | 故事标题 |
| `genre` | string | yes | 题材 |
| `premise` | string | yes | 核心设定 |
| `setting` | string | no | 故事背景 |
| `protagonist` | object | no | 主角（`name` 必填，`identity`/`goal`/`motivation` 可选） |
| `conflict` | string | no | 主要冲突 |
| `stakes` | string | no | 失败代价 |
| `ending` | string | no | 结局方向 |
| `target_words` | integer | yes | 目标字数（500 ~ 30000） |
| `style` | string | no | 写作风格 |
| `extra_requirements` | string | no | 附加要求 |

完整示例（`configs/example_story.json`，可直接复制使用）：

```json
{
  "config_version": "1",
  "title": "消失的目击者",
  "genre": "悬疑",
  "premise": "唯一证人在出庭前一天突然消失。",
  "setting": "现代中国一线城市，商业贿赂案件进入庭审前夜。",
  "protagonist": {
    "name": "陈岚",
    "identity": "刑警",
    "goal": "在开庭前找到证人",
    "motivation": "她负责证人的保护工作"
  },
  "conflict": "证人的失踪可能与案件核心嫌疑人有关，而内部有人正在掩护他。",
  "stakes": "如果证人无法出庭，案件将因为关键证据不足而失败，陈岚的职业生命也会终结。",
  "ending": "失踪是证人主动设计的反击，目的是引出内部掩护者。",
  "target_words": 5000,
  "style": "冷峻、节奏紧凑",
  "extra_requirements": "不要超自然元素。"
}
```

## BeatPlan

阶段一产出剧情骨架，阶段二据此写正文。格式版本 `beat_plan_version` 与 `config_version`、项目 VERSION 各自独立。

| Field | Type | Required | Description |
|---|---|---|---|
| `beat_plan_version` | string | yes | BeatPlan 格式版本（当前 `"1"`） |
| `summary` | string | no | 整体规划摘要 |
| `beats` | array | yes | 非空；`id` 从 1 连续且唯一 |
| `beats[].id` | integer | yes | 序号（正整数） |
| `beats[].purpose` | string | yes | 这一拍的结构作用 |
| `beats[].event` | string | yes | 这一拍实际发生的事件 |
| `beats[].characters` | array | yes | 出场人物（可为空数组） |
| `beats[].conflict` | string | no | 本拍局部冲突 |
| `beats[].expected_outcome` | string | no | 本拍结束后故事状态的变化 |

```json
{
  "beat_plan_version": "1",
  "summary": "从证人失踪到真相公开",
  "beats": [
    { "id": 1, "purpose": "建立危机", "event": "证人失踪。", "characters": ["陈岚"] },
    {
      "id": 2,
      "purpose": "升级冲突",
      "event": "保护行动内部有人泄密。",
      "characters": ["陈岚", "周衡"],
      "conflict": "警方内部不再可信",
      "expected_outcome": "陈岚转为独自行动"
    }
  ]
}
```

> 生成失败或计划非法时，Storyloop 只报告错误并保留你已编辑的 BeatPlan：自动重试只会带着同一份
> BeatPlan 整篇重新生成，不会改写它，也不会针对具体问题修改句子。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/runs` | `{config, retry_policy?}` → 自动模式完整 Run，返回 `{run_id, status, story, beat_plan, validation, validation_status, validation_error?, review, review_status, quality_status, attempt_count, selected_attempt, attempts, artifacts}` |
| POST | `/api/runs/from-plan` | `{config, beat_plan, retry_policy?}` → 手动模式 Run（跳过规划） |
| POST | `/api/validate` | `{config, story}`（+可选 `run_id`）→ 单独校验正文，返回 `ValidationResult` |
| POST | `/api/review` | `{config, story}`（+可选 `run_id`）→ 单独审阅正文，返回 `ReviewResult` |
| POST | `/api/repair` | `{config, beat_plan, story, issue_type, issue_message}` → 单独定点修订一段正文，返回 `{repaired_story, issue_type, success}` |
| POST | `/api/plan` | StoryConfig → BeatPlan（只规划，不生成正文） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt（开发预览） |
| GET | `/api/runs/<run_id>` | 读回一次 Run 与它的 Attempt 摘要（`<run_id>` 非法或不存在时 400 / 404） |
| GET | `/api/runs/<run_id>/attempts/<n>` | 读回某一次 Attempt 的详情（`<n>` 非法或不存在时 400 / 404） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.8.0"}` |

`retry_policy` 可省略，省略时用默认值 `{max_attempts: 2, min_review_score: 70, retry_on_validation_failure: true, enable_repair: true, max_repairs_per_attempt: 1}`。
它不属于 StoryConfig，因此不会写进 `config.json`，只会记录在 Run 的 `metadata.json` 里。
非法值（`max_attempts` 不是 1 ~ 5 的整数、`min_review_score` 越出 0 ~ 100、`enable_repair` / `retry_on_validation_failure` 不是布尔、`max_repairs_per_attempt` 不是 0 ~ 3 的整数）返回 400，Run 不会开始。

`artifacts` 是产物文件名映射，例如
`{"config":"config.json","beat_plan":"beats.json","story":"story.md","metadata":"metadata.json"}`；
校验成功时还会多出 `"validation":"validation.json"`，审阅成功时多出 `"review":"review.json"`。
这些文件位于服务器的 `runs/<run_id>/` 下，响应中不会返回服务器绝对路径。

校验与审阅结果都随 Run 一起返回：`validation` 为 `ValidationResult` 或 `null`，
`validation_status` 为 `validating` / `completed` / `failed`（Validator 自身异常时另有 `validation_error`）；
`review` 为 `ReviewResult` 或 `null`，`review_status` 为 `reviewing` / `completed` / `failed`。
**校验不通过不会让 Run 失败**——`story` 与 `status: "completed"` 照常返回，`validation.passed` 为 `false`，
HTTP 状态码仍然是 200（这是一次成功的业务结果，不是错误）。同样地，`validation_status` 为 `failed`
只表示校验器自己出了问题，Run 本身依然 `completed`。

v0.7.0 的 Run 响应还带四个重试字段：`quality_status`（`accepted` / `exhausted`）、
`attempt_count`（本次 Run 实际做了几次尝试）、`selected_attempt`（被选中那一次尝试的编号）、
`attempts`（每次尝试的摘要数组：编号 / 是否接受 / 原因 / 分数 / 校验结论 / 修订次数，
修订摘要为 `repairs[]`，每次修订只记 `{repair_number, issue_type, success}`，**不含修订全文**）。
每次 Attempt 的完整正文与结论（含修订记录）用 `GET /api/runs/<run_id>/attempts/<n>` 单独取。

v0.8.0 起 Run 响应还带 `repair_count`（本次 Run 做过几次定点修订，没有修订时为 0）。
`GET /api/runs/<run_id>` 的详情里还会回显 `enable_repair` 与 `max_repairs_per_attempt`；
`GET /api/runs/<run_id>/attempts/<n>` 会带上 `initial_story`（修订前的正文，未发生修订时为 `null`）
与完整的 `repairs[]`（每次修订的问题类别、修订前后校验结论、修订前后审阅分数）。
修订的完整正文只落在本地产物里，不随 Run 响应返回。

`POST /api/repair` 请求体五个字段全是必需：`config`（StoryConfig）、`beat_plan`（剧情骨架）、
`story`（待修订正文）、`issue_type`（问题类别，取值 `ending` / `length` / `conflict` / `character` / `dialogue` / `structure`）、
`issue_message`（这一步要修什么的人类可读说明）。它不受 `enable_repair` 影响——
这是给人用的手动入口，想修就修，改了不写盘（不带 `run_id`）。
`issue_type` 只接受 `length` / `ending` / `character_presence` / `continuity` / `structure` / `general`，
非法返回 400 且不会调用模型。修订拿不到非空正文时（模型异常、返回空串、正文本身就是空的）
返回 200 但 `success` 为 `false`、`repaired_story` 为空字符串，`notes` 说明原因——
「没修好」是一次诚实的业务结果，不当成 502 报错。
没有全局 Run 历史接口——读 Run 必须带上 `run_id`。

失败响应形如 `{error: "安全错误信息", run_id?: "...", stage?: "planning"}`，HTTP 状态码：
`400` 请求体 / 配置 / BeatPlan / 重试策略 / 修订类别非法，`502` LLM 或规划 / 生成失败，`500` 其他内部错误。
（修订自身的失败不算错误码：拿不到非空正文时返回 200 + `success: false`。）

### curl 示例

```bash
# 自动模式：一次完整 Run
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d @configs/example_story.json -o run.json

# 手动模式：先规划，人工编辑 beats.json 后再生成
curl -X POST http://localhost:3000/api/plan \
  -H "Content-Type: application/json" \
  -d @configs/example_story.json -o beats.json

curl -X POST http://localhost:3000/api/runs/from-plan \
  -H "Content-Type: application/json" \
  -d '{"config": '"$(cat configs/example_story.json)"', "beat_plan": '"$(cat beats.json)"'}'

# 单独审阅一段正文：请求体为 {"config": {...}, "story": "正文文本"}
# 用 --data-binary @文件 发送，避免 shell 把中文转成乱码
curl -X POST http://localhost:3000/api/review \
  -H "Content-Type: application/json" \
  --data-binary @review-request.json

# 单独校验一段正文：请求体为 {"config": {...}, "story": "正文文本"}
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  --data-binary @validate-request.json

# 定点修订一段正文（手动入口，不受 enable_repair 影响，改了不写盘）
# repair-request.json: {"config": {...}, "beat_plan": {...}, "story": "待修订的正文",
#                      "issue_type": "ending", "issue_message": "故事缺少明确结局。"}
curl -X POST http://localhost:3000/api/repair \
  -H "Content-Type: application/json" \
  --data-binary @repair-request.json

# 自定义重试策略：最多 3 次尝试、总分阈值 80、修订最多 2 次
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{"config": '"$(cat configs/example_story.json)"', "retry_policy": {"max_attempts": 3, "min_review_score": 80, "retry_on_validation_failure": true, "enable_repair": true, "max_repairs_per_attempt": 2}}'

# 读回一次 Run（含 Attempt 摘要）
curl http://localhost:3000/api/runs/$(jq -r .run_id run.json)

# 读回一次 Attempt 的完整正文与结论
curl http://localhost:3000/api/runs/$(jq -r .run_id run.json)/attempts/2
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> `/api/runs` 与 `/api/runs/from-plan` 需要 `config` 字段（缺失或非法返回 400）；
> 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig。
> `retry_policy` 可选，缺失或字段非法（类型不对 / 越界）时返回 400，Run 不会开始。
> `/api/validate` 与 `/api/review` 需要 `config` 与字符串 `story`；审阅用的温度固定为 `0.3`，
> 与生成温度相互独立。校验不调用 LLM，因此没有温度一说，结果完全确定。
> `/api/repair` 需要 `config`、`beat_plan`、`story`、`issue_type`、`issue_message` 五个字段，
> `issue_type` 只接受 `length` / `ending` / `character_presence` / `continuity` / `structure` / `general`。

## Prompt Template

模板文件：`prompts/beat_planner.txt`（阶段一）、`prompts/story.txt`（阶段二）、
`prompts/reviewer.txt`（审阅）与 `prompts/repair.txt`（定点修订）——直接编辑即可（重启后生效）。

### `prompts/story.txt`

| Variable | Meaning |
|---|---|
| `{{title}}` | 故事标题 |
| `{{genre}}` | 题材 |
| `{{premise}}` | 核心设定 |
| `{{setting}}` | 故事背景（空值渲染为「未指定」） |
| `{{protagonist_name}}` / `{{protagonist_identity}}` / `{{protagonist_goal}}` / `{{protagonist_motivation}}` | 主角四字段 |
| `{{conflict}}` | 核心冲突 |
| `{{stakes}}` | 失败代价 |
| `{{ending}}` | 结局方向 |
| `{{target_words}}` | 目标字数 |
| `{{style}}` | 写作风格（空值渲染为「未指定」） |
| `{{extra_requirements}}` | 附加要求（空值渲染为「未指定」） |
| `{{beat_plan}}` | 剧情骨架（阶段一产出的 BeatPlan 文本） |

### `prompts/beat_planner.txt`

| Variable | Meaning |
|---|---|
| `{{title}}` / `{{genre}}` / `{{premise}}` | 标题 / 题材 / 核心设定 |
| `{{setting}}` / `{{conflict}}` / `{{stakes}}` / `{{ending}}` | 背景 / 冲突 / 代价 / 结局方向 |
| `{{protagonist}}` | 主角四字段合成文本 |
| `{{target_words}}` | 目标字数 |

### `prompts/reviewer.txt`

审阅阶段读取 StoryConfig 与正文，输出单一 JSON。温度固定为 `0.3`，不受请求里的 `temperature` 影响。

| Variable | Meaning |
|---|---|
| `{{title}}` / `{{genre}}` / `{{premise}}` | 标题 / 题材 / 核心设定 |
| `{{setting}}` / `{{conflict}}` / `{{stakes}}` / `{{ending}}` | 背景 / 冲突 / 代价 / 结局方向 |
| `{{protagonist}}` | 主角四字段合成文本 |
| `{{target_words}}` / `{{style}}` / `{{extra_requirements}}` | 目标字数 / 风格 / 附加要求 |
| `{{story}}` | 待审阅的正文 |

输出必须是单个 JSON 对象：`{"score": 0~100, "summary": "...", "strengths": [...], "problems": [...]}`。
带 ``` 代码围栏或首尾空白的输出会被容忍，其余非法输出按 `ReviewParseError` 处理（审阅失败，正文保留）。

### `prompts/repair.txt`

定点修订阶段读取 StoryConfig、BeatPlan、问题类别、问题说明与当前正文，输出完整修订后正文。
温度固定为 `0.5`（`REPAIR_TEMPERATURE`），与生成温度相互独立。修订不是重新创作：模板要求优先保留已正常内容，
只做解决当前问题所必需的最小修改，不改人物、设定、主要剧情和结局方向。

| Variable | Meaning |
|---|---|
| `{{story_config}}` | StoryConfig 的文本化呈现 |
| `{{beat_plan}}` | 剧情骨架文本 |
| `{{issue_type}}` | 问题类别（`ending` / `length` / `conflict` / `character` / `dialogue` / `structure`） |
| `{{issue_message}}` | 这一步要修什么的人类可读说明 |
| `{{story}}` | 待修订的正文 |

修订失败（模型异常或返回空正文）不会让 Run 失败：正文保留修订前那一版，
Run 按重试策略继续走，也不会写下「修订成功」的假结论。

## 测试

```bash
npm test    # artifact-store / basic-reviewer / beat-parser / beat-plan / beat-planner /
            # config-loader / generate-api / generation-attempt / generation-pipeline / llm /
            # plan-api / prompt-builder / repair-api / repair-models / repair-pipeline /
            # repair-strategy / retry-api / retry-pipeline / retry-policy / review-parser /
            # review-result / run-api / run-context / story-config / story-generator /
            # story-repairer / story-validator / template-loading / ui-repair / ui-retry /
            # ui-review / ui-story-config / ui-two-stage / ui-validation /
            # validation-api / validation-result / version
```

所有测试都不调用真实 LLM：LLM 由注入的桩对象或 `fetch` 桩替代。
重试相关断言同样只用桩：`GenerationPipeline` 由注入的假 Generator / Validator / Reviewer 驱动，
用来验证尝试次数、reason 取值与 `quality_status`，从不触发真实模型调用。
定点修订的断言同样是桩：修订成功、修订返回空、修订抛 `LLMError`、修订后达标 / 仍不达标、
`enable_repair = false` 时链路与 v0.7.0 逐字一致、`max_repairs_per_attempt = 0` 时不修订。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
- `configs/example_story.json`：示例 StoryConfig
- `prompts/reviewer.txt`：审阅 Prompt 模板
- `prompts/repair.txt`：定点修订 Prompt 模板
- `src/core/retry-policy.ts`：重试策略与 RetryDecision 的实现（纯函数，无外部依赖，可直接阅读）
- `src/lib/validation-rules.ts`：六条硬性校验规则的实现（无外部依赖，可直接阅读）