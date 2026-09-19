# Storyloop · AI 故事工场

> 一个支持保存、加载和复用 StoryConfig 的 AI 短篇小说生成器。
> A configurable AI short-story generator with reusable StoryConfig files and a modern web interface.

## 功能（当前版本 v0.2.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- **可复用 StoryConfig**：保存 / 加载 / 新建，JSON 文件即配置
- 结构化主角配置（姓名 / 身份 / 目标 / 动机）
- 故事背景、核心冲突、失败代价、期望结局
- 生成时自动保存 StoryConfig 快照（与正文、元数据同目录）
- **可编辑的外部 Prompt 模板**（`prompts/story.txt`）
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON
- CLI 从 StoryConfig 文件生成（`scripts/generate-cli.ts`）
- 本地配置（模型 / Base URL / 温度）

> 剧情规划（Story Planning / Beat Generation）、评审（Review）、校验（Validation）、重试（Repair）、
> 实验（Experiment）、基准（Benchmark）、自适应生成（Adaptive Generation）尚未包含在本版本中。

## 架构

```
┌──────────────────────┐
│  Modern Web UI       │  StoryConfig 表单 + Save / Load / New
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Generate API       │  POST /api/generate（StoryConfig 兼容输入）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   PromptBuilder      │  prompts/story.txt 渲染
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│      LLM Client      │  OpenAI-compatible（system + user）
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    Story Output      │  → UI + outputs/*.md + *.story.json + *.meta.json
└──────────────────────┘
```

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
```

命令行生成（与 UI 共用同一 StoryConfig 模型与 PromptBuilder）：

```bash
npx tsx scripts/generate-cli.ts --config configs/example_story.json
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

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/generate` | StoryConfig 兼容请求 → `{title, content, model, created_at, saved_to, config_to, metadata_to, request}` |
| POST | `/api/prompt/preview` | 相同请求 → 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.2.0"}` |

### curl 示例

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d @configs/example_story.json
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。
> 旧版 `{title, prompt}` 请求仍可兼容：`prompt` 会映射为 `premise`，并补齐默认 `genre` 与 `target_words`。

## Prompt Template

模板文件：`prompts/story.txt` —— 直接编辑即可（重启后生效）。

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

## 测试

```bash
npm test    # story-config / config-loader / ui-story-config / prompt-builder / template-loading / llm / generate-api / version
```

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
- `configs/example_story.json`：示例 StoryConfig
