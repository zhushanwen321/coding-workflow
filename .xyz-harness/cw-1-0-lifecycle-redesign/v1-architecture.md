# cw 1.0 v5 · src/v1/ 实现架构

> **定位**：v5 设计文档（design-v5-model/epic/feature/slice/wave）的实现架构。
> 从 v5 领域模型直写，不参考 `src/engine/`（v3/v4 时期的通用引擎原型）。
> 自底向上实现：wave → slice → feature → epic，每层一个或多个 topic。

---

## 0. 设计原则

### 0.1 领域模型直写，不抽泛型引擎

v5 给的是**领域模型**（WorkUnit/PlanningUnit/ExecutionUnit 是实体，状态机是规则）。
架构直接映射领域模型，不先抽一层 `UnitStateMachine<S,A,P>` 泛型再用配置适配。

理由：v5 的两类 WorkUnit 差异是本质的（7步 vs 9步、有无 test/exec-review、execute 语义不同）。
强行用泛型抹平会丢失类型表达力，且 v5 的 replan bypass（不改 status）和 wave 的 plan 特化
（from 含 design-reviewed）让"通用"反而更复杂。

### 0.2 数据与规则分离

- `core/` = 领域模型（WorkUnit 及其产物的**类型 + 工厂 + 不变量**）
- `rules/` = 领域规则（状态转换 / gate 校验 / freeze / replan 影响面计算的**纯函数**）

core 零依赖，可被任何层引用；rules 依赖 core，但无副作用。

### 0.3 副作用集中在 store + handlers

- `store/` 是唯一做 IO 的层（文件读写 + 原子写）
- `handlers/` 编排 rules + store（每个 action 一个 handler）
- `rules/` 全是纯函数，可密集单元测试

---

## 1. 目录结构

```
src/v1/
├── core/                        # 领域模型（纯类型 + 工厂，零依赖）
│   ├── workunit.ts              # WorkUnit/PlanningUnit/ExecutionUnit + createWorkUnit 工厂
│   ├── plan.ts                  # Plan/Split/WorkUnitItem + 条目基类
│   ├── evidence.ts              # Evidence/WaveEvidence/PlanningEvidence + 不变量
│   ├── judgments.ts             # DesignReviewJudgment/TestJudgment/ExecReviewJudgment + RetrospectData
│   ├── clarifications.ts        # Clarification/Decision/FeatureClarification/FeatureSpec(FR/AC/UC)
│   └── status.ts                # PlanningStatus/ExecutionStatus + StatusChange/AbandonedRef
│
├── rules/                       # 领域规则（纯函数，零 IO）
│   ├── state-machine.ts         # WAVE_TRANSITIONS/PLANNING_TRANSITIONS + guard + computeNextStatus
│   ├── freeze.ts                # append-only 校验（committed wave / passed case 不可改）
│   ├── replan.ts                # 影响面计算 + 级联 abort 清单（纯函数）
│   └── gates/                   # 各步 gate（纯函数，验产物完整性）
│       ├── design-review.ts     # test-cases-non-empty / necessity-non-empty / tradeoffs-present...
│       ├── test.ts              # commit-exists / tests-all-pass / test-references-design-review
│       ├── exec-review.ts       # readability-non-empty / followup-actions-when-needed...
│       └── retrospect.ts        # lessons-learned-non-empty / retrospect-covers-judgments
│
├── store/                       # 持久化（唯一 IO 层）
│   ├── v1-store.ts              # JSON 文件读写 + 原子写 + lockfile
│   └── schema.ts                # _v1.json schema（扁平集合 + parentUnitId 外键）
│
├── handlers/                    # action 编排（串起 rules + store）
│   ├── create.ts                # createWorkUnit + 初始化客观字段
│   ├── clarify.ts               # progressive append clarifications
│   ├── plan.ts                  # 写 plan 条目（WavePlan/SlicePlan...）
│   ├── design-review.ts         # 跑 gates + 写 designReviewJudgment
│   ├── execute.ts               # wave: 验 commit + 填 evidence 客观；planning: 启动下层
│   ├── test.ts                  # 跑测试 + 填 testRunResult + 写 testJudgment
│   ├── exec-review.ts           # 写 execReviewJudgment
│   ├── retrospect.ts            # 写 retrospectData
│   ├── closeout.ts              # 补 evidence 主观 + drift 检查 + 冻结
│   ├── replan.ts                # 编排 rules/replan 级联 abort + 返回影响面
│   └── abort.ts                 # 级联 abort 子孙 + append abandonedRefs
│
├── dispatch.ts                  # 统一入口（guard → handler 路由 → ActionResult）
├── types.ts                     # v1 对外类型（re-export core + handler params/results）
└── index.ts                     # 包入口
```

---

## 2. core/ 领域模型

### 2.1 status.ts — 状态 + 变更记录

来源：model §3.1/§3.2（状态枚举）、§4.4（StatusChange）、§5.6.1（AbandonedRef）。

```typescript
// model §3.1 — PlanningUnit 8 状态
export type PlanningStatus =
  | "created" | "clarifying" | "planning" | "design-reviewed"
  | "executing" | "retrospected" | "closed" | "aborted";

// model §3.2 — ExecutionUnit 10 状态
export type ExecutionStatus =
  | "created" | "clarifying" | "planning" | "design-reviewed"
  | "executing" | "tested" | "exec-reviewed" | "retrospected" | "closed" | "aborted";

// model §4.4 — statusHistory 元素（append-only）
export interface StatusChange {
  from?: PlanningStatus | ExecutionStatus;
  to: PlanningStatus | ExecutionStatus;
  at: string;          // ISO 8601
  action: string;
  note?: string;       // replan 原因 / abort 原因
}

// model §5.6.1 — 被上游废弃的引用记录（纯历史，不阻塞流程）
export interface AbandonedRef {
  workUnitItemId: string;
  abandonedAt: string;
}
```

### 2.2 workunit.ts — WorkUnit 实体 + 工厂

来源：model §1.4（顶层接口）、§5.3（通用字段）、§2.5（ExecuteResult）。

```typescript
// model §1.4 — 所有 WorkUnit 共享字段
interface WorkUnitBase {
  id: string;                    // "{scope}:{slug}"
  scope: "epic" | "feature" | "slice" | "wave";
  slug: string;
  parentUnitId?: string;
  status: PlanningStatus | ExecutionStatus;
  statusHistory: StatusChange[];
  basedOnParent: string[];       // 引用父层条目 id，append-only
  abandonedRefs: AbandonedRef[];
  objective: string;
}

// model §1.4 — PlanningUnit（epic/feature/slice）
interface PlanningUnit extends WorkUnitBase {
  scope: "epic" | "feature" | "slice";
  status: PlanningStatus;
  clarifications: Clarification[] | FeatureClarification;
  plan: Plan;                    // Plan 基类或 SlicePlan
  designReviewJudgment: DesignReviewJudgment;
  executeResult: PlanningExecuteResult;   // { childUnitIds }
  retrospectData: PlanningRetrospectData;
  evidence: PlanningEvidence;
}

// model §1.4 — ExecutionUnit（wave）
interface ExecutionUnit extends WorkUnitBase {
  scope: "wave";
  status: ExecutionStatus;
  clarifications: Clarification[];
  plan: WavePlan;
  designReviewJudgment: DesignReviewJudgment;
  executeResult: ExecutionExecuteResult;  // { commitHash }
  testJudgment: TestJudgment;
  execReviewJudgment: ExecReviewJudgment;
  retrospectData: RetrospectData;
  evidence: WaveEvidence;
}

// 工厂函数 — 初始化通用字段 + statusHistory 首条
export function createWave(args: {
  slug: string;
  objective: string;
  parentUnitId: string;
  basedOnParent: string[];
  createdAt?: string;
}): ExecutionUnit;

export function createPlanning(args: {
  scope: "epic" | "feature" | "slice";
  slug: string;
  objective: string;
  parentUnitId?: string;
  basedOnParent: string[];
  createdAt?: string;
}): PlanningUnit;
```

**三个判别字段**（model §1.4）：`executeResult` 子类型、有无 `testJudgment`、有无 `execReviewJudgment`。

### 2.3 其余 core 模块

| 模块 | 核心类型 | 来源 |
|---|---|---|
| `plan.ts` | `Plan` / `Split` / `WorkUnitItem`（id+status）/ `WavePlan`(+4字段) / `SlicePlan`(+5字段) | model §4.1/§4.2/§4.3 |
| `evidence.ts` | `Evidence`(基类) / `WaveEvidence`(+commitHash/changedFiles/testRunResult) / `PlanningEvidence`(+childDelivery) / `TestRunResult` / `ArtifactRef` | model §5.11 |
| `judgments.ts` | `DesignReviewJudgment` / `TestJudgment` / `ExecReviewJudgment`(+layerSpecific) / `RetrospectData` / `PlanningRetrospectData` / `FollowupAction` | model §5.8 + wave §3/§5/§6 |
| `clarifications.ts` | `Clarification`(extends WorkUnitItem) / `Decision` / `FeatureClarification` / `FeatureSpec`(FR/AC/UC) | model §5.9/§5.10/§6 |

**evidence 不变量**（core 层定义，handlers 层强制）：`frozenAt` 非空后，整个 evidence 对象不可再改。

---

## 3. rules/ 领域规则（纯函数）

### 3.1 state-machine.ts — 状态转换

直写两份 transitions 表（wave / planning），不泛型化。

```typescript
// wave 附录 A line 1171-1197 原样落地
export const WAVE_TRANSITIONS = {
  create:          { from: [], to: "created" },
  clarify:         { from: ["created","clarifying"], to: "clarifying", progressive: true },
  plan:            { from: ["clarifying","planning","design-reviewed"], to: "planning", progressive: true },
  "design-review": { from: ["planning","design-reviewed"], to: "design-reviewed", progressive: true },
  execute:         { from: ["design-reviewed"], to: "executing" },
  test:            { from: ["executing"], to: "tested" },
  "exec-review":   { from: ["tested"], to: "exec-reviewed" },
  retrospect:      { from: ["exec-reviewed"], to: "retrospected" },
  closeout:        { from: ["retrospected"], to: "closed" },
  abort:           { from: [/* 8 非终态 */], to: "aborted" },
  // replan: 旁路，不改 status，append statusHistory(from=to)
  replan:          { from: ["design-reviewed","executing","tested","exec-reviewed","retrospected"], to: undefined, progressive: true },
} as const;

// model §3.1
export const PLANNING_TRANSITIONS = { ... } as const;

// guard — 接收具体 status 类型，不是泛型
export function guardWave(action: WaveAction, status: ExecutionStatus | undefined): GuardVerdict;
export function guardPlanning(action: PlanningAction, status: PlanningStatus | undefined): GuardVerdict;

// computeNextStatus — progressive 语义 + replan bypass（to=undefined 时原地）
export function nextWaveStatus(action: WaveAction, current: ExecutionStatus): ExecutionStatus;
export function nextPlanningStatus(action: PlanningAction, current: PlanningStatus): PlanningStatus;
```

**replan bypass 处理**：`to: undefined` 时 `nextWaveStatus` 返回 current（不改 status），但调用方（handler）仍 append 一条 StatusChange（from=to=current, action="replan"）。

### 3.2 gates/ — 各步 gate 纯函数

来源：wave 附录 A line 1227-1271（gate 清单）。每个 gate 是 `(unit) => { passed: boolean; report: string }`。

```typescript
// rules/gates/test.ts
export function commitExists(unit: ExecutionUnit): GateResult;       // git cat-file -e commitHash
export function testsAllPass(unit: ExecutionUnit): GateResult;       // 跑测试套件，fail 数=0
export function testReferencesDesignReview(unit: ExecutionUnit): GateResult; // tradeoffRef/riskRef 覆盖
```

**gate 不做 IO**——`commitExists`/`testsAllPass` 需要 git/测试运行器的结果作为**输入参数**传入，gate 函数本身只判断。IO 由 handler 负责获取后注入。

### 3.3 freeze.ts — append-only 校验

来源：0.x 的 `validateAppendOnly` 语义（committed wave 不可改、passed case 不可改），但重新实现。

```typescript
export function checkFreeze(before: WorkUnit, after: WorkUnit): FreezeViolation[];
// 校验：committed 后的 wave 条目（status="abandoned" 的 WorkUnitItem）不可删/改核心字段
```

### 3.4 replan.ts — 影响面计算

来源：model §5.6.2 Step 2-3。纯函数，输入 WorkUnit 树 + 废弃条目，输出影响面。

```typescript
export function computeImpact(
  tree: WorkUnit[],           // 所有相关 WorkUnit（含子孙）
  abandonedIds: string[],     // 本次废弃的条目 id
): {
  aborted: string[];          // 受影响子孙 unit id（basedOnParent 命中废弃 id）
  preserved: string[];        // 未受影响
  pendingRebuild: string[];   // 失去承接的条目（提示 agent 重建）
};
```

---

## 4. store/ 持久化

### 4.1 存储格式

`~/.v1/<encoded-cwd>/_v1.json`（与 0.x 的 `~/.cw/` 隔离）。扁平集合 + parentUnitId 外键：

```typescript
interface V1JsonFile {
  workUnits: WorkUnitRecord[];   // 扁平，按 parentUnitId 外键关联
  // 不嵌套子对象——WorkUnit 的 childUnitIds 是 executeResult 里的 id 字符串数组
}
```

### 4.2 原子写

复用 0.x store.ts 的 POSIX 模式（独立实现，不 import 0.x）：
- `tmp + fsync + rename + fsync dir`（原子写）
- `lockfile(O_EXCL) + stale 检测`（跨进程锁）
- 内存深拷贝 + snapshot 回滚（事务）

---

## 5. handlers/ 编排层

每个 action 一个 handler，串起 `guard → gates → freeze → status 流转 → 写产物 → save`。

```typescript
// handlers/test.ts 示例
export function handleTest(unit: ExecutionUnit, input: TestInput, deps: V1Deps): ActionResult {
  // 1. guard（已在 dispatch 层做，handler 不重复）
  // 2. 跑测试（IO，deps 注入测试运行器）
  const testResult = deps.testRunner.run(unit);
  // 3. gate（注入结果）
  const gates = [commitExists(unit), testsAllPass(unit, testResult), testReferencesDesignReview(unit)];
  const failed = gates.filter(g => !g.passed);
  if (failed.length) return gateFailResult(failed);
  // 4. status 流转 + 写产物
  const next = nextWaveStatus("test", unit.status);
  unit.testJudgment = input.testJudgment;
  unit.evidence.testRunResult = testResult;   // evidence 跨阶段续写
  unit.statusHistory.push({ from: unit.status, to: next, ... });
  // 5. save
  deps.store.save(unit);
  return successResult(unit);
}
```

---

## 6. dispatch.ts 统一入口

```typescript
export function dispatch(params: V1Params, deps: V1Deps): ActionResult {
  // create 不 loadTopic
  // 非 create：load → guard → handler 路由
}
```

结构与 0.x dispatch.ts 相似（load → guard → switch），但路由到 v1 handlers，用 v1 store。

---

## 7. 与 0.x 的隔离

| 维度 | 隔离方式 |
|---|---|
| 代码 | src/v1/ 不 import src/ 下任何 0.x 文件 |
| 存储 | `~/.v1/` vs `~/.cw/`，互不干扰 |
| CLI | v1 独立入口（未来接入），不改 0.x dispatch.ts |
| 测试 | `tests/v1/` 独立，不跑 0.x 测试 |
| 类型 | v1 有自己的 types.ts，不与 0.x types.ts 冲突 |

---

## 8. 实现路线（自底向上）

| 顺序 | topic | 范围 | 验证 |
|---|---|---|---|
| 1 | **wave 地基** | core 基础类型（WorkUnit/Plan/Status）+ WAVE_TRANSITIONS + guard + store + 主链测试 | create→...→closeout 跑通 + guard 拒绝跳步 |
| 2 | **wave gates + judgments** | design-review/test/exec-review/retrospect gates + judgment 类型 + 各 handler | 每步 gate 校验生效 |
| 3 | **wave evidence + freeze** | evidence 跨阶段填充 + freeze 校验 + replan bypass | evidence 生命周期 + append-only |
| 4 | **wave replan 级联** | computeImpact + 级联 abort（wave 是叶子，影响面恒空，但机制要跑通）| replan 返回正确影响面 |
| 5 | **wave CLI 接入** | dispatch + CLI 子命令 + e2e 测试 | `cw v1 ...` 命令可用 |
| 6+ | slice → feature → epic | 复用 core/rules，加各自 plan 条目 + transitions | 自底向上 |
