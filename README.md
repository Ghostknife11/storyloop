# Storyloop · AI 故事工场

> 一个具备剧情规划、正文生成、Run 持久化和基础自动审阅能力的 AI 短篇小说生成器。
> A pipeline-based AI short-story generator with automatic post-generation review.

## 功能（当前版本 v0.5.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- **AI Beat Planning**：先生成剧情骨架（BeatPlan），再据此写正文
- **BeatPlan 手动编辑**：增删 Beat、上下移动排序，生成前可反复调整
- StoryConfig 在规划后发生变化时，BeatPlan 标记为 Outdated
- **可编辑的外部 Prompt 模板**（`prompts/beat_planner.txt`、`prompts/story.txt`、`prompts/reviewer.txt`）
- **GenerationPipeline**：一次完整生成 = 一个 Run，固定顺序 Config → Planning → Generation → Save Story → Review → Save Review
- **RunContext + Run ID**：每次运行有唯一 `run_id`（时间戳 + 短随机）与状态 / 阶段记录
- **Run Artifacts**：产物统一落在 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `review.json` / `metadata.json`），原子写入
- **Basic AI Reviewer**：每次生成的正文自动获得一次基础审阅
- **Overall 0–100 Score**：单一总分（不含多维度评分）
- **Strengths & Problems**：优点与问题各一份字符串列表
- **Review JSON Artifact**：审阅结果落盘为 `review.json`，可再次审阅覆盖
- **Run 进度与结果 UI**：五阶段进度指示 + Run ID / 产物清单 / Review 面板 / 失败阶段
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 统一走同一条 Pipeline（`scripts/generate-cli.ts run` / `plan` / `review`）
- 本地配置（模型 / Base URL / 温度）

> **Reviewer 的限制**：The reviewer provides feedback only. It does not automatically regenerate or repair the story.
> 审阅只产出评价，不会因为分数低而重新生成，也不会逐条修复问题；审阅失败时正文与 Run 都保持原样，
> 你可以手动重新审阅。
>
> 内容评审目前只有单一总分这一种形态：多维评审（Multi-dimensional Review）、故事校验（Story Validation）、
> Beat 校验（Beat Validation）、自动修复（Repair）、质量重试（Retry Policy）、PASS / FAIL 质量门禁、
> 实验（Experiment）、基准（Benchmark）、自适应生成（Adaptive Generation）尚未包含在本版本中。
> 本版本也没有工作流引擎 / DAG / Stage Registry：阶段顺序固定，不能任意跳段。

## 架构

```
┌──────────────────────┐
│  UI ／ CLI           │  StoryConfig 表单 + Save / Load / New · generate-cli run
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Run API            │  POST /api/runs · POST /api/runs/from-plan · POST /api/review
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  GenerationPipeline  │  固定顺序：Config → Planning → Generation → Save Story → Review → Save Review
│  · run()             │  StoryConfig → BeatPlan → Story → ReviewResult
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

正文先落盘再审阅：即使 Reviewer 调用失败或输出非法，`story.md` 与整个 Run 都保持成功，
只有 `review_status` 变为 `failed` 并记录原因。

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
    ├── review.json      # 审阅结果（Review 失败时不存在）
    └── metadata.json    # run_id / project_version / status / 阶段 / 时间 / 模型 / review_status
```

`metadata.json` 的字段：`run_id`、`project_version`、`status`（`created` / `planning` /
`generating` / `saving` / `reviewing` / `completed` / `failed`）、`current_stage`、`started_at`、`finished_at`、
`error`、`model`、`artifacts`、`review_status`（`reviewing` / `completed` / `failed`）、`review_error`、
`review_score`。失败时 `status` 为 `failed`，`error` 为安全错误信息（不含服务器绝对路径），
且已经写出的产物不会被删除。

失败阶段可识别：`config` / `planning` / `generating` / `persistence`。审阅失败不是 Run 失败：
`status` 仍为 `completed`，只有 `review_status` 为 `failed`。

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

命令行生成与审阅（与 UI / API 共用同一条 GenerationPipeline）：

```bash
# 一次完整 Run：StoryConfig → Plan → Generate → Save Story → Review
npx tsx scripts/generate-cli.ts run --config configs/example_story.json

# 手动模式：先单独规划，人工编辑 beats.json 后再生成
npx tsx scripts/generate-cli.ts plan --config configs/example_story.json --out beats.json
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats beats.json

# 只审阅已有正文（不生成；带 --run-id 时覆盖该 Run 的 review.json）
npx tsx scripts/generate-cli.ts review --config configs/example_story.json --story story.md
```

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
| POST | `/api/runs` | `{config}` → 自动模式完整 Run，返回 `{run_id, status, story, beat_plan, review, review_status, artifacts}` |
| POST | `/api/runs/from-plan` | `{config, beat_plan}` → 手动模式 Run（跳过规划） |
| POST | `/api/review` | `{config, story}`（+可选 `run_id`）→ 单独审阅正文，返回 `ReviewResult` |
| POST | `/api/plan` | StoryConfig → BeatPlan（只规划，不生成正文） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.5.0"}` |

`artifacts` 是产物文件名映射，例如
`{"config":"config.json","beat_plan":"beats.json","story":"story.md","metadata":"metadata.json"}`；
审阅成功时还会多出 `"review":"review.json"`。这些文件位于服务器的 `runs/<run_id>/` 下，
响应中不会返回服务器绝对路径。

审阅结果随 Run 一起返回：`review` 为 `ReviewResult` 或 `null`，`review_status` 为
`reviewing` / `completed` / `failed`，失败时另有 `review_error`。**审阅失败不会让 Run 失败**——
`story` 与 `status: "completed"` 照常返回，只是没有 `review`。

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
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> `/api/runs` 与 `/api/runs/from-plan` 需要 `config` 字段（缺失或非法返回 400）；
> 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig。
> `/api/review` 需要 `config` 与非空 `story`；审阅用的温度固定为 `0.3`，与生成温度相互独立。

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
            # review-result / run-api / run-context / story-config / story-generator / template-loading /
            # ui-review / ui-story-config / ui-two-stage / version
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