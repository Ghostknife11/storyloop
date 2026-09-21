# Storyloop · AI 故事工场

> 一个具备剧情规划、正文生成、基础有效性检查和自动审阅能力的 AI 短篇小说生成器。
> A pipeline-based AI short-story generator with hard validity checking and automatic post-generation review.

## 功能（当前版本 v0.6.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- **AI Beat Planning**：先生成剧情骨架（BeatPlan），再据此写正文
- **BeatPlan 手动编辑**：增删 Beat、上下移动排序，生成前可反复调整
- StoryConfig 在规划后发生变化时，BeatPlan 标记为 Outdated
- **可编辑的外部 Prompt 模板**（`prompts/beat_planner.txt`、`prompts/story.txt`、`prompts/reviewer.txt`）
- **GenerationPipeline**：一次完整生成 = 一个 Run，固定顺序 Config → Planning → Generation → Save Story → Validate → Save Validation → Review → Save Review
- **RunContext + Run ID**：每次运行有唯一 `run_id`（时间戳 + 短随机）与状态 / 阶段记录
- **Run Artifacts**：产物统一落在 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `validation.json` / `review.json` / `metadata.json`），原子写入
- **Story Validator（硬性有效性检查）**：正文落盘后立即跑一遍确定性规则，回答「这篇正文基本可用吗」
- **Hard Failure Detection**：任一规则报 `error` 即 `passed: false`，规则、严重度与说明全部随 Run 返回
- **Validation JSON Artifact**：校验结果落盘为 `validation.json`，可再次校验覆盖
- **Basic AI Reviewer**：每次生成的正文自动获得一次基础审阅
- **Overall 0–100 Score**：单一总分（不含多维度评分）
- **Strengths & Problems**：优点与问题各一份字符串列表
- **Review JSON Artifact**：审阅结果落盘为 `review.json`，可再次审阅覆盖
- **Run 进度与结果 UI**：六阶段进度指示 + Run ID / 产物清单 / Validation 面板 / Review 面板 / 失败阶段
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 统一走同一条 Pipeline（`scripts/generate-cli.ts run` / `plan` / `review` / `validate`）
- 本地配置（模型 / Base URL / 温度）

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

> **Validator 的限制**：The validator only reports. It does not automatically regenerate, repair, extend or rewrite the ending.
> 校验只给出通过 / 不通过与具体问题，不会因为不通过而重新生成，也不会自动修复、续写或改写结局；
> 校验失败时正文与 Run 都保持原样，你可以手动重新校验（Validate Again），或自己发起一次新的生成。
>
> 本版本只有单一总分这一种评价形态：多维评审（Multi-dimensional Review）、故事改写（Story Repair）、
> 质量重试（Retry Policy）、PASS / FAIL 质量门禁、商业审阅（Commercial Review）、
> 实验（Experiment）、基准（Benchmark）、因果归因（Failure Attribution）、自适应生成（Adaptive Generation）
> 尚未包含在本版本中。
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
│  GenerationPipeline  │  固定顺序：Config → Planning → Generation → Save Story → Validate → Save Validation → Review → Save Review
│  · run()             │  StoryConfig → BeatPlan → Story → ValidationResult → ReviewResult
│  · runWithPlan()     │  用户编辑后的 BeatPlan 直接进入生成
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   RunContext         │  run_id + status + current_stage + error
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  BeatPlanner         │  prompts/beat_planner.txt → LLM → BeatPlan（可手动编辑）
│  StoryGenerator      │  prompts/story.txt 渲染（含 Beat Plan）
│  StoryValidator      │  确定性硬性规则 → ValidationResult（不调用 LLM，只检查，不改写）
│  BasicReviewer       │  prompts/reviewer.txt → LLM → ReviewResult（只评价，不改写）
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
校验不通过（`passed: false`）同样**不是** Run 失败：`status` 仍为 `completed`，
正文与 `validation.json` 都在，Review 照常执行，系统不会自动重新生成。

## Run 与产物

一次完整生成就是一个 **Run**。Run ID 形如 `20260920_101530_k3f9aq`（本地时间戳 + 6 位随机字符），
由服务端生成，不依赖用户输入，可安全用作目录名。

`runs/` 目录已加入 `.gitignore`，产物只落在本地：

```
runs/
└── 20260920_101530_k3f9aq/
    ├── config.json      # 本次运行使用的 StoryConfig
    ├── beats.json       # 实际采用的 BeatPlan
    ├── story.md         # 生成的正文
    ├── validation.json  # 硬性校验结果（Validating 阶段失败时不存在）
    ├── review.json      # 审阅结果（Review 失败或被跳过时不存在）
    └── metadata.json    # run_id / project_version / status / 阶段 / 时间 / 模型 / validation_status / review_status
```

`metadata.json` 的字段：`run_id`、`project_version`、`status`（`created` / `planning` /
`generating` / `saving` / `validating` / `reviewing` / `completed` / `failed`）、`current_stage`、`started_at`、`finished_at`、
`error`、`model`、`artifacts`、`validation_status`（`validating` / `completed` / `failed`）、
`validation_passed`（布尔，`validation_status` 为 `completed` 时才有）、`validation_issue_count`、
`validation_error`（Validator 自身异常时记录）、`review_status`（`reviewing` / `completed` / `failed`）、
`review_error`、`review_score`。失败时 `status` 为 `failed`，`error` 为安全错误信息（不含服务器绝对路径），
且已经写出的产物不会被删除。

失败阶段可识别：`config` / `planning` / `generating` / `persistence`。
**校验不通过不是 Run 失败**：`status` 仍为 `completed`，`validation_status` 为 `completed`，
`validation_passed` 为 `false`。**校验器自身崩溃也不是 Run 失败**：`validation_status` 为 `failed`，
`validation_error` 记录原因，此时不写 `validation.json`。审阅失败同理，只影响 `review_status`。

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

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
```

命令行生成、校验与审阅（与 UI / API 共用同一条 GenerationPipeline）：

```bash
# 一次完整 Run：StoryConfig → Plan → Generate → Save Story → Validate → Review
npx tsx scripts/generate-cli.ts run --config configs/example_story.json

# 手动模式：先单独规划，人工编辑 beats.json 后再生成
npx tsx scripts/generate-cli.ts plan --config configs/example_story.json --out beats.json
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats beats.json

# 只校验一段已有正文（不生成、不审阅）
npx tsx scripts/generate-cli.ts validate --config configs/example_story.json --story story.md

# 只审阅已有正文（不生成；带 --run-id 时覆盖该 Run 的 review.json）
npx tsx scripts/generate-cli.ts review --config configs/example_story.json --story story.md
```

`run` 结束时会依次打印 Run ID / Status / Beats / 正文路径 / `Validation: PASSED|FAILED`
（附每条 issue 的 severity、code 与 message）/ Review Score / Artifacts。
校验不通过不会让 CLI 以非零码退出——它是一次成功的业务结果，只是结论为不通过。

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

> 生成失败或计划非法时，Storyloop 只报告错误并保留你已编辑的 BeatPlan，不会自动重试或自动改写（重试由你手动触发）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/runs` | `{config}` → 自动模式完整 Run，返回 `{run_id, status, story, beat_plan, validation, validation_status, validation_error?, review, review_status, artifacts}` |
| POST | `/api/runs/from-plan` | `{config, beat_plan}` → 手动模式 Run（跳过规划） |
| POST | `/api/validate` | `{config, story}`（+可选 `run_id`）→ 单独校验正文，返回 `ValidationResult` |
| POST | `/api/review` | `{config, story}`（+可选 `run_id`）→ 单独审阅正文，返回 `ReviewResult` |
| POST | `/api/plan` | StoryConfig → BeatPlan（只规划，不生成正文） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.6.0"}` |

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

`POST /api/validate` 只校验、不生成；带上已存在的 `run_id` 时会覆盖该 Run 的 `validation.json`，
`run_id` 非法或不存在时返回 400。请求体缺少 `story` 字段或类型不对时返回 400；
`story` 有值但全是空白则返回 200 + `EMPTY_CONTENT`——那是内容层面的硬失败，不是请求格式错误。
真实的 LLM 请求失败属于生成错误，不由 Validator 负责。

`POST /api/review` 只审阅、不生成；带上已存在的 `run_id` 时会覆盖该 Run 的 `review.json`，
`run_id` 非法或不存在时返回 400。

失败响应形如 `{error: "安全错误信息", run_id?: "...", stage?: "planning"}`，HTTP 状态码：
`400` 请求体 / 配置 / BeatPlan 非法，`502` LLM 或规划 / 生成失败，`500` 其他内部错误。

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
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> `/api/runs` 与 `/api/runs/from-plan` 需要 `config` 字段（缺失或非法返回 400）；
> 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig。
> `/api/validate` 与 `/api/review` 需要 `config` 与字符串 `story`；审阅用的温度固定为 `0.3`，
> 与生成温度相互独立。校验不调用 LLM，因此没有温度一说，结果完全确定。

## Prompt Template

模板文件：`prompts/beat_planner.txt`（阶段一）、`prompts/story.txt`（阶段二）与
`prompts/reviewer.txt`（审阅）——直接编辑即可（重启后生效）。

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

## 测试

```bash
npm test    # artifact-store / basic-reviewer / beat-parser / beat-plan / beat-planner / config-loader /
            # generate-api / generation-pipeline / llm / plan-api / prompt-builder / review-parser /
            # review-result / run-api / run-context / story-config / story-generator / story-validator /
            # template-loading / ui-review / ui-story-config / ui-two-stage / ui-validation /
            # validation-api / validation-result / version
```

所有测试都不调用真实 LLM：LLM 由注入的桩对象或 `fetch` 桩替代。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
- `configs/example_story.json`：示例 StoryConfig
- `prompts/reviewer.txt`：审阅 Prompt 模板
- `src/lib/validation-rules.ts`：六条硬性校验规则的实现（无外部依赖，可直接阅读）