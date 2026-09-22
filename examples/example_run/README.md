# 示例 Run（v1.0.0 冻结布局）

这个目录是一次**真实 Pipeline 运行**的产物，由测试用 FakeLLM 重新生成后写死时间戳，
用来展示 v1.0.0 冻结的 Run 产物布局，不含任何真实凭据或个人数据。

对应路径：JSON 计划 → 一次低分失败 → 修订一轮 → 终稿入选。
因为发生过修订，这里的运行级 `metadata.json` 记的是**修订后**的分数（`review_score` 82），
而 `review.json` 与 `attempts/01/review.json` 是**首次**那份审阅（41 分），修订后的审阅
在 `attempts/01/repairs/01/review.json` 里——这是刻意保留的不对称，不是数据损坏。
字段含义见 [docs/run-artifacts.md](../../docs/run-artifacts.md)。
