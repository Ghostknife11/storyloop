# Storyloop · AI 短篇生成引擎

> 一个稳定的 AI 短篇小说生成引擎：剧情规划、硬性校验、基础审阅、确定性自动重试、定点修订，
> 以及一份把以上结论汇到一起的统一质量快照。
> A stable pipeline-based AI short-story generator: beat planning, hard validation, basic review,
> deterministic automatic retry, targeted repair, and a unified quality snapshot.
>
> **v1.2.0 开始建立统一质量工程层。** v1.0.0 冻结了生成契约，v1.1.x 收紧了地址关卡，
> v1.2.0 做的是把散落在 `validation.json` / `review.json` / `metadata.json` / API 响应里的
> 质量结论收口成一份 `QualityResult`：不调用模型、不产生新分数、没有多维、没有 PASS/FAIL 阈值——
> 它读的三样东西在 v1.2.0 之前就全都在产物里了。全部改动 additive：既有字段、路由、
> 错误码、CLI 参数与产物布局一个都没动。

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
StoryConfig → Planning →〔Validate BeatPlan〕→〔Attempt 1..max_attempts: Generate → Save Story → Validate → Review → Commercial Review → Repair? → Decide〕→ Finalize
```

- **AI Beat Planning**：先生成剧情骨架（BeatPlan），再据此写正文；骨架可手动编辑后进入生成
- **Beat Plan Validator（剧情骨架结构校验，v1.4.0）**：写正文之前先检查这份骨架撑不撑得起一个
  完整短篇；结论只报告，不改写骨架，用户改完可以再校验一次
- **Story Validator（硬性有效性检查）**：正文落盘后立即跑一遍确定性规则，回答「这篇正文基本可用吗」
- **Basic AI Reviewer**：每次生成的正文自动获得一次基础审阅，产出 0–100 整体分，
  并给出四个基础维度的分数与短评（连贯性 / 叙事 / 人物 / 因果）
- **Commercial Reviewer（商业可读性审阅，v1.5.0）**：与上面那道结构审阅完全并列的第二个
  审阅者，从「读者会不会继续读下去」的角度再出一次结论：Hook（开篇抓力）/ Pacing（节奏）/
  Engagement（全篇持续阅读动力）/ Payoff（回报）四个维度各 0–100 分加一句短评，
  外加优点 / 问题 / 建议三组清单。两份结论互不覆盖、互不影响
- **Automatic Retry（自动重试）**：生成失败、校验不通过或总分低于阈值时按确定性策略重新生成
- **Targeted Story Repair（定点修订）**：Attempt 不通过时先按具体问题类别改写这篇正文，
  修订后再校验、再审阅；修订彻底失败才退回整篇重新生成
- **Unified Quality Snapshot（统一质量快照）**：把校验结论、审阅结论与采纳结论汇成一份
  `QualityResult`（`quality.json` + API 的 `quality` 字段 + 前端 Quality Summary 面板），
  不调用模型、不新增分数
- **Run Artifacts**：产物统一落在 `runs/<run_id>/`，每次 Attempt、每次修订单独归档
- **Run Provenance（Run 出身清单，v1.6.0）**：每次 Run 在 `metadata.json` 旁多落一份
  `run-manifest.json`，写清跑在哪个代码版本与 commit 上、用的哪个模型、六份提示词各自的版本与
  内容摘要、各阶段 temperature 与重试策略、每次 Attempt 的结局，以及这批产物的 SHA-256。
  API 的 `manifest` 字段与前端 Run Provenance 面板读的是同一份。它只为一次 Run 自证出身：
  不做跨 Run 对比、不跑基准、不统计成功率
- **Experiment Framework（受控实验框架，v1.7.0）**：同一份 StoryConfig、同一份骨架、同一批
  环境，批量跑多个 Variant（最多 4 个 × 最多 5 次，总计不超过 12 条样本）。可改的变量只有
  四个：`model` / `temperature` / `retry.maxAttempts` / `retry.minReviewScore`。
  执行的是 `ExperimentRunner`（复用 v1.6.0 的 GenerationPipeline，每个样本都是一次完完整整的
  普通 Run），落盘的是 `ExperimentStore` 里 `experiments/` 下的 `definition.json` / `runs.json` /
  `results.json`。它只摆数字：每个 Variant 的计数与均值，顺序永远是你声明时的顺序
- **现代 Web UI**：六阶段进度、Attempt 计数、修订明细、Validation / Review / Commercial
  Review / Run Provenance 面板、实验列表与实验详情、Run ID 与产物清单
- **OpenAI-compatible LLM**：OpenAI / DeepSeek / 硅基流动 / 任意兼容端点
- **可编辑 Prompt 模板**：`prompts/*.txt` 直接改，重启生效
- **稳定 CLI**：`run` / `plan` / `review` / `validate` / `repair` 五个命令，与 API 共用同一套逻辑

> **Validator 与 Reviewer 是两件事**：
>
> | | Story Validator | Basic Reviewer |
> |---|---|---|
> | 回答的问题 | 「这篇正文基本可用吗」 | 「这篇故事写得好吗」 |
> | 实现 | 确定性规则，不调用 LLM | LLM 审阅，主观评价 |
> | 产出 | `ValidationResult`（`passed` + `issues`） | `ReviewResult`（`score` + 可选 `dimensions` + `summary` + `strengths` + `problems`） |
> | 判定性质 | 硬性：`error` 即不通过 | 软性：分数只做反馈 |
>
> 两者互不影响：**Review 分数不参与 Validation 判定**——哪怕 Review 打 0 分，校验该过还是过。
>
> **维度是评价输出，不是行动依据（v1.3.0）**：审阅者在整体分之外还给四个基础维度各打一个
> 0–100 分并附一句短评。有维度时整体分就是这四个数的均分（四舍五入到 1 位小数，
> 纯算术、无权重），`RetryPolicy` 里仍然只有 `min_review_score` 一个总分门槛——
> 维度不新增阈值、不触发重试或修订、不改变采纳判定。维度也可有可无：
> 1.3.0 之前的 Run 没有这个字段，读取时整个键不出现，行为与当年逐字一致。
>
> **两个审阅者是两件事（v1.5.0）**：Basic Reviewer 看结构（连贯性 / 叙事 / 人物 / 因果），
> Commercial Reviewer 看读者体验（Hook / Pacing / Engagement / Payoff）。两者各自的提示词、
> 各自的解析器、各自的产物文件（`review.json` 与 `commercial-review.json`），
> **绝不合成一个「八维大 Prompt」**。商业可读性分数同样不驱动任何决策：不触发重试、不触发
> 修订、不进 `QualityResult`（质量快照仍然只有 Co/N/C/Ca 四个维度）。它也**不是市场预测**——
> 没有「爆款概率」「必火」「市场成功率」一类字段或文案，分数描述的是文本本身可观察的事实。
>
> **定点修订在整篇重试之前**：修订策略是纯函数（问题类别只由校验 issue code 或审阅问题文本推出，
> 没有模型参与、没有打分、没有择优），重试同样由确定性策略驱动，没有学习、没有自适应：
> 同样的输入得到同样的重试次数。修订只回答「这篇正文哪里不对、按类别改一次」，不回答「为什么会失败」。
>
> **Beat 校验只报告，不修复（v1.4.0）**：骨架结构不达标时 Storyloop 不改写任何一拍、不重排顺序、
> 不自动补拍，也不据此重新规划——它只告诉你哪儿站不住，骨架怎么改由你决定。
>
> **受控实验只摆数字，不评比（v1.7.0）**：一次实验回答「只改这四个变量分别发生了什么」。
> 它**不排名、不评选赢家**（结果表的行顺序永远是你声明 Variant 的顺序，绝不按分数重排）；
> 缺分数的那一条显示 `—`，**不被当成 0**（补 0 等于凭空制造一个差评）；
> **不是模型跑分平台**（没有 leaderboard、没有胜率、没有「推荐 Variant」）；
> **不做显著性检验**（没有 p 值 / 置信区间 / 效应量，两个均值差多少由读数字的人自己判断）；
> **不自动调参**（同一份定义重跑会被 409 挡住：定义与结果都不可变，要改条件就复制成一个新实验）。
> 同一次实验里 A 组三条都有分、B 组只有一条有分，两组的均值本来就不可直接比大小——
> 这也是界面必须把「有几条真的跑出了分」摆出来的原因。
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
│   Run API            │  POST /api/runs · POST /api/runs/from-plan · POST /api/validate · POST /api/review · POST /api/review/commercial · POST /api/validate-beats
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────┐
│  generate-service                        │  CLI 与 API 共用同一批函数，不重复实现业务逻辑
└──────────┬───────────────────────────────┘
           ▼
┌──────────────────────┐
│  GenerationPipeline  │  固定顺序：Config → Planning →〔Validate BeatPlan〕→〔Attempt 1..max_attempts: Generate → Save Story → Validate → Review → Commercial Review → Repair? → Decide〕→ Finalize
│  · run()             │  StoryConfig → BeatPlan → Story → ValidationResult → ReviewResult → CommercialReviewResult
│  · runWithPlan()     │  用户编辑后的 BeatPlan 直接进入生成
│  · RetryPolicy       │  max_attempts / min_review_score / retry_on_validation_failure / enable_repair / max_repairs_per_attempt
│  · RepairLoop        │  定点修订在整篇重试之前：Repair → Re-validate → Re-review → 仍不达标才重试
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   RunContext         │  run_id + status + current_stage + error
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  QualityAssembler（v1.2.0）                                  │
│  纯函数：ValidationResult + ReviewResult + 采纳结论          │
│  → QualityResult（overall_score / validation_passed /       │
│    accepted / issues / suggestions / summary /               │
│    dimensions?）                                            │
│  不调用模型 · 无随机 · 同一输入永远得到同一份 JSON            │
└──────────┬───────────────────────────────────────────────────┘
           ▼
┌──────────────────────┐
│  BeatPlanner         │  prompts/beat_planner.txt → LLM → BeatPlan（可手动编辑）
│  BeatValidator       │  prompts/beat_validator.txt → LLM → BeatValidationResult（只看结构，不改写骨架）
│  StoryGenerator      │  prompts/story.txt 渲染（含 Beat Plan）
│  StoryValidator      │ 确定性硬性规则 → ValidationResult（不调用 LLM，只检查，不改写）
│  BasicReviewer       │  prompts/reviewer.txt → LLM → ReviewResult（只评价，不改写）
│  CommercialReviewer  │  prompts/commercial_reviewer.txt → LLM → CommercialReviewResult（只看读者体验，不改写）
│  StoryRepairer       │  prompts/repair.txt → LLM → 修订后正文（可选，不注入则无修订能力）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│      LLM Client      │  OpenAI-compatible（system + user）· 单次超时 LLM_TIMEOUT · transport retry 硬上限 2 次
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────┐
│    ArtifactStore     │  原子写入 runs/<run_id>/ 下的产物，写失败抛 ArtifactWriteError
│                      │  v1.2.0 起多一份 quality.json（Run 根与 attempts/NN/ 各一份）
│                      │  v1.4.0 起多一份 beat-validation.json（Run 根，对 BeatPlan 唯一）
│                      │  v1.5.0 起多一份 commercial-review.json（Run 根与 attempts/NN/ 各一份）
└──────────────────────┘
```

质量结论的流向：Validator / Reviewer / RetryPolicy 各自产出**原始**结论（落盘为
`validation.json` / `review.json`、metadata 记录分数），QualityAssembler 只做**汇总**——
把同一份结论整理成 `QualityResult` 写进 `quality.json`。它排在原始结论的下游，
不会反过来影响校验、审阅或重试的任何判定。

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

BeatPlan 在第一个 Attempt 之前单独过一道结构校验（v1.4.0，进度记在 `validating_beat_plan`）：
规则层先查空骨架、拍数不足、编号重复、编号不连续这几件不用问模型的事；这些没问题才把
StoryConfig + BeatPlan 交给模型判结构。**结论里带 error 级问题时整个 Run 就此结束**——
一个 Attempt 都不跑，`story.md` 与 `attempts/` 都不会出现（骨架都站不住时不花生成额度）；
只有 warning 或完全没有问题时照常生成。BeatValidator 自身崩溃则只把
`beat_validation_status` 置为 `failed` 并记录原因，骨架与生成流程都不受影响。

结构审阅之后还有一道**商业可读性审阅**（v1.5.0，进度记在 `reviewing_commercial`）：
同一个故事再拿给 `CommercialReviewer`，从「读者会不会继续读下去」的角度给 Hook /
Pacing / Engagement / Payoff 四个维度打分。这一步排在结构审阅之后、可能的修订之前，
因此同一篇正文的两份结论描述的是同一版文字。它自身失败（模型超时、输出非法）只把
`commercial_review_status` 置为 `failed` 并记录原因——正文、`validation.json` /
`review.json` / `quality.json` 与采纳结论一个都不受影响，Run 照常收尾。

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

v1.4.0 起这份骨架在写正文之前还要过一道**结构校验**（见下面的 BeatValidationResult）：
撑得起一个完整短篇才往下走，撑不起就停在这里。校验只读不写——你在 UI 里编辑 Beat、
保存、再点一次 Validate Beats，拿到的永远是新结论，旧的那份不会被就地改掉。

## Run 与产物

一次完整生成就是一个 **Run**。Run ID 形如 `20260920_101530_k3f9aq`（本地时间戳 + 6 位随机字符），
由服务端生成，不依赖用户输入，可安全用作目录名。

```text
runs/
└── <run_id>/
    ├── config.json      # 本次运行使用的 StoryConfig
    ├── beats.json       # 实际采用的 BeatPlan（多次 Attempt 复用同一份）
    ├── beat-validation.json  # 这份 BeatPlan 的结构校验结论（v1.4.0 新增，跑过这一步才有）
    ├── story.md         # 被选中那一次 Attempt 的正文（发生过修订时为修订后的版本）
    ├── validation.json  # 被选中那一次 Attempt 的首次硬性校验结果
    ├── review.json      # 被选中那一次 Attempt 的首次审阅结果
    ├── commercial-review.json  # 被选中那一次 Attempt 的商业可读性结论（v1.5.0 新增，跑过这一步才有）
    ├── quality.json     # 被选中那一次 Attempt 的统一质量快照（v1.2.0 新增）
    ├── metadata.json    # 运行级 metadata
    ├── run-manifest.json  # 这次 Run 的出身清单（v1.6.0 新增，只在运行级一份）
    └── attempts/
        ├── 01/
        │   ├── story.md          # 该次尝试的正文（发生过修订时为修订后的版本）
        │   ├── initial_story.md  # 修订前的正文（只有发生过修订时才存在）
        │   ├── validation.json   # 该次尝试的首次校验结论
        │   ├── review.json       # 该次尝试的首次审阅结论
        │   ├── commercial-review.json  # 该次尝试最终那一版正文的商业可读性结论（v1.5.0 新增）
        │   ├── quality.json      # 该次尝试的统一质量快照（v1.2.0 新增）
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
`review_score`、`review_error`、`quality_assembly_status`、`overall_score`、
`quality_issue_count`、`max_attempts`、`min_review_score`、
`attempt_count`、`selected_attempt`、`quality_status`、`enable_repair`、
`max_repairs_per_attempt`、`repair_count`、`beat_validation_status`、
`beat_validation_passed`、`beat_validation_issue_count`、`beat_validation_error`、
`commercial_review_status`、`commercial_score`、`commercial_review_error`、
`duration_ms`、`llm_call_count`。
`model` 始终是「本次真正生效的模型」（请求覆盖 → 环境变量 → 缺省值），attempt 级的 `error`
没有错误时是 `null`——这两条是 v1.0.0 固定下来的字段语义。
v1.8.0 起的 `duration_ms` / `llm_call_count` 是 `telemetry.json` 的转述：想看阶段耗时、
每次模型调用的起止与 usage，去读 [docs/telemetry.md](docs/telemetry.md)，metadata 里的
这两个数只是不用再翻一个文件时的快捷方式。

发生过修订时有一处**刻意的不对称**：运行级 `metadata.json` 里的 `validation_*` / `review_score`
取自入选 Attempt **修订后**的结论，而同目录的 `validation.json` / `review.json`（以及
`attempts/NN/` 下的同名文件）是**首次**结论，修订后的那份在 `attempts/NN/repairs/MM/` 里。
`quality.json` 与它派生的 `overall_score` / `quality_issue_count` 一律取**修订后**的结论，
与 metadata、与最终采用的 `story.md` 同口径；因此同一层里 `quality.json` 的分数可能高于
`review.json`（`examples/example_run/` 就是这个样子）。1.x 内保持这个语义不变。

**校验不通过不是 Run 失败**：`status` 仍为 `completed`，`validation_passed` 为 `false`，
此时会按策略定点修订或自动重试。**校验器自身崩溃也不是 Run 失败**：`validation_status` 为 `failed`，
`validation_error` 记录原因，此时不写 `validation.json`，也不会触发修订或重试。
自动重试达到上限同样不是 Run 失败：`quality_status` 为 `exhausted`，所有产物都保留。
只有连正文都拿不到时，Run 才以 `generating` 阶段失败结束。

完整的字段表与「什么情况下缺文件」见 [docs/run-artifacts.md](docs/run-artifacts.md)。

### Run 出身清单（v1.6.0）

运行级除了 `metadata.json` 还多了 `run-manifest.json`，回答「这份故事是拿什么跑出来的」：
用的是哪个代码版本与 commit、哪个模型、各阶段 temperature、六个提示词各自的版本与内容摘要、
每次 Attempt 的结局（是否入选 / 为什么重试 / 修了几轮），以及这批产物的 SHA-256 清单。
它自带 `schemaVersion`、用 camelCase，与 snake_case 的 metadata 契约物理隔离；不顶替
`metadata.json`，也不改它的任何一个字段。清单只记元数据，不搬运正文与结论文字；模型条目只留
模型名与 provider 分类，**baseUrl 原文不落盘**；客户端没有下发的 `topP` / `maxTokens` 也不写。

API 侧 `POST /api/runs` 与 `GET /api/runs/<run_id>` 各多一个 `manifest` 字段，就是这份清单。
v1.6.0 之前生成的 Run 没有它，读接口返回 `null`，界面面板整个隐藏。清单只为一次 Run 自证
出身：不做跨 Run 对比、不跑基准、不统计成功率（那些能力保留给后续版本）。

v1.7.0 起，实验里跑出来的每个样本在这份清单上多一个可选的 `experiment` 块
（`experimentId` / `variantId` / `repetition`）。普通 Run 没有这个键，读取时整个键不出现；
它只记录出身，不参与任何流程判断，也不会因为写不进清单而让一次成功的 Run 变成失败。
出身面板从 v1.7.1 起把这行摆出来（`Experiment experiment-id · variant x · repetition n`）。

## 受控实验（Experiment Framework，v1.7.0）

实验不是一次 Run，是**一组 Run 按同一份定义跑出来的一份结果**。一次实验固定回答一个问题：
「只改这四个变量，分别发生了什么？」

```text
ExperimentDefinition（base + variants[] + repetitions）
  → 展开成 variants × repetitions 个样本（顺序执行，不并发）
  → 每个样本走 GenerationPipeline（一次完完整整的普通 Run）
  → experiments/<experimentId>/{definition.json, runs.json, results.json}
  → 按 Variant 汇总：计数 + 均值
```

四个可改变量：`model`、`generation.temperature`、`retry.maxAttempts`、`retry.minReviewScore`。
定义里**不出现 `baseUrl`**——一条样本的地址永远来自服务端 `LLM_BASE_URL`，v1.1.0 的地址关卡
因此对每个 Variant 都生效，实验没有第二条入口可以绕。Prompt 也不是变量：每个阶段只读一份
固定提示词文件，注册表里每个角色只有一个版本，「换 Prompt 版本」在这个版本不产生任何变化，
所以定义里直接拒绝（`topP` / `maxTokens` 同理）。凭据 / 地址 / 原始提示词形状的键一律 400。

上限写在契约里：`variants` 1~4 个、`repetitions` 1~5、总样本数不超过 **12**。
「什么都没改」也是合法 Variant——基准自己就是一个 Variant。

单个样本失败不中止实验：剩下的接着跑，失败的那一格记下失败阶段（`generating` /
`planning` / …）与一句话摘要，整体状态是 `partial`。每跑完一格就重写一次 `runs.json`，
进程中途被杀，`GET` 也能如实显示已经跑出来的部分。

结果（`ExperimentResult`）只有计数与均值两类数字：`runCount` / `successCount` /
`failureCount` 与九个均值（整体分、商业分、四个质量维度、四个商业维度）。缺分数的样本
不参与均值，界面显示 `—`。`results.json` 的 `runs` 数组还逐条记下每个样本自己的
`overallScore` / `commercialScore`（读自它自己的产物，v1.7.1 补上），所以样本行也有数字可看。
**没有排序、没有赢家、没有显著性检验、没有自动调参。**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/experiments` | `{schemaVersion:"1", name, experimentId, base, variants, repetitions}` → 201，只建不跑 |
| GET | `/api/experiments` | 列表：每个实验一行（变体数 × 次数、状态、成败计数） |
| GET | `/api/experiments/<experiment_id>` | `{definition, runs, result}`；没跑过时 `runs` 与 `result` 是 `null` |
| POST | `/api/experiments/<experiment_id>/run` | 跑完整个实验，回传 `ExperimentResult`；已在运行时 409 |

界面：`/experiments`（列表 + 创建）、`/experiments/<experiment_id>`（变体卡片、结果表、
样本行，每条样本可点进既有的 Run 详情）。完整契约见 [docs/experiments.md](docs/experiments.md)。

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

没有角色一致性分析、动机分析、故事弧检查、Beat 校验、读者体验评价——
Validator 只回答「基本可用吗」，不回答「写得好不好」，也不回答「读者读不读得下去」
（后面两个分别是 Basic Reviewer 与 Commercial Reviewer 的事）。

## ReviewResult

| Field | Type | Description |
|---|---|---|
| `score` | number | 总分 0 ~ 100（整数或小数，越界即拒绝） |
| `summary` | string | 一段总体评价 |
| `strengths` | string[] | 优点列表（可为空数组，条目会 trim） |
| `problems` | string[] | 问题列表（可为空数组，条目会 trim） |

没有严重度、证据定位、置信度，也没有 PASS / FAIL 判定——审阅只提供反馈。
审阅用的温度固定为 `0.3`，与生成温度相互独立。

### 四个基础维度（v1.3.0，可选）

`ReviewResult` 有一个可选字段 `dimensions`：四个键，各自一个 0–100 分 + 一句短评。

| 维度键 | 中文名 | 评的是什么 |
|---|---|---|
| `coherence` | 连贯性 | 设定、称呼、时间线前后是否一致 |
| `narrative` | 叙事 | 结构是否完整、起承转合与节奏是否得当 |
| `character` | 人物 | 言行是否符合其目标与动机 |
| `causality` | 因果 | 事件推进是否有清楚的前因后果 |

连贯性与因果是两件事：前者管「前后对得上」，后者管「推得动」。一个故事可以因果清楚
却前后矛盾，也可以前后一致却推不动。

整体分 `score` 在有维度时等于四维均分（四舍五入到 1 位小数），对齐方式是纯算术，
不引入权重、不让模型自己解释。维度一旦出现就必须四个齐全、各自 0–100 且带非空短评：
缺维度、多维度（模型自己扩到 35 维也一样）、分数越界都按审阅输出非法处理——
不补 0、不挑一个先凑着，因为补出来的数会被当成真实评价参与展示。

维度只影响「看得见多少」，不影响「怎么决策」：没有按维度设的阈值，没有维度驱动的重试或修订。
没有维度的旧结论（1.3.0 之前的 `review.json`）一路照常可用。

## CommercialReviewResult（v1.5.0）

与 `ReviewResult` 完全并列的第二个结论：同一个故事，一份看结构（Co/N/C/Ca），一份看
「读者会不会继续读下去」。两者是**两个独立的审阅者**——各自的提示词、各自的解析器、
各自的产物文件（`review.json` / `commercial-review.json`），不合成一个八维大 Prompt，
也不互相改写对方的结论。

| Field | Type | Description |
|---|---|---|
| `score` | number | 商业整体分 0 ~ 100；**永远由四个维度重算**（等权均分，四舍五入到 1 位小数），模型自报值只作形状校验 |
| `summary` | string | 一段话说清这篇正文的商业可读性整体表现 |
| `strengths` | string[] | 商业可读性上的优点（可为空数组） |
| `problems` | string[] | 商业可读性上的问题（可为空数组） |
| `suggestions` | string[] | 可以怎么改的建议（可为空数组） |
| `dimensions` | object | 四个固定维度，见下 |

四个维度一个不能少、也不许多出别的（模型自己扩到 6 个也算非法），各自 0~100 分加一句
非空短评，整体分就是这四个数的均分：

| 维度键 | 中文名 | 评的是什么 |
|---|---|---|
| `hook` | Hook（开篇抓力） | 只看开头：冲突 / 悬念是否尽早出现，前几段有没有抓力 |
| `pacing` | Pacing（节奏） | 只看阅读速度与拖沓感：推进快不快、信息密度、有无重复 |
| `engagement` | Engagement（全篇持续阅读动力） | 只看全篇：悬念是否持续、冲突是否维持、读到哪里容易弃读 |
| `payoff` | Payoff（回报） | 只看承诺与兑现：高潮够不够值、结尾是否回应主要冲突 |

两条边界必须分清：Hook ≠ Engagement（开头抓人但中段崩塌，是 Hook 高、Engagement 低）；
Pacing ≠ Narrative（结构成立但读起来拖沓，是 Pacing 低）。
评分描述的是文本本身可观察的事实，**不预测市场、销量、读者规模或商业结果**。

商业可读性分数不驱动任何决策：`RetryPolicy` 里仍然只有 `min_review_score` 一个总分门槛
（比的还是结构审阅的整体分），修订策略仍然只看问题类别，`QualityResult` 里也**没有**
商业分。审阅用的温度固定为 `0.3`，与结构审阅同级、与生成温度相互独立。这一步自身失败
只让 `commercial_review_status` 变成 `failed`，Run 与其它结论照常成立。
`POST /api/review/commercial` 可以单独跑一次：同样的模型、同样的规则，
带 `run_id` 时覆盖该 Run 根目录的 `commercial-review.json`。

## QualityResult（v1.2.0，v1.3.0 增加可选维度）

把上面两样结论与采纳结论汇到一起的统一快照。字段就是「一处校验结论 + 一处审阅结论 +
一个采纳结论」，没有等级、没有趋势：

| Field | Type | Description |
|---|---|---|
| `overall_score` | number \| null | 单一整体分；有维度时取四维均分，否则取 `review.score`。没有审阅结论时是 `null`（不是 0） |
| `validation_passed` | boolean \| null | `true` / `false`；校验没跑（组件自身异常）时是 `null`，与「校验没过」是两件事 |
| `accepted` | boolean | RetryPolicy 的采纳结论，不参与判定 |
| `issues` | QualityIssue[] | 问题清单（可为空数组） |
| `suggestions` | QualitySuggestion[] | 建议清单（可为空数组） |
| `summary` | string \| null | 审阅的总体评价；审阅失败或没给时是 `null` |
| `dimensions` | object? | v1.3.0 可选：四个基础维度的分数与短评，由 `ReviewResult.dimensions` 原样搬运；没有维度时整个键不出现 |

`QualityIssue`：`id`（`validation-N` / `review-N`）、`source`（`validation` / `review`）、
`category`（校验侧是 issue code，审阅侧统一 `review_problem`）、`message`、可选 `severity`。
`QualitySuggestion`：`id`（`review-suggestion-N`）、`source`、`message`。

`QualityAssembler` 是纯函数：同一输入永远得到同一份 JSON，不调用模型、无随机，
读的三样东西（`ValidationResult` / `ReviewResult` / 采纳结论）在 v1.2.0 之前就都在产物里。
它只汇总，**不参与**任何校验、审阅或重试判定；维度也只是从审阅结论搬到快照里，
不在这里重新打分。

快照出现在三个地方，内容一致：Run 根与 `attempts/NN/` 下的 `quality.json`、
Run 类入口与两个读回接口响应里的 `quality`、前端 Quality Summary 面板。
修订目录 `attempts/NN/repairs/MM/` 里**没有** `quality.json`。v1.2.0 之前的 Run 没有这个文件，
读取时按同一套规则临时装配，不会因此失败。装配取的是这次尝试**最终留下的那一版**结论
（发生过修订时是修订后那一轮，与 `metadata.json` 同口径，v1.2.1 起如此）。

## BeatValidationResult

写正文之前对 BeatPlan 的结构校验结论。StoryValidator 看正文，这里看骨架（§2）——
两套结论各自独立，谁也不算谁的输入。

| Field | Type | Description |
|---|---|---|
| `passed` | boolean | `true` 当且仅当没有 `severity: "error"` 的 issue；由 issues 重新推导，不采信模型自报值 |
| `issues` | BeatValidationIssue[] | 命中项清单（可为空数组） |
| `summary` | string | 一句话说清这份骨架结构上成不成；面板直接展示，不再二次拼接 |

`BeatValidationIssue` 四个字段：`code`（稳定问题码）、`severity`（`warning` / `error`，
只有两级）、`message`（人类可读说明）、可选 `beat_ids`（涉及哪几拍，指认不到就不填）。
没有 rewritten_plan / fixed_beats / suggested_plan——**本版本只报告，不修复**。

| Code | Severity | 谁判的 | 触发条件 |
|---|---|---|---|
| `EMPTY_PLAN` | error | 规则层 | BeatPlan 里没有任何一拍 |
| `TOO_FEW_BEATS` | warning | 规则层 | 拍数少于 3，正面建立 / 冲突升级 / 高潮收束必然挤在一起 |
| `BROKEN_SEQUENCE` | error | 规则层 | 编号不是从 1 连续递增 |
| `DUPLICATE_BEAT` | error | 规则层 | 两拍同一个 id |
| `MISSING_OPENING` | warning | 模型 | 没有哪一拍承担建立人物 / 处境 / 世界观的正面任务 |
| `MISSING_ESCALATION` | warning | 模型 | 没有冲突升级或转折，拍与拍之间原地踏步 |
| `MISSING_CLIMAX` | error | 模型 | 没有高潮或决定性对抗，故事缺一个顶点 |
| `MISSING_RESOLUTION` | error | 模型 | 没有收束，结局处于悬空状态 |
| `CHARACTER_STATE_CONFLICT` | error | 模型 | 同一人物在不同拍之间状态互相矛盾 |
| `UNSUPPORTED_TURN` | error | 模型 | 某一拍的转折没有任何前文铺垫 |
| `ENDING_NOT_PREPARED` | warning | 模型 | 结局所需的条件（道具 / 信息 / 关系）从未在前文出现 |

前四条由规则层（不调用 LLM 的纯函数）判定，出现 error 时直接下结论、不再请求模型——
不花冤枉钱。后七条交给模型判结构，温度固定为 `0.2`，与生成温度相互独立。
规则层与模型报到同一处问题时只保留一份。

**校验不通过不是 Run 失败，而是 Run 提前结束**：`status` 为 `failed`、`current_stage` 为
`validating_beat_plan`，`beat_validation_passed` 为 `false`，产物里留下 `beats.json` 与
`beat-validation.json`——够你看出是哪儿站不住，但一个 Attempt 都没跑。
**只有 warning 时照常生成**，结论同样落盘。BeatValidator 自身崩溃时
`beat_validation_status` 为 `failed`、`beat_validation_error` 记录原因，生成流程不受影响，
此时没有 `beat-validation.json`。没跑过这一步的 Run（v1.4.0 之前）
`beat_validation_status` 是 `not_started`、`beat_validation` 是 `null`。

`POST /api/validate-beats` 可以单独校验一份骨架：同样的模型、同样的规则，
但**不写任何产物**——Run 里那一份 `beat-validation.json` 由 Pipeline 自己负责。

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
| POST | `/api/review/commercial` | `{config, story}`（+可选 `run_id`）→ 单独做商业可读性审阅（v1.5.0） |
| POST | `/api/validate` | `{config, story}`（+可选 `run_id`）→ 单独校验正文 |
| POST | `/api/validate-beats` | `{config, beat_plan}` → 单独校验剧情骨架的结构，不写任何产物 |
| POST | `/api/repair` | `{config, beat_plan, story, issue_type, issue_message}` → 单独定点修订 |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt，不调模型 |
| GET | `/api/runs/<run_id>` | 读回一次 Run 与它的 Attempt 摘要 |
| GET | `/api/runs/<run_id>/attempts/<n>` | 读回某一次 Attempt 的详情 |
| POST | `/api/experiments` | 建一份实验定义（201）。**只建，不跑** |
| GET | `/api/experiments` | 实验列表：定义摘要 + 结果状态，不带样本详情 |
| GET | `/api/experiments/<experiment_id>` | 一份实验的定义 + 格子 + 结果（没跑过时后两者是 `null`） |
| POST | `/api/experiments/<experiment_id>/run` | 顺序跑完整个实验，回传 `ExperimentResult` |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "<VERSION 文件内容>"}` |

`retry_policy` 可省略，省略时用默认值。它不属于 StoryConfig，不会写进 `config.json`，
只会记录在 Run 的 `metadata.json` 里。非法值返回 400，Run 不会开始。
`artifacts` 是产物文件名映射（`config` / `beat_plan` / `story` / `metadata`，
校验、审阅或质量装配各自成功时追加 `validation` / `review` / `quality`，
跑过 Beat 结构校验时追加 `beat_validation`，商业可读性审阅成功时追加 `commercial_review`），
响应中不会返回服务器绝对路径。

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
| `COMMERCIAL_REVIEW_FAILED` | 502 | 商业可读性审阅拿不到合法 CommercialReviewResult（v1.5.0，与 `REVIEW_FAILED` 并列） |
| `REPAIR_FAILED` | 502 | 单独修订入口的模型输出非法 |
| `BEAT_VALIDATION_FAILED` | 502 | 骨架结构校验拿不到合法 BeatValidationResult（v1.4.0） |
| `VALIDATION_FAILED_INTERNAL` | 500 | Validator 自身崩溃（不是「校验不通过」） |
| `EXPERIMENT_INVALID` | 400 | v1.7.0 新增：实验定义不合法（含凭据 / 地址 / 原始提示词形状的键），或服务端没配 `LLM_API_KEY` 却请求跑实验 |
| `EXPERIMENT_NOT_FOUND` | 404 | v1.7.0 新增：`experiment_id` 不存在 |
| `EXPERIMENT_CONFLICT` | 409 | v1.7.0 新增：同名实验已存在、这份实验已经跑过（定义与结果都不可变），或它正在运行中 |
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
| `--model` / `--base-url` / `--temperature` | 全部（validate 除外） | 覆盖服务端 LLM 设置；**温度只作用于规划与生成**——审阅固定 0.3、商业可读性审阅固定 0.3、修订固定 0.5，三者与生成温度相互独立（v1.4.1 起 CLI 会明说这一点） |
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
| **LLM Settings** | 请求覆盖 > 环境变量 > 默认值 | `LLM_BASE_URL` / `LLM_MODEL` / `temperature` / `timeoutMs`，全部非敏感；温度只驱动规划与生成，审阅 / 商业可读性审阅 / 修订 / Beat 校验各有固定温度 |
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

请求体里的 `baseUrl` 覆盖会带着这把密钥去请求对应地址，所以它不能指向任意主机：
只允许 `http` / `https` 的公网地址，本机、环回、私网、链路本地（含云元数据地址）与保留段一律在
发出请求前按 400 `CONFIG_INVALID` 拒掉，域名还要解析出地址后再判一遍；IPv6 里内嵌 IPv4 的
mapped / NAT64 地址按内嵌的那个地址判
（详见 [docs/api.md](docs/api.md) 的「`baseUrl` 覆盖的地址限制」）。
服务端自己的 `LLM_BASE_URL` 是运维的受信配置，不受这套规则约束；CLI 的 `--base-url` 与它同级，
见 [docs/cli.md](docs/cli.md)。

## 已知限制

这些是**刻意不做**的，不是待修的缺陷。每一条都有对应说明：

- **维度只有四个，且只是评价输出**：审阅除了 0–100 整体分只给连贯性 / 叙事 / 人物 / 因果
  四个基础维度，没有更细的拆解、没有子维度、没有维度阈值、没有维度驱动的重试或修订
  （整体分即四维均分，重试仍只看 `min_review_score` 一个门槛）
- **没有 Best-of-N 择优**：取第一个满足策略的 Attempt，不会在多次尝试里挑「最好的」
- **没有质量门禁**：没有 PASS / FAIL 判定，`quality_status` 只有 `accepted` / `exhausted` 两种
- **没有商业可行性预测**：商业可读性审阅（v1.5.0）只评价文本本身可观察的读者体验
  （Hook / Pacing / Engagement / Payoff），不评估市场适配、读者规模、销量或商业结果，
  也没有「爆款概率」一类的数字
- **实验不是基准平台**：v1.7.0 的受控实验能批量跑多个 Variant 并按 Variant 汇总计数与均值，
  但它不排名、不评选赢家、不做显著性检验、没有跨实验统计口径、没有评分回归集；
  一个定义里的样本总数上限 12（`variants` 1~4 × `repetitions` 1~5），变量只有
  `model` / `temperature` / `retry.maxAttempts` / `retry.minReviewScore` 四个
- **没有自动调参与自动搜索**：实验只执行你写下来的条件，不尝试新组合、不根据结果反推更好的
  参数、不优化 Prompt；同一份定义重跑会被 409 挡住（定义与结果都不可变）
- **实验没有断点续跑**：跑到一半被杀，磁盘上留着前几格的进度（`GET` 看得见），但再次开跑是
  从第一格重新开始，已经花过钱的样本会再跑一遍；跑的时候不要中途杀进程
- **没有高级可观测性**：只做工程日志（等级 + `run_id` / `attempt` / `repair` 上下文 + 脱敏），
  没有 Metrics / Trace / Prometheus / OpenTelemetry / Dashboard
- **没有失败归因与因果图**：修订只按类别改一次，不回答「为什么会失败」、
  不推断「哪个组件最可能出问题」
- **没有自适应生成与自优化**：同样的输入得到同样的重试次数与同样的修订类别
- **Beat 校验只管结构，且只报告**：它不评价规划质量（这一拍写得好不好、该不该这么排），
  不做跨拍因果推演，也没有自动改写、重排、补拍或重新规划——发现问题后由你决定怎么改
- **没有工作流引擎 / DAG / Stage Registry**：阶段顺序固定，不能任意跳段
- **没有鉴权、限流、批量与流式**：API 没有用户体系，也没有 SSE / WebSocket
- **`target_words` 是目标不是保证**：实际输出长度受模型能力与上下文窗口影响
- **只支持 OpenAI-compatible 端点**：没有 Provider Registry / Model Router / Fallback

## 升级说明

v1.7.0 新增 **受控实验框架**（Experiment Framework）：`POST /api/experiments` 建定义、
`POST /api/experiments/<id>/run` 跑完、`GET /api/experiments[/<id>]` 读结果，界面是
`/experiments` 与 `/experiments/<id>`。数据落在 `runs/` 旁的 `experiments/` 下三个 JSON。
纯 additive：从 1.6.x 升到 1.7.0 **不需要改任何代码**，1.6.x 写的产物可以直接读，一次普通 Run
一个字节都没变（`run-manifest.json` 只在实验样本上多一个可选的 `experiment` 块，普通 Run 里
这个键不出现）。要紧的有三条：新增三个错误码 `EXPERIMENT_INVALID` / `EXPERIMENT_NOT_FOUND` /
`EXPERIMENT_CONFLICT`；实验定义里不接受凭据、地址与原始提示词形状的键（400）；
同一份定义只能跑一次（409，要改条件就复制成新实验）。回滚到 1.6.0 的代价为零，
多出来的目录、路由与字段被旧版本忽略。逐版说明见 [docs/upgrade.md](./docs/upgrade.md)。
v1.6.0 新增 **Run 出身清单** `run-manifest.json`：每次 Run 除了 `metadata.json` 还多写一份
记录「这份故事是拿什么跑出来的」——代码版本与 commit、模型、各阶段 temperature、六份提示词的
版本与内容摘要、每次 Attempt 的结局、以及这批产物的 SHA-256。它只在 Run 根目录一份，
自带 `schemaVersion`、用 camelCase，与 snake_case 的 metadata 契约物理隔离。纯 additive：
从 1.5.x 升到 1.6.0 **不需要改任何代码**，1.5.x 写的产物可以直接读（`manifest` 读作 `null`
、Run Provenance 面板整个隐藏）。要紧的有三条：运行级固定文件数从九个变十个；两个 Run 类
响应各多一个可选字段 `manifest`；清单里不写凭据——baseUrl 原文、API Key 都不落盘，
`topP` / `maxTokens` 这类客户端没有下发的参数也不写。回滚到 1.5.2 的代价为零，
多出来的文件与字段被旧版本忽略。逐版说明见 [docs/upgrade.md](./docs/upgrade.md)。
v1.5.2 是一次界面修订：没有新能力、没有新文件、新字段或新路由，只改 `src/**/*.tsx` 里的
样式类名。从 1.5.1 升到 1.5.2 **不需要改任何代码**，1.5.1 写的产物可以直接读。要紧的有三条：
Story Config 外框不再让内容溢出到边框外（两列布局补 `min-h-0`，两列各自 `min-h-0` +
`overflow-y-auto`，内容超高时在自己的圆角框内滚动）；界面颜色改用主题 token，
浅色模式不再是一层看不见的边框配读不清的浅灰正文（`border-border` / `bg-muted*` /
`text-foreground` / `bg-input` / `bg-card`）；右列结果区原来**一像素都滚不动**——
`scrollHeight` 等于 `clientHeight`，Attempts / Quality / Validation / Review /
Commercial Review 全渲染在框外且不可达，修好后右列和左列一样在自己的圆角框内滚到底。
回滚到 1.5.1 的代价为零。逐版说明见
[docs/upgrade.md](./docs/upgrade.md)。
v1.5.1 是一次修订：没有新能力、没有新文件、新字段或新路由，只修 1.5.0 里两处「文档承诺与
实现对不上」的地方。从 1.5.0 升到 1.5.1 **不需要改任何代码**，1.5.0 写的产物可以直接读。
要紧的有两条：失败的 Run 不再把 `commercial_review_status` 谎写成 `not_started`（这一步
跑成了就是 `completed`、它自己失败了就是 `failed`，结论本体仍不写，因为失败路径从不 promote）；
看非入选 Attempt 时产物清单里的 `commercial_review` 现在指到 attempt 目录那份，不再把入选
Attempt 的结论当成当前这份。回滚到 1.5.0 的代价为零。逐版说明见
[docs/upgrade.md](./docs/upgrade.md)。
v1.5.0 加了**商业可读性审阅**：与结构审阅完全并列的第二个审阅者，产出
`CommercialReviewResult`（`commercial-review.json` + API 的 `commercial_review` 字段 +
前端 Commercial Review 面板 + `POST /api/review/commercial`）。纯 additive：
从 1.4.x 升到 1.5.0 **不需要改任何代码**，1.4.x 写的产物可以直接读
（`commercial_review_status` 读作 `not_started`、`commercial_review` 读作 `null`），
1.5.0 写的 Run 回落到 1.4.x 只是多一份被忽略的文件与几个被忽略的 metadata 字段。
要紧的有三条：`RetryPolicy` 仍然只有 `min_review_score` 一个门槛、仍然只看结构审阅分，
商业分不触发重试也不触发修订；`QualityResult` 里没有商业分，仍然只有 Co/N/C/Ca 四个维度；
商业可读性审阅自身失败只让 `commercial_review_status` 变成 `failed`，正文、校验结论、
结构审阅结论与质量快照一个都不受影响。回滚到 1.4.1 没有任何代价，也不需要迁移。
v1.4.0 在 Planning 之后加了一道 BeatPlan 结构校验（`BeatValidationResult` /
`beat-validation.json` / `POST /api/validate-beats` / 前端 Beat Validation 面板），
纯 additive：从 1.3.x 升到 1.4.0 **不需要改任何代码**，1.3.x 写的产物可以直接读
（`beat_validation_status` 读作 `not_started`、`beat_validation` 读作 `null`），
1.4.0 写的 Run 回落到 1.3.x 只是多一份被忽略的文件与几个被忽略的 metadata 字段。
唯一的行为变化在生成链路上：骨架结构带 error 级问题时 Run 会在写正文之前结束，
这类 Run 以前会一路生成到 Attempt 阶段。
v1.4.1 是一次修订：没有新能力、没有新文件、新字段或新路由，只把 1.0.0 ~ 1.4.0 里
「文档写了实现没做到」和「口径没走到底」的地方改回文档承诺的样子。从 1.4.0 升到 1.4.1
**不需要改任何代码**，1.4.0 写的产物可以直接读。要紧的有三条：`attempt` 摘要的审阅分
改走 `reviewOverallScore`（有维度时与 RetryPolicy 比的门槛分、`quality.overall_score`
是同一个数，没有维度时逐字不变）；`review.json` / `validation.json` / `quality.json` /
`beat-validation.json` 被改坏时读接口仍然 200、对应字段是 `null`，不再 500；CLI 的
`--temperature` 现在会透传给规划，而审阅 / 修订收到它会明确打一行「已忽略」
（它们用固定温度 0.3 / 0.5，这一点从 1.0.0 起就没变）。回滚到 1.4.0 的代价也只有一处：
有审阅维度时 attempt 摘要的分会退回 `review.score` 原值。
v1.3.0 给审阅结论加了四个可选的基础维度（连贯性 / 叙事 / 人物 / 因果），整体分改为四维均分，
纯 additive：从 1.2.x 升到 1.3.0 **不需要改任何代码**，1.2.x 写的产物可以直接读，
1.3.0 写的 Run 回落到 1.2.x 只是多一个被忽略的 `dimensions` 字段。
v1.2.0 建立了统一质量工程层（`QualityResult` / `quality.json` / API 的 `quality` 字段 /
前端 Quality Summary 面板），纯 additive：从 1.1.x 升到 1.2.0 **不需要改任何代码**，
1.1.1 写的产物可以直接读，1.2.0 写的 Run 回落到 1.1.x 也只是多一个被忽略的文件。
v1.2.1 修的是旧 Run 质量兜底的口径（读取时临时装配改取修订后的那一版结论，
与落盘的 `quality.json`、与 `metadata.json` 对齐），从 1.2.0 升到 1.2.1 不需要改任何代码。
v1.1.1 修的是 v1.1.0 那道地址关卡自身的问题（CLI 的 `--base-url` 不再被自己挡、
IPv4-mapped / NAT64 地址改判），约束方向不变；从 1.1.0 升到 1.1.1 不需要改任何代码。
v1.1.0 收紧了请求体 `baseUrl` 覆盖的取值，只允许 http/https 的公网地址；其余与 1.0.1 一致。
从 1.0.0 升到 1.0.1 不需要改任何代码；v1.0.0 相对于 0.9.x 也**几乎没有破坏性变更**，
需要留意的只有两条：运行级 metadata 的 `model` 现在始终存在（以前按条件写），
attempt 级 metadata 的 `error` 没有错误时是 `null`（以前按条件写）。
两者都是「字段从可能没有变成一定有」，不会让旧读取方崩掉。

```bash
git fetch && git checkout 1.5.0     # tag 不带 v 前缀
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
| `tests/test_url_guard.test.ts` | 请求体 `baseUrl` 只允许 http/https 公网地址，私网/环回/保留段在发请求前就被拒 |

v1.2.0 的质量快照另有六个测试文件（同样只用假组件，不调真实接口）：
`test_quality_assembler`（装配规则与确定性）、`test_quality_models`（快照解析容错）、
`test_quality_compat`（旧 `review.json` 解析、无快照的旧 Run、修订后口径兜底）、
`test_quality_pipeline`（落盘与内存一致）、`test_quality_api`（三处口径一致、旧 Run 兼容、
`quality.json` 损坏后的降级、地址关卡回归）、`test_quality_ui`（面板状态推导）。

v1.3.0 的四个基础维度另有两个测试文件：
`test_quality_dimensions`（维度模型、确定性聚合、可选字段校验、解析、重试门槛只认整体分）、
`test_quality_dimensions_pipeline`（维度在真实管道里一路带到 `quality.json` 与 metadata，
修订后取新的维度，没有维度时与 v1.2.x 逐字一致）。

v1.4.0 的 BeatPlan 结构校验另有四个测试文件：
`test_beat_validation`（模型、schema 白名单、规则层、解析、`BeatValidator` 行为）、
`test_beat_validation_pipeline`（硬失败阻断、warning 放行、校验器自身异常、不注入时与
v1.3.0 逐字一致）、`test_beat_validation_api`（新路由、错误码、旧 Run 读回）、
`test_beat_validation_ui`（面板状态推导，含「骨架不过 ≠ 校验器失败」）。

v1.4.1 的修补回归散在原有文件里：分数口径（`test_generation_attempt`）、
读回容错与原子写（`test_artifact_store`、`test_retry_api`）、CLI 温度透传与帮助
（`test_cli`）、`beat_validation_error`（`test_beat_validation_pipeline`）、
产物清单前缀（`test_ui_artifacts`）。

v1.5.0 的商业可读性审阅另有四个测试文件：
`test_commercial_review`（维度模型、schema 白名单、确定性聚合、解析、
`CommercialReviewer` 行为）、`test_commercial_review_pipeline`（两份产物逐字相同、
修订后重跑、失败隔离、**低商业分不触发重试或修订**、不注入时与 1.4.1 逐字一致）、
`test_commercial_review_ui`（面板五种状态、四个维度顺序、没有 Fix / Retry 入口、
没有市场化预言措辞）、`test_commercial_api`（新路由四种返回、模型自报分被重算值顶掉、
覆盖 `commercial-review.json` 但不碰 `review.json`、旧 Run 读回）。

v1.5.1 的修订回归散在原有文件里（+4 条，未新增文件）：`test_commercial_review_pipeline`
补齐四条失败路径的 `commercial_review_status` 口径（跨 Attempt 记住真实结果、自己失败即
`failed`、一个 Attempt 都没跑到才是 `not_started`）、`test_ui_artifacts` 把非入选 Attempt 的
产物清单从四个文件改成五个（`commercial_review` 并入前缀规则）。

v1.5.2 的界面修订新增 `tests/test_ui_theme_tokens.test.ts`（13 条）：源码级断言钉住
「不许再写死白 / 锌色边框与底色」「`bg-black/*` 只允许出现在整屏遮罩上」「300/400 档强调色
必须带 `dark:` 前缀」「两列主工作区必须同时有 `min-h-0` 与 `overflow-y-auto`」「三个内嵌面板
必须用 `rounded-lg`」「原生 select 必须用 `border-input` 配 `bg-transparent`、浅色下不许
出现 `bg-input`」「生成结果面板必须是 `grow shrink-0` 而不是 `flex-1`、正文滚动区不许写死
高度」。拿 1.5.1 的源码跑这批断言会红 37 处。

全部测试合计 **71 个文件 / 1104 条**，全部只调用真实 LLM 之外的桩：
LLM 由注入的桩对象或 `FakeLLM` 替代（`tests/helpers/fixtures.ts`），
`fetch` 也被桩掉。重试相关断言同样只用桩，从不触发真实模型调用。
URL 校验的用例用注入的假解析器跑，不真的查 DNS，也不碰任何真实主机。

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
- `src/core/quality-assembler.ts`：统一质量快照的装配规则（纯函数，不调模型）
- `src/types/quality-dimensions.ts`：四个基础维度与四维均分的实现（纯算术）
- `src/lib/validation-rules.ts`：六条硬性校验规则的实现
- `src/lib/api-error.ts`：稳定错误码与状态码映射
- `src/lib/safe-text.ts`：错误文本的净化规则（绝对路径替换、凭据打码），只此一份
- `src/lib/version.ts`：版本号单一真源
- `tests/helpers/fixtures.ts`：共享样例数据与 `FakeLLM`
