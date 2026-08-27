---
description: "项目约定审查（维度 A）。审查 CW 引擎 2.0 特有约定：状态机正确性（事件账本 + fold 投影）/ Gate 完备性（spec 十四规则 + verify 三道 gate）/ 引擎类型边界（agent-agnostic）/ CLI 契约（16 命令面）。只在 src/ 有改动时适用。"
name: project-conventions
---

# 项目约定审查标准（Subagent A 用）

## 目的

本文档是 CW（coding-workflow）的**项目特定约定审查标准**，供 review 阶段的 Subagent A 使用。

定义 CW 引擎自身必须遵守的工程约定——状态机正确性、Gate 完备性、引擎层类型边界、CLI 契约。
这些约定是「这个项目（纯 TypeScript CLI 引擎，agent 工作的 CI）」特有的，换一个项目就不适用，
因此与语言通用质量（quality-criteria.md）分开。

> 术语与命令面的权威源：仓库根 `CONTEXT.md`（统一语言）与根 `AGENTS.md`（2.0 核心约定）。
> 本文锚点一律用「文件路径 + 符号/导出名」，不写死行号（行号漂移会让清单快速腐烂）。

## 适用场景

- 只在审查 **coding-workflow 自身源码**（`src/`）时启用；不限 harness / standalone——
  两种模式下本维度都在维度清单内（harness 判定的统一口径见 plan-completeness.md 的启用条件）
- 审查的项目特定约定分 4 个子维度：状态机正确性 / Gate 完备性 / 引擎层类型边界 / CLI 契约
- 判定结果分三档：**MUST_FIX / SUGGESTION / INFO**

## 判定档位语义

| 档位 | 含义 | 处理 |
|------|------|------|
| MUST_FIX | 违反引擎核心不变式（账本失守、投影被破坏、Gate 弱化、契约破裂），会导致流程崩坏或机器检查失效 | 记入 report，阻塞通过，必须先修 |
| SUGGESTION | 有改进空间但不阻塞（如错误消息缺恢复动作、注释与实现脱节） | 记入 report，建议修，不阻塞 |
| INFO | 仅提示（如新增规则建议补 e2e、命名与既有风格不一致） | 记入 report，可选 |

档位由「最严重的问题」决定：出现一个 MUST_FIX 级缺陷 → 该子维度记 MUST_FIX；只有 SUGGESTION 级 → 记 SUGGESTION；全无问题 → pass（不列条目）。

---

## 子维度 1：状态机正确性（事件账本 + fold 投影）

### 定义

2.0 的唯一真相源 = append-only JSONL 事件账本（`events.log`），六类事件封闭集
（UnitCreated / SpecSubmitted / VerdictSubmitted / EvidenceSubmitted / VerifyRan / ReflectionRan）。
**状态不存储只计算**：`status = fold(events)` 纯函数投影，四态
`created → spec-frozen → verified → closed`。没有「声明状态」的命令，只有「交证据」的命令——
补录结构性不可能。状态机失守 = 账本不变式被绕过或投影被污染，整个流程的可信前提崩塌。

### 核心文件

- `src/events/types.ts`（`EventType` 六类封闭集 / `EventPayloadMap` / `UnitStatus` 四态 / `UnitProjection` / `ACCEPTANCE_ID_RE`）
- `src/core/fold.ts`（`fold` / `deriveStatus` / `deriveStatusInTree` / `deriveStatuses`）
- `src/store/events-log.ts`（`EventLedger`：`append` 文件锁短事务「读末 seq → seq+1 → 追加 + fsync」、`readAll` 信封形状校验、损坏行带行号与恢复动作）
- `src/store/ledger-domain.ts`（`unitLedgerDomain` 写入不变式：孤儿事件拒绝 / UnitCreated 唯一 / EvidenceSubmitted 幂等）

### MUST_FIX 标准

- **事件封闭集不同步**：`EventType` / `EventPayloadMap` 新增成员时，`src/core/fold.ts` 的
  switch（含 `const _exhaustive: never` 穷尽性检查）与 `src/store/ledger-domain.ts` 的
  `knownEventTypes` 必须同步。漏一处 = fold 抛未知事件或读层信封校验拒绝
- **「状态只计算不存储」被破坏**：新增任何直接写状态、声明状态的路径（不经事件入账就改变
  投影结果）→ MUST_FIX。状态的唯一合法驱动方式 = 经 `EventLedger.append` 入账事件
- **ReflectionRan 参与状态派生**：ReflectionRan 是纯 append 记录（反思先于审查的锚记录），
  `fold` 只把它 push 进 `reflections`，**不参与四态派生**。若 `deriveStatus` /
  `deriveStatusInTree` 开始消费 reflections 判定状态 → MUST_FIX
- **fold 纯函数性破坏**：同一事件数组折叠两次结果必须 deep-equal（replay 幂等）。`fold` /
  `deriveStatus` 引入 IO、时钟、全局可变状态等副作用 → MUST_FIX
- **fold 对损坏输入静默跳过**：孤儿事件 / 重复 UnitCreated 在 append 侧已被
  `unitLedgerDomain` 拒绝，fold 再见到即事件流被外部改动——必须抛错（现状如此），
  改成静默跳过 = 把损坏伪装成正常投影
- **绕过 EventLedger.append 直写账本**：绕过文件锁短事务或域级写入校验（孤儿 / 重复创建 /
  幂等键）自行 fs.appendFile 写 `events.log` → seq 断裂 + 不变式失守
- **spec-review role 强校验弱化**：`src/handlers/review-submit.ts` 中 spec-review verdict
  必须由 `role=reviewer` 提交（缺/错 exit 1 纯拒绝、不产生任何事件）；`deriveStatus` 只消费
  `role === "reviewer"` 的 spec-review pass verdict（mx-3 纵深第二层，兜住绕过入账层的路径）。
  任何一侧被弱化（如接受 developer 自审的 spec-review）→ MUST_FIX

### SUGGESTION 标准

- `deriveStatus` / `deriveStatusInTree` 的转换条件变化未同步 `src/core/fold.ts` 模块头的
  四态公式注释（注释是语义权威出处，脱节 = 下一个读者被误导）
- 树感知 closed 判定出现平行实现（唯一出处 = `deriveStatusInTree`，
  `deriveStatuses` 只提供批量传播机制）

### 示例

```typescript
// MUST_FIX：绕过 EventLedger 直写账本（无锁、无域校验、seq 自算）
appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`); // 禁止

// pass：唯一合法写入口——文件锁短事务 + 域级校验
const envelope = ledger.append("SpecSubmitted", payload); // 读末 seq → seq+1 → 追加 + fsync

// pass：ReflectionRan 纯记录，不驱动状态
case "ReflectionRan":
  unit.reflections.push(event.payload); // 不触碰四态判定
  break;
```

---

## 子维度 2：Gate 完备性（spec 十四规则 + verify 三道 gate）

### 定义

Gate 是 CW 的核心价值（机器检查门，防 AI 谎报）。2.0 分两道防区：
**提交期** = spec gate 十四规则（`checkSpecRules`，多缺口全列不短路）；
**验证期** = verify 三道 gate（红阶段 → 名字级比对 → 干净 checkout 重跑）。

### 核心文件

- `src/gates/spec-rules.ts`（`checkSpecRules`：规则①-⑭；禁令/形态单一事实源枚举
  `ADAPTER_FLAG_CONTRACTS` / `FULL_REGRESSION_FORMS` / `DIRECTORY_FLAG_TOKENS` /
  `DIRECTORY_FLAG_EQUALS_PREFIXES` / `TYPECHECK_BINS` / `TYPECHECK_SCRIPT_NAMES`）
- `src/events/types.ts`（`AcceptanceType` 五枚举 `unit | integration | e2e-real | e2e-mock | manual`、
  `AcceptanceLayer`（`unit | topic`）、`ACCEPTANCE_ID_RE`、`SpecRulesResult`）
- `src/testrun/registry.ts`（`knownAdapterTypes`：vitest / e2e-sh / pytest / playwright，
  从 `defaultRegistry` 派生的 runner 合法值单一事实源）
- `src/verify/`（`red-phase.ts` 红阶段、`name-match.ts` 的 `nameMatch` 词边界比对、
  `checkout.ts` 干净检出、`run.ts` 的 `runAcceptances` + `adapterTypeFor` 路由）

### MUST_FIX 标准

- **多缺口全列不短路被破坏**：`checkSpecRules` 的 failures 收集循环里提前 return / 短路
  → 设计意图破坏（spec 一次提交应看到全部缺口，逐轮挤牙膏浪费回炉代数）
- **合法值单一事实源漂移**：
  - runner 合法值手写第二份清单（应调 `knownAdapterTypes()`，注册表扩容自动同步）
  - `ACCEPTANCE_ID_RE` 是 spec gate 规则⑦与 e2e-sh MARKER_RE 的同源锚，绕开它手写正则
    → 两路合法集漂移
  - 新增冲突形态（flag 禁令 / 全量回归形态 / 目录逃逸词法族）散落在枚举外多个函数
    → 禁止，必须进对应单一事实源枚举
- **verify 三道 gate 弱化**：
  - 红阶段（新测试打到实现前基线树必须挂）跳过条件扩大——唯一逃生口是 `--no-red-phase`
    显式 flag，任何「静默跳过红阶段」的改动 → MUST_FIX
  - 名字级比对（`nameMatch` 词边界匹配重跑产物用例名，非计数启发式）加 trim/substring
    容差，破坏「防 AI 谎报」设计意图 → MUST_FIX
  - 干净 checkout 重跑改绑执行瞬间的工作区状态（如复用当前工作树不检出账本 commit）→ MUST_FIX
- **fail 不入账**：VerifyRan fail 也入账留审计（exit 1 = 有 fail 且已入账），改成
  fail 不入账 = 审计断链、flake 连挂投影失真
- **解析失败口径回退**：e2e-sh「零标记行 + exit≠0」归解析失败（确定性挂，走
  specContractBroken 回炉通道），若改回混入 flake 通道 → MUST_FIX

### SUGGESTION 标准

- warning 级规则（⑪ 全量回归形态 / ⑬ typecheck script 名族 / ⑭ runner-type 隐式错配）
  升级为 fail 级但未论证误杀面（升级需说明为什么不误伤合法形态）
- 新增规则/适配器未补对应测试（`tests/` 按波次命名，与 `docs/rewrite/acceptance/` 基线对应）

### 示例

```typescript
// MUST_FIX：规则循环里短路，后续规则缺口不再列出
if (failures.length > 0) return { ok: false, failures }; // 禁止——多缺口全列不短路

// pass：failures/warnings 全程 push，末尾统一判定
return { ok: failures.length === 0, failures, warnings };
```

---

## 子维度 3：引擎类型边界（agent-agnostic）

### 定义

CW 是 agent-agnostic 引擎：**engine 不依赖任何 agent harness 能力**（无 skill 加载、
无 workflow 引擎），agent 只需通过 bash 调 `cw` 命令。本子维度审这条边界与引擎层
TypeScript 硬规则。

> 通用的「类型安全 / 错误处理 / 边界条件」范式审查归 quality-criteria.md（Subagent B）。
> 本子维度只审 CW 引擎特有的约定。

### 核心文件

- `src/dispatch.ts`（`CommandEntry` / `ALL_COMMANDS` / `dispatch`——platform-agnostic 命令分发）
- `src/store/project.ts`（`getCwHome` / `encodeCwd` / `ledgerPath` / `resolveProjectDir`——数据布局）
- `src/runner/loop.ts`（`runLoop` / `AGENT_SPAWN_TIMEOUT_MS`——runner 调度）
- `src/runner/spawn/`（human / pi 显式 spawn 后端，engine 接触 harness 的唯一许可位）

### MUST_FIX 标准

- **引擎核心域引入 harness 依赖**：`src/core/`、`src/events/`、`src/store/`、`src/gates/`、
  `src/handlers/`、`src/readonly/` import 任何 harness runtime / skill 体系 / 特定 agent CLI
  → MUST_FIX。spawn 适配只允许出现在 `src/runner/spawn/` 的显式后端（human / pi），
  新后端走同型适配注册，不污染 engine
- **引擎层裸 `any`**：项目硬规则禁止 `any`（用 `unknown` 或具体类型）；穷尽性检查用
  `const _exhaustive: never = action`。引擎层出现裸 `any` 且无注释 → MUST_FIX
- **账本读取绕过 EventLedger**：`events.log` 是外部可编辑输入，读取必须走 `EventLedger.readAll`
  （信封形状校验 + 损坏行抛带行号与恢复动作的错误）。裸 `readFileSync` + `JSON.parse` → MUST_FIX
- **根目录解析校验绕过**：`getCwHome` / `getCwWorktreeHome` / `resolveProjectDir` 要求覆盖值
  必须绝对路径（per-cwd 隔离与 worktree 布局依赖稳定唯一根）。改这些函数时放宽校验 → MUST_FIX
- **encodeCwd 编码规则单点漂移**：`encodeCwd`（`src/store/project.ts`）= 可读前缀
  （`\ / .` 三字符替换为 `__`）+ sha256(cwd) 前 8 位 hex 防碰撞后缀。改编码规则必须同步
  全部布局函数（`ledgerPath` / `gateLedgerPath` / `evidenceDir` / `worktreePath` 等）与
  外部检测脚本的同源口径，否则找不到账本

### SUGGESTION 标准

- 跨模块纯类型引用未用 `import type`，可能把循环依赖打进运行时
- 错误消息缺恢复动作（项目约定：错误信息必须可操作，形成「错误 → 权威源 → 重试」闭环；
  2.0 src 内既定风格是文案里直接给 `恢复动作：...`）

### 示例

```typescript
// MUST_FIX：引擎核心层直接依赖特定 harness
import { spawnPi } from "some-agent-harness"; // 禁止出现在 src/core、src/store 等

// pass：dispatch 是纯命令分发，spawn 后端隔离在 runner/spawn/
export async function dispatch(args: readonly string[], cwd: string): Promise<number>
```

---

## 子维度 4：CLI 契约（16 命令面 + exit 语义）

### 定义

CLI 是 agent 与引擎的唯一接口（agent 通过 bash 调 cw）。2.0 命令面 = **16 命令**：
unit 域 10（写 5：create / evidence submit / review submit / verify / setup-agent-dir +
跑 1：run + 只读 4：status / frontier / tree / report）+ gate/pipeline 域 6
（写 2：gate wrap / ci-judge + 跑 1：pipeline run + 只读 3：gate query / gate stats /
pipeline status）。本子维度审命令面一致性、exit 语义、双域隔离。

### 核心文件

- `src/cli.ts`（`main` / `ENV_ERROR_EXIT` / HELP 文本）
- `src/dispatch.ts`（`ALL_COMMANDS` 组装 / `matchByPrefix` + `findCommand` 最长前缀优先 / 未知命令返回 -1）
- `src/handlers/index.ts`（写 + 跑命令注册表 12 条）/ `src/readonly/index.ts`（只读命令注册表 4 条）
- `src/handlers/verify.ts` 与 `src/gate/wrap.ts`（三态 exit 常量与语义注释）

### MUST_FIX 标准

- **16 命令面漂移**：HELP 文本、`src/handlers/index.ts` / `src/readonly/index.ts` 注册表、
  `CONTEXT.md` 三处不一致；新命令未注册进对应域 index.ts（各域在自己的 index.ts export
  `commands: CommandEntry[]`，`dispatch.ts` 只组装不改写）→ MUST_FIX
- **exit 语义破坏**：
  - verify / gate wrap 三态：`0` = 全过（wrap 含缓存命中）/ `1` = 有 fail（**入账留审计**）/
    `2` = 环境错误（**不入账**）。挪用或互换 → MUST_FIX
  - cli.ts 未预期异常兜底 exit 2——预期错误（用法/校验/判定 fail）一律经 handler 返回值
    出口（exit 0/1/2），throw 穿透到 catch = 防线失守
  - `dispatch` 对未知命令返回 -1，cli 层转 exit 1 并提示 `cw --help`
- **最长前缀优先匹配被破坏**：`BY_NAME_LENGTH` 按子命令 token 数降序（防
  "evidence submit" 被 "evidence" 类短名截断匹配），改动排序或匹配策略 → MUST_FIX
- **只读命令写账本**：`status` / `frontier` / `tree` / `report` 恒只读，误改成写
  → MUST_FIX
- **双域硬隔离破坏**：unit 域（`events.log`，六类事件）与 gate 域（`gate-events.log`，
  `GateCheckRan` / `GateCacheHit` / `PipelineStepRan` 三类事件）各自独立 seq 空间、
  独立 fold（`src/gate/fold.ts`），仅共享泛化账本心（`EventLedger` 域描述符注入，
  `src/store/ledger-domain.ts`）。跨域写入 / 共享 seq / 域特化知识回流机制层 → MUST_FIX

### SUGGESTION 标准

- 新命令/新 flag 未同步 HELP 文本或注册表 `summary`
- 错误消息缺「如何修正」指引（应含恢复动作，而非只报「失败」）

### 示例

```typescript
// MUST_FIX：预期错误 throw 穿透，exit 语义误判
throw new Error("unit 不存在"); // 穿透到 cli catch → exit 2（环境错误），实际是用法错误

// pass：预期错误经 handler 返回值出口
stderr.write("cw: unit 不存在。恢复动作：先 cw create ...\n");
return 1; // 用法/校验类 fail，exit 1
```

---

## 分工边界（重要）

本文档**只审 coding-workflow 项目特有的约定**（状态机 / Gate / 引擎类型边界 / CLI 契约）。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 通用类型安全（any/as 断言的范式判定）、通用错误处理（try/catch 完整性）、通用边界条件、测试有效性 | Subagent B（读 quality-criteria.md） |
| spec/验收基线声明与实际交付的落地核对（spec 声明的用例、命令、文件有没有落地） | Subagent C（读 plan-completeness.md） |
| 通用代码风格、命名规范（camelCase 等） | Subagent B |

### 重叠处理

- **引擎层裸 any**：归本文档（Subagent A），因为它是 CW 项目硬规则（引擎层禁 any）——项目特定优先于通用
- **账本/gate 数据流上的错误处理**（EventLedger 损坏行文案、append 校验）：归本文档；
  与账本无关的通用 try/catch 完整性归 Subagent B
- **gate 规则与测试的对应**（规则/适配器改动是否补测试）：项目约定层面归本文档；
  测试断言是否具体归 quality-criteria.md

**重叠裁决**：同一缺陷最多被一个维度报告。全局优先级为 **C（spec 落地）> A（项目约定）> B（通用质量）**。当问题同时符合 A 和 B 时（如引擎层裸 any 既是项目硬规则又是通用类型安全问题），归 A（项目特定优先于通用）；当问题同时符合 A 和 C 时归 C。详见 review-aggregator.md 的去重规则。

---

## 返回值（stdout JSON）

审查完成后，维度报告写入编排器指定路径（如 `.review/run-<runId>/project-conventions.md`），
并向编排器返回：

```json
{ "report_file": "<维度报告绝对路径>", "must_fix": N, "suggestion": N, "info": N }
```

字段与 review-aggregator.md 的聚合统计约定一致。
