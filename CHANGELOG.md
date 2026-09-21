# Changelog

All notable changes to Storyloop.

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

---

> **2026-09-21 · 历史重建说明**：为形成真实的逐版本演进历史，本仓库于 2026-09-21 重建了全部 Git 历史
> （重新整理并标注各版本提交）；此前已发布的 tag 与 GitHub Release 均已失效并被替换。
> v0.0.1 内容与此前一致，v0.1.0 ~ v0.4.0 的提交序列与此前不同（内容以上各版本条目为准），
> v0.4.0 另补齐了进度 UI、CLI 走 Pipeline 与四组测试（见下）。

---

## [Unreleased]

### Changed

- 版本 tag 由 `v0.x.x` 改为 `0.x.x`（`0.0.1` ~ `0.6.0`）。GitHub Releases 页按 release 创建时间倒序排列，
  而创建时间取自 annotated tag 的 tagger 时间且无法通过接口修改；原 `v0.0.1` / `v0.2.0` 两个 tag 的
  tagger 时间晚于 `v0.4.0`，导致页面版本顺序错乱。改用新 tag 名并将各 tag 的 tagger 时间对齐到其
  commit 时间后，Releases 页顺序与版本号一致。Release 标题仍带 `v` 前缀（如 `v0.6.0 — Story Validator`）。
  Release URL 相应变为 `…/releases/tag/0.6.0`

### Fixed

- About 页版本说明仍写作「初始公开原型」并声称规划尚未包含，与 v0.3.0 起已具备的 Beat 规划不符；改为按当前版本实际能力描述（规划已具备，评审 / 校验 / 修复 / 重试 / 实验 / 基准 / 自适应尚未包含）
- About 页副标题与页面 metadata 的「生成原型」统一为「生成器」，与 README 一致

---

## [0.6.0] —— 2026-09-21

### Added

- Story Validator（`src/lib/story-validator.ts` + `src/lib/validation-rules.ts`）：正文落盘后的硬性有效性检查，
  回答「这篇正文基本可用吗」。不调用 LLM，纯确定性规则
- `ValidationResult` / `ValidationIssue` 模型与校验（`src/types/validation-result.ts`）：
  `{passed, issues}` 与 `{code, severity, message}`
- Severity 只有 `warning` / `error` 两级：任一 `error` 即 `passed: false`，只有 warning 或全无时 `passed: true`
- 六条稳定问题码的校验规则：`EMPTY_CONTENT` / `INVALID_OUTPUT` / `TOO_SHORT` /
  `POSSIBLE_TRUNCATION` / `MISSING_ENDING` / `MISSING_PROTAGONIST`
- 长度下限 `max(300, target_words × 0.15)`，配一视同仁的字数统计：CJK 字符逐个计数、连续拉丁字母 / 数字算一个词，
  标点与空白不计入（不用对中文失效的 `len(text.split())`）
- 截断启发式：引号未闭合、结尾停在句子中间、缺少终止标点——刻意宽松，宁可漏报不误报
- 主角存在性检查只在配置了 `protagonist.name` 时执行；没有角色一致性 / 动机 / 故事弧分析
- Validation JSON artifacts：`runs/<run_id>/validation.json`，重复校验时覆盖同一文件
- Validation stage in `GenerationPipeline`：Save Story 之后、Review 之前
- Validation status in run metadata：`validation_status` / `validation_passed` / `validation_issue_count` /
  `validation_error`；`validation_status` 区分「校验不通过」（`completed` + `passed: false`）
  与「校验器自身异常」（`failed`）
- Validation panel in the modern UI：独立于 Review 的校验区块，展示 Passed / Failed 与每条 Issue 的
  Code / Severity / Message，失败时保留正文并提供「Validate Again」
- Manual validation endpoint：`POST /api/validate`（`{config, story}`，可选 `run_id` 覆盖该 Run 的 validation.json）
- CLI `validate` 子命令，与 Pipeline 共用同一个 `StoryValidator`；`run` 结束时报 `Validation: PASSED|FAILED`
- Tests：validation-result / story-validator / validation-api / ui-validation

### Changed

- 固定阶段顺序由 Config → Planning → Generation → Save Story → Review → Save Review 扩展为
  Config → Planning → Generation → Save Story → **Validate → Save Validation** → Review → Save Review
- `RunStatus` 新增 `validating`；UI 进度指示由五阶段改为六阶段
- `POST /api/runs` 与 `/api/runs/from-plan` 的响应新增 `validation` / `validation_status` / `validation_error?`
- `GenerationPipeline` 构造参数新增 `StoryValidator`；`RunDeps` 新增可选 `validator`
- README 定位改为「具备剧情规划、正文生成、基础有效性检查和自动审阅能力」，并明确区分
  Validator（硬性 · 规则 · 可用吗）与 Reviewer（软性 · LLM · 写得好吗）

### Fixed

- `POST /api/validate` 曾把「有值但全是空白」的 `story` 当请求格式错误返回 400，使 `EMPTY_CONTENT`
  无法经由 API 触发；现在只有 `story` 缺失或类型不为字符串才返回 400，空白正文交由 `EMPTY_CONTENT` 规则报告
- 六条校验规则的提示信息原为英文，与项目其余部分的中文不一致；统一改为中文
- `tsx` 被 README 的 `npx tsx scripts/generate-cli.ts` 使用却未在 `package.json` 中声明，
  导致文档中的 CLI 命令无法直接运行

### Compatibility

- 校验不通过不会让 Run 失败：`story.md`、`validation.json` 与 `status: "completed"` 照常返回，
  `validation.passed` 为 `false`，HTTP 状态码仍为 200（这是一次成功的业务结果，不是错误）
- Validator 自身抛异常也不是 Run 失败：正文保留，`validation_status` 为 `failed` 并记录 `validation_error`，
  此时不写 `validation.json`；Story 非空时 Review 仍照常执行
- `EMPTY_CONTENT` 时跳过 Review（没有可审阅的正文），但空正文本身仍会落盘
- The validator reports only. It does not automatically regenerate, repair, extend or rewrite the ending.
- Review 分数不参与 Validation 判定：哪怕 Review 打 0 分，校验该过还是过；打 100 分，该不过还是不过

---

## [0.5.0] —— 2026-09-21

### Added

- Basic AI story reviewer（`BasicReviewer` + `prompts/reviewer.txt`）：对生成正文做一次基础审阅
- `ReviewResult` 模型与校验（`src/types/review-result.ts`）：`score` / `summary` / `strengths` / `problems`
- Overall 0–100 quality score：单一总分，越界（`< 0` 或 `> 100`）与非数字一律拒绝
- Review summary：一段总体评价
- Strengths and problems lists：两个字符串列表，条目 trim，允许为空数组
- Review parser（`src/lib/review-parser.ts`）：容忍 ``` 代码围栏与首尾空白，其余非法 JSON 抛 `ReviewParseError`
- Review JSON artifacts：`runs/<run_id>/review.json`，重复审阅时覆盖同一文件
- Review stage in `GenerationPipeline`：正文落盘之后才审阅
- Review status in run metadata：`review_status` / `review_error` / `review_score`
- Review panel in the modern UI：分数 / 摘要 / 优点 / 问题，失败时保留正文并提供「重新审阅」
- Manual review endpoint：`POST /api/review`（`{config, story}`，可选 `run_id` 覆盖该 Run 的 review.json）
- CLI `review` 子命令，与 Pipeline 共用同一个 `BasicReviewer`
- Tests：review-result / review-parser / basic-reviewer / ui-review

### Changed

- Complete generation runs now include post-generation review
- Run metadata now records review status and basic review score
- 固定阶段顺序由 Config → Planning → Generation → Persistence 扩展为
  Config → Planning → Generation → Save Story → Review → Save Review
- `RunStatus` 新增 `reviewing`；UI 进度指示由四阶段改为五阶段
- `POST /api/runs` 与 `/api/runs/from-plan` 的响应新增 `review` / `review_status` / `review_error`
- `GenerationPipeline` 构造参数新增 `BasicReviewer`；`RunDeps` 新增可选 `reviewer`
- README 定位改为「具备剧情规划、正文生成、Run 持久化和基础自动审阅能力」，并明确审阅只反馈不改写

### Fixed

- `src/lib/story-generator.ts` 中 `buildStoryPrompt` 的累加变量声明为 `let` 但从未重新赋值，触发 `prefer-const` lint 错误；改为 `const`

### Compatibility

- 审阅失败不会让 Run 失败：`story.md` 与 `status: "completed"` 照常返回，只有 `review_status` 为 `failed`
- 审阅温度固定为 `0.3`，与生成用的 `temperature` 相互独立
- The reviewer provides feedback only. It does not automatically regenerate or repair the story.
  没有 PASS / FAIL 阈值、没有多维评分、没有自动重试与自动修复。

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
