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

v1.8.0 起在 Run 根目录多一份 `telemetry.json`：这次 Run 的**执行过程**——每个阶段各跑了
多久、六次模型调用各自的起止与 usage、一次 Attempt 与一轮修订的过程指标，以及 Run 级汇总。
它与 `metadata.json` / `run-manifest.json` 三份并排，互不替代：metadata 记「这次发生了什么」，
清单记「这次是拿什么跑出来的」，遥测记「这次是怎么跑过来的」。

样例里有三处值得特别看一眼：

- `llmCalls` 有 6 条，但 `call-002`（骨架校验）没有 `inputTokens` / `outputTokens` /
  `totalTokens`——Provider 那一次没给 usage。于是 `totals.usageSampleCount` 是 5 而不是 6，
  三项 token 是对那 5 次求和，**没有把缺失的那次当成 0**。
- 整份文件里没有任何费用字段。这个仓库不维护价格表，Provider 也没在响应里给金额，
  所以 cost 整个键都不出现——「不知道」不等于「不花钱」。
- `stages` 里没有 `skipped` 项：这一步这一版接了什么，都真跑过了。

遥测只观察、不控制：这里的任何一个数都不参与重试、修订或采纳判定。
字段含义见 [docs/telemetry.md](../../docs/telemetry.md)。

v1.9.0 起在 Run 根目录多一份 `failure-analysis.json`：对上面这些**已经存在**的事实做的一次
确定性失败分类——它不新增观测，也不解释为什么，只回答「这次 Run 有没有失败、算哪一类、
在哪个阶段、有哪些证据」。样例这次是成功的，所以 `status` 是 `none`、`primaryCategory` 是
`null`、`signals` 与 `evidence` 都是空数组，`summary` 就是那一句
`No run-level failure detected.`。

这个 `none` 不是「看起来没事」就填个没事：这次 Run 没有 error code、遥测状态是
`completed`、唯一一次 Attempt 被采纳、质量分也过了线，四条事实全对上才敢写 `none`。换一次
失败的 Run，这里就会出现带来源的信号和指向具体文件的证据。`metadata.json` 上对应的两个
additive 摘要字段是 `failure_analysis_status`（= `none`）与 `primary_failure_category`
（没有主要失败类别就不写这个键）。字段含义见
[docs/failure-analysis.md](../../docs/failure-analysis.md)。
