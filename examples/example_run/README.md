# 示例 Run（v1.6.0 布局）

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

v1.5.0 起多了两份 `commercial-review.json`（Run 根目录与 `attempts/01/`）：由**独立的**
`CommercialReviewer` 对最终正文做的商业可读性审阅，四个固定维度（H / P / E / Pf）各给
0 ~ 100 分加一段短评，`score` 是这四个维度的确定性均分（82+68+74+62 → 71.5）。
根目录那份由入选 Attempt 的结论 promote 过来，与最终入选的 `story.md` 严格对应，
`metadata.json` 上的 `commercial_review_status` / `commercial_score` 也由它派生。
它与 `review.json` / `quality.json` 是**两套独立评价**，不互换、不合并，也不驱动重试或
修订——71.5 分不会让这次 Run 多跑一次。修订目录 `attempts/01/repairs/01/` 同样
不写 `commercial-review.json`：attempt 级那份已经是修订后正文的结论。

v1.6.0 起在 Run 根目录多一份 `run-manifest.json`：这次 Run 的**出身清单**——跑在哪个
版本上、用了哪个模型、哪六份提示词（各带一个版本号与原文 SHA-256）、六个阶段各自的温度、
重试策略、每次 Attempt 入选与否，以及每个产物文件的路径与内容摘要。它与 `metadata.json`
并排放，互不替代：metadata 记「这次发生了什么」，清单记「这次是拿什么跑出来的」。
清单里没有 `metadata.json` 与它自己——它记不了自己的摘要。摘要都是照磁盘上那份文件现算的，
所以根目录这份 `story.md` 与 `attempts/01/story.md` 的 `sha256` 逐字相同（promote 过来的）。
`baseUrl` 本身不写，只写来源类别。字段含义见 [docs/run-artifacts.md](../../docs/run-artifacts.md)。
