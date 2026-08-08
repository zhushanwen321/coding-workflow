# 系统架构

> CW-CLI 当前态快照。架构决策的历史见 git log + ADR（如有）。
> 领域术语、统一语言见 [CONTEXT.md](./CONTEXT.md)；项目核心约定见 [AGENTS.md](./AGENTS.md)。

## 分层

```
┌──────────────────────────────────────────────────────────┐
│  CLI 层 (src/cli.ts)                                       │
│  argv 解析 → stdin → buildParams → CwParams               │
│  ADVANCE_ACTIONS(9) / READONLY_QUERIES(5) / create 路由   │
│  exit code 映射（0 正常 / 1 CwError·CwEngineError / 2 内部） │
│  只读查询（tree/status/list/handoff/frontier）                        │
├──────────────────────────────────────────────────────────┤
│  Engine 层 (src/dispatch.ts)                               │
│  create: 按 input.layer 路由（epic/feature/slice/wave）     │
│  非 create: loadWorkUnit → guard → 按 scope 路由 handler    │
│  → ActionResult（对外纯函数入口，无 IO 副作用）              │
├───────────────┬───────────────┬──────────────────────────┤
│ 状态机         │ Gate          │ 持久化                    │
│ src/rules/     │ src/rules/    │ src/store/                │
│ state-machine  │ gates/        │ cw-store.ts               │
│ .ts            │ + freeze.ts   │ (CwStore)                 │
├───────────────┴───────────────┴──────────────────────────┤
│  Action Handlers (src/handlers/)                           │
│  wave: src/handlers/<action>.ts（10 个 wave handler）       │
│  planning: src/handlers/{epic,feature,slice}/<action>.ts    │
│  事务内 gate → store 变更 → transitionStatus → buildNextAction │
├──────────────────────────────────────────────────────────┤
│  Guidance (src/guidance/) — 拼入 nextAction.guidance 文本   │
│  build-guidance / cross-layer / failure-hint / templates    │
└──────────────────────────────────────────────────────────┘
```

数据流（单次 `cw <action>` 调用）：

```
agent bash 调 cw <action> [flags]
  → cli.ts: argv 解析 + stdin/buildParams 构造 CwParams
  → dispatch.ts:
      create     → 按 input.layer 路由 handleCreate{Epic|Feature|Slice|}（不 loadWorkUnit）
      非 create  → loadWorkUnit(store, unitId)（按 scope 返回 Epic|Feature|Slice|ExecutionUnit）
                 → guard{Wave|Planning}(action, unit.status)（单重 guard，只验状态机合法性）
                 → dispatch{Wave|Slice|Feature|Epic} → handler(unit, input, deps)
  → handler: gate 检查 → 事务内 store 变更 → transitionStatus → buildNextAction
  → cli.ts: stdout JSON + exit code
```

## WorkUnit 四层模型

CW 编排的最小单元是 **WorkUnit**，4 层结构（详见 [CONTEXT.md](./CONTEXT.md)「WorkUnit 四层模型」）：

```
epic → feature → slice → wave
```

- `epic`/`feature`/`slice` 是 **PlanningUnit**（不产代码，`execute` 时按 `plan.split` 下沉创建子层 unit）。
- `wave` 是 **ExecutionUnit**（叶子，产代码，记 `commitHash`，不下沉）。
- 子 unit 通过 `parentUnitId` 外键关联，**扁平存储**（store.json 单集合 `workUnits`，不嵌套）。
- execute 下沉时子 slug = `${unit.slug}::${split.slug}`（`::` 分隔）。

类型定义见 `src/core/workunit.ts`（`WorkUnitBase`、`Epic`/`Feature`/`Slice`/`ExecutionUnit`），id 格式 `<scope>:<slug>`。

## 模块划分

| 模块 | 路径 | 职责 | 变化轴 |
|------|------|------|--------|
| `cli` | `src/cli.ts` + `src/cli-params.ts` | CLI 入口：argv 解析、stdin、buildParams、exit code、只读查询路由；`cli-params.ts` 提供 per-action flag 白名单表（`FlagWhitelist` + 全局共享基础集 + `validateFlags`，unknown flag → CwError exit 1）+ per-command help 双入口（`cw help <action>` / `cw <action> --help` 同源复用白名单表） | 新增 action 时加 buildParams case + 白名单登记 + `ADVANCE_ACTIONS`/`READONLY_QUERIES` | [from: cw-guidance-hardening §system-architecture] |
| `dispatch` | `src/dispatch.ts` | 统一入口纯函数：create 按 layer 路由 / 非 create `loadWorkUnit` → guard → 按 scope 分派 → `ActionResult`；定义 `CwEngineError` + `CwParams` 联合类型 | 新增 action/层时加 dispatch 子函数 switch case |
| `state-machine` | `src/rules/state-machine.ts` | `WAVE_TRANSITIONS` + `PLANNING_TRANSITIONS` 两张表 + `guardWave`/`guardPlanning`（单重 guard）+ `nextWaveStatus`/`nextPlanningStatus` + `isWaveTerminal`/`isPlanningTerminal` | 新增 action/status 时改对应表 |
| `handlers` | `src/handlers/`（wave 直放 + `{epic,feature,slice}/` 子目录）+ `validate-input.ts` | 各 action 的事务编排：gate 检查 → store 变更 → status 流转 → 拼下一动作；`internal.ts` 提供 `transitionStatus`/`buildNextAction`/`buildFailureNextAction`/`appendFailRecord`/`buildCreateIdempotentResult`；`validate-input.ts` 提供 typebox 全深度 input 校验（11 schema × 4 层 27 入口，CwError exit 1）；create handler 带幂等预检（layer 定界 + 终态特判 + idempotent 提示） | 新增 action 时加每层 handler + input schema 登记 | [from: cw-guidance-hardening §system-architecture] |
| `gates` | `src/rules/gates/`（`design-review.ts`/`test.ts`/`exec-review.ts`/`retrospect.ts`/`types.ts`）+ `src/rules/freeze.ts` + `src/rules/replan.ts` | 各阶段机器检查纯函数（零 IO，返回 `GateResult`）；`freeze.ts` 的 `checkFreeze` 验 append-only 不变性；`replan.ts` 的 `computeImpact` 算影响面；`retrospect.ts` 带 key 防御（codeSmell/followup/tradeoff typeof 防御）+ failure 报告扩展（期望全集+缺失子集）；`test.ts` 的 `commitExists` 可复用（execute 前置校验 + test gate 纵深防御） | 新增 gate 时加检查函数 | [from: cw-guidance-hardening §system-architecture] |
| `store` | `src/store/cw-store.ts` + `schema.ts` | `CwStore`：store.json 读写（POSIX 原子写 + 跨进程文件锁 + 内存事务）+ `WorkUnitRecord` upsert/load/findChildren | 存储格式变化时改 schema |
| `core` | `src/core/`（`workunit.ts`/`status.ts`/`plan.ts`/`evidence.ts`/`judgments.ts`/`clarifications.ts`/`git.ts`/`errors.ts`/`frontier.ts`/`hierarchy.ts`） | 领域模型与类型（零依赖）；`CwError`（预期错误，exit 1）；`frontier.ts` 算 frontier 视图（非终态节点 + blocked/dependsOn）；`hierarchy.ts` 跨父子 WorkUnit 关系只读遍历 + `isDependencySatisfied`（依赖全终态判定，frontier 消费） | 核心契约，变更影响面大 |
| `guidance` | `src/guidance/`（`build-guidance.ts`/`cross-layer.ts`/`failure-hint.ts`/`prefix-builder.ts`/`schema-injector.ts`/`subagent-guidance.ts`/`templates/`） | 拼入 `nextAction.guidance` 的纯文本提示词（正常三段式 / 异常四段式），agent 的唯一导航来源；`cross-layer.ts` 算 closeout 回溯方向（sibling/ascend/undefined）；schema 段取 **nextAction**（非刚完成 action）；`prefix-builder.ts` 渲染剥离 layer: 前缀（单 layer 显示）；replan guidance 透传 schema 段 | 阶段方法论变化时改 template | [from: cw-guidance-hardening §system-architecture] |
| `readonly` | `src/readonly/`（`render.ts`/`cross-cwd.ts`/`index.ts`） | 只读查询（tree/status/list/handoff/frontier）的渲染——不经 dispatch、不写 store；frontier 输出含聚合字段（advanceableCount/blockedCount）；list 尾行总览 + next-step 建议（--all 带 --cwd）；status 大字段默认截断 + `--full` 全量 | 查询输出格式变化时改 render | [from: cw-guidance-hardening §system-architecture] |

> 关键约定（[AGENTS.md](./AGENTS.md)）：engine **agent-agnostic**（不依赖任何 agent harness 能力，guidance 是纯文本，agent 通过 bash 调 `cw`）；**guidance 是唯一导航**；**单重 guard**（只 `guard{Wave|Planning}` 防跳步，`GuardErrorCode` 仅 `illegal_transition`）；**gate 熔断不阻断**（连续 fail 5 次后 guidance 换文案，但不阻止重试）。

## dispatch 主流程

`dispatch(params, deps)`（`src/dispatch.ts`）是 engine 的统一入口纯函数，按 scope 路由到 4 个子分派器：

1. **create**：不需要 `loadWorkUnit`（入口 action），按 `input.layer`（默认 `wave`）路由到 `handleCreate` / `handleCreateSlice` / `handleCreateFeature` / `handleCreateEpic`。工厂初始化全字段空态。
2. **非 create**：`loadWorkUnit(store, unitId)` 按 `record.scope` 返回 `ExecutionUnit`（wave）/ `Slice` / `Feature` / `Epic`，`null` 则 throw `CwEngineError(unit_not_found)`（exit 1）。
3. **guard**：wave 走 `guardWave`，planning（slice/feature/epic）走 `guardPlanning`——只查 `WAVE_TRANSITIONS`/`PLANNING_TRANSITIONS` 表验状态机合法性。`test`/`exec-review` 是 wave 专属，PlanningUnit 收到直接 throw `CwEngineError(illegal_transition)`。
4. **handler 路由**：`dispatchWave` / `dispatchSlice` / `dispatchFeature` / `dispatchEpic` 各自 `switch(params.action)`，TS 判别式联合自动 narrow `params.input` 到对应层 Input 类型。

失败语义（关键区分）：
- **guard fail / unit not found** → throw `CwEngineError`（exit 1，**不可恢复**）。
- **handler gate fail** → 返回 `ActionResult(ok=false)` + `gateResults`（**可 retry**，不改 status、不 save，但 append 一条 fail 记录到 statusHistory）。

返回类型 `ActionResult`（`src/handlers/types.ts`）：`unitId` / `status` / `ok` / `gateResults?` / `error?` / `replanImpact?` / `freezeViolations?` / `failureCount?` / `children?`（execute 下沉时返回子层信息 `{unitId, dependsOn}[]`，供递归调度器消费）/ `nextAction?`（含 `crossLayer?`：跨层导航，详见 [ADR-0011](./docs/adr/0011-recursive-parallel-scheduling.md) 回退章节）。依赖注入接口 `CwDeps`：`store` / `gitValidator` / `testRunner?` / `fileExists` / `workspacePath` / `clock`——所有 IO 能力通过此接口注入，handler 本身不直接做 IO。

## 关键状态机

状态机定义在 `src/rules/state-machine.ts`，**两张表**分别对应两层 status 枚举（`src/core/status.ts`）：

- **`WAVE_TRANSITIONS`**（ExecutionUnit/wave，`ExecutionStatus` 9 态）：8 主流程 + `abort` + `replan`。
- **`PLANNING_TRANSITIONS`**（PlanningUnit：epic/feature/slice，`PlanningStatus` 7 态）：6 主流程（无 wave 的 `test`/`exec-review`）+ `abort` + `replan`。

wave 主链（8 步）+ abort/replan 两个旁路：

```mermaid
stateDiagram-v2
    [*] --> created: create
    created --> designing: design
    designing --> designing: design
    designing --> design-reviewed: design-review
    design-reviewed --> design-reviewed: design-review
    design-reviewed --> designing: design
    design-reviewed --> executing: execute
    executing --> tested: test
    tested --> exec-reviewed: exec-review
    exec-reviewed --> retrospected: retrospect
    retrospected --> closed: closeout
    design-reviewed --> design-reviewed: replan
    executing --> executing: replan
    tested --> tested: replan
    exec-reviewed --> exec-reviewed: replan
    retrospected --> retrospected: replan
```

PlanningUnit 主链少两步（无 `test`/`exec-review`）：`retrospect` 直接从 `executing` 进入；`replan.from` 不含 `retrospected`（retrospect 发现的问题走重建下层而非 replan 本层，只允许 `design-reviewed`/`executing` 触发）。完整 from→to 表见 [CONTEXT.md](./CONTEXT.md)「状态流转规则」与 `WAVE_TRANSITIONS`/`PLANNING_TRANSITIONS` 源码。

设计要点：
- **progressive action**（`design`/`design-review`/`replan`）带 `progressive: true`——若 current 已是目标 `to`，允许原地再次触发（不改 status）。
- **replan 是旁路**（`to = undefined`）：不改 status，但仍 append 一条 statusHistory（`from = to = current`），并要求 agent 回 `designing` 重走 `design-review`。
- **终态**：`closed` / `aborted` 不可逆（`isWaveTerminal`/`isPlanningTerminal`）。
- **单重 guard**：只有 `guard{Wave|Planning}`（查表防跳步），无纵深防御；`GuardErrorCode` 仅 `illegal_transition`。新 status 由 handler 侧的 `transitionStatus`（`src/handlers/internal.ts`）按 `next{Wave|Planning}Status` 算出后写入。

> 注：当前模型**没有**旧的 `review_fix`/`test_fix` 回退循环。gate 失败是原地 retry（不回退 status），连续 fail 由 `failure-hint.ts` 递进换 guidance 文案（见下「gate 机制」），不阻断。

## gate 机制

gate 是 CW 的核心价值——不信任 agent 的声明，只信机器验证的证据。gate 是纯函数（`src/rules/gates/*.ts` + `src/rules/freeze.ts`，零 IO），返回统一的 `GateResult { passed, report }`；IO 能力（`gitValidator`/`testRunner`/`fileExists`）通过 `CwDeps` 注入到 handler，handler 调 gate 时传入。

各 action 的 gate 集合（handler 内组装，详见对应 `src/handlers/<action>.ts`）：

| action | gate / 校验 | 校验内容 | 出处 |
|--------|------------|---------|------|
| `create` | 无 gate | 工厂初始化全字段空态 | `src/handlers/create.ts` |
| `design` | 无 gate（feature 专属 `validateFeatureSpec`） | testCases/split 结构在 `design-review` 阶段才验；feature 的 input.spec 存在时先过 typebox 结构校验（防畸形 spec 入库），wave/slice/epic 无 | `src/handlers/design.ts`、`src/rules/spec-schema.ts` |
| `design-review` | wave 10 个 / slice 14 个 / feature 16 个 / epic 13 个 | 结构完整性（wave: `test-cases-non-empty`/`test-command-non-empty`/`test-cases-have-expected`/`no-sibling-wave-file-conflict`[跨 wave 文件冲突，handler 注入兄弟 plan.files]；slice: `tech-choice-non-empty`/`split-non-empty`/`split-dag-valid`/`split-fan-out-limit`/`duplicate-split-slug`；feature: FR-AC 强引用 `fr-ac-coverage`/`ac-reachable-from-fr`/`ac-non-empty` + `slice-split-*`（含 `slice-split-fan-out-limit`）+ `duplicate-split-slug`；epic: `feature-split-*`（含 `feature-split-fan-out-limit`）+ `duplicate-split-slug`）+ `all-decisions-resolved` + `inherited-item-ids-valid` + `inherited-item-ids-declared`（软 gate，severity=warn 不阻断）+ judgment 非空（`design-review-{necessity,sufficiency,alternatives}-*`/`design-review-{tradeoffs,risks}-present`）+ `layer-specific-non-empty`（各层专属维度） | `src/rules/gates/design-review.ts` |
| `execute` | 无 gate | commit 存在性在 `test` gate 验（避免 executing 状态因 commit 无效卡死） | `src/handlers/execute.ts` |
| `test` | 4 个 gate（wave 专属） | `commit-exists`（commitHash 真实存在，整个 cw 唯一 git 校验点）+ `tests-all-pass`（业务正确性机器验证）+ `test-cases-executed`（用例被执行）+ `test-references-design-review`（引用一致性，覆盖 tradeoffs/risks） | `src/rules/gates/test.ts` |
| `exec-review` | 4 个 gate（wave 专属） | `exec-review-readability-non-empty` + `exec-review-architecture-non-empty` + `exec-review-overall-verdict-non-empty` + `exec-review-followup-actions-when-needed`（纯人审，验结构不验内容） | `src/rules/gates/exec-review.ts` |
| `retrospect` | wave 2 个 + PlanningUnit 额外多个 | wave: `lessons-learned-non-empty` + `retrospect-covers-judgments`；PlanningUnit 额外: `all-waves-closed`/`split-fulfillment-covers-plan`/`reviewed-items-cover-design-review`/`child-unit-evidence-complete`/`delivery-verdict-non-empty`/`child-delivery-consistency`/`lessons-learned-non-empty`（含 `deliveryVerdict` 验收子层） | `src/rules/gates/retrospect.ts` |
| `closeout` | `artifacts-drift-check`（内联） | artifacts[].ref 非空且指向真实存在（commit kind 用 `gitValidator.exists`，其他用 `fileExists.exists`）；全 pass 才冻结 evidence（写 `frozenAt`） | `src/handlers/closeout.ts` |
| `replan` | `checkFreeze`（append-only 校验） | 废弃条目标 `status=abandoned` 后核心字段不可改/不可删/不可复活（`src/rules/freeze.ts`）；通过后 `computeImpact` 算影响面 + 级联 abort | `src/handlers/replan.ts`、`src/rules/freeze.ts`、`src/rules/replan.ts` |
| `abort` | 无 gate | → `aborted` 终态 | `src/handlers/abort.ts` |

gate fail 语义（[CONTEXT.md](./CONTEXT.md)「核心架构概念」）：
- **短路返回** `ActionResult(ok=false)` + `gateResults`——不改 status、不 save，但 `appendFailRecord` 写一条 fail 记录到 statusHistory。
- **熔断不阻断**：`failureCount`（从 statusHistory 派生的同一 action 连续 fail 次数，跨 session 不重置）≥ 5 时，`src/guidance/failure-hint.ts` 在异常 guidance 末尾追加「强烈建议先 `cw abort`」文案——但 **不阻止** agent 继续重试（CW 永不硬阻断）。

聚合 runner：`runSliceDesignReviewGates` / `runFeatureDesignReviewGates` / `runEpicDesignReviewGates`（`design-review.ts`）与 `runSliceRetrospectGates`（`retrospect.ts`）封装多 gate 批跑；wave 的 gate 由 handler 直接内联组装。

## 持久化

`CwStore`（`src/store/cw-store.ts`）是 store.json 持久化层，单集合扁平存储：

- **存储布局**：`~/.cw/<encodedCwd>/store.json`（per-cwd 隔离），`encodeCwd` 把路径分隔符 `/`、`\` → `__`（`src/store/schema.ts`）。`CW_HOME` 环境变量可覆盖默认 `~/.cw`（必须绝对路径）。
- **文件结构**（`CwJsonFile`，`src/store/schema.ts:22`）：`{ schemaVersion?, repoMeta?, workUnits: WorkUnitRecord[] }`。`schemaVersion` 为写侧版本标记（`emptyFile` 写入 `SCHEMA_VERSION`，读侧不做版本判断）。`workUnits` 是扁平集合，子 unit 通过 `parentUnitId` 外键关联（不嵌套）；`repoMeta`（git 元信息）首次 save 时回填。
- **POSIX 原子写**：write tmp → `fsync(tmp)` → `rename` → `fsync(dir)`，任一阶段 crash 磁盘上要么旧文件完整要么新文件完整。
- **跨进程文件锁**：lockfile + `O_EXCL` 原子创建 + stale 检测（超 30s 或持有进程已死）+ fingerprint 二次比对防 TOCTOU 误删。
- **内存事务**：`transaction(fn)` 在 `structuredClone` 的深拷贝副本上操作，正常→原子落盘，异常→丢弃副本（ROLLBACK）；支持嵌套（复用外层副本）。
- **DAO**：`load(id)` / `loadAll()` / `save(unit)`（upsert，按 id）/ `findChildren(parentUnitId)`（按外键查子层）。

中间产物（design/design-review 等阶段 input JSON）落 `<workspacePath>/.cw/<slug>/<action>.json`（已 gitignore），不进 store.json。

## 外部依赖

| 类型 | 依赖 | 用途 |
|------|------|------|
| In-process | `minimist` | argv 解析（`src/cli.ts`） |
| Local-sub | `git`（子进程） | commit 存在性校验（`test` gate 的 `commit-exists`，经 `CwDeps.gitValidator` 注入）+ execute 提取 changedFiles + repoMeta 收集 |
| Local-sub | 文件系统 | store.json 读写（`src/store/cw-store.ts`）+ artifacts drift 校验（`closeout`，经 `CwDeps.fileExists` 注入） |
| True-external | 无 | CW 不依赖任何远程服务 |

## 评估指标架构（已弃用）

> 三层指标体系（交付质量 / 过程效率 / 杠杆健康度）随 0.x 时代 `cw stats` / `cw assess` 一并删除，`stats.ts` 已不存在。设计文档归档于 [.xyz-harness/deprecated-metrics/](./.xyz-harness/deprecated-metrics/)，仅作历史可追溯。
