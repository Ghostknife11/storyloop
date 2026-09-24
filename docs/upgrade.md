# 升级说明

> v1.0.0 是一次**冻结**，不是功能发布：没有新增智能能力，主要是把 0.9.x 已经能跑的
> 能力写成公开契约，并补齐合同测试与文档。因此从 0.9.x 升到 1.0.0 **几乎没有破坏性变更**。
>
> 版本策略见 [compatibility.md](./compatibility.md)。

## 从 1.0.0 升级到 1.0.1

**没有任何需要改代码的地方。** 1.0.1 不改运行行为，产物布局、字段、API、CLI 与 1.0.0 逐字一致；
1.0.0 写的产物可以被 1.0.1 直接读，反之亦然。要做的是：

1. 如果你**引用过** `docs/run-artifacts.md` 的字段表或 README 的运行级字段清单，重新拉一份：
   - 运行级 metadata 实际有 24 个字段（1.0.0 的文档只列了 13 个）；
   - `retry_on_validation_failure` 不在运行级 metadata 里，它是 RetryPolicy 的字段；
   - repair 级 metadata 没有 `issue_message`，它在同目录的 `request.json` 里。
2. 如果你依赖「`validation.json` / `review.json` 就是最终结论」这个假设，现在文档写明了：
   这两份文件（各级目录下都是）是**首次**结论，修订后的在 `attempts/NN/repairs/MM/` 里，
   而 metadata 与 API 的分数取**修订后**的结论。1.0.0 的行为本来就是这样，1.0.1 只是把它写清楚。

升级后跑一遍 `npm test`：新增的 `tests/test_contract_docs_sync.test.ts` 会核对文档与产物一致。

## 从 1.0.1 升级到 1.1.0

**只有一处行为变化**，其余与 1.0.1 逐字一致：产物布局、字段、CLI、错误码都不变。

1. 请求体里的 `baseUrl` 覆盖现在只允许 http/https 的**公网**地址。带本机、环回、私网、
   链路本地（含 `169.254.169.254` 云元数据地址）或保留段的请求，从「照常执行」变成
   400 `CONFIG_INVALID`，而且是在发出任何请求之前就拒掉。
   完整规则见 [api.md](./api.md) 的「`baseUrl` 覆盖的地址限制」。
2. 只有「在请求体里 `baseUrl` 指向本地假模型」的联调用法受影响。迁移办法是把同一个地址
   写到服务端的 `LLM_BASE_URL`：那是运维的受信配置，不受这套规则约束，
   「服务端指向本地假模型」照旧可用：

   ```bash
   # 之前：请求体 { "baseUrl": "http://127.0.0.1:9999/v1" }
   # 现在：服务端 .env
   LLM_BASE_URL=http://127.0.0.1:9999/v1
   ```

3. 如果你调的是 `/api/plan`、Run 类入口、`/api/review`、`/api/repair`、`/api/prompt/preview`
   以外的路径，或者从不覆盖 `baseUrl`，这一版对你没有任何影响。
4. 收紧的理由是凭据外泄：服务端是拿着 `LLM_API_KEY` 作为 Bearer token 去请求这个地址的，
   地址却是请求方定的。取舍记录在 [compatibility.md](./compatibility.md)。

升级后跑一遍 `npm test`：新增的 `tests/test_url_guard.test.ts` 会核对地址校验与服务层接线
（含「拒绝时 `fetch` 一次都没被调用」）。域名解析用注入的假解析器，不真的查 DNS。

## 从 1.1.0 升级到 1.1.1

**没有任何需要改代码的地方。** 1.1.1 修的是 v1.1.0 那道地址关卡自身的问题：
请求体 `baseUrl` 的约束方向不变，公网为主、内网一律拒绝的判定一条都没放松；产物布局、
字段、错误码与 1.1.0 逐字一致。具体三项：

1. **CLI 的 `--base-url` 恢复可用。** v1.1.0 把关卡接到了服务层，CLI 的 `plan` 因为没走
   服务层而绕过了它，`run` / `review` / `repair` 却都被拦住——三个子命令拦、一个不拦，
   而且文档没说 `--base-url` 也受影响。v1.1.1 明确 CLI 与 `LLM_BASE_URL` 同级（都是本机
   受信配置）：四个子命令统一按受信输入处理，ClI 指向本地假模型不再被拒。
   走 HTTP 的调用方行为完全不变。
2. **内嵌 IPv4 的 IPv6 地址改判。** v1.1.0 匹配点分文本的分支永远走不到（URL 会先把
   `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`），于是合法的公网 mapped 地址被误拒。
   v1.1.1 从地址最后两段取内嵌 IPv4，`::ffff:0:0/96` 与 NAT64 `64:ff9b::/96` 都按它判，
   另补 `fec0::/10`、`2002::/16` 两段。禁令清单只增不减。
3. **错误名与类名一致。** `UnsafeRequestUrlError` 不再借用 `RequestValidationError`。
   对外的 `error.code`（`CONFIG_INVALID`）与 400 状态码不变。

升级后跑一遍 `npm test`：`tests/test_cli.test.ts` 新增了「v1.1.1 CLI 入口的 baseUrl 信任级」，
`tests/test_url_guard.test.ts` 补了 mapped / NAT64 / 站点本地 / 6to4 四类地址的判定。

## 从 1.1.x 升级到 1.2.0

**没有任何需要改代码的地方。** v1.2.0 是纯 additive：既有字段、路由、错误码、CLI 参数与
产物布局一个都没动，v1.1.1 写的产物可以被 v1.2.0 直接读，反之 1.2.0 写的 Run 回落到
1.1.x 也能读（多出来的 `quality.json` 与三个 metadata 字段会被安全忽略）。

新增的四样东西：

1. **`quality.json`**——运行根与 `attempts/NN/` 各一份，把已有的校验结论、审阅结论与采纳结论
   汇成一份统一快照。布局与字段见 [run-artifacts.md](./run-artifacts.md)。
2. **API 响应里的 `quality`**（`QualityResult | null`）——Run 类入口、Run 详情、Attempt 详情
   都多了这一个字段，其余字段逐字不变。字段说明见 [api.md](./api.md)。
3. **`ReviewResult` 的可选 `suggestions`**——`prompts/reviewer.txt` 现在会额外要一组建议；
   模型没返回时响应与落盘里这个键整个不出现。字段说明见 [api.md](./api.md)。
4. **前端多了一张 Quality Summary 面板**——只做汇总，不带 Fix / Retry 一类操作入口。

需要知道的两件事：

- **旧 Run 没有 `quality.json`。** v1.2.0 之前生成的 Run 在读取时按同一套规则临时装配出
  `quality`，读响应不会失败，也不会回写文件。明细见
  [compatibility.md](./compatibility.md) 的「v1.2.0 的统一质量层」。
- **`quality.json` 取修订后的结论**，而同目录 `review.json` 是首次结论。这让快照与 metadata 的
  `overall_score` / `quality_issue_count` 同口径，代价是同一层里两个文件的分数可能不同——
  这是刻意保留的不对称（[compatibility.md](./compatibility.md) 已知不对称第 5 条）。

升级后跑一遍 `npm test`：新增的 `tests/test_quality_assembler.test.ts`（装配规则）、
`tests/test_quality_models.test.ts`（快照解析容错）、`tests/test_quality_compat.test.ts`
（旧 `review.json` / 无快照的旧 Run 原样可读）、`tests/test_quality_pipeline.test.ts`
（落盘与内存一致）、`tests/test_quality_api.test.ts`（读回一致、旧 Run 兼容）、
`tests/test_quality_ui.test.ts`（面板状态推导）覆盖这一层，且都用假模型，不调真实接口。

## 从 1.2.0 升级到 1.2.1

**没有任何需要改代码的地方。** 1.2.1 是一次修订版本：没有新能力、没有新文件、没有改字段、
没有改路由，只修 v1.2.0 一处「同一口径没走到底」的问题，顺带订正几处文档。

1. **旧 Run 的 `quality` 兜底装配改取修订后的结论。** v1.2.0 落盘的 `quality.json` 取的是
   修订后那一轮（与 `metadata.json` 的 `overall_score`、与最终采用的 `story.md` 同口径），
   但没有这个文件的旧 Run 在读取时临时装配读的却是 attempt 目录下的**首次**结论。于是同一个
   发生过修订的旧 Run：`metadata.json` 说 82、`repairs[].after_review_score` 说 82、
   接口给的 `quality.overall_score` 是 41。v1.2.1 起按三级兜底取，每级都是「这次尝试最终留下
   的那一版正文」（明细见 [api.md](./api.md) 与
   [compatibility.md](./compatibility.md) 的「v1.2.1 对同一条口径的修正」）。
2. **文档订正。** `docs/run-artifacts.md` 里一处把快照写成「首次校验 + 首次审阅」装配，
   与同文件下一段的实际口径相反；README、`CHANGELOG.md` 与 1.2.0 Release 的质量测试文件数
   写的都是五个，实际是六个（漏了 `tests/test_quality_compat.test.ts`）。

如果你在读 1.2.0 之前生成的 Run，升级后会看到 `quality.overall_score` / `summary` /
`suggestions` 与同一次尝试的 `metadata.json` 对齐（描述修订后那一版正文）。这是**修回**
v1.2.0 承诺的口径，不是新行为：v1.2.0 之后生成的 Run 读取结果一个字节都没变，
读接口依旧不写盘、不 500。

```bash
git fetch && git checkout 1.2.1     # tag 不带 v 前缀
npm install
```

回滚到 1.2.0 没有任何代价（纯 additive 的差别只影响旧 Run 的兜底口径）：

```bash
git checkout 1.2.0
```

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
git fetch && git checkout 1.2.0     # tag 不带 v 前缀；从 0.9.x 升级时 checkout 1.0.0 亦可
npm install
cp .env.example .env                # 填入 LLM_API_KEY 后即可跑
npm run dev                         # Web UI
npx tsx scripts/generate-cli.ts run --config configs/example_story.json
```

升级后建议跑一遍发布门禁：`npm test`（其中合同测试会校验 README / docs / 版本号一致，
并核对文档字段表与真实产物逐字段一致）。

## 回滚

0.9.x 的产物布局与 1.0.0 兼容（只多两个恒定字段），因此回滚到 0.9.x 不会读不到历史 Run；
反过来，0.9.x 的代码读 1.0.0 / 1.0.1 写的产物时，`error: null` 与 `model` 会被安全忽略。
从 1.1.0 回滚到 1.0.1 同理：两边产物逐字节同构，代码差异只有新增的 URL 校验与测试；
回滚后请求体 `baseUrl` 又可以指向任意主机（这正是 1.1.0 收紧掉的行为）。
从 1.1.1 回滚到 1.1.0 也不需要迁移：CLI 会重新开始拦 `--base-url` 指向本机的请求，
HTTP 行为与 1.1.0 相同；合法的公网 IPv4-mapped 地址会再次被误拒（只影响少数 IPv6 部署）。
从 1.2.0 回滚到 1.1.1 同样不需要迁移：1.2.0 新增的 `quality.json` 与 metadata 的三个新字段
只是被旧版本忽略，旧版本不会因为多一个文件而读不了 Run；CLI 与 HTTP 行为逐字相同。
