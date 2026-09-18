# Storyloop · AI 故事工场

> 一个支持题材、长度、风格和附加要求配置的 AI 短篇小说生成器。
> A configurable AI short-story generator with reusable prompt templates and a modern web interface.

## 功能（当前版本 v0.1.0 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- 结构化生成请求：Genre / Premise / Target Words / Style / Extra Requirements
- **可复用的外部 Prompt 模板**（`prompts/story.txt`，可直接编辑）
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出 + 生成元数据 JSON（自动保存到 `outputs/`，支持复制与下载）
- 本地配置（模型 / Base URL / 温度）

> 规划（Planning）、评审（Review）、校验（Validation）、重试（Retry）、基准（Benchmark）尚未包含在本版本中。

## 架构

```
┌──────────────────────┐
│  Modern Web UI       │  Title / Genre / Premise / Words / Style / Extra
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   Generate API       │  POST /api/generate（结构化请求）
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
│    Story Output      │  → UI + outputs/*.md + *.json
└──────────────────────┘
```

## 快速开始

```bash
npm install
cp .env.example .env    # 配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev             # http://localhost:3000
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/generate` | 结构化故事请求 → `{title, content, model, created_at, request}` |
| POST | `/api/prompt/preview` | 相同请求 → 渲染后的最终 Prompt（开发预览） |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.1.0"}` |

### curl 示例

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "title": "消失的目击者",
    "genre": "悬疑",
    "premise": "唯一证人在出庭前一天消失。",
    "target_words": 5000,
    "style": "冷峻、节奏紧凑",
    "extra_requirements": "不要超自然元素"
  }'
```

> 说明：`target_words` 是目标字数，实际输出长度会受模型能力和上下文窗口影响。

## Prompt Template

模板文件：`prompts/story.txt` —— 直接编辑即可（重启后生效）。

| Variable | Meaning |
|---|---|
| `{{title}}` | 故事标题 |
| `{{genre}}` | 题材 |
| `{{premise}}` | 核心设定 |
| `{{target_words}}` | 目标字数 |
| `{{style}}` | 写作风格（空值渲染为「未指定」） |
| `{{extra_requirements}}` | 附加要求（空值渲染为「未指定」） |

## 测试

```bash
npm test    # 35 tests: story-request / prompt-builder / template-loading / llm / generate-api / version
```

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
