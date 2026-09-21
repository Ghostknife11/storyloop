# Changelog

All notable changes to Storyloop.

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

---

> **2026-09-21 · 历史重建说明**：为形成真实的逐版本演进历史，本仓库于 2026-09-21 重建了全部 Git 历史
> （重新整理并标注各版本提交）；此前已发布的 tag 与 GitHub Release 均已失效并被替换。
> v0.0.1 内容与此前一致，v0.1.0 ~ v0.4.0 的提交序列与此前不同（内容以上各版本条目为准），
> v0.4.0 另补齐了进度 UI、CLI 走 Pipeline 与四组测试（见下）。

---

## [0.4.0] —— 2026-09-20

### Added

- `GenerationPipeline`：一次完整故事生成 = 一个 Run，固定顺序 Config → Planning → Generation → Persistence
- `RunContext` + Run ID（本地时间戳 + 6 位随机字符），记录 status / current_stage / error
- `ArtifactStore`：产物统一写入 `runs/<run_id>/`（`config.json` / `beats.json` / `story.md` / `metadata.json`），原子写入
- `POST /api/runs`（自动模式）与 `POST /api/runs/from-plan`（手动模式）
- UI 四阶段进度指示、Run ID / 产物清单展示与失败阶段提示
- CLI `run` 子命令，与 UI / API 共用同一条 Pipeline
- Tests：generation-pipeline / run-context / artifact-store / run-api

### Changed

- `POST /api/generate` 改为兼容入口，等价于 `POST /api/runs/from-plan`
- 生成响应改为 `{run_id, status, story, beat_plan, artifacts}`，不再返回服务器文件绝对路径
- CLI 由 `plan` / `generate` 两阶段命令改为 `run`（`--beats` 可选）与 `plan`
- 产物目录由 `outputs/` 改为 `runs/<run_id>/`，并加入 `.gitignore`
- 失败时 metadata 记录失败阶段与安全错误信息（不含服务器绝对路径），已产出的文件不删除

### Removed

- `outputs/` 产物目录与 `src/lib/output.ts`（由 `ArtifactStore` 取代）

### Compatibility

- 旧版扁平 `{title, prompt}` 请求仍会归一化为 StoryConfig；`POST /api/generate` 仍可携带 `{config, beat_plan}` 直接生成。
- 生成失败不会自动重试或自动改写，重试由你手动触发。

---

## [0.3.0] —— 2026-09-19

### Added

- Two-stage generation: StoryConfig → BeatPlanner → BeatPlan → StoryGenerator → Story
- BeatPlan model with schema validation (`types/beat-plan.ts`)
- External beat planning prompt template (`prompts/beat_planner.txt`)
- BeatPlan parser with markdown code-fence tolerance
- `POST /api/plan` API (stage one)
- Beat Plan panel in the UI with manual editing (add / delete / reorder)
- Outdated marker when StoryConfig changes after a plan was generated
- Prompt preview now includes the Beat Plan when one is available
- CLI `plan` and `generate` subcommands
- BeatPlan snapshot (`*.beats.json`) saved with story, config and metadata
- Beat count recorded in generation metadata and API response

### Changed

- `POST /api/generate` now requires `beat_plan` (400 when missing)
- Story prompt template now renders the Beat Plan section
- CLI is now two subcommands instead of a single `--config` run

### Compatibility

- Legacy `{title, prompt}` requests are still normalized to StoryConfig, but generation now requires a beat plan from `POST /api/plan`.

---

## [0.2.0] —— 2026-09-19

### Added

- Persistent StoryConfig model
- Story setting configuration
- Protagonist configuration
- Conflict and stakes fields
- Optional ending direction
- JSON StoryConfig save/load
- StoryConfig validation
- Example StoryConfig
- Config snapshot saved with generated stories
- CLI generation from StoryConfig when CLI is available

### Changed

- PromptBuilder now consumes StoryConfig
- Generate UI now edits reusable StoryConfig data
- Generation API now accepts StoryConfig-compatible input

### Removed

- Deprecated StoryRequest model superseded by StoryConfig

---

## [0.1.0] —— 2026-09-19

### Added

- Structured story generation request
- Genre selection
- Target word count configuration
- Writing style configuration
- Extra generation requirements
- External story prompt template
- PromptBuilder abstraction
- Prompt preview API（开发功能）
- Generation metadata JSON sidecar

### Changed

- Generation API now accepts structured story parameters
- Generate UI now exposes configurable story fields
- Prompt construction moved out of the request handler

### Compatibility

- Legacy `prompt` requests may still be mapped to `premise` during the v0.x transition.

---

## [0.0.1] —— 2026-09-19

### Added

- Initial short-story generation backend
- Modern web UI
- Story title and prompt input
- OpenAI-compatible LLM support
- Markdown story output
- Health and version APIs

---

*Format: [Semantic Versioning](https://semver.org/)*
