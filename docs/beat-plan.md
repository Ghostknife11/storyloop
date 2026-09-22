# BeatPlan v1 契约

> 本文件是 v1.0.0 冻结的 BeatPlan schema。1.x 版本不得删字段、改字段名或改变字段语义；
> 需要扩展时只能追加可选字段（见 [upgrade.md](./upgrade.md) 与 [compatibility.md](./compatibility.md)）。
>
> 实现：`src/types/beat-plan.ts`（`validateBeatPlan`）
> 契约测试：`tests/test_contract_beat_plan.test.ts`

## 版本

```text
beat_plan_version = "1"
```

`beat_plan_version` 与 `config_version` 是两套独立版本号，互不推导。
缺省时取当前版本：请求体里不写 `beat_plan_version` 即视为 `"1"`。

## BeatPlan

| 字段 | 类型 | 必填 | 缺省 | 含义 | 示例 |
|---|---|---|---|---|---|
| `beat_plan_version` | string | 否 | `"1"` | BeatPlan 格式版本 | `"1"` |
| `summary` | string | 否 | 无 | 整份规划的一句话概述 | `"证人失踪案的三个节点。"` |
| `beats` | StoryBeat[] | 是 | — | 剧情节点，非空 | 见下 |

## StoryBeat

| 字段 | 类型 | 必填 | 缺省 | 含义 | 示例 |
|---|---|---|---|---|---|
| `id` | number | 是 | — | 正整数，从 1 连续、不可重复 | `1` |
| `purpose` | string | 是 | — | 这个节点在结构上的作用 | `"建立危机"` |
| `event` | string | 是 | — | 这个节点发生的事 | `"证人没有出庭。"` |
| `characters` | string[] | 是 | — | 出场角色名，可为空数组 | `["陈岚"]` |
| `conflict` | string | 否 | 无 | 该节点的对抗点 | `"距离开庭只剩一天。"` |
| `expected_outcome` | string | 否 | 无 | 期望读者获得的效果 | `"读者明白时间压力。"` |

排序与编号规则：

- `id` 必须是正整数（`>= 1`）
- `id` 不得重复
- `id` 排序后必须恰好是 `1, 2, …, n`，不允许跳号
- 数组顺序即叙事顺序；按 `id` 升序读取

校验只查结构，不评价规划质量（不判断 beat 是否合理、是否够多）。

## JSON 示例

最小可用（只含必填字段）：

```json
{
  "beat_plan_version": "1",
  "beats": [
    { "id": 1, "purpose": "建立危机", "event": "证人没有出庭。", "characters": ["陈岚"] },
    { "id": 2, "purpose": "高潮", "event": "对峙揭相。", "characters": ["陈岚", "周牧"] }
  ]
}
```

完整字段：

```json
{
  "beat_plan_version": "1",
  "summary": "证人失踪案的三个节点。",
  "beats": [
    {
      "id": 1,
      "purpose": "建立危机",
      "event": "证人没有出庭，距离开庭只剩一天。",
      "characters": ["陈岚"],
      "conflict": "时间不足，且有人不希望她出庭。",
      "expected_outcome": "读者明白时间压力与内部风险。"
    },
    {
      "id": 2,
      "purpose": "升级",
      "event": "陈岚发现保护记录被改过。",
      "characters": ["陈岚", "周牧"],
      "conflict": "她无法确定能信任谁。",
      "expected_outcome": "疑心转向内部。"
    },
    {
      "id": 3,
      "purpose": "高潮",
      "event": "对峙揭相，证人主动现身。",
      "characters": ["陈岚", "周牧", "证人"],
      "conflict": "出庭前最后对峙。",
      "expected_outcome": "失踪的真相被揭开。"
    }
  ]
}
```

## 不做什么

- 不做 Beat 质量评分、不标注 `confidence` / `strategy_score`
- 不做 Beat 之间的依赖图、因果图
- 不追加 `quality_dimension` 一类多维字段（那是 1.2.0 之后的事）

## 相关

- [StoryConfig v1 契约](./story-config.md)
- [Run 产物契约](./run-artifacts.md)
- [API 契约](./api.md)（`POST /api/plan` 返回它，`POST /api/runs/from-plan` 消费它）
