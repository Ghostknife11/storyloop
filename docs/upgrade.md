# 升级说明

> v1.0.0 是一次**冻结**，不是功能发布：没有新增智能能力，主要是把 0.9.x 已经能跑的
> 能力写成公开契约，并补齐合同测试与文档。因此从 0.9.x 升到 1.0.0 **几乎没有破坏性变更**。
>
> 版本策略见 [compatibility.md](./compatibility.md)。

## 从 0.9.x 升级到 1.0.0

### 行为变化（需要注意的两处）

1. **运行级 metadata 的 `model` 字段现在始终存在**（`TASK §9`）。
   以前只在请求显式带了 `model` 时才写；现在写的是「本次真正生效的模型」——
   请求覆盖 → 环境变量 → 缺省值。下游如果按「字段不存在 = 用默认模型」判断，需要改成读该字段。
2. **attempt 级 metadata 的 `error` 字段现在始终存在**（`TASK §10`）。
   没有错误时值是 `null`，不再是「条件出现」。这样「缺字段」与「没错误」可以区分。

两处都是**新增必填语义**，不会让旧消费者读到一半崩掉：字段从「可能没有」变成「一定有」。

### 修掉的边界情况

- `--temperature abc` 这类解析不出数字的 CLI 参数，以前会被静默丢掉（当成没给），
  直到调模型才以运行时失败收场（退出码 1）。现在按参数错误处理，退出码 2。
- 写盘失败的 API 错误码在 0.9.1 已经修过（`ARTIFACT_WRITE_FAILED` / 500 而不是 `GENERATION_FAILED` / 502）。

### 契约冻结（新增，不是破坏）

以下内容从「实现细节」变成「公开契约」，1.x 内不会再变：

| 契约 | 文档 | 合同测试 |
|---|---|---|
| StoryConfig v1 schema | [story-config.md](./story-config.md) | `tests/test_contract_story_config.test.ts` |
| BeatPlan v1 schema | [beat-plan.md](./beat-plan.md) | `tests/test_contract_beat_plan.test.ts` |
| Run 产物布局与 metadata 字段集 | [run-artifacts.md](./run-artifacts.md) | `tests/test_contract_artifacts.test.ts` |
| HTTP API 路径/字段/错误码 | [api.md](./api.md) | `tests/test_contract_api.test.ts` |
| CLI 命令/参数/退出码 | [cli.md](./cli.md) | `tests/test_contract_cli.test.ts` |
| README 结构与版本一致性 | — | `tests/test_contract_docs.test.ts` |

### 新增的仓库资产

- `examples/example_run/`：一次完整 Run 的合成样例产物，与线上布局逐字节同构（时间戳已写死）
- `configs/example_story.json`：覆盖所有可选字段的示例配置

### 没有做的事

按 v1.0.0 的范围约束，这一版**没有**引入多维审阅、Beat 质量校验、商业审阅、
实验框架、基准测试、高级可观测性、失败归因、因果图、自适应生成与自优化。
这些能力保留给 1.1.0 及之后的版本。

## 升级操作

```bash
git fetch && git checkout 1.0.0     # tag 不带 v 前缀
npm install
cp .env.example .env                # 填入 LLM_API_KEY 后即可跑
npm run dev                         # Web UI
npx tsx scripts/generate-cli.ts run --config configs/example_story.json
```

升级后建议跑一遍发布门禁：`npm test`（其中合同测试会校验 README / docs / 版本号一致）。

## 回滚

0.9.x 的产物布局与 1.0.0 兼容（只多两个恒定字段），因此回滚到 0.9.x 不会读不到历史 Run；
反过来，0.9.x 的代码读 1.0.0 写的产物时，`error: null` 与 `model` 会被安全忽略。
