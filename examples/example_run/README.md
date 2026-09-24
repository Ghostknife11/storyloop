# 示例 Run（v1.4.0 布局）

这个目录是一次**真实 Pipeline 运行**的产物，由测试用 FakeLLM 重新生成后写死时间戳，
用来展示当前版本的 Run 产物布局，不含任何真实凭据或个人数据。

对应路径：JSON 计划 → Beat 结构校验 → 一次低分失败 → 修订一轮 → 终稿入选。
因为发生过修订，这里的运行级 `metadata.json` 记的是**修订后**的分数（`review_score` 82），
而 `review.json` 与 `attempts/01/review.json` 是**首次**那份审阅（41 分），修订后的审阅
在 `attempts/01/repairs/01/review.json` 里——这是刻意保留的不对称，不是数据损坏。

v1.2.0 起多了两份 `quality.json`（Run 根目录与 `attempts/01/`）：由 `QualityAssembler`
从**修订后**的校验结论、审阅结论与采纳结论确定性装配，因此分数与 `metadata.json` 的
`overall_score` 一致（82），也和最终入选的 `story.md` 对齐。修订目录
`attempts/01/repairs/01/` 不写 `quality.json`——attempt 级那份就是修订后的快照。
另请注意 `suggestions` 这个新增的可选字段：首次那份审阅没有它，修订后的那份有；
读取时缺失按旧结构处理，这正是向后兼容的样子。

v1.4.0 起在 Run 根目录多一份 `beat-validation.json`：BeatPlan 在生成正文**之前**先过
一道结构校验，结论落在这里，`metadata.json` 上对应的 `beat_validation_status` /
`beat_validation_passed` / `beat_validation_issue_count` 三个字段也由它派生。
样例里这次校验**通过**（`passed: true`），只带一条 `ENDING_NOT_PREPARED` 的 warning——
结局要的那句「三分钟去向」在前三拍里没有铺垫；warning 不阻断生成，所以后面照常进了
生成循环。字段含义见 [docs/run-artifacts.md](../../docs/run-artifacts.md)。
