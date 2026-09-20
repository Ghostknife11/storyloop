# Storyloop · AI 故事工场

> 一个支持保存、加载和复用 StoryConfig 的 AI 短篇小说生成器。
> A configurable AI short-story generator with reusable StoryConfig files and a modern web interface.

## 功能（当前版本 v0.4.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- **两阶段生成**：先生成剧情骨架（BeatPlan），再据此写正文
- **BeatPlan 手动编辑**：增删 Beat、上下移动排序，生成前可反复调整
- StoryConfig 在规划后发生变化时，BeatPlan 标记为 Outdated
- **可编辑的外部 Prompt 模板**（`prompts/beat_planner.txt`、`prompts/story.txt`）
- **GenerationPipeline**：一次完整生成 = 一个 Run，固定顺序 Config → Planning → Generation → Persistence
- **RunContext + Run ID**：每次运行有唯一 `run_id`（时间戳 + 短随机）与状态 / 阶段记录
- **ArtifactStore**：产物统一落在 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `metadata.json`），原子写入
- **Run 进度与结果 UI**：四阶段进度指示 + Run ID / 产物清单 / 失败阶段
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 统一走同一条 Pipeline（`scripts/generate-cli.ts run` / `plan`）
- 本地配置（模型 / Base URL / 温度）

> 内容评审（Review）、质量校验（Quality Validation）、自动修复（Repair）、质量重试（Retry Policy）、
> 实验（Experiment）、基准（Benchmark）、自适应生成（Adaptive Generation）尚未包含在本版本中。
> 本版本也没有工作流引擎 / DAG / Stage Registry：阶段顺序固定，不能任意跳段。

## 架构

```
┌──────────────────────┐
│  UI ／ CLI           │  StoryConfig 表单 + Save / Load / New · generate-cli run
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Run API            │  POST /api/runs · POST /api/runs/from-plan
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  GenerationPipeline  │  固定顺序：Config → Planning → Generation → Persistence
│  · run()             │  StoryConfig → BeatPlan → Story
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
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│      LLM Client      │  OpenAI-compatible（system + user）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    ArtifactStore     │  原子写入 runs/<run_id>/ 下四个产物
└──────────────────────┘
```

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
    └── metadata.json    # run_id / project_version / status / 阶段 / 时间 / 模型
```

`metadata.json` 的字段：`run_id`、`project_version`、`status`（`created` / `planning` /
`generating` / `saving` / `completed` / `failed`）、`current_stage`、`started_at`、`finished_at`、
`error`、`model`、`artifacts`。失败时 `status` 为 `failed`，`error` 为安全错误信息（不含服务器绝对路径），
且已经写出的产物不会被删除。

失败阶段可识别：`config` / `planning` / `generating` / `persistence`。

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
```

命令行生成（与 UI / API 共用同一条 GenerationPipeline）：

```bash
# 一次完整 Run：StoryConfig → Plan → Generate → Persist
npx tsx scripts/generate-cli.ts run --config configs/example_story.json

# 手动模式：先单独规划，人工编辑 beats.json 后再生成
npx tsx scripts/generate-cli.ts plan --config configs/example_story.json --out beats.json
npx tsx scripts/generate-cli.ts run --config configs/example_story.json --beats beats.json
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
| POST | `/api/runs` | `{config}` → 自动模式完整 Run，返回 `{run_id, status, story, beat_plan, artifacts}` |
| POST | `/api/runs/from-plan` | `{config, beat_plan}` → 手动模式 Run（跳过规划） |
| POST | `/api/plan` | StoryConfig → BeatPlan（只规划，不生成正文） |
| POST | `/api/generate` | 兼容入口，等价于 `/api/runs/from-plan` |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.4.0"}` |

`artifacts` 是产物文件名映射，例如
`{"config":"config.json","beat_plan":"beats.json","story":"story.md","metadata":"metadata.json"}`；
这些文件位于服务器的 `runs/<run_id>/` 下，响应中不会返回服务器绝对路径。

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
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> `/api/runs` 与 `/api/runs/from-plan` 需要 `config` 字段（缺失或非法返回 400）；
> 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig。

## Prompt Template

模板文件：`prompts/beat_planner.txt`（阶段一）与 `prompts/story.txt`（阶段二）——直接编辑即可（重启后生效）。

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

## 测试

```bash
npm test    # artifact-store / beat-parser / beat-plan / beat-planner / config-loader / generate-api /
            # generation-pipeline / llm / plan-api / prompt-builder / run-api / run-context /
            # story-config / story-generator / template-loading / ui-story-config / ui-two-stage / version
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