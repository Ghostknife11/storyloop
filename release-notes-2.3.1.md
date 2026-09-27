# v2.3.1 — 审计响应补丁（Benchmark Platform）

2.3.1 是 2.3.0 的一次**审计响应**补丁。对 2.3.0 的代码重跑了一次完整的 Mimosa 深度扫描
（`scan-2026-09-27T19-20-25`，封印 `sha256:c41c2ee2…`）：报告一条中危「疑似跨文件污点」，
逐条核实后确认是**误报**。**本版不修复任何安全漏洞。**

## 那条中危为什么是误报

扫描报告的原文是：

> HTTP 请求输入 → `application/workspace-documents.ts:273` 的 MongoDB 动态排序字段 sort

三件事让它不可能成立：

1. **本项目没有任何数据库。** `package.json` 里没有 mongo / mongoose / SQL / Prisma / Redis
   一类驱动，`src/` 里没有任何数据库客户端。
2. **被点名的路由不接受排序入参。** `GET /api/projects/<id>/documents` 只接受路径段 `id`；
   全仓 `/api/` 下不存在 `sort` / `orderBy` 之类的请求参数。
3. **那处 `.sort()` 不是数据驱动的。** `listDocuments` 收的是一个写死的比较器：`updatedAt`
   降序，`updatedAt` 打平时按 id 倒序收尾。唯一的 HTTP 派生输入 `projectId` 走的是
   `isWorkspaceId` + 目录 containment 两道校验，从不参与排序。

## 本版真正补的两处

人工复核那条链路时另外查出两处**防护不对称**。它们都不是可利用的漏洞——每一处都有路径
containment 检查兜底，调用方在到达之前也已经校验过 id——但「拼路径之前先看 id 合不合法」
这条纪律在两个存储里写得不一致，等于把唯一的关卡留在了调用顺序上。

### Security

- **`FileDocumentRepository.revisionsDir` 补齐 id 校验**：`projectId` 与 `documentId`
  现在都先过 `isWorkspaceId` 再拼路径，与兄弟存储
  `FileRevisionRepository.revisionsDir` 逐字一致。此前只有这一处漏了。
- **`BenchmarkStore.suiteDir` 补齐 Suite id 与版本校验**：现在自己检查
  `SUITE_ID_PATTERN` / `SUITE_VERSION_PATTERN`，与 `suiteEntries` / `readSuite` /
  `readBeatPlan` 同一条纪律。写路径收到的 Suite 本来就由领域工厂校验过，新增的这一层守的是
  「万一没拦住」时 `putSuite` 也不把路径拼出去。
- 两处都只可能挡住本来就会被挡住或本来就到不了的输入，**现有行为一个字节都没变**。

### Fixed

- `CHANGELOG` 里 2.3.0 条目排序更正（新增版本条目应置顶，此前误排在 2.2.0 之下）。
  两个条目的正文与已发布版逐字一致，本次只调整位置。

### Tests

- `test_benchmark_store`：直接往 `putSuite` 塞不合法 id / 版本的 Suite，必须抛
  `BenchmarkWriteError`，且 `benchmarks/suites/` 下一个目录都不多出来。
- `test_workspace_document`：删稿件要连 `revisions/` 一起删，且删除动作不越出项目目录；
  两个 id 不合法一律抛错。
- `test_contract_docs`：新增「CHANGELOG 最新条目必须等于 VERSION」（上一条排序错误正是
  漏掉这道关），以及 2.3.1 的说真话门禁——README / CHANGELOG / upgrade / compatibility
  都必须写明「不修复任何安全漏洞」，不许被后来的人改写成功劳。

### 测试与升级

- `tsc --noEmit` 干净；eslint 0 error（46 个既有 warning）；`next build` 通过。
- **118 个测试文件 / 1917 条测试全绿**（较 2.3.0 多 6 条，全部只用桩与临时目录，
  不打任何真实付费 API）。
- 升级见 [docs/upgrade.md](docs/upgrade.md) 的「从 2.3.0 升级到 2.3.1」：
  **没有任何需要改代码的地方，也没有任何产物要迁移**，回滚到 2.3.0 的代价为零。

## 需要如实说明的

- 扫描自身判定 `runStatus: inconclusive`、`completeness: partial`，并记录了一条覆盖缺口
  （部分调用为动态派发或超出分析规模，跨文件可达性可能不完整）。因此这次扫描**不能**被解释为
  「项目已无问题」。
- 本版修复的两处不是安全漏洞，是防护纪律的一致性缺口；这样做是为了让下一次扫描不再需要
  人工解释同一处代码。

> 安全扫描的覆盖不完整，本次发布不能解释为「项目已无问题」。
