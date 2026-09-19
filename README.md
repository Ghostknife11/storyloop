# Storyloop · AI 故事工场

> 一个支持保存、加载和复用 StoryConfig 的 AI 短篇小说生成器。
> A configurable AI short-story generator with reusable StoryConfig files and a modern web interface.

## 功能（当前版本 v0.3.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- 生成时自动保存 StoryConfig 快照（与正文、BeatPlan、元数据同目录）
- **两阶段生成**：先生成剧情骨架（BeatPlan），再据此写正文
- **BeatPlan 手动编辑**：增删 Beat、上下移动排序，生成前可反复调整
- StoryConfig 在规划后发生变化时，BeatPlan 标记为 Outdated
- **可编辑的外部 Prompt 模板**（`prompts/beat_planner.txt`、`prompts/story.txt`）
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 两阶段生成（`scripts/generate-cli.ts plan` / `generate`）
- 本地配置（模型 / Base URL / 温度）

> 内容评审（Review）、质量校验（Quality Validation）、自动修复（Repair）、质量重试、
> 实验（Experiment）、基准（Benchmark）、自适应生成（Adaptive Generation）尚未包含在本版本中。

## 架构

```
┌──────────────────────┐
│  Modern Web UI       │  StoryConfig 表单 + Save / Load / New
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Plan API           │  POST /api/plan（StoryConfig）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    BeatPlanner       │  prompts/beat_planner.txt → LLM → BeatPlan
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  BeatPlan（可编辑）   │  UI 增删 / 排序，或 CLI --beats 文件
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Generate API       │  POST /api/generate（{config, beat_plan}）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  StoryGenerator      │  prompts/story.txt 渲染（含 Beat Plan）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│      LLM Client      │  OpenAI-compatible（system + user）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    Story Output      │  → UI + outputs/*.md + *.story.json + *.beats.json + *.meta.json
└──────────────────────┘
```

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
```

命令行生成（两阶段，与 UI 共用同一套 StoryConfig / BeatPlan / Prompt 模型）：

```bash
# 阶段一：StoryConfig → BeatPlan（beats.json）
npx tsx scripts/generate-cli.ts plan --config configs/example_story.json --out beats.json

# 阶段二：StoryConfig + BeatPlan → 正文
npx tsx scripts/generate-cli.ts generate --config configs/example_story.json --beats beats.json
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
| POST | `/api/plan` | StoryConfig → BeatPlan（阶段一） |
| POST | `/api/generate` | `{config, beat_plan}` → `{title, content, model, created_at, saved_to, config_to, beats_to, metadata_to, request}` |
| POST | `/api/prompt/preview` | `config`（+可选 `beat_plan`）→ 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.3.0"}` |

### curl 示例

```bash
# 阶段一：生成剧情骨架
curl -X POST http://localhost:3000/api/plan \
  -H "Content-Type: application/json" \
  -d @configs/example_story.json -o beats.json

# 阶段二：config + beats 一起提交，生成正文
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"config": '"$(cat configs/example_story.json)"', "beat_plan": '"$(cat beats.json)"'}'
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> `POST /api/generate` 自 v0.3.0 起必须携带 `beat_plan`（缺失返回 400）。旧版 `{title, prompt}` 请求仍会归一化为 StoryConfig，
> 但同样需要先经过 `/api/plan` 获得剧情骨架。

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
npm test    # beat-plan / beat-parser / beat-planner / story-generator / plan-api / story-config / config-loader / ui-story-config / ui-two-stage / prompt-builder / template-loading / llm / generate-api / version
```

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
- `configs/example_story.json`：示例 StoryConfig