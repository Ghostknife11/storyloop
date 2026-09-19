# Changelog

All notable changes to Storyloop.

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

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
