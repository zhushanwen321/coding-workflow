# Plan: CW 重构为 lite 单轨极简状态机

> 重构方向：推倒重建（方案 X）。现有 2633 行代码 + 14 测试文件全部作废，从零重写。
> 范围：只做 lite 单轨 `create → plan → dev → test → retrospect → closeout`。
> 砍掉：mid tier、tier 字段（lite-only 硬编码）、E2E 剥离、evidence parser、dev diff 校验、check 读 md、质量约束（覆盖率阈值/E2E 双层等交回 skill 管）。
>
> **engine 职责边界（v2 修订，选项 A）**：engine 只防跳步（状态机 guard）+ 最基础结构校验（plan.json format=lite + waves≥1 + cases≥1 + commit 存在 + judgeByExpected）。质量约束（plan.md 6 章节、覆盖率阈值、E2E mock+real 双层、Wave 依赖无环、并行组无冲突）**全部交回 skill 文档管**，engine 不做。本轮目标是「跑通」，不是「防偷工」。

## 业务目标

**一句话**：把 CW 从「lite/mid 双轨 + progressive + evidence + check 读 md」的复杂系统，重构为一个 agent 只需调 `cw` CLI 就能走完整条链路的极简状态机，核心价值是「防 agent 跑偏」而非「防 agent 偷工」（偷工防线本次不做）。

**可衡量成功标准**：
1. 单一 CLI 入口 `cw`，agent 通过 CLI 返回的 nextAction 驱动全流程，无需读 skill 文档判断下一步
2. lite 全链路 `create → plan → dev → test → retrospect → closeout` 在真实子进程 e2e 测试中跑通
3. 总代码量 ≤ 1200 行（现有 2633 行砍掉一半以上，复杂度显著下降）
4. 全量测试通过，无遗留 stub（现有 mid handler 的 `throw NotImplementedError` 必须消失）

**约束**：
- TypeScript + ESM（`"type": "module"`），保持现有技术栈
- 依赖最小：保留 `@sinclair/typebox`（schema 校验）+ `minimist`（argv 解析），不新增依赖
- 不引入 sqlite（JSON 文件持久化保留，但有理有据——见数据模型设计）
- 不做 E2E 测试剥离，E2E 用例仍混在 plan 的 testCases 里
- 不做 evidence parser、dev diff 校验（第二层防线本次不做）

**不做**：
- mid tier 全部砍掉（clarify / detail / 8 个 mid check 脚本）
- **tier 字段彻底砍掉**（lite-only，format 硬编码校验 `format === "lite"`，create 不收 tier 参数）
- **纵深防御 guard 砍掉**（checkPhaseCascade / checkCacheConsistency），只留 checkLinear 单重 guard。GuardErrorCode 只剩 `illegal_transition`，phase_incomplete / cache_inconsistent 不复存在。半成品状态（status 已流转但 gate 未 pass）靠 handler 内 computeGatePassed + nextAction 指回自己兜底——接受这个降级（reviewer 确认不会卡死，只是少了 fail-fast）
- **质量约束砍掉**（plan gate 不再校验覆盖率阈值 / E2E mock+real 双层 / Wave 依赖无环 / 并行组无冲突 / plan.md 章节）。assertAcyclicDeps 也砍——环形依赖潜伏到 execute 报错，本轮可接受
- 并行 e2e_plan / e2e_test 状态机扩展
- evidence 解析、dev diff 校验、check 读 md（check-plan.ts / check-closeout.ts / shared.ts 全删）
- coding-execute / coding-retrospect / lite-plan 等 skill 文档（本轮只重构 engine + CLI，skill 文档后续单独处理）

**保留（reviewer 指出不能砍的）**：
- Evidence.gateHistory 快照（closeout 后可回溯完整 gate 历史，不能丢）
- gate 熔断逻辑（GATE_RETRY_LIMIT=5 + countConsecutiveGateFails + buildCircuitBreakerGuidance，防 agent 卡死在某个 gate）
- GitValidator（validate + isAncestorOfAny，dev gate / replan 依赖）

## 技术改动点

> 本节是文件级清单。重构 = 整个 `src/` 推倒重写，`tests/` 重写。下面列出重写后的目标结构。

- **删除** `src/` 全部现有 26 个 .ts 文件（engine/cli 两层全删，含 checks/ 目录 8 个 mid check 脚本 + shared.ts）
- **删除** `tests/` 全部现有 14 个测试文件
- **新建** `src/types.ts` — 领域模型 + 统一接口契约（合并现有分散的 types/store-types/dao-seeds，砍 tier 字段）
- **新建** `src/state-machine.ts` — 声明式转换表 + 单重 guard checkLinear + gate 熔断（砍 checkPhaseCascade / checkCacheConsistency）
- **新建** `src/store.ts` — JSON 持久化（保留事务模型，砍掉 tier/mid 字段映射）
- **新建** `src/plan-parser.ts` — typebox schema + format 硬编码校验（**reviewer 指出遗漏文件**：含 LitePlanSchema + parseLitePlan，format 锁定从 `=== tier` 改为硬编码 `=== "lite"`；砍 assertAcyclicDeps）
- **新建** `src/path-encoding.ts` — cwd 编码（**reviewer 指出遗漏文件**：encodeCwd 纯函数，cli.ts 的 resolveDbPath 依赖。从现有 path-encoding.ts 1:1 移植，零改动）
- **新建** `src/gate.ts` — 极简 gate + GitValidator（planCheck + devCheck + testCheck + fileExistsCheck + GitValidator 类，合并到一个文件）
- **新建** `src/actions.ts` — 7 个 action handler 合并到单文件（create/plan/dev/test/retrospect/closeout/replan）
- **新建** `src/dispatch.ts` — 统一入口（loadTopic → guard → handler → ActionResult）+ GuardError
- **新建** `src/cli.ts` — CLI 入口（argv 解析 + stdin + exit code + resolveDbPath + status/list 只读查询）
- **新建** `tests/` — 重写：types/state-machine/store/plan-parser/gate/dispatch 单测 + cli e2e 全链路测试

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 说明 |
|------|----------|------|------|
| W1 | src/types.ts, src/path-encoding.ts | - | 领域模型 + 接口契约 + cwd 编码（全模块依赖，必须先定）。path-encoding 是零依赖纯函数，与 types 并列无依赖 |
| W2 | src/state-machine.ts, src/store.ts, src/plan-parser.ts | W1 | 状态机 + 持久化 + plan schema（纯逻辑，可单测，无 IO 依赖。三者互相无依赖，内部可并行写） |
| W3 | src/gate.ts, src/actions.ts, src/dispatch.ts | W1, W2 | gate + handler + 入口。**内部串行顺序：gate → actions → dispatch**（actions 依赖 gate 的 planCheck/GitValidator；dispatch 依赖 actions 的 handler） |
| W4 | src/cli.ts | W3 | CLI 入口（依赖 dispatch + store + path-encoding） |
| W5 | tests/ | W1-W4 | 全量测试（单测 + e2e） |

> **reviewer 注**：W2 三个文件互相无依赖可并行，但本轮为求稳按串行写。W3 必须严格 gate→actions→dispatch 顺序。

## 单测用例清单

| 用例ID | 覆盖改动点 | 输入 | 预期 |
|--------|-----------|------|------|
| U1 | state-machine:TRANSITIONS | create action, status=undefined | guard 通过, nextStatus=created |
| U2 | state-machine:TRANSITIONS | plan action, status=created | guard 通过, nextStatus=planned |
| U3 | state-machine:TRANSITIONS | dev action, status=created | guard 拒绝(illegal_transition), code 正确 |
| U4 | state-machine:TRANSITIONS | test action, status=planned(未developed) | guard 拒绝(illegal_transition)。**v2 修订**：单重 guard 不产生 phase_incomplete，所有跨阶段跳步都报 illegal_transition |
| U5 | state-machine:TRANSITIONS | closeout action, status=developed(跳过test/retro) | guard 拒绝(illegal_transition) |
| U6 | state-machine:computeGatePassed | topic 全 wave committed | dev gatePassed=true |
| U7 | state-machine:computeGatePassed | topic 有 1 wave 未 committed | dev gatePassed=false |
| U8 | state-machine:computeGatePassed | topic 全 testCase passed | test gatePassed=true |
| U9 | state-machine:buildNextAction | create 后 topic | nextAction.action=plan, skill=lite-plan。**v2 修订**：create 不再收 tier 参数，buildNextAction 不分支 tier |
| U9b | state-machine:computeNextStatus | status=developed 时再调 dev（progressive） | nextStatus 仍为 developed（原地停留）。**reviewer 补充**：progressive 原地停留语义 |
| U9c | state-machine:computeNextStatus | status=tested 时再调 test（progressive） | nextStatus 仍为 tested。**reviewer 补充**：test 渐进式基础语义 |
| U10 | state-machine:buildNextAction | plan gate pass 后 | nextAction.action=dev, waves 列表返回 |
| U11 | state-machine:buildNextAction | dev 全 committed 后 | nextAction.action=test, testCases 列表返回 |
| U12 | store:transaction | 写入后异常 throw | 磁盘不变(ROLLBACK) |
| U13 | store:transaction | 正常写入 | 磁盘更新, reload 读到新值 |
| U14 | store:loadTopic | topicId 不存在 | 返回 null |
| U15 | store:setWaveCommitted | 已 committed 的 wave 再次提交 | committed 更新为新 hash |
| U16 | plan-parser:parseLitePlan | plan.json 结构合法(format=lite, waves≥1, testCases≥1) | 解析成功，返回 waves/testCases。**v2 修订**：format 硬编码校验 `=== "lite"`，不再依赖 tier |
| U17 | plan-parser:parseLitePlan | plan.json format="mid-clarify"（非 lite） | 抛错，reason 含 format 不匹配。**v2 修订**：tier 已砍，改为测 format 非 lite 字符串 |
| U18 | plan-parser:parseLitePlan | plan.json waves 空 | 抛错（schema 校验 waves 长度≥1） |
| U19 | dispatch:plan | 合法 planJson | 写入 waves/testCases, status=planned, nextAction=dev |
| U19b | dispatch:plan | gate fail（planJson format 非 lite） | status 不变（仍 created），gateHistory append fail，nextAction 指回 plan retry。**reviewer 补充**：gate fail 的 status 不变语义 |
| U20 | dispatch:dev | 合法 commitHash | wave.committed 写入, gatePassed.dev 重算 |
| U21 | dispatch:dev | 无效 commitHash(不存在) | 该 wave 不写 committed, 报错 |
| U22 | dispatch:test | testCase actual 匹配 expected | status=passed, gatePassed.test 重算 |
| U23 | dispatch:test | testCase actual 不匹配 expected | status=failed, reason 含 mismatch |
| U24 | dispatch:test | caseId 不存在于 topic | throw not found |
| U24b | dispatch:test | testCase requiresScreenshot=true 但 screenshotPath 缺失 | status=failed, reason 含 screenshot required。**reviewer 补充**：requiresScreenshot 分支 |
| U24c | dispatch:test | 第二次 test 提交（status=tested, progressive） | 不报 illegal_transition，剩余 case 继续判定。**reviewer 补充**：test 渐进式 |
| U25 | dispatch:replan | 合法追加 wave（已 committed wave 保留，新增未 committed） | replaceUncommittedWaves, status 回退 planned, gatePassed 重算 |
| U26 | dispatch:replan | 新 plan 删除已 committed 的 wave | throw append-only 违规（wave_deleted_committed）。**reviewer 补充**：replan 拒绝路径 1/4 |
| U27 | dispatch:replan | 新 plan 修改已 committed wave 的 changes 字段 | throw append-only 违规（wave_modified_committed）。**reviewer 补充**：replan 拒绝路径 2/4 |
| U28 | dispatch:replan | 新 plan 删除已 passed 的 testCase | throw append-only 违规（case_deleted_passed）。**reviewer 补充**：replan 拒绝路径 3/4 |
| U29 | dispatch:replan | 新 plan 修改已 passed testCase 的 expected 字段 | throw append-only 违规（case_modified_passed）。**reviewer 补充**：replan 拒绝路径 4/4 |
| U30 | dispatch:closeout | 合法归档 | evidence 写入（含 gateHistory 快照）, status=closed。**v2 修订**：evidence 保留 gateHistory |

## E2E 用例清单

| 用例ID | 场景 | 测试层 | 说明 |
|--------|------|--------|------|
| E1 | create→plan→dev→test→retrospect→closeout 全链子进程跑通 | mock | 用真实 node 子进程调 dist/cli.js，CW_HOME 指向 tmp，git init tmp workspace |
| E2 | dev 阶段渐进式提交（多 wave 分多次 cw dev 调用） | mock | 验证 progressive：第二次 dev 不报 illegal_transition |
| E3 | 非法跳步（created 直接到 test）被拒绝 | mock | 验证 exit code + stderr 含 illegal_transition |
| E4 | replan 场景：dev 中追加 wave | mock | 验证 append-only 校验 + status 回退 |

> 注：所有 E2E 均为 mock 层（无需真实外部服务），通过子进程 + tmp 目录实现。real 层验证依赖真实 git repo，在 E1 中已含 git init/commit，视为 real 层凭证。

## 覆盖率 gate（W5 测试 Wave 本地自检命令，非 engine 运行时 gate）

> 注：engine 运行时不做覆盖率质量约束（本轮选项 A）。这里的命令是 W5 测试阶段的自检门——跑完单测后本地验证覆盖率，不通过则 W5 不算完成。与 engine gate 无关。

命令: `npx vitest run --coverage`
阈值: 85%（全量覆盖率，项目小不做增量 diff）

## 架构设计（重构后）

### 状态机（极简版）

6 个 action，严格线性，单重 guard：

```
create → plan → dev → test → retrospect → closeout
created  planned developed tested   retrospected   closed
```

**关键简化点**：
1. **单重 guard**：只做 `checkLinear`（status ∈ expectedStatuses）。砍掉 `checkPhaseCascade` 和 `checkCacheConsistency`——lite 单轨里，线性 status 检查已经足够防跳步，progressive 的 phase 级联检查是 mid 双轨复杂度才需要的。computeGatePassed 仍在 handler 内算（用于 nextAction 分流），但不再作为 guard 前置门。GuardErrorCode 只剩 `illegal_transition`。
2. **progressive 只留 dev/test**：dev 可在 developed 状态下多次提交 wave（渐进式），test 可在 tested 状态下多次提交 case。retrospect 是 single-shot。
3. **replan 保留但简化**：只允许 dev 阶段追加 wave（append-only，4 种违规类型全保留），砍掉 mid replan 路径。
4. **gate 熔断保留**：GATE_RETRY_LIMIT=5，连续失败达阈值后 nextAction guidance 换熔断文案（建议 ask_user 人工审查）。不阻断，只告警。

**接受的降级（reviewer 指出，本轮明确接受）**：
- 砍 checkPhaseCascade 后，「status 已流转但 gate 未 pass」的半成品状态不再 fail-fast，靠 handler 内 computeGatePassed + nextAction 指回自己兜底。agent 可能困惑为什么 dev 一直不流转到 test——需看 waves 列表判断。本轮可接受。
- 砍 checkCacheConsistency 后，gatePassed 缓存漂移不再有 guard 兜底。replan handler 必须在事务内同步 gatePassed（代码注释强调），否则 bug 静默潜伏。本轮可接受。

### 数据模型（types.ts）

```typescript
type Action = "create" | "plan" | "dev" | "test" | "retrospect" | "closeout" | "replan";
type Status = "created" | "planned" | "developed" | "tested" | "retrospected" | "closed";

interface GateHistoryEntry {
  id: number; phase: Action; action: Action; gate: string;
  result: "pass" | "fail"; ts: string; report?: string; progressive: boolean;
  // **v2 修订**：砍掉 tier 字段（GateTier 类型整个砍掉）
}

interface Evidence {
  closedAt: string; coverage?: number;
  gateHistory: GateHistoryEntry[];  // **v2 修订**：reviewer 指出不能砍，closeout 后回溯用
}

interface Topic {
  topicId: string; slug: string; objective: string;
  workspacePath: string; topicDir: string;
  createdAt: string; status: Status;
  waves: Wave[]; testCases: TestCase[];
  gateHistory: GateHistoryEntry[];
  gatePassed: Partial<Record<Action, boolean>>;
  evidence?: Evidence;
  // **v2 修订**：砍掉 tier / planFormat / coverage（coverage 移入 evidence）字段
}

// **v2 新增**：Seed 类型定义（reviewer 指出 plan 原本缺）
interface WaveSeed { id: string; dependsOn: string[]; changes?: string[] }
interface TestCaseSeed {
  id: string; layer: "mock" | "real"; scenario: string; steps: string;
  expected: { url?: string; text?: string }; executor: string;
  requiresScreenshot: boolean; dependsOn?: string[];
  // **v2 修订**：砍掉 assertion / file / describe / parallelGroup
}

interface Wave { id: string; dependsOn: string[]; committed: string | null; changes: string[] }
interface TestCase {
  id: string; layer: "mock" | "real"; scenario: string; steps: string;
  expected: { url?: string; text?: string }; executor: string;
  status: "pending" | "passed" | "failed";
  actual?: object; screenshotPath?: string; failureReason?: string;
  requiresScreenshot: boolean; dependsOn: string[];
}
```

**砍掉的 types 字段**：tier（不再分档）、planFormat（lite 专属）、coverage（移入 Evidence）、issues/parallelGroup（wave 精简）、assertion/file/describe（testCase 精简）、GateTier（gate 精简，不再分档强度）、GateHistoryEntry.tier（随 GateTier 一起砍）、schemaVersion（简化迁移）。

**保留的 types 字段（reviewer 指出不能砍）**：Evidence.gateHistory（closeout 回溯）、GateHistoryEntry 其余字段。

### Store（JSON 持久化，保留）

**为什么保留 JSON 不换 sqlite**：单 workspace 的 topic 数据量（几个 topic × 几十个 wave/case）远未到 JSON 性能瓶颈；JSON 有可读、可 git diff、可手工 inspect 的优势；现有事务模型（文件锁 + 原子写 + ROLLBACK）已验证可靠。换 sqlite = 重写 ~400 行 + 引入依赖 + 丧失可读性，零收益。

保留的核心：`transaction(fn)`（文件锁 + 深拷贝副本 + 异常 ROLLBACK + 原子 rename）。砍掉 mid 无关字段映射。

### CLI 协议（cli.ts）

入口：`cw <action> [options]`，stdin 传 JSON。agent 只需知道 `cw create`，后续全靠返回的 nextAction。

```
cw create --slug xxx --objective "yyy" [--workspace path]
  → { topicId, nextAction: { action: "plan", guidance: "..." } }

echo '{"format":"lite",...}' | cw plan --topicId xxx
  → { status: "planned", nextAction: { action: "dev", waves: [...] } }

cw dev --topicId xxx --tasks '[{"waveId":"W1","commitHash":"abc"}]'
  → { gatePassed: {dev: bool}, nextAction: {...} }

cw test --topicId xxx --cases '[{"caseId":"E1","actual":{"text":"hi"}}]'
  → { gatePassed: {test: bool}, nextAction: {...} }
```

**nextAction 是 agent 的唯一导航**：每个 action 的返回都含 `nextAction: { action, skill?, guidance, waves?, testCases? }`，agent 按它推进。

### Gate（极简，选项 A：engine 不管质量约束）

engine 只防跳步（状态机 guard）+ 最基础结构校验。质量约束全部交回 skill 文档管。

- **plan gate**：plan.json 的 format === "lite"（硬编码，不依赖 tier）、waves ≥ 1、testCases ≥ 1。typebox schema 校验，**不读 plan.md 文件**。
  - **砍掉的检查（交回 skill 管）**：6 章节齐全、覆盖率阈值≥60%、E2E mock+real 各≥1、Wave 依赖无环（assertAcyclicDeps）、并行组文件无冲突、单测可机器判定。
- **dev gate**：commit 存在 + 非空（GitValidator.validate，保留现有逻辑）。
- **test gate**：judgeByExpected 重算（保留现有纯函数，砍掉 mid 的 commitHash/claimedStatus 分支）。
- **retrospect/closeout gate**：只验文件存在（retrospect.md / 归档文件）。**有意降级**：现有 check-closeout.ts 的 6 大类检查（ARCHIVED 溯源 / NFR 验证 / DESIGN-LOG 等）全部砍掉，本轮只验文件存在。后续如需质量约束可再补。

**砍掉**：GateRegistry 声明表、GateRunner dispatch 表、8 个 check 脚本（mid 专属）+ check-plan.ts + check-closeout.ts + shared.ts（全部删）、GateTier 分档强度。

**保留**：GitValidator（validate + isAncestorOfAny，放 gate.ts）、judgeByExpected 纯函数（放 types.ts）。

## 实现步骤

### Wave 1: types.ts + path-encoding.ts（领域模型 + 零依赖纯函数）

1. 定义 Action / Status 类型（7+6 个值）
2. 定义 GateHistoryEntry / Evidence / Topic / Wave / TestCase 接口（**Evidence 含 gateHistory 快照**）
3. 定义 WaveSeed / TestCaseSeed（砍掉 issues/assertion/file/describe/parallelGroup）
4. 定义 judgeByExpected 纯函数（从现有 types.ts 移植，砍 mid 分支）
5. 定义 ActionDeps / ActionResult / NextAction / GuardVerdict 接口（**GuardVerdict.code 只留 illegal_transition**）
6. path-encoding.ts：encodeCwd（从现有 1:1 移植，零改动）
7. 单测 U1-U5 的类型层面验证（tsc 通过）

### Wave 2: state-machine.ts + store.ts + plan-parser.ts（纯逻辑层，三者互相无依赖）

1. TRANSITIONS 声明式表（7 个 action 的 expectedStatuses + nextStatus + progressive 标记）
2. checkLinear 单重 guard（砍 checkPhaseCascade / checkCacheConsistency）
3. computeGatePassed（dev=全committed, test=全passed, single-shot=gateHistory 有 pass）
4. computeNextStatus（progressive 原地停留）
5. buildNextAction（switch 6 个 action，每个返回 nextAction 含 guidance）
6. gate 熔断保留：GATE_RETRY_LIMIT=5 + countConsecutiveGateFails + buildCircuitBreakerGuidance
7. store.ts：CwStore 类（transaction + 文件锁 + 原子写 + 4 集合 DAO，砍 tier 字段映射）
8. plan-parser.ts：LitePlanSchema（typebox）+ parseLitePlan（format 硬编码 `=== "lite"`，砍 assertAcyclicDeps）
9. 单测 U6-U18

### Wave 3: gate.ts → actions.ts → dispatch.ts（严格串行）

1. gate.ts：planCheck（调 plan-parser）+ devCheck（GitValidator）+ testCheck（judgeByExpected）+ fileExistsCheck（retrospect/closeout）
2. gate.ts：GitValidator 类（移植现有，validate + isAncestorOfAny）
3. actions.ts：handleCreate / handlePlan / handleDev / handleTest / handleRetrospect / handleCloseout / handleReplan（7 个合并单文件）
   - **handleReplan**：保留 validateAppendOnly 全部 4 种违规类型检测
   - **handleReplan**：事务内必须同步 gatePassed（砍掉 cache_inconsistent guard 后的注释强依赖）
   - **handleCloseout**：evidence 含 gateHistory 快照
4. dispatch.ts：dispatch 纯函数（loadTopic → guard → handler 分派 → ActionResult）
5. dispatch.ts：GuardError 类
6. 单测 U19-U30

### Wave 4: cli.ts（CLI 入口）

1. minimist argv 解析
2. stdin 读取（Promise 封装）
3. resolveDbPath（CW_HOME + encodeCwd 从 path-encoding.ts import）
4. constructActionDeps（store + git + workspacePath）
5. dispatch 调用 + stdout JSON 序列化
6. exit code 映射（0=正常, 1=参数/guard 错误, 2=内部异常）
7. status / list 只读查询子命令（不经 dispatch）

### Wave 5: tests/（全量测试）

1. tests/state-machine.test.ts（U1-U11 + U9b/U9c progressive）
2. tests/store.test.ts（U12-U15）
3. tests/plan-parser.test.ts（U16-U18）
4. tests/dispatch.test.ts（U19-U30，含 replan 4 拒绝路径 + gate fail 不变 + screenshot + test 渐进式）
5. tests/e2e.test.ts（E1-E4，真实子进程跑 dist/cli.js）
6. `npm run build` + `npm test` 全绿
