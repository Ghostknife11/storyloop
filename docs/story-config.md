# StoryConfig v1 契约

> 本文件是 v1.0.0 冻结的 StoryConfig schema。1.x 版本不得删字段、改字段名或改变字段语义；
> 需要扩展时只能追加可选字段（见 [upgrade.md](./upgrade.md) 与 [compatibility.md](./compatibility.md)）。
>
> 实现：`src/types/story-config.ts`（`validateStoryConfig`）
> 契约测试：`tests/test_contract_story_config.test.ts`
> 仓库样例：`configs/example_story.json`

## 版本

```text
config_version = "1"
```

请求体不写 `config_version` 时按 `"1"` 处理；写成其它值直接报错
（`UnsupportedConfigVersionError`，HTTP 400 `CONFIG_INVALID`），不会猜测或降级。

## StoryConfig

| 字段 | 类型 | 必填 | 缺省 | 含义 |
|---|---|---|---|---|
| `config_version` | string | 否 | `"1"` | 配置格式版本 |
| `title` | string | 是 | — | 故事标题，trim 后非空，≤ 120 字 |
| `genre` | string | 是 | — | 题材；任意非空字符串，不设枚举 |
| `premise` | string | 是 | — | 一句话前提 |
| `target_words` | number | 是 | `5000` | 目标字数，500 ~ 30000 的整数 |
| `setting` | string | 否 | 无 | 世界观与地点 |
| `protagonist` | object | 否 | 无 | 主角设定，见下 |
| `conflict` | string | 否 | 无 | 核心冲突 |
| `stakes` | string | 否 | 无 | 失败的代价 |
| `ending` | string | 否 | 无 | 结局走向 |
| `style` | string | 否 | 无 | 文风要求 |
| `extra_requirements` | string | 否 | 无 | 其它硬性要求 |

两个细节值得记住：

- `target_words` 只在「整个请求体就当 StoryConfig」这种写法下会自动补 5000。
  一旦用 `{ "config": {...} }` 包装，缺 `title` / `target_words` 直接报错——包装写法不做任何兜底。
- `prompt` 是 0.x 遗留字段：只在未包装写法里会被提升为 `premise`，并自动补 `genre = "其他"`。
  v1.0.0 仍保留这个兼容行为，建议新代码直接写 `premise`。

## protagonist

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 主角名，非空；返回时截断到 60 字 |
| `identity` | string | 否 | 身份 / 职业 |
| `goal` | string | 否 | 主角目标 |
| `motivation` | string | 否 | 动机 |

`protagonist` 整体省略时不做主角在场检查；给了对象但缺 `name` 则报错。

## 规则边界

`validateStoryConfig` 只做结构与类型校验：字段在不在、类型对不对、字数区间、版本号认不认。
它不评价故事点子好不好，也不会因为 `target_words` 太大而拒绝。

校验通过的返回值是「归一化后的新对象」：字段顺序固定、可选字段缺失时不出现该键、
未知字段一律丢弃。也就是说输入里的额外字段不会穿透到后续阶段。

## 不做什么

- 不做题材枚举/白名单（`genre` 是自由文本）
- 不做敏感内容审查
- 不推断 `target_words` 的合理性区间（500 ~ 30000 之外才报错）
- 不引入 `theme` / `tone` / `audience` 等新维度字段（保留给 1.x 之后的版本）

## 相关

- [BeatPlan v1 契约](./beat-plan.md)
- [Run 产物契约](./run-artifacts.md)
- [API 契约](./api.md)
