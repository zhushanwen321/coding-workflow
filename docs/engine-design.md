# cw 1.0 通用引擎设计文档

> **状态**：原型验证完成（11 个 smoke test 全绿），待迁移阶段
> **源会话**：2026-07-19，从 wayfinder 定位讨论演化为全产品重设计
> **源代码**：`src/engine/`（7 个文件，1252 行 + 2 个 config）
> **验证测试**：`tests/engine-smoke.test.ts`（11 个测试全绿）
> **配套设计**：`.xyz-harness/cw-1-0-lifecycle-redesign/plan.md`（产品级设计）

---

## 0. 文档目的

记录 cw 1.0 通用引擎（UnitStateMachine + ScopeConfig）的设计论证、接口契约、风险验证结论。

原型已完成，4 个核心验证标准全部通过。本文档是后续迁移工作的设计真值来源。

---

## 1. 设计起点：cw 0.x 已经是半通用化引擎

调研 cw 0.x（`src/state-machine.ts` / `src/actions.ts` / `src/shapes/` / `src/store.ts`）后发现，cw 0.x 已经走完了「配置驱动行为」的第一步：

| cw 0.x 设计 | 复用度 | 在 1.0 中的去向 |
|---|---|---|
| `TransitionRule` 声明式转换表（state-machine.ts:217-330）| ★★★ 直接平移 | `ScopeConfig.transitions` |
| `checkLinear` 单重 guard（state-machine.ts:343-368）| ★★★ 直接平移 | `UnitStateMachine.guard()` |
| `computeNextStatus` + progressive 语义（state-machine.ts:397-403）| ★★★ 直接平移 | `UnitStateMachine.computeNextStatus()` |
| `TaskShape` 注册表 + `VerificationStrategy` / `ReviewStagePolicy`（shapes/）| ★★★ 雏形 | `ScopeConfig`（扩展为完整层配置）|
| `GateHistoryEntry` 7 字段（types.ts:238-247）| ★★★ 直接平移 | `gate.ts` |
| `store.transaction` 原子模型（store.ts:453-477）| ★★★ 直接复用 | 迁移阶段接入 |
| `Violation` 抽象（shapes/types.ts:93）| ★★☆ 扩展 | `FreezeRule` + `FreezeViolation` |
| `*_TURN_LIMIT` + `GATE_RETRY_LIMIT`（state-machine.ts:40-50）| ★★★ 直接平移 | `ScopeConfig.loops` + `gateRetryLimit` |

**关键结论**：cw 0.x 的 L3 层已经是一个「半通用化的配置驱动引擎」。1.0 不是从零设计，是把 TaskShape 模式扩展成完整 ScopeConfig。

## 2. 12 机制全通用论证

源会话中通过逐个挖掘，发现 cw 0.x 散落在各层的 12 个机制**全部是通用的**，零层独有：

| # | 机制 | cw 0.x 误判 | 真实归类 |
|---|---|---|---|
| 1 | fog of war | L5 独有 | 通用（增量识别），L5 是密度高的实例 |
| 2 | claim 子系统 | L5 独有 | parallel 模式全局 mutex（跨 session 复杂实例）|
| 3 | 并发控制 | 每层不同 | mutex/isolation/sequence 三正交维度 |
| 4 | coverage gate | L4/L3 各自 | parents→children 覆盖检查 |
| 5 | evidence gate | L3 独有 | 证据锚定（git-commit / content-hash / non-empty）|
| 6 | drift 检测 | L3 独有 | 版本快照对比 |
| 7 | type dispatch | L5/L3 各自 | 类型分发（TaskShape / ticket type）|
| 8 | append-only | L3 wave 特殊 | 4 子类（event-log / versioned / frozen-at / growing-set）|
| 9 | TDD | L3 独有 | 预期-实现-验证三段式（强中弱三档）|
| 10 | commit-anchor | L3 独有 | 内容寻址证据锚（git-commit 实例）|
| 11 | immutability | 散落各层 | 通用策略（frozen-at 带 allowThaw 配置）|
| 12 | phase 顺序 | 三层独立 | 四步骨架（clarify/review/lock/split）+ 参数化 |

**结论**：所有「L5/L4/L3 独有」的判断都是错的——要么把通用机制的复杂实例当独有机制（如 claim），要么把密度差异当机制差异（如 fog），要么把配置参数当独立机制（如 unlock）。**0 个层独有机制**。

## 3. 核心架构

### 3.1 通用 Unit 抽象（`src/engine/unit.ts`）

把 topic / wave / spec / ticket 统一为 `Unit<S, P>`：

```typescript
interface Unit<S extends string, P> {
  id: string;                    // "{scope}:{slug}"
  scope: ScopeId;                // "L3-topic" | "L3-wave" | ...
  slug: string;
  status: S;
  statusHistory: StatusEvent[];  // 通用事件日志（append-only）

  // 跨层指针（解耦递归嵌套）
  parentUnitId?: string;         // wave→topic
  childUnitIds: string[];        // topic→waves
  derivedFromId?: string;        // 上游 unit

  // drift 基础设施
  parentLockVersion?: number;
  driftStatus: "clean" | "drifted" | "acknowledged";
  driftLog: DriftEvent[];

  lockVersion?: number;          // L4 spec unlock/re-lock 用
  type?: string;                 // 类型分发

  payload: P;                    // 层特定 frontmatter
  collections: Record<string, unknown[]>;  // 通用集合容器
}
```

**关键设计**：`collections: Record<string, unknown[]>` 把 cw 0.x 散落在 Topic 上的 `gateHistory` / `waves` / `testCases` / `clarifyRecords` / `reviewIssues` / `testFixLog` 等内嵌数组统一为通用容器。写入语义由 `ScopeConfig.collections[name].writeMode` 控制。

### 3.2 ScopeConfig（`src/engine/scope-config.ts`）

一层状态机的完整声明，包含状态机 + 通用机制配置：

```typescript
interface ScopeConfig<S, A, P> {
  scope: string;
  transitions: Record<A, TransitionRule<S>>;
  initStatus: S;
  terminalStatuses: ReadonlySet<S>;
  phases: { clarify?: PhaseConfig<A>; review?; lock?; split? };
  coverageGates?: CoverageGateSpec<P>[];
  evidenceGates?: EvidenceGateSpec<P>[];
  freezeRules?: FreezeRule<P>[];
  fogConfig?: FogConfig<P>;
  typeDispatch?: Map<string, SubFlowConfig>;
  driftConfig?: DriftSpec;
  loops?: Record<string, LoopConfig>;
  gateRetryLimit?: number;
  collections: Record<string, CollectionSpec>;
  actionGates?: Record<A, readonly string[]>;
}
```

### 3.3 UnitStateMachine（`src/engine/state-machine.ts`）

通用引擎，零 topic 假设：

```typescript
class UnitStateMachine<S, A, P> {
  constructor(config: ScopeConfig<S, A, P>, deps: EngineDeps) {}

  dispatch(unit, action, params, options?): DispatchResult<S, P> {
    // 1. guard（平移 cw 0.x checkLinear）
    // 2. gate runner（按 options.gateSpecs 执行）
    // 3. freeze check（如果 options.checkFreeze）
    // 4. computeNextStatus（平移 cw 0.x progressive 语义）
    // 5. applyProducts（options.productApplicator 写 collections）
  }

  guard(action, current): GuardVerdict
  computeNextStatus(action, current): S
  isTerminal(status): boolean
}
```

### 3.4 GateSpec + GateRunner（`src/engine/gate.ts`）

cw 0.x 砍掉的 GateRegistry 以新形式重建：

```typescript
interface GateSpec<P> {
  id: string;
  kind: "coverage" | "evidence" | "existence" | "schema";
  check: (unit, input, deps) => GateResult;
}

interface GateRunner {
  run(unit, action, progressive, gates, input, deps): { passed, results, entries };
}
```

### 3.5 FreezeRule（`src/engine/freeze.ts`）

替代 cw 0.x `validateAppendOnly` 的硬编码 5 种违规：

```typescript
interface FreezeRule<P> {
  id: string;
  collection: string;              // 哪个 collection 受保护
  predicate: (item, unit) => boolean;  // 元素是否受保护
  immutableFields: readonly string[];  // 受保护后不可改的字段
  violationType: string;
}

function checkFreeze<P>(oldUnit, newUnit, rules): FreezeViolation[];
```

## 4. 风险验证结论（用 smoke test 作证据）

原型 11 个测试全绿，回答了 4 个核心风险：

### 风险 1：递归嵌套是否干净？✓ 干净

**验证**：`smoke test > 递归嵌套干净` 2 个测试通过。

- wave 提升为独立 Unit 后，topic↔wave 通过 `parentUnitId` / `childUnitIds` 字符串指针解耦
- topic 持有的是 wave 的 id（`"L3-wave:{slug}"`），不是 wave 对象
- topic 要拿 wave 状态，必须通过 `store.load(waveId)`，不直接访问 wave 内部
- topic 的 status 不受 wave commit 影响（解耦验证）
- topic closeout gate 校验「所有 child wave 都是 terminal」时，通过 `store.findChildren(topicId)` 查询，不通过对象引用

**结论**：递归嵌套干净成立。后续 L4 spec / L5 effort 同样可用此模式。

### 风险 2：通用引擎能否吃下 L3？✓ 能

**验证**：`smoke test > L3 topic 主链走通` 3 个测试通过。

- cw 0.x 的 8 status + 10 action 完全用 `L3_TOPIC_CONFIG` 配置表达
- 主链 `create→plan→tdd_plan→dev→review→test→retrospect→closeout` 跑通，状态流转正确
- guard 阻止跳步（created 直接 dev → illegal_transition）
- 终态后任何 action 都 illegal_transition

**结论**：通用引擎完全吃下 L3，零硬编码 if-else 分支。后续 L4/L5 配置即可。

### 风险 3：freeze 抽象成立吗？✓ 成立

**验证**：`smoke test > freeze 抽象` 3 个测试通过。

- replan 改已 committed wave 的 `changes` 字段 → 返回 `wave_modified_committed` 违规
- replan 删已 committed wave → 返回 `wave_deleted_committed` 违规
- replan 改已 passed testCase 的 `expected` → 返回 `case_modified_passed` 违规

**结论**：`FreezeRule` 声明表完全替代 cw 0.x `validateAppendOnly` 的硬编码。配置即声明，零 if-else。

### 风险 4：progressive 语义保留？✓ 保留

**验证**：`smoke test > progressive 语义` 通过。

- developed 状态下再次调 dev（追加第二个 wave），status 仍为 developed（不回退到 pre_dev_verified）
- 与 cw 0.x `computeNextStatus` 的 progressive 行为完全一致

### 加分：gate 短路 + 状态不流转

- gate fail → status 不变，gateHistory 记 fail
- 多 gate 第一个 fail → 第二个不执行（短路）

## 5. 工程量数据

| 维度 | 数值 |
|---|---|
| `src/engine/` 核心代码 | 7 文件 / 1252 行（unit / scope-config / gate / freeze / deps / state-machine + 2 configs）|
| smoke test | 11 测试全绿（460ms）|
| tsc | 零错误 |
| cw 0.x 基线测试 | 849 passed（engine/ 独立，零影响）|

## 6. 迁移路径（cw 0.x → 1.0）

原型验证通过，后续迁移工作（另开 topic）分 5 个阶段：

### 阶段 M1：接入真实 store + gate
- 实现 `CwStoreAdapter`（实现 `UnitStore` 接口，桥接到 cw 0.x `CwStore`）
- 把 cw 0.x gate.ts 具名函数（planCheck / devCheck / fileExistsCheck / redLightCheck / ...）迁移为 `GateSpec`
- 把 cw 0.x 的 19 个 handler 内联 gate 调用迁移为 `ScopeConfig.actionGates`

### 阶段 M2：完整迁移 L3 topic
- 把 cw 0.x 的 12 status + 19 action 完整配置化（原型只配了 8+10）
- 迁移 `*_TURN_LIMIT` + `GATE_RETRY_LIMIT` 到 `ScopeConfig.loops`
- 迁移三套 review issue 平行实现（review / spec_review / plan_review）为统一的 collection
- 把 cw 0.x 的 393 个测试基线迁移为 engine 驱动

### 阶段 M3：实现 L4 spec ScopeConfig
- 完整配置 L4 spec 流程（drafting → reviewing → locked → split → archived）
- 实现 unlock / re-split / supersede 三个逆向 action
- 实现 lock gate（FR-AC 覆盖 + glossary 术语校验）
- 实现 lockHistory / splitHistory / statusHistory 三个 append-only 容器

### 阶段 M4：实现 L5 effort ScopeConfig
- 完整配置 L5 effort 流程（charting → resolving → ready-to-collapse → collapsed）
- 实现 ticket 内部流转（open → claimed → resolved → graduated）
- 实现 fog of war（通用化后 L5 是密度高的实例）
- 实现 claim 子系统（parallel 模式全局 mutex）

### 阶段 M5：跨层 drift + 影响传播
- 实现 `parentLockVersion` + drift 检测
- 实现 drift 状态机（clean → drifted → acknowledged）
- 实现 5 条跨层逆向路径（spec unlock / supersede / effort reopen / ADR supersede / research invalidate）
- 实现下游 drift 处理 action（acknowledge-drift / rebase-on-spec / abort）

## 7. 已确认的产品决策（源会话）

| # | 决策 | 影响 |
|---|---|---|
| 1 | 产品定位转向：session 级 → 全生命周期 | PRODUCT.md:53 推翻 + ADR |
| 2 | 每层独立状态机 → 通用引擎 + ScopeConfig | 本文档论证 |
| 3 | glossary 强制（lock gate 校验术语定义）| L4 spec lock gate |
| 4 | L5 claim 完整实现（lock + TTL + heartbeat）| L5 effort 阶段 M4 |
| 5 | 现有 topic 数据不迁移 | 阶段 M2 全新 `.cw/` store |
| 6 | 渐进交付（M1-M5）| 本文档 §6 |

## 8. 关键文件索引

| 内容 | 路径 |
|---|---|
| 通用 Unit | `src/engine/unit.ts` |
| ScopeConfig 接口 | `src/engine/scope-config.ts` |
| GateSpec + GateRunner | `src/engine/gate.ts` |
| FreezeRule + checkFreeze | `src/engine/freeze.ts` |
| EngineDeps（store/gate-runner 注入）| `src/engine/deps.ts` |
| UnitStateMachine 通用引擎 | `src/engine/state-machine.ts` |
| L3 topic 配置 | `src/engine/configs/l3-topic.ts` |
| L3 wave 配置（递归嵌套）| `src/engine/configs/l3-wave.ts` |
| smoke test（11 测试）| `tests/engine-smoke.test.ts` |
| 产品级设计（5 层架构）| `.xyz-harness/cw-1-0-lifecycle-redesign/plan.md` |
| 流程图（6 page HTML）| `.xyz-harness/cw-1-0-lifecycle-redesign/lifecycle-flow.html` |

## 9. 附录：与 cw 0.x 的代码对照

| cw 0.x | cw 1.0 | 平移方式 |
|---|---|---|
| `TRANSITIONS`（state-machine.ts:217-330）| `ScopeConfig.transitions` | 配置平移 |
| `checkLinear`（state-machine.ts:343-368）| `UnitStateMachine.guard()` | 算法平移，参数化 S/A |
| `computeNextStatus`（state-machine.ts:397-403）| `UnitStateMachine.computeNextStatus()` | 算法平移 |
| `TaskShape` 注册表（shapes/registry.ts）| `ScopeConfig` 实例 | 模式扩展 |
| `VerificationStrategy` / `ReviewStagePolicy` | `ScopeConfig` 子集 | 接口整合 |
| `validateAppendOnly`（actions.ts:2533）| `FreezeRule` + `checkFreeze` | 硬编码 → 声明表 |
| `gateAdvance`（actions.ts:636）| `GateRunner.run` | 雏形扩展 |
| `gateHistory` append（散落 handler）| `GateRunner.run` 统一 append | 集中化 |
| `store.transaction`（store.ts:453）| 迁移阶段接入 `CwStoreAdapter` | 直接复用 |
| `*_TURN_LIMIT`（state-machine.ts:40-50）| `ScopeConfig.loops` | 配置平移 |
| `Topic.waves[]` 内嵌字段 | `Unit.collections.waves` + 独立 wave Unit | 结构升级（递归嵌套）|
