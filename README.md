# Storyloop · AI 故事工场

> 一个带现代 Web UI 的 AI 短篇小说生成原型。
> An early AI short-story generation prototype with a modern web interface.

## 功能（当前版本 v0.0.1 真实具备）

- 现代 Web UI（暗色玻璃风格 · 响应式 · 深浅主题）
- 短篇小说生成：标题 + 故事需求 → 完整正文
- OpenAI-compatible LLM 支持（OpenAI / DeepSeek / 硅基流动 / 任意兼容端点）
- Markdown 输出（自动保存到 `outputs/`，支持复制与下载）
- 本地配置（模型 / Base URL / 温度）

> 规划、评审、校验、实验与基准体系尚未包含在本版本中。

## 架构

```
┌──────────────┐
│   Web UI     │
└──────┬───────┘
       ▼
┌──────────────┐
│ Generate API │  POST /api/generate
└──────┬───────┘
       ▼
┌──────────────┐
│ Prompt Build │
└──────┬───────┘
       ▼
┌──────────────┐
│     LLM      │  OpenAI-compatible
└──────┬───────┘
       ▼
┌──────────────┐
│ Story Output │  → UI + outputs/*.md
└──────────────┘
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
| POST | `/api/generate` | `{title, prompt}` → `{title, content, model, created_at}` |
| GET | `/api/health` | `{status: "ok"}` |
| GET | `/api/version` | `{version: "0.0.1"}` |

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4 + Base UI
- OpenAI-compatible LLM API
- Vitest 单元测试

## 文档

- `CHANGELOG.md`：版本历史
