# 平台架构（v2.0.0）

> 本文说明 **v2.0.0 的架构**：六层职责、依赖方向、组合根、端口与适配器、Run 生命周期、
> 产物归属与安全边界。冻结的是「依赖方向与边界」这一组约定——新增能力按这个方向加，
> 由 `tests/test_architecture.test.ts` 静态扫 import 并把越界的边变成红灯。
>
> v2.0.0 是**第一个架构大版本**：它不改任何用户可见行为（HTTP API、请求响应字段、CLI、
> 错误码、`runs/` 下的产物布局与字段、界面逐字不变），改的是仓库内部谁可以 import 谁。
> 1.0.0 以来的产物原样可读，不需要迁移，也不需要转换层。
> 迁移成本只在「把本项目当库 import」的场景，见 [upgrade.md](./upgrade.md)。

## 六层职责

```text
                     ┌──────────────────────────────────────────┐
   Interface         │ src/interface · src/app/api · src/app    │  解析 · 渲染 · 路由适配
   （接口层）         │ src/components · scripts/                │  不写业务规则
                     └───────────────┬──────────────────────────┘
                                     │ 只拿到装好的用例
                     ┌───────────────▼──────────────────────────┐
   Composition       │ src/composition                          │  全仓唯一 new 出具体实现的地方
   （组合根）         │                                          │
                     └───────────────┬──────────────────────────┘
                                     │
                     ┌───────────────▼──────────────────────────┐
   Application       │ src/application                          │  用例编排 · 门面 · DTO ↔ Domain
   （应用层）         │                                          │  不含 React、不含 HTTP
                     └───────┬──────────────────────┬───────────┘
                             │                      │
          ┌──────────────────▼───────┐  ┌───────────▼──────────┐
          │ Engine                   │  │ Analysis             │  Engine：规划 / 生成 / 校验 /
          │ src/engine               │  │ src/analysis         │  审阅 / 修订 / 流式管道
          └───────────┬──────────────┘  └───────────┬──────────┘  Analysis：实验汇总 / 失败分类
                      │                             │   （对已有证据做推断）
          ┌───────────▼─────────────────────────────▼───────────┐
          │ Domain                                            │  领域契约与纯函数：模型、
          │ src/domain                                        │  规则、策略、序列化
          └───────────────────────┬───────────────────────────┘
                                  │ 被上述各层共同依赖
          ┌───────────────────────▼───────────────────────────┐
          │ Ports（端口）                                      │  接口只在这里声明，不实现
          │ src/ports                                         │  LLMClient / RunRepository /
          └───────────────────────▲───────────────────────────┘  ExperimentRepository /
                                  │                             ArtifactStore / Logger / …
          ┌───────────────────────┴───────────────────────────┐
          │ Infrastructure（基础设施）                        │  具体实现：文件系统、网络、
          │ src/infrastructure                                │  环境变量、时间、哈希
          └───────────────────────────────────────────────────┘
```

| 层 | 目录 | 负责 | 明确不做 |
|---|---|---|---|
| Interface | `src/interface`、`src/app/**`、`src/components/**`、`scripts/` | 解析输入、渲染输出、适配 HTTP/CLI | 不写业务规则，不 `new` 任何基础设施实现 |
| Composition | `src/composition` | 装配：把基础设施实现交给用例 | 不放业务逻辑；不放分支策略 |
| Application | `src/application` | 用例编排、公共门面、DTO ↔ Domain 转换、错误形状 | 不 import React、不读 `process.env` |
| Engine | `src/engine` | 一次 Run 的推进：规划、生成、校验、审阅、修订、管道 | 不 import Next.js、不碰 HTTP 路由 |
| Analysis | `src/analysis` | 对**已有证据**做推断：实验汇总、失败分类 | 不 import React、不 import Infrastructure |
| Domain | `src/domain` | 领域契约与纯函数：StoryConfig / BeatPlan / 各结论模型 / RetryPolicy / 校验规则 / 序列化 | 不 import Node 内置模块、不 import Next/React、不碰网络 |
| Ports | `src/ports` | 只声明接口（type），一个文件一副职责 | 不放实现、不放任何 `class` |
| Infrastructure | `src/infrastructure` | 一切副作用：LLM 客户端、文件存储、配置、日志、遥测、哈希、URL 关卡 | 不 import Interface / Components |

## 依赖方向

```text
Interface → Composition → Application → {Engine, Analysis} → Domain
                                              ↓                ↓
                                          Ports ← Infrastructure
```

读作「只能指向右边」：Infrastructure 实现 Ports 声明的东西，Domain 谁都能用，反过来
**Domain 不许知道任何一层的存在**。下面是机器守住的硬边界（`tests/test_architecture.test.ts`）：

| 层 | 允许依赖 | 绝对禁止 |
|---|---|---|
| Domain / Ports | 彼此 | Node 内置模块、`next`、`react`、网络、文件系统 |
| Engine | Domain、Ports、六件白名单基础设施 | `next`、`react`、`src/app` |
| Analysis | Domain、Engine、Ports | `react`、界面组件、Infrastructure |
| Application | Domain、Engine、Analysis、Ports、Infrastructure | `react`、`src/app` |
| Interface / Components / App | Domain、Composition、Application | 自己 `new` 存储 / 生成器等实现 |
| Infrastructure | Domain、Engine（仅限 `telemetry-collector` / `app-config` / `version` / `run-id` / `logger` / `manifest-builder` 六个模块）、Ports | `react`、`src/interface`、`src/app` |

两条方向之外的债务写在明面上并锁在白名单里，只许缩小不许扩大：

1. **Engine → Infrastructure**：六个模块（遥测收集、应用配置、版本号、run_id 生成、
   日志、Manifest 装配）。它们是横切工具，注入太碎反而制造噪音；白名单逐条列在架构测试里，
   多引一个就红灯。
2. ** Components → Engine**：界面取修订策略用（`repair-strategy` 的纯函数），其余界面文件只依赖 Domain。

## Composition Root（组合根）

`src/composition/index.ts` 是全仓**唯一 `new` 出具体实现**的地方。用法就是任务书写的那三行：

```ts
import { createDependencies, createStoryLoopApplication } from "@/composition";

const deps = createDependencies({ runsDir: "runs" });   // 基础设施实例在这里落地
const app  = createStoryLoopApplication(deps);          // 用例在这里绑成应用
const { status, json } = await app.service.generate(body);
```

- `createDependencies()` 解析环境与目录，new 出 `ArtifactStore`（= `RunRepository`）与
  `ExperimentStore`，把注入的 `LLMClient`（如果有）塞进两个用例袋子。
- `createStoryLoopApplication(deps)` 把依赖绑成可用的应用：`service`（公共门面）、
  `deps`（CLI 直接读存储用）、`generate`（生成路径的唯一正式入口）、`health()`。
- `createStoryLoop(options)` 是上面两步的合并写法，路由与 CLI 用的就是它。

每次调用都重新解析一次环境与目录，不在模块级缓存：`RUNS_DIR` / `LLM_*` 是运维旋钮，
改了要立刻生效（这条从 v1.x 沿用至今）。

### v2.2.0：组合根按能力拆成两个模块

v2.2.0 加了 Creator Workspace 之后，`src/composition/` 分成两个模块：

| 模块 | 装什么 | 谁 import |
|---|---|---|
| `@/composition`（`index.ts`） | 生成管线：`createDependencies` / `createStoryLoopApplication` / `createStoryLoop`。这里会 `new` 出按请求现建的模型客户端 | `/api/plan`、`/api/runs/**`、`/api/generate`、`/api/review*`、`/api/repair`、`/api/experiments/**`、CLI |
| `@/composition/workspace` | Workspace：`createWorkspace` / `createWorkspaceBundle`。只 new 三个文件存储（项目 / 稿件 / 导出），**依赖图里一个 HTTP 客户端都没有** | `/api/projects/**` 十二条路由 |

`index.ts` 仍然 re-export workspace 那几个符号（老 import 路径不断），但**新路由必须直接
import `@/composition/workspace`**：绕回 index 就等于把模型客户端拉回工作区的依赖图里，
拆模块买到的东西就没了。

拆开买到的是两件实在事：

1. **看得见**。工作区路由的 import 闭包里连一个会发请求的模块都不存在，
   `tests/test_workspace_network_boundary.test.ts` 把这条当断言跑（静态闭包 + 把 `fetch`
   换成会计数的桩跑四个写接口，两层都查）。
2. **读代码的人不会再猜**。一个只读写 `projects/` 的入口，看的组合根就是它该看的那一个。

同一处还有一条命名规矩，写在 `src/interface/api.ts` 里：**浏览器数据层按 HTTP 动词命名**
（`fetchProjects` / `postProject` / `patchDocument` / `postExport` / `downloadExport`），
服务端用例才用领域名词（`createProject` / `saveDocument` / …）。两侧共用函数名时，
读代码的人和按名字认符号的静态分析都会认错——v2.2.0 因此吃过一次误报：四条
「2 跳到达 ssrf」全是把路由里的用例调用认成了浏览器侧同名函数。
`tests/test_architecture.test.ts` 有一条断言把两侧函数名集合钉成不相交。

## Ports 与 Adapters

端口是 `src/ports/` 下的 type，一个文件一副职责，没有 `GenericRepository<T>`：

| 端口 | 文件 | 适配器（Infrastructure） |
|---|---|---|
| `LLMClient` | `ports/llm-client.ts` | `infrastructure/llm/openai-compatible-llm-client.ts` |
| `RunRepository` / `ArtifactStore` | `ports/artifact-store.ts` | `infrastructure/storage/artifact-store.ts` |
| `ExperimentRepository` | `ports/experiment-store.ts` | `infrastructure/storage/experiment-store.ts` |
| `Logger` | `ports/logger.ts` | `infrastructure/logging/logger.ts` |
| `ProviderProbe` | `ports/provider-probe.ts` | `infrastructure/health/health-probe.ts` |
| `FailureAnalyzer` | `ports/failure-analyzer.ts` | `analysis/failure-analyzer.ts` |

`RunRepository` 与 `ArtifactStore` 是同一个接口的两个名字：任务书两处都点了名，方法面却
一份就够，所以 `ports/artifact-store.ts` 末尾是别名而不是第二份接口。

适配器换掉不影响上层：换一个 `LLMClient` 实现（比如本地假模型）只需在组合根注入，
Engine 里的 `StoryGenerator` / `BeatPlanner` 一行都不用改。

## 公共服务门面

`src/application/story-loop-service.ts` 导出 `StoryLoopService`，方法名与既有用例一一对应：

```text
plan · generate · generateFromPlan · previewPrompt · validate · validateBeats ·
review · reviewCommercial · repair · createExperiment · listExperiments ·
getExperiment · runExperiment · getRun · version
```

API 路由与 CLI 只面向这个门面。它有意识地**不是上帝对象**：方法只是转调对应用例，
没有分支策略；新能力进来就是新加一个方法，不是往旧方法里加 `if`。

## Run 生命周期

```text
StoryConfig
   │  plan()                → BeatPlan（可手动编辑）
   ▼
validateBeats()             → BeatValidationResult（error 级 ⇒ Run 在写正文前结束）
   ▼
generate() / generateFromPlan()
   ▼
Attempt 1..max_attempts:
   Generate → Save Story → Validate → Review → Commercial Review →〔Repair → Revalidate → Rereview〕→ Decide
   ▼
Finalize：提升入选 Attempt 的产物到 Run 根，写 quality / manifest / telemetry / failure-analysis
```

编排在 Engine 的 `GenerationPipeline`，用例层只做「取输入 → 调管道 → 转结果」。
重试与修订的判定全部来自 `domain/retry-policy.ts` 的确定性规则——同样的输入永远得到
同样的次数，没有学习、没有自适应。

## 产物归属

一次 Run 的产物只由 `ArtifactStore` 写、`ArtifactStore` 读，`runs/` 下的布局从 v1.0.0 冻结
至今一个字节没变：

```text
runs/<run_id>/
├── config.json · beats.json · story.md · validation.json · review.json · quality.json
├── beat-validation.json · commercial-review.json · quality-stack.json
├── metadata.json · run-manifest.json · telemetry.json · failure-analysis.json
└── attempts/NN/            （含 repaires/NN/MM/）
```

归属规则只有一条：**写盘是基础设施的专属副作用**。Domain 是纯函数；Engine 通过端口拿
`ArtifactStore`；实验样本的产物与普通 Run 完全一样（`run-manifest.json` 上多一个可选的
`experiment` 块，普通 Run 里这个键不出现）。v1.x 的产物在 2.0.0 中原样可读，读不到的旧
字段按「没有这个键」处理，不补零、不猜测。

v2.1.0 在运行级多一个 `quality-stack.json`（三套质量结论的统一视图，只在 Run 根目录一份），
归属规则一个字都没变：它由 `QualityStackCoordinator`（Domain 侧的纯函数）从已有的三套结论
算出，经 Engine 调端口落盘；上面每一个原有文件一个字段都没少。逐字段契约见
[quality-stack.md](./quality-stack.md)。

v2.2.0 多了**第二棵产物树**，与 `runs/` 同级：

```text
projects/<project_id>/
├── project.json             项目本身
├── documents/<doc_id>.json  稿件（含正文与 contentHash）
├── revisions/<doc_id>/      同一篇稿的轻量修订记录（只增不改）
└── exports/
    ├── index.json           导出账本（只增不改）
    └── <文件名>.docx|.epub  导出文件本体
```

归属规则还是那一条：写盘只在 Infrastructure。`run-manifest.json` 上多一个可选的
`workspace.projectId`，把一次 Run 指到它所属的项目——这是 Run 归属的唯一事实源，
项目详情是扫出来的，不缓存第二份。逐字段契约见 [workspace.md](./workspace.md)。

## 安全边界

| 边界 | 位置 | 守住的约定 |
|---|---|---|
| LLM 端点地址关卡 | `infrastructure/security/url-guard.ts` | 请求体 `baseUrl` 只允许 http/https 公网地址，私网 / 环回 / 链路本地（含 `169.254.169.254`）在**发出任何请求之前**被拒；全仓唯一实现，服务端 `LLM_BASE_URL` 是受信配置不受此限 |
| 凭据隔离 | `infrastructure/config/app-config.ts` | 密钥只在服务端环境里被读一次；不进 API 响应、不进署名、不进产物 |
| 质量诊断序列化 | `domain/quality-diagnostic.ts` · `domain/quality-stack.ts` | 三套质量组件的诊断只走既有的 secret-safe 边界落盘：`quality-stack.json` 里没有 API Key、没有 `Authorization` / `Cookie` 头、没有 `process.env` 原文、没有带密钥的 URL；诊断也不驱动重试 / 修订 / 换模型 / 换 Prompt |
| 文本净化 | `domain/safe-text.ts` | 绝对路径替换、凭据打码，落盘与响应前统一过一遍 |
| URL 关卡唯一实现 | `infrastructure/security/url-guard.ts` | `assertPublicBaseUrl` 只有一份定义，架构测试盯着 |
| 健康接口 | `app/api/health/route.ts` | 只回答是非题（配没配 / 能不能写），不返回密钥、不返回 baseUrl |
| 配置来源 | `infrastructure/**` | `process.env` 只在 Infrastructure 读；`src/app` / `scripts` / 界面一个都不读 |
| 工作区不外联 | `composition/workspace.ts` · `tests/test_workspace_network_boundary.test.ts` | v2.2.0 新增：工作区十二条路由的 import 闭包里没有 LLM 客户端、没有 URL 关卡、没有生成管线；并且把 `fetch` 换成会计数的桩后，建稿 / 改名 / 存稿 / 导出照旧成功、计数为 0 |
| 工作区不跑出项目目录 | `infrastructure/storage/{project,document,export}-store.ts` | 所有路径拼接后必须仍落在 `projects/<id>/` 内；越界一律 400，不去读目录外的东西 |
| 工作区不认未登记字段 | `domain/workspace.ts` | 白名单外的键（含 `apiKey` 这类凭据形状的字段名）一律 400；`contentHash` 只能由服务端现算 |

## 架构测试

`tests/test_architecture.test.ts`（静态扫 import，不跑真代码）守住本页的全部约定：

- 六层的允许 / 禁止依赖表，含「Domain 不许 import `next` / `react` / `node:`」
- `src/app/**/route.ts` 必须从组合根（或其按能力拆出的子模块）取用例，且不自己 `new` 任何基础设施实现
- `assertPublicBaseUrl` 只允许有一份定义（v1.1.0 的关卡不许出现第二个实现）
- 三个仓储端口文件存在，且没有 `GenericRepository<T>`
- Engine → Infrastructure 的白名单逐条列死，多一条就红灯
- 无循环依赖（迭代式 DFS 染色检测）
- v2.2.0 新增：浏览器数据层与服务端用例不共用函数名（静态分析按名字认符号，同名就会被认错）

另有两个专项测试文件守工作区边界（都只读源码 / 打桩，不调真模型）：
`tests/test_workspace_network_boundary.test.ts`（导入闭包无 HTTP 客户端 + `fetch` 桩计数为 0）
与 `tests/test_workspace_ui.test.ts`（界面禁词与三条边界）。
