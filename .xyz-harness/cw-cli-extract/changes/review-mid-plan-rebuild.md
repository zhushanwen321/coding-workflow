---
verdict: changes_requested
mode: rebuild-reviewer
reviewer_frame: reverse-cognition (他证，禁读初稿重建后 diff)
source_materials:
  - main/CONTEXT.md
  - xyz-pi-extensions-workspace/main/extensions/coding-workflow/src/index.ts
  - src/cw/types.ts
  - src/cw/state-machine.ts
  - src/cw/store.ts (头部)
  - src/cw/gates.ts (头部)
  - src/cw/plan-parser.ts (前 160 行)
  - src/cw/actions/replan.ts (grep 验证)
confirmed_decisions_respected: [D-001, D-002, D-003, D-004, D-005, D-A]
---

# mid-plan 反向重建审查（rebuild reviewer）

## Verdict: CHANGES_REQUESTED

有 1 项 must_fix（replan 在 requirements 侧全程缺席，违反 G1 自设成功标准）。其余 4 项 should_fix + 2 项 nit。架构主线（适配层替换/engine 零改动搬迁/三重 guard/状态机表）经源码比对**准确**，设计立场成立。

---

## 重建结果摘要（独立重建，未读初稿前）

### Actor 清单
1. **Coding Agent**（主）— 经子进程驱动 CW 流程的 AI agent。当前 pi（经 registerTool），目标任意 agent（经 CLI spawn + 读 stdout JSON）。是 dispatch 的最终调用方。
2. **Skill 层**（上游供料者）— 产出 plan.json / clarify.json / detail.json 结构化 JSON（lite-plan / mid-plan / mid-detail-plan 等 skill）。**不属于 engine**，是 engine 的入参生产者；engine 不解析 skill，只消费其 JSON 产物。
3. **Composition Root / 适配层**（接线者）— 构造 ActionDeps 并调 dispatch。当前 = index.ts `execute()`；目标 = CLI 入口。

### 用例（engine 必须能经 CLI 触发的，= 9 个 CwAction）
- create（建 topic，锁 tier）
- plan（lite）/ clarify（mid）/ detail（mid）— 阶段 JSON 提交 + 结构 gate
- dev（渐进式 commitHash 提交，medium-git）
- test（渐进式；**lite=strong-recompute/judgeByExpected+screenshot，mid=medium-coverage/commitHash+claimedStatus**）
- retrospect（复盘报告，weak-structural）
- closeout（归档，weak-structural，终态不可逆）
- **replan**（append-only 追加 wave/testCase，planned/developed→planned，v1 lite）

### 数据流（重建）
```
Agent →[action+params]→ CLI 适配层(argv 解析/typebox 校验/构造 ActionDeps)
  → dispatch(params, deps) ── 纯函数，platform-agnostic
    ├─ guard 三重(checkLinear / checkPhaseCascade / checkCacheConsistency，读 store.loadTopic)
    ├─ action handler(读 store / 跑 gate=runGate|GitValidator|judgeByExpected / 写 store 事务 / 组 nextAction)
  → ActionResult(topicId,status,gatePassed,gateTier?,gateHistoryEntry?,nextAction,mustFix?)
  →[序列化 JSON + exit code]→ Agent(按 nextAction 推进)
```

### 领域模型（types.ts，搬运不变）
CwTopic(根：topicId/slug/tier/objective/workspacePath/topicDir/status/planFormat/waves/testCases/gateHistory/gatePassed/evidence?) → Wave(id/dependsOn/parallelGroup/committed/changes/issues) → TestCase(id/layer/scenario/steps/expected?/assertion?/executor/status/actual?/screenshotPath?/commitHash?/requiresScreenshot?) → ActionResult(DTO)。judgeByExpected 是 types.ts 内的纯函数（exact-match，零容差）。

### 边界（pi 耦合点，必须被 CLI 替换；engine 零 pi）
1. `ExtensionAPI` import + `pi.registerTool()`（index.ts）
2. `StringEnum`（@earendil-works/pi-ai，schema helper）
3. `CwParamsSchema`（tool 入参 schema）
4. `execute()`（composition root）
5. `renderSummary()`（pi TUI 文本渲染）
6. `resolveCwDbPath()`（硬编码 `~/.pi/agent/cw/`）
7. `encodeCwd`（与 subagents ADR-027 同源路径编码约定）

### 分层（engine 真实分层）
types(零运行时依赖) → state-machine / store / gates / plan-parser → actions/(9 handlers) → **dispatch(index.ts 顶部，纯路由=engine 入口)** → registerCodingWorkflowTool(index.ts 底部，pi 适配层=唯一 pi 耦合)。

### 状态机（TRANSITIONS 表，9 行）
create([]→created) / plan([created]→planned) / clarify([created]→clarified) / detail([clarified]→detailed) / dev([planned,detailed,developed]→developed,prog) / test([developed,tested]→tested,prog,reqDev) / retrospect([tested,retrospected]→retrospected,prog,reqTest) / closeout([retrospected]→closed) / **replan([planned,developed]→planned,prog)**。三重 guard 返回 GuardVerdict（illegal_transition / phase_incomplete / cache_inconsistent），不 throw。circuit breaker：同 phase 连续 fail≥5 切 guidance。

---

## must_fix（阻断项）

### M1. [MISSING / K] requirements.md §2 用例 + §4 功能清单 + §8 不做 — replan action 全程缺席
- **初稿**：UC-1~5 无 replan；F1~7 无 replan；§8「不做」未排除 replan；AC-5.2 只要求「一条完整 lite 流程 create→plan→dev→test→retrospect→closeout」（不含 replan）。
- **重建**：CwAction 是 9 值枚举含 `replan`；state-machine.ts TRANSITIONS 有 replan 行（`expectedStatuses:["planned","developed"], nextStatus:"planned", progressive:true`）；index.ts dispatch 有 `case "replan": return handleReplan(...)`；replan.ts 是 append-only 实现（追加 wave/testCase，已 committed wave 不可删改）。**replan 是一等 action。**
- **冲突点**：requirements §1 G1 成功标准明文「**engine 全部 action 可经 CLI 触发**并返回正确 ActionResult」+ G3「与现有 pi 扩展行为 100% 等价」。replan 是 action 之一，却无对应用例 / 无 `cw replan` 命令 / 无功能项 / 无 AC。
- **后果**：若按 requirements 立项构建 + 按 AC-5.2 验收，会漏掉 `cw replan`，直接违反 G1/G3。architecture.md §5 转换表虽含 replan 行（line 103），但 requirements 侧无需求牵引，需求与架构两侧不对齐。
- **修复**：requirements 补一个 replan 用例（append-only 追加 wave/testCase，已 committed 不可改）+ F 清单加一项 + AC-5.2 e2e 补 replan 路径（或至少单列 replan 等价断言）。
- **类型**：K（覆盖缺口）。

---

## should_fix

### S1. [MISMATCH / D-可逆] requirements.md UC-4 + AC-4.1 — status/list 是 CLI 新增能力（engine 无对应 action），且 buildNextAction 需 action 入参
- **初稿**：UC-4 把 `cw status` / `cw list` 当作用例，AC-4.1 称「status 输出与 engine loadTopic + **buildNextAction** 完全一致」。
- **重建**：engine dispatch 只路由 9 个 CwAction，**无 status/list action**（dispatch 无此 case）。`buildNextAction(action: CwAction, topic: CwTopic)` 签名**必须传 action** 才能产 nextAction。一个纯 status 查询没有「当前 action」概念。
- **问题**：初稿把 CLI 新增查询能力与 engine 9-action 流并列，且 AC-4.1 引用 buildNextAction 却没说 status（无 action）如何调用它。实现者会卡在「status 查询传什么 action 给 buildNextAction」。
- **修复**：UC-4 明确标注「CLI 新增查询能力（engine 无对应 action，非 G3 等价范围）」；并说明 nextAction 如何由 (tier,status) 反推（如 created+lite→plan），或降级为 status 只输出 status/gatePassed/waves 进度、不含 nextAction。
- **类型**：D-可逆（补一段说明，不改架构）。

### S2. [MISSING / D-可逆] requirements.md UC-3 AC — test 的 lite/mid 分歧在 AC 中完全未体现
- **初稿**：UC-3 标题「提交进度（dev/test 渐进式）」，但 AC-3.1/3.2 **只写了 dev 的 commitHash**（AC-3.2「无效 commitHash（git log 查不到）→ gate fail」是 mid test 语义）。
- **重建**：test 是 engine 里**分歧最大**的 gate——
  - lite test = `strong-recompute`：CW 用 `judgeByExpected(expected, actual)` **exact-match 重算**，**丢弃 claimedStatus**；`requiresScreenshot=true` 且 submission 缺 screenshotPath → failed。
  - mid test = `medium-coverage`：**信 claimedStatus** + GitValidator 校验 commitHash 可追溯到已 committed 的 dev commit。
- **问题**：UC-3 读起来像 test 只是又一个 dev 式 commit 提交，掩盖了 lite（机器重算+截图）vs mid（信声明+commitHash 追溯）的根本分叉。G3「100% 等价」覆盖 test，但 AC 无 lite/mid 分支断言。
- **修复**：UC-3 拆两条 AC——lite test（actual/screenshotPath + judgeByExpected 重算，claimedStatus 被丢）vs mid test（commitHash+claimedStatus，GitValidator 追溯 dev commit）。
- **类型**：D-可逆（补 AC）。

### S3. [MISSING / F] architecture.md §4 核心模型 — Wave 不变式「committed 一旦写入非空则不变（除非 replan）」与 replan.ts 源码冲突
- **初稿**（line 47）：Wave 不变式 = 「committed 一旦写入非空则不变（**除非 replan**）」。
- **重建**：replan.ts 头注释明文「**已 committed 的 wave 不可删/改**（保护 dev gate GitValidator 语义）」（line 9），实现里 `old.committed !== null` 的 wave 全字段不可改、不可删（line 79-92）。replan 是 **append-only**——只追加新 wave / 改未 committed 的 wave，**已 committed 的 committed 字段跨 replan 仍然不变**。
- **问题**：caveat「（除非 replan）」事实错误，暗示 replan 能重置 committed，与源码相反，会误导实现者对聚合一致性的理解。
- **修复**：删 caveat，改为「committed 一旦写入非空则不变（replan 为 append-only，已 committed 的 wave 不可删改，见 replan.ts）」。
- **类型**：F（事实性，与源码冲突）。

### S4. [MISSING / D-可逆] requirements.md UC-1 替代流程 + architecture workspacePath 解析 — 漏了 worktree cwd 防护
- **初稿**：UC-1 替代流程「workspacePath 用 `--workspace` 指定或 env 默认 process.cwd()」；architecture §7 resolveDbPath 只说脱离 pi 路径，未提解析健壮性。
- **重建**：pi adapter `execute()` 有显式 **worktree cwd 检测**（`fallbackCwd.includes("/.cw-wt/")` → 拒绝 process.cwd() fallback，强制显式 workspacePath 或 `CW_WORKSPACE_ROOT` env，注释 ADR-029 dataflow D1：worktree agent 漏传 workspacePath 会 encodeCwd(worktree路径) 打开空 _cw.json 数据隔离）。
- **问题**：G3 要求行为等价，但 workspacePath 解析的关键防护在 pi adapter 有、CLI 设计文档没继承。generic CLI 同样会被 worktree 内的 agent 误调（任意 agent 都可能在 worktree 里 spawn cw）。
- **修复**：补一条 workspacePath 解析健壮性约束（检测 worktree cwd / 拒绝模糊 fallback / 要求显式 --workspace 或 CW_WORKSPACE_ROOT），或显式声明「CLI 不做此防护，由调用方 agent 保证传 --workspace」并记风险。
- **类型**：D-可逆（补约束）。

---

## nit

### N1. [MISMATCH / F] architecture.md §8 — git 关系标签不一致
层级图（line ~155 mermaid）标 git 为「遵奉者」（conformist），关系表（line ~165）标「客户-供应商」（customer-supplier）。CW 经 execFileSync 调 git 子命令，CW 是客户、git 是供应商，表更准。统一为「客户-供应商」。

### N2. [MISMATCH / F] requirements.md UC-2 — retrospect 归为 single-shot，但 TRANSITIONS retrospect=progressive
UC-2 标题「推进流程（single-shot action）」隐含 retrospect 单发，但 state-machine.ts TRANSITIONS `retrospect.progressive = true`（expectedStatuses `[tested, retrospected]`，态内可重提交）。可辩护（语义上是一份复盘报告），但值得注一句「retrospect 转换表标 progressive（可重提交），UC 归 single-shot 是按语义归组」。

---

## 审查元注

- **确认决策未被当 gap 重报**：D-001（CLI 协议子命令+stdin/file）、D-002（存储 ~/.cw/+CW_HOME）、D-003（npm 包 bin=cw）、D-004（等价验证策略）、D-005（skill 原样透传）、D-A（适配层不抽象多 runtime port）均未在本报告列为发现。本报告的 must_fix/should_fix 都是**需求覆盖/事实准确性**问题，非决策挑战。
- **禁读纪律**：重建阶段严格未读两份初稿，先从 CONTEXT.md + 6 个源码文件独立重建 Actor/用例/数据流/模型/边界/状态机，再读初稿 diff。
- **架构主线肯定**：§2 设计立场（适配层替换/engine 三层零改动搬迁）、§5 状态机表（9 行逐一比对 TRANSITIONS 全部正确）、§6 Port/Seam 判断（ActionDeps 真 seam、CLI 协议假设 seam 不抽象=D-A）、§11 反模式 grep 清单——均准确且与源码一致。问题集中在 requirements 侧的覆盖完整性 + 个别事实性表述。
