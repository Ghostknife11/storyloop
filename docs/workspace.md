# Creator Workspace（v2.2.0）

> 本文件是 v2.2.0 新增的 Creator Workspace 契约：项目与稿件的数据布局、工作区 HTTP 路由、
> Creator Health 的信号码、导出契约与五条明确的边界。
> 它** additive **：v1.0.0 冻结的 Run 类路由、错误码、产物布局与字段一个都没动，
> 2.1.0 的质量栈也不受影响。旧版本没有工作区路由，调用只会 404，不会 500。
>
> 契约测试：`tests/test_contract_api.test.ts`（路由清单）、`tests/test_workspace_api.test.ts`
> （工作区路由状态码与字段）、`tests/test_workspace_ui.test.ts`（界面边界）、
> `tests/test_workspace_network_boundary.test.ts`（这一层不许发外联请求）。

## 一句话

一个 **项目**（Project）把若干次 **运行**（Run）和若干篇 **稿件**（StoryDocument）收在一起：
从一次 Run 复制出一份可编辑的稿件，改完导出成 DOCX / EPUB，顺手看一眼这个项目当前
**确定性地**健康不健康（不给建议、不打分）。

Run 与生成链路完全不变：工作区**不新增任何智能能力**，也**不改任何已有产物的一个字节**。

## 数据布局

```text
projects/
  prj_<yyyymmddhhmmss>_<6 位随机>/
    project.json            # 项目本身（schemaVersion / id / name / status / ...）
    documents/
      doc_<...>.json        # 一篇稿件：标题、正文、状态、来源、contentHash
    revisions/
      doc_<...>/           # 同一篇稿的轻量修订记录（追加，只增不改）
    exports/
      index.json            # 导出账本（只增不改，按创建时间正序）
      <夜行列车_ab12cd.docx>   # 导出文件本体，与账本记下的文件名逐字一致
```

id 的形状统一是 `<种类>_<时间戳>_<6 位小写字母数字>`，种类只有四种：
`prj` / `doc` / `out` / `rev`。

- `projects/` 与 `runs/` **同级**：跟着 `RUNS_DIR` 走，运维把 Run 指到别处，项目就跟到别处。
- `project.json` 里**不放 Run 清单**。Run 归属的唯一事实源是每次 Run 自己的
  `run-manifest.json`（`workspace.projectId` 字段，§19）；项目详情是**扫**出来的，
  所以永远不会和磁盘上的真相对不上。v2.1.0 及更早写的 Run 没有这个字段，
  它们不属于任何项目（不是错误，只是没有归属）。
- `exports/index.json` 是账本：下载时**只按账上记的文件名**读文件，URL 里递什么都不影响
  最终取哪一段内容（§42）。

### StoryDocument 的字段边界

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `projectId` | string | 服务端生成；请求体里带这两个字段一律 400 |
| `title` | string | ≤ 120 字符 |
| `status` | enum | `draft` / `final`；**final 只是给使用者看的标记**，不参与任何自动判定 |
| `source` | enum | `generated`（从 Run 建的）/ `edited`（改过）/ `imported` |
| `content` | string | 正文全文 |
| `sourceRunId` | string \| null | 建稿时的那次 Run；之后怎么改都不回写 Run 的 `story.md` |
| `contentHash` | string | **服务端现算**的 SHA-256；请求体声明哈希一律 400 |
| `createdAt` / `updatedAt` | string | ISO 8601 |
| `isFavorite` | boolean | 只影响列表排序在前 |

请求体一律过两张网：`rejectUnknownKeys`（白名单外的键 400，含 `apiKey` 这类凭据形状的字段）
与 `rejectSecretBearingKeys`（看着像密钥的字段名直接拒）。

## 工作区路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/projects` | 项目列表：未归档在前，再按更新时间倒序 |
| POST | `/api/projects` | 建项目；只认 `name` / `storyConfigRef` / `isFavorite` |
| GET | `/api/projects/<id>` | 项目详情：项目 + `runIds` + `documentIds` |
| PATCH | `/api/projects/<id>` | 改名 / 收藏 / 归档；只认 `name` / `isFavorite` / `status` |
| GET | `/api/projects/<id>/documents` | 稿件列表（不含正文） |
| POST | `/api/projects/<id>/documents` | 从一次 Run 建稿（Run → Draft）；只认 `runId` |
| GET | `/api/projects/<id>/documents/<docId>` | 读一篇稿（含正文与 `contentHash`） |
| PATCH | `/api/projects/<id>/documents/<docId>` | 保存；只认 `title` / `content` / `status` / `isFavorite` |
| GET | `/api/projects/<id>/exports` | 导出历史 |
| POST | `/api/projects/<id>/exports` | 导出一篇稿（`docx` / `epub`） |
| GET | `/api/projects/<id>/exports/<exportId>` | 下载已导出的文件（二进制） |
| GET | `/api/projects/<id>/health` | 项目健康结论（确定性） |

项目 id 与稿件 id 都必须是**单段目录名**（`^[A-Za-z0-9][A-Za-z0-9._-]*$`，≤ 64 字符，
不是 `.` / `..`）。不合法一律 400，不存在一律 404，**没有一条会 500**。

请求体会过三层：形状不合法（缺字段、类型不对）→ 400；`rejectUnknownKeys` 把白名单外的键
（含 `apiKey` 这类凭据形状的字段名）拒掉 → 400；路径拼接后必须仍落在该项目自己的目录内
（§42）——越界一律 400，不去读目录外的东西。

### 新增错误码

| code | HTTP | 何时出现 |
|---|---|---|
| `WORKSPACE_INVALID` | 400 | 请求体不是合法 JSON、字段不在白名单、id 形状不合法、`runId` 不存在或那篇正文是空的 |
| `WORKSPACE_NOT_FOUND` | 404 | 项目 / 稿件 / 导出记录不存在，或导出记录对应的文件已经不在 |
| `WORKSPACE_CONFLICT` | 409 | 生成的 id 撞上了已有项目或已有稿件（重试即可） |
| `WORKSPACE_WRITE_FAILED` | 500 | 落盘失败（原子写的临时文件加重命名没成功）或保存时 `contentHash` 对不上——后者整篇都不落盘 |

用户错误（改请求就能解决）一律 4xx；响应里永远不出现堆栈、本机绝对路径或凭据。

### 响应形状

```jsonc
// GET /api/projects
{ "projects": [ { "project": { "id": "prj_...", "name": "…", "status": "active",
                                "isFavorite": false, "updatedAt": "…" },
                 "runCount": 3 } ] }

// GET /api/projects/<id>
{ "project": { … }, "runIds": ["20260927_100000_ab12cd"], "documentIds": ["doc_…"] }

// POST /api/projects/<id>/documents   → 201
{ "schemaVersion": "1", "id": "doc_…", "projectId": "prj_…", "title": "夜行列车",
  "status": "draft", "source": "generated", "content": "…", "sourceRunId": "20260927_…",
  "contentHash": "…", "createdAt": "…", "updatedAt": "…", "isFavorite": false }

// POST /api/projects/<id>/exports → 201，另带 Content-Disposition 头
{ "result": { "schemaVersion": "1", "id": "out_20260927_101500_ab12cd", "projectId": "prj_…",
              "documentId": "doc_…", "format": "docx",
              "filename": "夜行列车_ab12cd.docx",
              "artifactPath": "exports/夜行列车_ab12cd.docx",
              "contentHash": "…", "byteSize": 24173, "createdAt": "…" },
  "download": "attachment; filename=\"____ab12cd.docx\"; filename*=UTF-8''…",
  "mimeType": "…",
  "byteSize": 24173 }
```

注意 `POST /exports` 的响应体里**没有文件字节**：字节在
`GET /api/projects/<id>/exports/<exportId>`。那条路由按账本里的文件名读文件，
记录说导出过而文件不在了就是 404，不去磁盘上另找一个相近的顶上。

`artifactPath` 是**项目内相对路径**，不是服务器绝对路径（§67）。

## Creator Health

`GET /api/projects/<id>/health` 返回：

```jsonc
{ "status": "attention",                     // healthy | attention | blocked
  "signals": [ { "code": "latest_run_failed", "severity": "warning",
                 "message": "最近一次运行没有产出正文",
                 "source": "run-manifest" } ],
  "updatedAt": "…" }
```

九个性状是全部，一个不多（`HEALTH_SIGNAL_CODES`）：

| code | message（文案会改，码不改） |
|---|---|
| `archived` | 项目已归档：里面的运行与稿件都还在，只是不再出现在默认列表最前面 |
| `latest_run_failed` | 最近一次运行没有产出正文：<原因> |
| `quality_blockers` | 最近一次运行的质量诊断有 N 项 blocker |
| `quality_warnings` | 最近一次运行的质量诊断有 N 项 warning |
| `quality_stale` | 当前稿件在最近一次审阅之后改过：那次质量结论不再代表这一版 |
| `no_current_document` | 有运行记录但还没有在写的稿件：可以从任意一次运行建一篇 |
| `retry_pressure` | 这个项目过半的运行都要靠重试或修订才收场（N%） |
| `no_exports` | 当前稿件还没有导出过 DOCX / EPUB |
| `no_runs` | 这个项目还没有任何运行记录 |

- **确定性**：同一份磁盘事实，两次请求逐字相同（连信号顺序都一样）。它不调模型。
- **只报告，不建议**：没有「换个模型试试」这种话，也没有任何分数、百分比、
  趋势箭头或「本可节省的时间」。信号认 `code` 不认 `message`——文案会改，码不改。
- **不驱动任何行为**：没有任何代码读它来决定重试、修订、采纳或归档。

## 五条边界（写进测试的）

1. **不删**。归档只是把项目挪到列表后面，稿件与 Run 一个字节都不少。
   本版本没有「永久删除项目 / 删除稿件 / 删除导出」入口。
2. **不自动**。没有「一键成稿」「自动优化」「推荐下一步」；编辑器的自动保存只做存盘，
   不改写正文的任何判断。
3. **不评分**。界面上除 Run 自带的 `review.score` 与 `commercial_review.score`
   之外没有别的数字；缺分显示「—」，不补 0。
4. **不外联**。工作区这一层不发起任何 HTTP 请求；`tests/test_workspace_network_boundary.test.ts`
   把 `fetch` 换成会计数的桩后照常跑完建稿 / 改名 / 存稿 / 导出，计数必须是 0。
5. **不碰 Run**。从 Run 建稿是**复制**：之后在编辑器里怎么改，都不回写 Run 的
   `story.md`，也不给 Run 追加任何字段。
