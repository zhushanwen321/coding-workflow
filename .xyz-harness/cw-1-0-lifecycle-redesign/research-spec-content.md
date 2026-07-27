# 4 层 Spec 内容设计调研报告

> 基于 12 个真实 xyz-harness topic 的文件内容分析，归纳每层 spec 应装什么内容。

## 调研对象

| # | Topic | 项目 | 文件齐全度 |
|---|-------|------|-----------|
| 1 | 2026-06-20-frontend-rebuild | xyz-agent | ✅ 全（含 plan-frontend.md、visual-acceptance/） |
| 2 | 2026-06-08-agent-run-block-refactor | xyz-agent | ✅ 全 |
| 3 | 2026-06-07-chat-send-mode-design | xyz-agent | ✅ 全 |
| 4 | 2026-06-05-chat-area-round1 | xyz-agent | ✅ 全 |
| 5 | 2026-06-01-global-nav-stack | xyz-agent | ✅ 全 |
| 6 | 2026-06-21-workflow-refactor | xyz-pi-extensions | ✅ 全（含 clarification.md、domain-models.md、plan-w1~w5.md） |
| 7 | 2026-06-14-use-skill-tracker | xyz-pi-extensions | ✅ 全（含 clarification.md） |
| 8 | 2026-06-11-plan-mode | xyz-pi-extensions | ✅ 全（含 plan-mode-design.md） |
| 9 | 2026-06-04-todo-loop-improvements | xyz-pi-extensions | ✅ 全 |
| 10 | 2026-06-02-peekhour-model-switch | xyz-pi-extensions | ✅ 全 |
| 11 | 2026-05-31-skill-state-tracker | xyz-pi-extensions | ✅ 全 |
| 12 | 2026-05-28-fix-modality-overflow-failover-filtering | llm-simple-router | ✅ 全 |

---

## 任务 1：spec.md 内容模式

### 1.1 章节频率统计

| 章节 | 出现次数 | 频率 | 典型标题 |
|------|---------|------|---------|
| Background / 背景 | 12/12 | 100% | Background、背景与现状 |
| Functional Requirements / FR | 12/12 | 100% | Functional Requirements、FR-1~FR-N |
| Acceptance Criteria / AC | 12/12 | 100% | Acceptance Criteria、验收标准 |
| Constraints / 约束 | 12/12 | 100% | Constraints、技术约束 |
| Business Use Cases / 业务用例 | 10/12 | 83% | 业务用例、UC-1~UC-N |
| Out of Scope / 范围外 | 10/12 | 83% | Out of Scope、Out-of-scope |
| Decision Records / 决策记录 | 8/12 | 67% | Key Decisions、决策记录 |
| Complexity Assessment | 7/12 | 58% | Complexity Assessment |
| Open Questions / 待确认 | 5/12 | 42% | Open Questions、待 plan 阶段确认 |
| Architecture / 架构约束 | 4/12 | 33% | 架构约束、Architecture |
| DEFERRED 清单 | 3/12 | 25% | DEFERRED 清单 |
| Sub-documents 引用 | 3/12 | 25% | Sub-documents |
| Non-functional Requirements | 3/12 | 25% | Non-functional Requirements |
| Spec Coverage Matrix | 2/12 | 17% | Spec Coverage Matrix |
| Migration Strategy | 1/12 | 8% | Migration Strategy |
| Responsive Strategy | 1/12 | 8% | Responsive Strategy |
| Relationship to Existing Features | 1/12 | 8% | Relationship to Existing Features |

### 1.2 核心章节结构（必选）

```
# 标题
> 一句话摘要

## Background（必选，100%）
  现状描述、问题定义、设计目标

## Functional Requirements（必选，100%）
  FR-1: 功能名
    - 具体要求（表格/列表/代码块）
    - 边界条件
  FR-2: ...
  FR-N: ...

## Acceptance Criteria（必选，100%）
  AC-1: 条件 → 预期结果
  AC-2: ...
  表格形式：# | 条件 | 验证方式

## Constraints（必选，100%）
  - 技术约束（语言/框架/API）
  - 范围约束（不做什么）
  - 兼容性约束
```

### 1.3 可选章节（按需）

```
## 业务用例（83%，建议默认包含）
  UC-1: Actor → 场景 → 预期结果
  UC-2: ...

## Out of Scope（83%，建议默认包含）
  明确列出不做的事

## 决策记录（67%，有设计权衡时包含）
  | ID | 决策 | 理由 |

## Complexity Assessment（58%，中大型需求包含）
  改动文件数、复杂度等级、风险点

## Open Questions（42%，有未决事项时包含）
  [AMBIGUOUS] 问题描述 + 选项

## 架构约束（33%，涉及架构变更时包含）
  分层规则、依赖铁律

## DEFERRED 清单（25%，大型需求包含）
  推迟到后续阶段的功能项

## Sub-documents（25%，有子文档时包含）
  引用的外部设计文档
```

### 1.4 字段结构证据

**FR 结构（典型）**：
```markdown
### FR-1: 功能名
| ID | 要求 |
|----|------|
| FR-1.1 | 具体要求 1 |
| FR-1.2 | 具体要求 2 |
```
来源：plan-mode/spec.md FR-1~FR-10

**AC 结构（典型）**：
```markdown
| # | 条件 | 验证方式 |
|---|------|---------|
| AC1 | Mode Switcher 三种模式可通过 popover 切换 | 手动测试 |
| AC2 | ... | ... |
```
来源：chat-send-mode-design/spec.md

**决策记录结构（典型）**：
```markdown
| ID | 决策 | 理由 |
|----|------|------|
| D-1 | 破坏性变更选方案 C | 用户明确：AI 可发起调用 |
| D-2 | tool 收口为 2 个 | 单入口 schema 膨胀 |
```
来源：workflow-refactor/spec.md

### 1.5 spec.md 内容分类

| 内容类型 | 占比 | 说明 |
|---------|------|------|
| **结构化数据** | ~40% | FR 表格、AC 表格、决策表、UC 结构化 |
| **自由文本** | ~60% | Background、Constraints、Complexity 描述 |

---

## 任务 2：plan.md 内容模式

### 2.1 章节频率统计

| 章节 | 出现次数 | 频率 | 典型标题 |
|------|---------|------|---------|
| Goal / 目标 | 12/12 | 100% | Goal、目标 |
| Task List / 任务列表 | 12/12 | 100% | Task List、任务列表 |
| File Structure / 文件结构 | 10/12 | 83% | File Structure |
| Architecture / 架构说明 | 10/12 | 83% | Architecture |
| Tech Stack | 9/12 | 75% | Tech Stack |
| Dependency Graph / 依赖图 | 8/12 | 67% | Dependency Graph、依赖图 |
| Execution Groups / 执行组 | 7/12 | 58% | Execution Groups |
| Interface Contracts / 接口契约 | 6/12 | 50% | Interface Contracts |
| Spec Coverage Matrix | 6/12 | 50% | Spec Coverage Matrix |
| Sub-documents | 5/12 | 42% | Sub-documents |
| Commit 策略 | 4/12 | 33% | Commit 策略 |
| Wave Schedule | 3/12 | 25% | Wave Schedule |
| Migration Strategy | 2/12 | 17% | Migration Strategy |
| AMBIGUOUS Resolution | 2/12 | 17% | AMBIGUOUS Resolution |
| ADR 评估 | 1/12 | 8% | ADR 评估 |

### 2.2 核心章节结构

```
# Plan: 标题

## Goal（必选，100%）
  一句话描述要做什么

## Architecture（必选，83%）
  架构方案、分层说明

## Tech Stack（必选，75%）
  技术栈列表

## File Structure（必选，83%）
  | File | Type | Group | Description |
  文件类型：create / modify / delete

## Task List（必选，100%）
  | # | Task | Type | Depends on | Group |
  每个 Task 包含：
    - 文件列表
    - 具体步骤（checkbox 格式）
    - 验证方式

## Dependency Graph（建议，67%）
  Wave 进度表 + 执行顺序

## Execution Groups（建议，58%）
  分组描述 + Subagent 配置 + 执行流程

## Interface Contracts（建议，50%）
  Module → Method → Signature → Returns → Edge Cases

## Spec Coverage Matrix（建议，50%）
  | Spec AC | Interface Method | Data Flow | Task |
```

### 2.3 Task 卡片结构（典型）

```markdown
### T1: 任务名
**文件**: `path/to/file.ts`
**改动**:
1. 具体改动 1
2. 具体改动 2

**验证**: `grep xxx path/` 有输出
```
来源：agent-run-block-refactor/plan.md

或更详细：
```markdown
### Task 1: 任务名
**Type:** frontend / backend / shared
**Files:**
- Create: `path/to/file.ts`
- Modify: `path/to/other.ts`

**Description:** 任务描述

- [ ] **Step 1: 子步骤名**
  具体实现描述

- [ ] **Step 2: 子步骤名**
  具体实现描述

- [ ] **Commit**
  git commit message
```
来源：global-nav-stack/plan.md

### 2.4 plan.md 内容分类

| 内容类型 | 占比 | 说明 |
|---------|------|------|
| **结构化数据** | ~60% | Task 表格、File Structure 表格、Dependency Graph、Interface Contracts |
| **自由文本** | ~40% | Goal、Architecture 描述、Task 步骤描述 |

---

## 任务 3：non-functional-design.md 内容模式

### 3.1 章节频率统计

| 章节 | 出现次数 | 频率 |
|------|---------|------|
| 稳定性 | 12/12 | 100% |
| 数据一致性 | 12/12 | 100% |
| 性能 | 12/12 | 100% |
| 业务安全 | 12/12 | 100% |
| 数据安全 | 12/12 | 100% |

**额外章节（少数 topic）**：
- 可扩展性（plan-mode，1/12）
- 可观测性（plan-mode，1/12）
- 兼容性（plan-mode，1/12）
- 资源管理（plan-mode，1/12）
- 跨 Extension 契约稳定性（plan-mode，1/12）

### 3.2 固定五维度结构

```markdown
# Non-Functional Design — 标题

## 1. 稳定性
  改动影响范围、风险点、缓解方案

## 2. 数据一致性
  存储方案、并发控制、YAML 字段安全性

## 3. 性能
  时间复杂度、空间复杂度、瓶颈分析

## 4. 业务安全
  权限控制、AI 行为指令、敏感操作

## 5. 数据安全
  敏感信息处理、文件权限、网络传输
```

### 3.3 典型内容证据

**稳定性（典型）**：
```markdown
改动集中在渲染层（message-layout.ts + 新组件），不触及数据层。
风险点：MergeBlock streaming 的 setInterval 计时器必须在组件卸载时清理。
通过 Vue 的 `onUnmounted` 钩子清理即可。
```
来源：agent-run-block-refactor/non-functional-design.md

**性能（典型）**：
```markdown
分组逻辑 `groupByContentBlocks` 对每个 contentBlock 做 O(1) 查找。
50+ contentBlocks 的极端场景：分组遍历 O(50)，渲染 O(50) 个组件。
```
来源：agent-run-block-refactor/non-functional-design.md

**不适用标注（典型）**：
```markdown
## 4. 业务安全
不适用。本次改动不涉及权限控制或敏感数据处理。
```
来源：agent-run-block-refactor/non-functional-design.md

### 3.4 non-functional-design.md 内容分类

| 内容类型 | 占比 | 说明 |
|---------|------|------|
| **结构化数据** | ~20% | 五维度固定框架 |
| **自由文本** | ~80% | 每个维度的具体分析 |

---

## 任务 4：test_cases_template.json + e2e-test-plan.md 模式

### 4.1 e2e-test-plan.md 章节频率

| 章节 | 出现次数 | 频率 |
|------|---------|------|
| Test Scenarios / 测试场景 | 12/12 | 100% |
| Test Environment | 10/12 | 83% |
| 覆盖 AC 映射 | 6/12 | 50% |
| Automation vs Manual Split | 2/12 | 17% |
| Test Data Fixtures | 2/12 | 17% |
| 分层测试策略 | 1/12 | 8% |

### 4.2 Test Scenario 结构（典型）

```markdown
### TS-1 / E2E-1 / Scenario 1: 场景名
**覆盖 AC:** AC-1, AC-2
**步骤:**
1. 步骤 1
2. 步骤 2
3. ...

**预期:**
- 预期结果 1
- 预期结果 2
```
来源：所有 e2e-test-plan.md

或更简洁：
```markdown
### Scenario 1: 场景名 (AC1)
1. 步骤 1
2. 步骤 2
```
来源：global-nav-stack/e2e-test-plan.md

### 4.3 test_cases_template.json 结构

所有 topic 的 test_cases_template.json 都是 JSON 数组，每个元素包含：

```json
{
  "id": "TC-1",
  "name": "测试用例名",
  "type": "unit | integration | manual",
  "spec_ref": "AC-1",
  "preconditions": "前置条件",
  "steps": ["步骤1", "步骤2"],
  "expected": "预期结果",
  "status": "pending | passed | failed"
}
```

典型证据：
- agent-run-block-refactor/test_cases_template.json：8 个用例，3 种 type
- chat-send-mode-design/test_cases_template.json：12 个用例
- workflow-refactor/test_cases_template.json：23 个用例（unit/integration/manual）

### 4.4 测试分层模式

| 层 | 工具 | 覆盖 |
|----|------|------|
| Unit | vitest | 纯逻辑、store computed、工具函数 |
| Integration | vitest + test-utils | 组件渲染、API 契约 |
| E2E | 手动 / Playwright | UI 交互、端到端流程 |
| Visual | 人工对照 | 像素级验收 |

来源：frontend-rebuild/e2e-test-plan.md §1

### 4.5 内容分类

| 内容类型 | 占比 | 说明 |
|---------|------|------|
| **结构化数据** | ~70% | 测试场景表格、用例 JSON、AC 映射 |
| **自由文本** | ~30% | 环境描述、策略说明 |

---

## 任务 5：use-cases.md 模式

### 5.1 UC 结构（100% 一致）

```markdown
## UC-1: 用例名

- **Actor**: 角色
- **Preconditions**: 前置条件
- **Main Flow**:
  1. 步骤 1
  2. 步骤 2
  3. ...
- **Alternative Paths**:
  - A1: 替代路径 1
  - A2: 替代路径 2
- **Exception Paths**:
  - E1: 异常路径 1
- **Postconditions**: 后置条件
- **Module Boundaries**: 涉及的模块
- **AC 覆盖:** AC-1, AC-2
```

### 5.2 UC 数量统计

| Topic | UC 数量 |
|-------|--------|
| frontend-rebuild | 3 |
| agent-run-block-refactor | 4 |
| chat-send-mode-design | 5 |
| chat-area-round1 | 8 |
| global-nav-stack | 3 |
| workflow-refactor | 3 |
| use-skill-tracker | 3 |
| plan-mode | 4 |
| todo-loop-improvements | 4 |
| peekhour-model-switch | 6 |
| skill-state-tracker | 2 |
| modality-overflow-failover-filtering | 2 |

**平均**: 3.8 个 UC/topic

### 5.3 UC 覆盖映射表（83% 的 topic 包含）

```markdown
## 覆盖映射表
| UC | AC-1 | AC-2 | AC-3 | ... |
|----|------|------|------|-----|
| UC-1 | ✅ | — | ✅ | ... |
| UC-2 | — | ✅ | ✅ | ... |
```

### 5.4 use-cases.md 内容分类

| 内容类型 | 占比 | 说明 |
|---------|------|------|
| **结构化数据** | ~80% | UC 结构（Actor/Main Flow/Postconditions）、覆盖映射表 |
| **自由文本** | ~20% | 步骤描述、替代路径描述 |

---

## 任务 6：推荐 4 层 Spec 内容设计

### 6.1 设计原则

基于调研证据：

1. **结构化优先**：FR、AC、UC、Task 都是结构化数据，适合机器解析
2. **自由文本兜底**：Background、Architecture、Constraints 需要自由文本
3. **层次递进**：spec（做什么）→ plan（怎么做）→ test（验什么）→ nfr（非功能约束）
4. **向后兼容**：保留现有文件名，扩展字段结构

### 6.2 推荐的 4 层 Clarification.Spec 结构

```typescript
// 每层的 clarification.spec 子字段
interface LayerSpec {
  // 第 1 层：需求层（spec.md 对应）
  requirements: {
    background: string           // 自由文本：现状、问题、目标
    functional: FunctionalReq[]  // 结构化：FR 列表
    acceptance: AcceptanceCriteria[]  // 结构化：AC 列表
    useCases: UseCase[]          // 结构化：UC 列表
    outOfScope: string[]         // 结构化：范围外列表
    decisions: Decision[]        // 结构化：决策记录
    constraints: string[]        // 结构化：约束列表
    deferred: DeferredItem[]     // 结构化：推迟项
    openQuestions: OpenQuestion[] // 结构化：待确认项
  }

  // 第 2 层：计划层（plan.md 对应）
  plan: {
    goal: string                 // 自由文本：一句话目标
    architecture: string         // 自由文本：架构方案
    techStack: string[]          // 结构化：技术栈
    files: FileChange[]          // 结构化：文件变更列表
    tasks: Task[]                // 结构化：任务列表
    dependencyGraph: Wave[]      // 结构化：依赖图 + Wave 调度
    interfaceContracts: Contract[] // 结构化：接口契约
    executionGroups: ExecGroup[] // 结构化：执行组
  }

  // 第 3 层：测试层（e2e-test-plan.md + test_cases_template.json 对应）
  testing: {
    scenarios: TestScenario[]    // 结构化：测试场景
    testCases: TestCase[]        // 结构化：测试用例（JSON 格式）
    environment: TestEnvironment // 结构化：测试环境
    coverageMap: CoverageMap     // 结构化：AC 覆盖映射
  }

  // 第 4 层：非功能层（non-functional-design.md 对应）
  nonFunctional: {
    stability: NFRDimension      // 自由文本 + 风险列表
    dataConsistency: NFRDimension // 自由文本 + 一致性策略
    performance: NFRDimension    // 自由文本 + 复杂度分析
    businessSecurity: NFRDimension // 自由文本 + 安全策略
    dataSecurity: NFRDimension   // 自由文本 + 数据保护
  }
}
```

### 6.3 每层详细字段定义

#### 第 1 层：需求层（Requirements Layer）

**装什么**：背景、功能需求、验收标准、业务用例、范围边界、设计决策

```typescript
interface FunctionalReq {
  id: string              // "FR-1"
  title: string           // 功能名
  description: string     // 详细描述
  subRequirements?: SubReq[] // 子需求（FR-1.1, FR-1.2）
  type: 'table' | 'list' | 'code' // 内容类型
}

interface SubReq {
  id: string              // "FR-1.1"
  description: string
}

interface AcceptanceCriteria {
  id: string              // "AC-1"
  condition: string       // 验收条件
  verification: string    // 验证方式
  specRef?: string        // 引用的 spec 章节
}

interface UseCase {
  id: string              // "UC-1"
  title: string
  actor: string
  preconditions: string[]
  mainFlow: string[]
  alternativePaths?: string[]
  exceptionPaths?: string[]
  postconditions: string
  moduleBoundaries: string
  coveredACs: string[]    // ["AC-1", "AC-2"]
}

interface Decision {
  id: string              // "D-1"
  decision: string
  rationale: string
  type: 'long-term' | 'short-term' // 方案性质
}

interface DeferredItem {
  id: string              // "G-013"
  feature: string
  triggerCondition: string // 何时做
  source: string          // gap 来源
}

interface OpenQuestion {
  id: string              // "OQ1"
  question: string
  options: string[]
  recommendation?: string
  status: 'open' | 'resolved'
}
```

**证据来源**：
- FR 表格：plan-mode/spec.md（10 个 FR，每个有 ID 表格）
- AC 表格：chat-send-mode-design/spec.md（12 个 AC，表格形式）
- UC 结构：所有 use-cases.md（Actor/Main Flow/Postconditions）
- 决策表：workflow-refactor/spec.md（13 个 D-1~D-13）
- DEFERRED：frontend-rebuild/spec.md §9（27 个推迟项）

#### 第 2 层：计划层（Plan Layer）

**装什么**：目标、架构方案、文件变更、任务拆分、依赖关系、接口契约

```typescript
interface FileChange {
  path: string
  type: 'create' | 'modify' | 'delete'
  group?: string          // 执行组
  description?: string
}

interface Task {
  id: string              // "T1" 或 "Task 1"
  title: string
  type: 'frontend' | 'backend' | 'shared'
  files: FileChange[]
  dependsOn: string[]     // 依赖的 task ID
  group?: string          // 执行组
  steps: TaskStep[]       // 实现步骤
  verification?: string   // 验证方式
  commitMessage?: string
}

interface TaskStep {
  order: number
  description: string
  isCheckbox: boolean     // 是否用 checkbox 格式
}

interface Wave {
  id: number
  groups: string[]        // 执行组名
  description: string
}

interface Contract {
  module: string
  method: string
  signature: string
  returns: string
  edgeCases: string[]
  specRef?: string
}

interface ExecGroup {
  id: string              // "FG1"
  description: string
  tasks: string[]         // task ID 列表
  estimatedFiles: number
  subagentConfig?: {
    agent: string
    model?: string
    injectedContext: string[]
  }
  dependencies: string[]  // 依赖的 group ID
}
```

**证据来源**：
- File Structure：所有 plan.md（100% 包含）
- Task List：所有 plan.md（100% 包含）
- Dependency Graph：8/12 plan.md（67%）
- Interface Contracts：6/12 plan.md（50%）
- Execution Groups：7/12 plan.md（58%）

#### 第 3 层：测试层（Testing Layer）

**装什么**：测试场景、测试用例、测试环境、覆盖映射

```typescript
interface TestScenario {
  id: string              // "TS-1" 或 "E2E-1"
  title: string
  coveredACs: string[]    // ["AC-1", "AC-2"]
  steps: string[]
  expected: string[]
  type: 'automated' | 'manual' | 'mixed'
}

interface TestCase {
  id: string              // "TC-1"
  name: string
  type: 'unit' | 'integration' | 'manual'
  specRef: string         // "AC-1"
  preconditions: string
  steps: string[]
  expected: string
  status: 'pending' | 'passed' | 'failed'
}

interface TestEnvironment {
  framework: string       // "vitest"
  tools: string[]         // ["@vue/test-utils"]
  runtime: string         // "npm run dev"
  mockStrategy: string    // "VITE_MOCK=true"
}

interface CoverageMap {
  [acId: string]: {
    scenarios: string[]   // 覆盖该 AC 的场景 ID
    testCases: string[]   // 覆盖该 AC 的用例 ID
  }
}
```

**证据来源**：
- Test Scenario：所有 e2e-test-plan.md（100%）
- Test Cases JSON：所有 test_cases_template.json（100%）
- Coverage Map：6/12 e2e-test-plan.md（50%）

#### 第 4 层：非功能层（Non-Functional Layer）

**装什么**：稳定性、数据一致性、性能、业务安全、数据安全

```typescript
interface NFRDimension {
  applicable: boolean     // 是否适用
  analysis: string        // 自由文本分析
  risks: Risk[]           // 风险列表
  mitigations: string[]   // 缓解措施
}

interface Risk {
  description: string
  severity: 'low' | 'medium' | 'high'
  mitigation: string
}
```

**证据来源**：
- 五维度固定框架：所有 non-functional-design.md（100%）
- 不适用标注：agent-run-block-refactor/non-functional-design.md（"不适用"）

### 6.4 结构化 vs 自由文本 比例

| 层 | 结构化数据 | 自由文本 | 说明 |
|----|----------|---------|------|
| 需求层 | ~40% | ~60% | Background/Constraints 是自由文本 |
| 计划层 | ~60% | ~40% | Task/Files 是结构化，Architecture 是自由文本 |
| 测试层 | ~70% | ~30% | Scenario/TestCase 是结构化，环境描述是自由文本 |
| 非功能层 | ~20% | ~80% | 五维度框架是结构化，分析内容是自由文本 |

### 6.5 推荐的 CW 1.0 实现方案

```typescript
// WorkUnit.clarification.spec 的 4 层结构
interface ClarificationSpec {
  requirements: RequirementSpec  // 第 1 层
  plan: PlanSpec                // 第 2 层
  testing: TestingSpec          // 第 3 层
  nonFunctional: NonFunctionalSpec // 第 4 层
}

// 每层都是可选的，按阶段填充
// create → requirements 填充
// plan → plan 填充
// tdd_plan → testing 填充
// review → nonFunctional 填充
```

### 6.6 保留类型化 vs 自由文本的决策

| 内容 | 推荐 | 理由 |
|------|------|------|
| FR/AC/UC/Task/TestCase | **类型化（结构化数组）** | 机器解析、覆盖追踪、自动化生成 |
| Background/Architecture/NFR 分析 | **自由文本（string）** | 需要叙述性表达，不适合结构化 |
| Decision/OpenQuestion | **类型化（结构化数组）** | 决策有 ID、理由，可追踪 |
| FileChange/Wave/Contract | **类型化（结构化数组）** | 工具链消费（依赖图生成、覆盖率计算） |
| DEFERRED | **类型化（结构化数组）** | 需要追踪状态和触发条件 |

---

## 总结

### 核心发现

1. **spec.md 是需求层的完整表达**：Background + FR + AC + UC + Constraints + Decisions
2. **plan.md 是计划层的完整表达**：Goal + Architecture + Files + Tasks + Dependencies + Contracts
3. **non-functional-design.md 是非功能层的完整表达**：五维度固定框架
4. **e2e-test-plan.md + test_cases_template.json 是测试层的完整表达**：Scenarios + TestCases + Environment

### 4 层 Spec 内容设计

| 层 | 对应文件 | 核心内容 | 结构化比例 |
|----|---------|---------|----------|
| 需求层 | spec.md | FR + AC + UC + Decisions + Constraints | 40% |
| 计划层 | plan.md | Tasks + Files + Dependencies + Contracts | 60% |
| 测试层 | e2e-test-plan.md + test_cases_template.json | Scenarios + TestCases + CoverageMap | 70% |
| 非功能层 | non-functional-design.md | 五维度分析（稳定性/一致性/性能/安全/数据安全） | 20% |

### CW 1.0 适配建议

每层的 `clarification.spec` 子字段按上述结构定义，支持：
- **阶段化填充**：create 填需求层，plan 填计划层，tdd_plan 填测试层，review 填非功能层
- **机器解析**：结构化字段支持自动化（覆盖率计算、依赖图生成、AC 追踪）
- **人类可读**：自由文本字段支持叙述性表达
- **向后兼容**：保留现有文件名，扩展字段结构
