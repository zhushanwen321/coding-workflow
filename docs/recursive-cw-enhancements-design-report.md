# 递归问题求解 — cw 增强设计报告

> **日期**：2026-08-01
> **分支**：`feat-recursive-problem-solving`（coding-workflow 仓）
> **CW topic**：`slice:recursive-cw-enhancements`（已过 clarify → plan → design-review → execute → retrospect，全部实现并 commit）
> **源头设计**：`xyz-agent-workspace/feat-recursive-problem-solving/.xyz-harness/recursive-problem-solving/spec-c-cw-enhancements.md`
> **用途**：对比当前方案与 spec-c 原始设计的差异，**重点是 xyz-agent（spec-f）会消费的协议部分**，供调整 xyz-agent 开发计划

---

## 0. TL;DR

spec-c 的 6 处改动（C1-C5 + duplicate-slug gate）**全部保留，功能范围不变**，并已全部实现（见 §6 实施状态）。经两轮 reviewer 审查 + 架构归位评估，做了 **3 处架构调整 + 6 处实现修正**，其中 **2 处影响 xyz-agent spec-f 的消费协议**（字段数据源更明确、类型 B 调用链更清晰，但不破坏契约）。另有 **1 处增量改动**（`lastStatusHistoryAction`，见 §7）在实施阶段追加，对 spec-f 是向后兼容的字段新增。

**xyz-agent 侧需要关注的变更**：
- `children` 字段的 `dependsOn` 数据来源从"slug 映射可能歧义"改为"childDelivery 显式映射"——**更可靠，消费方无感**
- frontier 的 `blocked` 由 cw 计算好输出——**spec-f 的 queryFrontier/topoSort 直接 filter(!blocked) 即可，与自己算状态**
- frontier 每个 node 多一个可选 `lastStatusHistoryAction`（§7）——**后备检测信号，不读也能工作**
- `allWavesClosed` gate 已接受 `aborted` 终态——**spec-f 的失败传播（abort wave → 父 slice retrospect）可直接工作，无需 cw 改动**

---

## 1. 与 spec-c 原始设计的对比

### 1.1 保持不变的部分（spec-c 原案，本方案完全遵循）

| spec-c 条目 | 本方案 |
|------------|--------|
| C1：execute 返回 children 含 dependsOn | ✅ 完全一致 |
| C2：frontier 两遍扫描 + 类型 A/B blocked | ✅ 完全一致 |
| C3：handoff 渲染 FeatureSpec FR/AC | ✅ 完全一致 |
| C4：design-review 注入 layerSpecific 字段名 | ✅ 完全一致（实现路径细化，见 1.3） |
| C5：retrospect forbidden → optional | ✅ 完全一致 |
| C6：duplicate-slug gate | ✅ 完全一致（spec-c §2 旁路发现，用户决定一起补） |
| frontier 输出 JSON 字段（nodes/unitId/scope/status/nextAction/blocked/dependsOn/parentUnitId/childUnitIds） | ✅ 完全一致（另在实施阶段追加 `lastStatusHistoryAction?`，见 §7） |

### 1.2 架构调整（3 处，影响代码组织但不改对外协议）

#### 调整 1：frontier 计算与渲染分离

| 维度 | spec-c 原案 | 本方案 |
|------|------------|--------|
| 归属 | "render.ts 新增 renderFrontier，或新建 readonly/frontier.ts"（spec-c §2 实现位置，未定） | **计算逻辑放 `src/core/frontier.ts`，`render.ts` 只做 `renderFrontier` 格式化** |

**原因**：核实 `render.ts` 文件头（L1-14）明确声明"纯函数，只接收 CwStore/WorkUnitRecord 数据 + 参数，不触碰文件系统"。现有 4 个渲染函数（renderTree/renderStatus/renderList/renderHandoff）都是格式化已有数据，零状态机语义。frontier 的 blocked 推导读 `status`（终态判定）+ `plan.split.dependsOn` + `evidence.childDelivery` 算可推进性——是领域逻辑（与 `rollup.ts`、`rules/gates/` 同级），不是渲染。

**对 xyz-agent 的影响**：无。对外协议（`cw frontier --root <id>` 的 JSON 输出）完全不变，只是 cw 内部代码组织更清晰。

#### 调整 2：映射工具新建 core/hierarchy.ts

| 维度 | spec-c 原案 | 本方案 |
|------|------------|--------|
| 归属 | spec-c 未指定（只说"slug → childUnitId 映射逻辑"） | **新建 `src/core/hierarchy.ts`**，承载 `resolveChildDependsOn` 等跨父子 WorkUnit 关系的只读遍历工具 |

**原因**：`core/plan.ts:1` 注释"运行时零依赖"、`core/workunit.ts:1` 注释"领域模型"——都是纯声明文件。`resolveChildDependsOn` 同时依赖 `plan.split`（plan.ts）和 `evidence.childDelivery`（evidence.ts），是跨实体的组合操作，不属于任何单一实体。新建 `hierarchy.ts` 承载这类树形关系操作。

**对 xyz-agent 的影响**：无。这是 cw 内部工具函数，不对外暴露。

#### 调整 3：C3 从 frontier wave 挪到 guidance-gates wave

| 维度 | spec-c 原案 | 本方案 |
|------|------------|--------|
| wave 归属 | spec-c 未指定 wave 划分（只列改动清单） | C3（handoff 渲染 FR/AC）从与 frontier 同 wave，挪到与 C4/C5/C6 同 wave |

**原因**：C3 改 `renderDecisionsSection`，frontier 改 `renderFrontier`——不同函数、无依赖。放一起使 wave 过大且耦合不相关改动。挪到 guidance-gates wave（都是内部小改）更内聚。

**对 xyz-agent 的影响**：无。wave 划分是 cw 本项目的施工组织，不影响 xyz-agent。

### 1.3 实现修正（6 处，修正 spec-c 的不准确描述）

这些是 spec-c 原文描述不够精确或与代码现状不符的地方，本方案修正后**功能不变，但实现路径不同**。

#### 修正 1：C4 wave 层字段名 + 注入路径

| spec-c 原案 | 实际代码（核实） | 本方案修正 |
|------------|----------------|-----------|
| wave LayerSpecific 列了 `implApproachNote / testDesignNote / riskMitigationNote / qualityGateNote`（spec-c §4 改动 5 的 wave guidance） | `WaveDesignReviewLayerSpecific`（judgments.ts:53-58）真实字段：`testCaseCoverageNote / boundaryConditionNote / mockStrategyNote / tddRedReadinessNote`（全 optional） | 字段名改为真实代码的 4 个 |
| spec-c 说改 "wave guidance" 未展开 | wave **没有** `wave-internal.ts`（`src/handlers/wave/` 目录不存在），schema 走 `handlers/internal.ts:190 getSchemaText` → 全局 `ACTION_SCHEMA`（action-schemas.ts:30） | C4 分 4 处注入（见 IF5） |

**C4 的 4 处注入点**（spec-c 只笼统说"各层 get{Scope}SchemaText"）：

| 层 | 注入文件 | schema 源 |
|----|---------|----------|
| wave | `src/handlers/internal.ts` getSchemaText (L190) | 全局 `ACTION_SCHEMA["design-review"]` → 基类 `DesignReviewJudgment` |
| slice | `src/handlers/slice/slice-internal.ts` getSliceSchemaText (L83) | `SLICE_ACTION_SCHEMA["design-review"]` → 基类 |
| feature | `src/handlers/feature/feature-internal.ts` getFeatureSchemaText (L92) | `FEATURE_ACTION_SCHEMA["design-review"]` → 基类 |
| epic | `src/handlers/epic/epic-internal.ts` getEpicSchemaText (L91) | `EPIC_ACTION_SCHEMA["design-review"]` → 基类 |

四处当前**全部指向基类 `DesignReviewJudgment`**（layerSpecific 是 `Record<string,string>`），agent 看不到该填哪些 key。C4 在这四处对 `action === "design-review"` 特判，追加对应 LayerSpecific 字段名列表。

**对 xyz-agent 的影响**：间接。spec-f 的 wave/planning agent 填 design-review 时能看到字段名，不再靠 gate fail 试错。

#### 修正 2：C6 gate 注册位置

| spec-c 原案 | 实际代码（核实） | 本方案修正 |
|------------|----------------|-----------|
| "注册到 design-review gate 列表"（spec-c §6 改动 #5，笼统） | design-review gate 不是单一列表，是**三个独立 runner**：`runSliceDesignReviewGates`(L530) / `runFeatureDesignReviewGates`(L753) / `runEpicDesignReviewGates`(L887)，各自 `return [...]` 数组列 gate | gate 函数加到现有 `design-review.ts`（与 splitNonEmpty/splitDagValid 同文件，**不新建文件**），三个 runner 各加一行 `runGateSafely("duplicate-split-slug", duplicateSplitSlug, unit)`，`rules/index.ts` 三处 export 块补导出 |

**关键细节**：现有 `splitDagValid`（design-review.ts:399）用 `new Set(splits.map(s=>s.slug))` 建邻接表，**重复 slug 会被静默折叠成一个条目**——DAG 环检查看不到重复带来的歧义。新 gate 必须**显式检查重复**（`splits.length !== new Set(...).size`），不能依赖 splitDagValid 捕获。

**对 xyz-agent 的影响**：无。这是 cw 内部 gate 注册。

#### 修正 3：IF3（resolveChildDependsOn）frontier 类型 B 调用链

spec-c §2 描述了类型 B（wave dependsOn wave）需反向查找，但没说清调用链。本方案明确：

```
frontier 算 wave W 的 blocked（类型 B）:
  1. findParentSlice(W) → 拿到父 slice S
  2. resolveChildDependsOn(S.plan.split, S.evidence.childDelivery) → 返回所有子的依赖
  3. 在返回数组里 find(item => item.childUnitId === W.id) → 取 W 的 dependsOn
  4. 查 dependsOn 里的每个 childUnitId 是否终态 → 有未终态则 W blocked=true
```

**关键**：wave 自身 `plan.split` 恒空（createWave 时 cw 自动填 `[]`，workunit.ts:223 核实），**不能直接读 wave 自己的 split**，必须经父 slice 反查。`resolveChildDependsOn` 的输入是父 slice 的 `splits + childDelivery`，不是单个 wave。

**对 xyz-agent 的影响**：无（frontier 内部实现）。但 spec-f 的 `topoSort` 消费 `node.dependsOn` 字段——这个字段现在由 cw 经上述调用链算好填入 frontier 输出，spec-f 直接用。

#### 修正 4：resolveChildDependsOn 不读 childStatus

| spec-c 原案 | 本方案修正 |
|------------|-----------|
| 未声明 childStatus 是否影响映射 | IF3 显式声明：只用 `childDelivery` 的 `splitSlug + childUnitId` 两字段，**不读 `childStatus`** |

**原因**：execute 调用点（slice/execute.ts:63-68）刚 push 完 childDelivery，此时所有 `childStatus = "pending"`；frontier 调用点 childStatus 反映终态。映射逻辑（slug → childUnitId）与 childStatus 无关，显式声明避免实现者因 childStatus=pending 而 early-return 空。

**对 xyz-agent 的影响**：无。

#### 修正 5：nextAction 的 scope → STATUS_TO_ACTION 映射

spec-c §2 说"用 status→action 映射（render.ts:497-521）"，但实际有两张表：

- `WAVE_STATUS_TO_ACTION`（render.ts:507）→ 返回 `WaveAction | undefined`
- `PLANNING_STATUS_TO_ACTION`（render.ts:522）→ 返回 `PlanningAction | undefined`

frontier 按 `unit.scope` 选表：`scope === 'wave'` 查 WAVE 表，其余查 PLANNING 表。

**对 xyz-agent 的影响**：无（frontier 内部）。

#### 修正 6：C1 内联构建，不经反向解析器

| spec-c 原案 | 本方案修正 |
|------------|-----------|
| spec-c §1 改动 2 示例：`unit.plan.split.map((s,i) => ({unitId: unit.executeResult.childUnitIds[i], dependsOn: s.dependsOn?.map(...)}))` | 一致，但明确：C1 在 execute handler 的构建循环里**直接内联构建** children（那里同时有 split + child.id + split.dependsOn），**不调 `resolveChildDependsOn`** |

**原因**：execute 循环里已有 `split` 和 `child.id`，直接正向映射即可。`resolveChildDependsOn`（反向解析，从已落盘数据反查）只服务 frontier 只读查询场景。强行让 C1 经反向解析器会给 execute 加多余读取。

**代价**：C1 的 slug→childUnitId 映射（execute 时正向）与 frontier 的 resolveChildDependsOn（查询时反向）形成两套同义映射——接受重复换取并行性（w1 和 w2 无代码依赖，可并行施工）。

**对 xyz-agent 的影响**：无。`children` 字段的对外结构不变。

---

## 2. xyz-agent spec-f 消费协议（重点）

### 2.1 cw 对外暴露的协议（spec-f 消费方）

这些是 spec-f 的 workflow 脚本会直接消费的 cw 输出。**本方案与 spec-c 原案完全一致，未破坏任何契约**。

#### 协议 1：execute 返回的 children（C1）

```jsonc
// cw execute --unitId slice:xxx 的 stdout JSON
{
  "unitId": "slice:xxx",
  "status": "executing",
  "ok": true,
  "children": [
    { "unitId": "wave:xxx::w1", "dependsOn": [] },
    { "unitId": "wave:xxx::w2", "dependsOn": ["wave:xxx::w1"] }
  ],
  "nextAction": { ... }
}
```

spec-f 消费点（spec-f §2 buildActionSchema L290-306）：
```javascript
if (!isWave && action === "execute") {
  return { type:"object", properties:{ children:{ type:"array", items:{...} } } };
}
```
**契约稳定**。`children` 字段名、`{unitId, dependsOn}` 结构、`dependsOn` 是 childUnitId 列表——全部与 spec-c 一致。

#### 协议 2：frontier 输出（C2）

```jsonc
// cw frontier --root epic:xxx --format json 的 stdout
// 注：示例省略可选字段 lastStatusHistoryAction（见 §7），实际每个 node 都带。
{
  "rootUnitId": "epic:xxx",
  "nodes": [
    {
      "unitId": "wave:xxx::w1",
      "scope": "wave",
      "status": "executing",
      "nextAction": "test",
      "blocked": false,
      "dependsOn": [],
      "parentUnitId": "slice:xxx::s1"
    },
    {
      "unitId": "wave:xxx::w2",
      "scope": "wave",
      "status": "created",
      "nextAction": "clarify",
      "blocked": true,
      "blockedReason": "依赖 wave:xxx::w1 未完成",
      "dependsOn": ["wave:xxx::w1"],
      "parentUnitId": "slice:xxx::s1"
    },
    {
      "unitId": "slice:xxx::s1",
      "scope": "slice",
      "status": "executing",
      "nextAction": "retrospect",
      "blocked": true,
      "blockedReason": "子层有未终态节点: wave:xxx::w1, wave:xxx::w2",
      "dependsOn": [],
      "parentUnitId": "feature:xxx",
      "childUnitIds": ["wave:xxx::w1", "wave:xxx::w2"]
    }
  ]
}
```

spec-f 消费点（spec-f §2 主循环 L96-104 + queryFrontier L234-242 + topoSort L340-374）：
```javascript
const frontier = queryFrontier(rootUnitId);
const actionable = frontier.nodes.filter(n => !n.blocked && !isTerminal(n.status));
const { concurrent, sequential } = topoSort(actionable);  // 用 node.dependsOn 做拓扑排序
```
**契约稳定**。`blocked` 由 cw 算好，spec-f 直接 filter。`dependsOn` 是 childUnitId 列表（经 childDelivery 反查），topoSort 直接用。

#### 协议 3：allWavesClosed gate 已接受 aborted（⚠️ spec-f §1.3 悬而未决问题已解决）

spec-f §1.3 担心："父 slice retrospect 的 all-waves-closed gate 需校验'所有子层终态'（含 aborted）——需核实 cw 的 gate 实现是'全 closed'还是'全终态'。如果是'全 closed'需改为'全终态'"

**核实结果**：`allWavesClosed`（retrospect.ts:197-215）**已经接受 aborted**：
```typescript
const nonTerminal = childStatuses.filter((s) => s !== "closed" && s !== "aborted");
// L210: report: `all-waves-closed: ${nonTerminal.length} 个 child wave 未进入终态`
// L215: report: `all-waves-closed: 全部 ${childStatuses.length} 个 child wave 已终态（closed/aborted）`
```

**结论**：spec-f 的失败传播（wave 超时 → `cw abort` → wave 终态 aborted → 父 slice retrospect 的 allWavesClosed gate 通过）**可直接工作，cw 侧无需改动**。

### 2.2 字段命名（未冻结为不可变契约）

按用户决策：`frontier` action、`children` 字段、`blocked`/`blockedReason` 字段应进 CONTEXT.md 词表作为当前规范，但**不冻结为跨项目不可变契约**。后续如需新增/修改字段名，必须先讨论。

> ⚠️ **实施差异**：原计划这些字段进 CONTEXT.md，但实际开发**未更新 CONTEXT.md**（仍停留在 15 action 旧文本，缺这些词表行）。详见 §5。代码侧（`src/cli.ts` / `src/handlers/types.ts` / `src/core/frontier.ts`）已全部实现，是事实上的当前规范。

**当前规范字段清单**（代码已实现，待补进 CONTEXT.md）：

| 字段 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `frontier` | 第 16 个 Action（只读） | CLI 命令 | 列出 WorkUnit 树的非终态节点 + 可推进性 |
| `children` | ActionResult 顶层 | `ChildInfo[]?` | execute 返回的子层信息（仅 planning-execute） |
| `blocked` | frontier 输出 | `boolean` | 节点是否阻塞（等依赖/等子层） |
| `blockedReason` | frontier 输出 | `string?` | 阻塞原因 |
| `lastStatusHistoryAction` | frontier 输出（FrontierNode） | `string?` | statusHistory 最后一条的 action；`"replan"` 时调度器需做 replan 后备检测（§7，实施阶段追加） |

### 2.3 xyz-agent 开发计划的建议调整点

基于以上分析，xyz-agent 的 spec-f / spec-w 开发计划**无需因 cw 侧方案变更而大改**，但有几个点值得注意：

1. **C2（frontier）必须首批实现**——spec-f v2 已把 frontier 从"崩溃恢复专用"升级为"BFS 主循环必需"（spec-f §1.1 决策方式 A）。这点 spec-f 已记录，无需调整。

2. **allWavesClosed 已接受 aborted**——spec-f §1.3 的"需核实/需改"可标记为"已确认 cw 侧无需改动"，移除该待办。

3. **`children` 字段的 dependsOn 数据源更可靠**——本方案用 childDelivery 显式映射而非 slug 字符串匹配，duplicate slug 不再导致 childUnitId 错配。spec-f 的 topoSort 消费的 `dependsOn` 更可信。

4. **依赖路径**——spec-f 依赖 spec-c 的 C1（children）+ C2（frontier）。C1 和 C2 已作为两个独立 wave 实现并 commit（w1=`47e5b97`、w2=`522bcd0`），cw 侧两个协议均已交付。

---

## 3. 本方案最终拆分（3 个 wave，全并行）

```
w1: children          — C1，改 4 文件（handlers/types.ts + epic/feature/slice/execute.ts）
w2: frontier          — C2，新建 core/frontier.ts + core/hierarchy.ts + 改 readonly/{render,index}.ts + cli.ts
w3: guidance-gates-spec — C3+C4+C5+C6，改 render.ts(renderDecisionsSection) + handlers/internal.ts +
                          {slice,feature,epic}-internal.ts + subagent-guidance.ts + design-review.ts + rules/index.ts
```

**依赖关系**：w1/w2/w3 的 `split.dependsOn` 全空——代码无依赖，可完全并行。

**注意点**：w2 和 w3 都改 `render.ts`（w2 加 `renderFrontier`，w3 改 `renderDecisionsSection`）——不同函数，git merge 不冲突，但若并行开发需注意提交顺序。

---

## 4. 审查轨迹

本方案经以下审查环节：

| 轮次 | 审查方 | 发现 | 处理 |
|------|--------|------|------|
| 1 | reviewer（plan-vs-spec-c 一致性） | 4 critical + 4 major + 2 minor | 全部修正（见 1.3） |
| 2 | reviewer（架构归位） | frontier 归属 + 映射工具归属 + gate 注册 + ActionResult 影响 + CONTEXT.md 5 项 | 采纳架构调整 1/2（见 1.2），gate/ActionResult/CONTEXT 确认无问题 |
| 3 | 主 agent 代码核实 | wave-internal.ts 不存在、LayerSpecific 真实字段、三个 runner、ACTION_SCHEMA 全指向基类、allWavesClosed 已接受 aborted | 全部核实，修正 plan |
| 4 | cw design-review 机器 gate | 11 gate 全过（tech-choice-non-empty / split-non-empty / split-dag-valid / all-decisions-resolved / inherited-item-ids-valid / necessity / sufficiency / alternatives / tradeoffs / risks / layer-specific-non-empty） | 通过 |

---

## 5. CONTEXT.md 更新清单（实施差异说明）

> 本节原标题「待办」，因实现已完成，改为记录实施差异：原计划同步更新仓库根 `CONTEXT.md`（按用户要求，新增字段进词表），**实际代码已落地（action 数=16、`frontier` 命令、`children`/`blocked` 字段均已实现），但 `CONTEXT.md` 文件本身未被本次开发更新**——它仍停留在「15 种操作 / 15 个 Action / READONLY_QUERIES = 4 只读」的旧文本，缺 frontier / children / blocked / lastStatusHistoryAction 词表行。

**代码侧已确认的现状**（与下表对照）：

- `src/cli.ts:147-160` `ADVANCE_ACTIONS` = 10 推进（create+10=11 推进类），`src/cli.ts:164` `READONLY_QUERIES = tree/status/list/handoff/frontier`（5 只读）→ 总计 **16 个 action**。
- `src/handlers/types.ts:111` `children?: ChildInfo[]`；`:117` `ChildInfo`。
- `src/core/frontier.ts:59-78` `FrontierNode`（含 `blocked`/`blockedReason`/`dependsOn`/`childUnitIds`/`lastStatusHistoryAction`）。

原计划改动清单（**至今未落地到 `CONTEXT.md`，留作遗留**）：

| 位置 | 计划改动 | 现状 |
|------|---------|------|
| L11 | "15 种操作之一" → "16 种" | ❌ 未改 |
| L40 | "## 15 个 Action" → "## 16 个 Action" | ❌ 未改 |
| L58 后 | 新增 `frontier` 行：`\| frontier \| 只读 \| 列出 WorkUnit 树的非终态节点 + 可推进性（blocked），--root <id> \|` | ❌ 未加 |
| L60 | "READONLY_QUERIES = 4 只读" → "5 只读" | ❌ 未改 |
| L109 | ActionResult 概念行追加 `children?`（仅 planning-execute 填充） | ❌ 未改 |
| L104-115 核心架构概念表 | 新增 `blocked` / `lastStatusHistoryAction` 概念行 | ❌ 未加 |

> 注：`CONTEXT.md` 位于仓库根（不在 `docs/`），不属于本次 docs 审查范围；本报告仅记录差异。若需补齐，应由一次独立的 CONTEXT.md 同步改动完成。`blocked`/`blockedReason`/`lastStatusHistoryAction` 是 frontier 查询的推导结果（瞬态），不是持久化字段——与 `nextAction?`/`failureCount?` 同类，应进概念表而非 WorkUnitBase 数据模型表（L130-139）。

---

## 6. 实施状态

本报告原稿写作时 CW topic `slice:recursive-cw-enhancements` 停在 `design-reviewed`，原 §6 写的是「等你确认后启动 execute」。**实际后续已全部实现、测试并 commit**，3 个 wave + 1 个增量改动全部落地：

| wave | 改动 | commit |
|------|------|--------|
| w1（children，C1） | `ActionResult` 新增 `children?: ChildInfo[]` | `47e5b97 feat(c1): add children field to ActionResult for recursive scheduling` |
| w2（frontier，C2） | 新建 `src/core/frontier.ts` + `src/core/hierarchy.ts` + `cw frontier --root <id>` 命令 | `522bcd0 feat(c2): add cw frontier readonly command for recursive BFS scheduling` |
| w3（guidance-gates，C3+C4+C5+C6） | handoff 渲染 FeatureSpec FR/AC + layerSpecific schema 注入 + retrospect optional + `duplicate-split-slug` gate | `e943383 feat(c3-c6): handoff FR/AC, layerSpecific schema, retrospect optional, dup-slug gate` |
| 增量（lastStatusHistoryAction） | FrontierNode 新增 `lastStatusHistoryAction?` 字段，供递归调度器做 replan 后备检测 | `a7f0af1 feat(frontier): expose lastStatusHistoryAction for replan detection` |

另：`c98a77e docs(cw-cli skill): fix --input/execute flags + add frontier command` 同步更新了 cw-cli skill 文档。

> **遗留**：`CONTEXT.md`（仓库根，非 `docs/`）原计划按 §5 同步更新（15→16 action、新增 frontier/children/blocked 词表行），但实际开发未触及该文件——仍停留在「15 种操作 / 15 个 Action / READONLY_QUERIES = 4 只读」。详见 §5 的实施差异说明。

报告完。

---

## 7. 增量改动：lastStatusHistoryAction（replan 后备检测）

> 本报告初稿（§0-6）完成于 design-review 阶段，覆盖 C1-C6。**实施 frontier（C2）后追加了一个增量改动**（commit `a7f0af1`），原报告未含，本节补记。

### 7.1 背景：replan 是旁路，status→action 映射看不到它

`replan` action 是**旁路**——不改 status，只 append 一条 `statusHistory`（`action="replan"`）并做影响面计算/级联 abort。这意味着 frontier 的 Pass 1 用 `status→action` 映射（`WAVE_STATUS_TO_ACTION` / `PLANNING_STATUS_TO_ACTION`，frontier.ts:22-46）算出的 `nextAction` **反映不出"刚发生了 replan"**。

递归调度器（xyz-agent spec-f 的 BFS 主循环）需要知道某个 unit 刚被 replan 过——因为 replan 后通常需要回 plan 阶段重做（即便 status 仍停在 `executing`）。

### 7.2 改动：FrontierNode 新增 lastStatusHistoryAction

`FrontierNode`（frontier.ts:59-78）新增字段：

```typescript
/** statusHistory 最后一条的 action（如 "replan"/"clarify"/"plan"/"execute"）。
 *  供递归调度器做 replan 后备检测——replan 是旁路（status 不变），frontier 的
 *  status→action 映射不反映"需回 plan"，调度器靠此字段识别 replan 发生。 */
lastStatusHistoryAction?: string;
```

实现（frontier.ts:149-160）：从 `unit.statusHistory` 取最后一条，读其 `.action` 字段；空数组/非数组/缺 action 字段时返回 `undefined`（安全降级，不崩溃）。

### 7.3 对 xyz-agent spec-f 的影响

- **契约新增（向后兼容）**：frontier 输出每个 node 多一个可选字段 `lastStatusHistoryAction`。spec-f 的消费代码（§2.3 的 `queryFrontier`/`topoSort`）**不读这个字段也能工作**——它是后备检测的补充信号，非必需。
- **推荐用法**：调度器优先用 `nextAction`（status 派生），当 `lastStatusHistoryAction === "replan"` 时降级为"该 unit 需要回 plan 阶段处理 replan 影响面"，而非按 status 推进。
- **§2.2 字段清单**：原表列 frontier 输出字段时未含此项，实际已含（见下表更新）。

### 7.4 §2.2 字段清单更新

frontier 输出字段（与 §2.2 协议 2 的 JSON 示例一致，补充 `lastStatusHistoryAction`）：

| 字段 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `lastStatusHistoryAction` | frontier 输出（FrontierNode） | `string?` | statusHistory 最后一条的 action；`"replan"` 时调度器需做 replan 后备检测 |
