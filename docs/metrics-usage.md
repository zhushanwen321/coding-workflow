# CW-CLI 评估指标：使用指南

> 配套 [metrics-design.md](./metrics-design.md)（指标是什么、为什么这么设计）。本文档回答"怎么用、怎么解读、怎么据此改进"。

---

## 快速上手

### 单 topic 指标

```bash
cw stats --topicId cw-2026-07-14-xxx
```

输出三类指标：complexity（复杂度分桶）、efficiency（过程效率）、leverHealth（杠杆健康度）。

### 跨 topic 聚合

```bash
cw stats --all
```

按 runtimeEnv（agent + llm + cwVersion）分组，同组内按复杂度分桶，桶内算均值。

### post-closeout 评估

```bash
# closeout 后手动调（不在 nextAction 导航里）
cw assess --topicId cw-2026-07-14-xxx --type quality --score 4 --notes "结构清晰"
cw assess --topicId cw-2026-07-14-xxx --type defect --notes "并发丢数据" \
  --defect '{"severity":"major","area":"store.ts","rootCause":"边界遗漏","foundInReview":false}'
```

---

## 输出解读

### complexity

```json
{
  "complexity": {
    "level": "medium",
    "waves": 5,
    "estimatedFiles": 8
  }
}
```

| level | 含义 |
|-------|------|
| simple | 小改动（≤3 wave, ≤5 文件），firstTryPassRate 天然高 |
| medium | 中等规模 |
| complex | 大改动（≥10 wave 或 ≥15 文件），预期返工多 |

**解读规则**：不要跨复杂度比较 firstTryPassRate。simple 任务的 0.9 不比 complex 任务的 0.6 好——它们在不同尺度上。`cw stats --all` 已经在内部做了分桶归一。

### efficiency

```json
{
  "efficiency": {
    "firstTryPass": { "plan": true, "tdd_plan": true, "dev": false, "test": true },
    "earlyInterceptionRate": 0.75,
    "devRetryCount": 2,
    "testRetryCount": 0,
    "totalGateFails": 4,
    "lateReworkRate": 0.0,
    "planCompletionRate": 1.0,
    "coverageFlag": false
  }
}
```

逐项解读：

| 指标 | 好的信号 | 坏的信号 | 行动 |
|------|---------|---------|------|
| firstTryPass | 全 true | 多个 false | 看 false 的 phase，加强该阶段的 prompt/gate |
| earlyInterceptionRate | 高（>0.7） | 低（<0.3）+ lateReworkRate 高 | 问题漏到后期了，检查 gate 是否失效 |
| devRetryCount | 0-1 | ≥3 | plan 拆分不合理 或 TDD 红灯没做好 |
| testRetryCount | 0-1 | ≥3 | expected 不准 或 实现质量差 |
| totalGateFails | 0-2 | ≥5 | 整体执行粗糙 |
| lateReworkRate | 0 | >0.3 | review/closeout 才发现问题 = 前置 gate 没拦住 |
| planCompletionRate | 1.0 | <0.7 | plan 过于乐观 或 执行力不足 |
| coverageFlag | false | true | 测试通过率 < 50%，严重覆盖不足 |

**典型组合诊断**：

| 组合 | 诊断 |
|------|------|
| devRetryCount 高 + planCompletionRate 低 | 执行力问题——agent 做不完 |
| devRetryCount 低 + planCompletionRate 低 | plan 乐观——拆得太细做不到 |
| earlyInterceptionRate 低 + lateReworkRate 高 | 左移失效——问题漏到 review 后 |
| testRetryCount 高 + coverageFlag false | 测试体系有问题——expected 不准 或 覆盖太浅 |

### leverHealth

```json
{
  "leverHealth": [
    { "lever": "spec 范围守门", "gate": "lite-plan-schema", "status": "pass" },
    { "lever": "TDD 红灯先行", "gate": "tdd-red-light", "status": "pass" },
    { "lever": "review 存在性", "gate": "file-exists+non-empty", "status": "not-run" },
    { "lever": "retrospect 结构化", "gate": "file-exists+non-empty", "status": "pass" }
  ]
}
```

| status | 含义 | 是否问题 |
|--------|------|---------|
| pass | 该杠杆最终生效 | 正常 |
| fail | 该杠杆失败（retry 后仍未通过） | 需排查 |
| not-run | 该杠杆未被触发 | 看情况 |

**not-run 不一定是问题**：

- review 存在性 not-run + topic 还在 dev 阶段 → 正常（还没到 review）
- review 存在性 not-run + topic 已 closed → 异常（跳过了 review）
- TDD 红灯先行 not-run → 看是否故意跳过红灯（real 层 testCase 通常不检查红灯）

**fail 是问题**：杠杆 fail 意味着 retry 后仍未通过，说明该机制的门槛可能需要调整，或 agent 在该阶段持续挣扎。

---

## 跨 topic 对比（cw stats --all）

### 输出结构

```json
{
  "groups": [
    {
      "agent": "Pi",
      "llm": "GLM-5.2",
      "cwVersion": "1.2.0",
      "topicCount": 5,
      "buckets": [
        { "level": "simple", "topicCount": 2, "avgFirstTryPassRate": 0.9, "avgEarlyInterceptionRate": 1.0, "avgTotalGateFails": 1.0 },
        { "level": "medium", "topicCount": 2, "avgFirstTryPassRate": 0.7, "avgEarlyInterceptionRate": 0.6, "avgTotalGateFails": 3.5 },
        { "level": "complex", "topicCount": 1, "avgFirstTryPassRate": 0.5, "avgEarlyInterceptionRate": 0.4, "avgTotalGateFails": 6.0 }
      ]
    },
    {
      "agent": "Pi",
      "llm": "GLM-5.2",
      "cwVersion": "1.3.0",
      "topicCount": 4,
      "buckets": [ ... ]
    }
  ]
}
```

### 正确的对比姿势

**只比同 agent + 同 llm + 同复杂度桶的不同 cwVersion**：

```
Pi + GLM-5.2 + cwVersion 1.2.0 的 medium 桶
vs
Pi + GLM-5.2 + cwVersion 1.3.0 的 medium 桶
```

如果 1.3.0 的 medium 桶 avgFirstTryPassRate 从 0.7 升到 0.85 → cw-cli 改进有效。

**错误的对比**：

- 跨 agent：Pi 的 complex 桶 vs Claude Code 的 complex 桶 → 能力差异混入
- 跨 llm：GLM-5.2 vs Sonnet-4.5 → 模型差异混入
- 跨复杂度：simple 桶 vs complex 桶 → 任务难度差异混入
- unknown 分组 vs 有 runtimeEnv 的分组 → 旧数据混入

### 统计显著性

cw stats --all 的桶内均值在 topicCount 少时波动极大。经验法则：

| 桶内 topicCount | 均值可靠性 |
|----------------|-----------|
| <3 | 不可靠，单 topic 的极端值就能扭曲均值 |
| 3-5 | 有方向性参考价值 |
| >5 | 可信对比 |

cwVersion 升级效果评估至少需要同组同桶各有 3 个 topic。少于这个数量时，用趋势而非绝对值判断。

---

## assess 的使用时机

assess 是**设计者**（不是执行 agent）在 closeout 后手动调用的。

### 什么时候调 assess

| 场景 | type | 用途 |
|------|------|------|
| 代码上线后发现质量问题 | quality | 回溯评分 |
| 测试遗漏了边界 | test | 记录测试盲区 |
| 生产环境出现稳定性问题 | stability | 记录稳定性缺陷 |
| 发现 review 没抓到的 bug | defect | 校准 review 召回率 |

### defect 登记的规范

```bash
cw assess --topicId <id> --type defect \
  --notes "高并发下 store.ts flock 竞争导致数据丢失" \
  --defect '{"severity":"major","area":"store.ts","rootCause":"并发边界遗漏","foundInReview":false}'
```

**foundInReview 的判定标准**：

- `true`：翻开 review.md 或 reviewIssues，发现该问题曾被记录但没修干净
- `false`：review 完全没提到这个问题

不要凭记忆判断——回去翻 review 的产物。foundInReview 的准确性直接决定 review 召回率的可信度。

### rootCause 分类建议

| rootCause | 含义 | 暗示的改进方向 |
|-----------|------|--------------|
| 边界遗漏 | 空数组/非法输入/并发等边界没处理 | 加强边界测试用例 |
| 类型错误 | 类型不安全导致运行时错误 | 收紧类型检查 |
| 需求理解偏差 | 实现与需求不符 | 加强 clarify 阶段 |
| 错误处理缺失 | catch 吞异常或没 catch | review 加强错误处理维度 |
| 性能问题 | 算法/数据结构选择不当 | 加性能测试 case |

rootCause 的分类不需要严格统一——积累后自己看分布，哪类 rootCause 多就重点加强对应阶段。

---

## 常见误用

### 1. 把 firstTryPassRate 当唯一指标

firstTryPassRate 高不代表质量好——可能 test 的 expected 太松（全 pass 但没覆盖关键路径）。必须结合 leverHealth（test 机器重算是否 pass）和 assess（post-closeout 是否发现 defect）一起看。

### 2. 跨 agent 比较

不同 agent 的执行风格差异巨大（有的 agent 保守多 commit，有的激进少 commit），wave 数和文件数都受影响。跨 agent 比 complexity 分桶本身就不公平。

### 3. 用 single topic 下结论

单 topic 的指标波动太大。一个 topic 的 firstTryPassRate=0.5 可能只是任务恰好卡在某个难点。至少 3 个同复杂度的 topic 才有参考价值。

### 4. 忽略 not-run 杠杆

not-run 不代表"没问题"——它代表"该机制未被触发"。如果 TDD 红灯先行总是 not-run，说明 agent 系统性跳过红灯确认，这本身就是一个需要关注的问题。

### 5. assess 只填 quality 不填 defect

quality/test/stability 是评分（主观），defect 是校准锚点（客观）。没有 defect 数据，review 召回率无法计算，整个第一层评估就没有校准基准。

---

## 指标驱动的改进循环

```
积累 topic（同 runtimeEnv + 同复杂度桶）
      │
      ▼
cw stats --all  →  对比不同 cwVersion 的桶内均值
      │
      ├─ firstTryPassRate 下降  →  找退步的 phase，检查该阶段 prompt/gate 变更
      ├─ earlyInterceptionRate 下降  →  左移失效，检查 gate 是否被绕过
      ├─ leverHealth 出现 fail  →  该机制门槛需调整
      └─ assess defect 的 foundInReview=false 比例高  →  review 需加强
      │
      ▼
改进 cw-cli（修 prompt / 调 gate / 加测试维度）
      │
      ▼
新一轮积累 + 对比
```

这个循环的时间尺度是**周/月**，不是单次 session。指标的价值在趋势，不在单点。
