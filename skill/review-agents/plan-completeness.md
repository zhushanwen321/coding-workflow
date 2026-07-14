# Plan 完成度审查标准（Subagent C 用）

## 目的

本文档是 CW（coding-workflow）review 阶段的**客观事实核对标准**，供 Subagent C 使用。

与 Subagent A（项目约定）/ Subagent B（通用质量）不同，Subagent C 不做主观质量判断——
只做客观事实核对：plan 列的 changes 有没有落地，plan 的设计（依赖、范围）是否正确。

## 适用场景

- 对照 dev-plan.json 的 waves[].changes 与 topic.waves[].changedFiles（git diff-tree 持久化的实际改动文件）
- 输出落地率 + 未落地清单 + 设计问题清单
- 判定结果分两档：**已落地 / 未落地（must_fix）**

---

## Part 1: changes 落地率核对

### 核对流程

1. **读 dev-plan.json 的 waves[].changes**：每个 change 是一个"文件级改动点描述"（如"修改 src/store.ts 加 fileLock 方法"）
2. **对照 topic.waves[].changedFiles**：这是 dev 阶段 cw(dev) 通过 git diff-tree --name-only 持久化的**实际改动文件列表**
3. **判断每个 change 是否落地**：文件级客观核对——
   - plan 说"修改 store.ts"，changedFiles 里有没有 `store.ts`？
   - plan 说"加 fileLock 方法"，changedFiles 里有 `store.ts` 但方法是否真加上了？（这一步需要读文件确认，但只看文件级即可，不做深度质量判断）
4. **输出落地率**：已落地 changes 数 / 总 changes 数

### 判定标准

| change 描述 | changedFiles | 判定 |
|-------------|--------------|------|
| "修改 src/store.ts 加 fileLock" | 含 `src/store.ts` | **已落地** |
| "修改 src/store.ts 加 fileLock" | 不含 `src/store.ts` | **未落地（must_fix）** |
| "新建 src/lock.ts" | 含 `src/lock.ts` | **已落地** |
| "新建 src/lock.ts" | 不含 `src/lock.ts` | **未落地（must_fix）** |
| "修改 store.ts + gate.ts" | 只含 `store.ts`，缺 `gate.ts` | **部分未落地（must_fix 缺失项）** |

**注意**：changedFiles 缺失（wave 未 committed 或 diff-tree 异常）时，该 wave 的所有 changes 视为未落地。

### 示例

dev-plan.json：

```json
{
  "waves": [
    {
      "id": "W1",
      "changes": ["修改 src/store.ts 加 fileLock 方法", "新建 src/lock.ts"]
    },
    {
      "id": "W2",
      "changes": ["修改 src/gate.ts 接入 fileLock"],
      "dependsOn": ["W1"]
    }
  ]
}
```

topic.waves[].changedFiles：

```json
[
  { "id": "W1", "committed": "abc123", "changedFiles": ["src/store.ts", "src/lock.ts"] },
  { "id": "W2", "committed": "def456", "changedFiles": ["src/gate.ts"] }
]
```

核对结果：

- W1 changes[0] "修改 src/store.ts 加 fileLock" → changedFiles 含 `src/store.ts` → **已落地**
- W1 changes[1] "新建 src/lock.ts" → changedFiles 含 `src/lock.ts` → **已落地**
- W2 changes[0] "修改 src/gate.ts 接入 fileLock" → changedFiles 含 `src/gate.ts` → **已落地**

落地率：3/3 = 100%。

---

## Part 2: plan 设计正确性审查

### 检查项

#### 2.1 路径可达性

- wave 的 dependsOn 是否合理：有没有环形依赖（W1 依赖 W2，W2 依赖 W1）？
- 有没有缺失前置：wave 依赖了不存在的 wave id？
- dependsOn 链是否能从无依赖的 wave 走到所有 wave（没有孤岛）？

#### 2.2 依赖完整性

- wave 之间的依赖是否覆盖了所有必要的顺序约束？
- 如果 W2 改的文件依赖 W1 新建的文件（import 关系），W2 是否 dependsOn W1？
- 漏掉依赖不会导致 build fail（CW 不解析 import），但会导致 dev 阶段返工——这是设计问题

#### 2.3 范围合理性

- 单个 wave 的 changes 是否过多？**>5 个文件改动的 wave 建议拆分**（记为 should_fix，不是 must_fix）
- 单个 wave 是否混了多个不相关的功能（垂直切片原则）？如果是，建议拆分

### 判定标准

| 问题类型 | 严重度 | 说明 |
|---------|--------|------|
| 环形依赖 | must_fix | wave 互相依赖，无法排序执行 |
| 缺失前置（dependsOn 指向不存在的 wave id） | must_fix | 依赖链断裂 |
| 漏依赖（实际有顺序约束但 dependsOn 没列） | should_fix | dev gate 已通过说明没炸，但设计不严谨 |
| wave 过大（>5 文件） | should_fix | 建议拆分，不阻塞 |
| wave 混不相关功能 | should_fix | 建议拆分，不阻塞 |

---

## 输出格式

Subagent C 的核对结果记入 review.md 的"plan 完成度核对"段：

```markdown
## plan 完成度核对（Subagent C）

### changes 落地率
- 总 changes 数：N
- 已落地：M
- 未落地：K
- **落地率：M/N = XX%**

### 未落地清单（must_fix）
| wave | change 描述 | 缺失文件 | 严重度 |
|------|------------|---------|--------|
| W2 | 修改 src/gate.ts 接入 fileLock | src/gate.ts 不在 changedFiles | must_fix |

### 设计问题清单
| 类型 | wave | 问题 | 严重度 |
|------|------|------|--------|
| wave 过大 | W3 | 7 个文件改动，建议拆分 | should_fix |
| 漏依赖 | W2 | 改的文件 import W1 新建文件，但 dependsOn 未列 W1 | should_fix |
```

---

## 分工边界（重要）

本文档**只审功能完整性**。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 代码类型安全、错误处理、边界条件 | Subagent B（读 quality-criteria.md） |
| 项目特定 lint 规则、架构规范 | Subagent A（读项目 code-review skill） |
| 代码实现质量（即使文件落地了，写得对不对） | Subagent B（文件落地只代表"改了"，不代表"改对了"） |

Subagent C 的边界：**只回答"plan 列的 changes 有没有落地 + plan 设计对不对"**，不回答"落地了但实现质量如何"。

同一缺陷最多被一个 subagent 抓到。如果你（Subagent C）报告的问题与 Subagent A/B 重叠，说明分工边界不清晰，功能完整性问题归 Subagent C 优先。
