# fx-2 验收报告：集成层死锁 R4 修复（恢复出口 + 重派上限）

> verifier 独立验收报告。验收基线：commit `ddc5a84` 的 `docs/rewrite/acceptance/fx-2-acceptance.md`。
>
> **总结论：PASS**（验收文档全部条目证实；4 条回归测试经基线影子工程复现为全红（修复前）/全绿（修复后）；5 项行为对抗抽查全过；2 项观察不构成失败，见 §6）。

## 1. 防篡改核验

| 检查 | 结果 |
|------|------|
| `git diff ddc5a84 -- docs/rewrite/acceptance/fx-2-acceptance.md` | 空（无篡改） |
| 工作区文件 sha256 | `cb55d1b96ccf5abd8faeba075ba528dfa89f3029b5022befa4d72a98126372fc` |
| `git show ddc5a84:<file>` sha256 | 一致（同上，diff 为空即逐字节相同） |

### diff 边界（`git diff ddc5a84 --stat`）

修改 2 个授权对象文件 + 1 个认知外文件；新增 1 个授权测试文件 + 认知外未跟踪产物：

- 授权：`src/runner/loop.ts`(+159/-18)、`src/runner/integrate.ts`(+76/-1)、`tests/fx2-integration-recovery.test.ts`（新文件，453 行）
- 认知外（非 builder 产物，不阻断，与 fx-1 报告 §1 的披露相同批）：`AGENTS.md` 一行（e2e 测试基建描述措辞；mtime 早于 builder 交付文件约 29 小时，非本次 builder 改动）；未跟踪 `wave-endstate-execution.drawio/.png/.svg`、`.$wave-endstate-execution.drawio.bkp`（diagram 产物）
- `src/core/fold.ts`、`tests/u8-*`、fx-1 全部交付文件：零改动 ✅（u8 零适配、fx-1 零回退的 diff 侧证据；测试侧证据见 §2）

## 2. 通过命令实跑（工作区当前状态）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（tsc src + tests） |
| `npm test` | **222/222 全绿**（36 个测试文件；跑 2 遍均 exit 0；= 基线 218 + fx-2 新增 4） |
| `npm run lint` | 零输出，exit 0 |
| `npx vitest run tests/fx2-integration-recovery.test.ts` × 2 遍 | 两遍均 4/4 全绿（时序敏感项：回归4 实测 3593ms / 3543ms，远低于 20s 上限） |

fx-1 回归文件（`fx1-r1-split-selfref` / `fx1-loop-dispatch` 等）在全量中绿 → fx-1 零回退。u8 集成测试全绿且文件零改动 → u8 零适配证实。

### 红绿声明独立复现（基线影子工程）

方法：`git archive ddc5a84` 导出 `/tmp/fx2-baseline` → 拷入 fx2 测试文件 → 软链 node_modules → `npm run build`（exit 0）→ 跑同文件。

结果：**4 failed / 0 passed**，全部以 vitest 超时形态失败（30s/60s）——正是 R4b 现场：修复前集成 fail 的 VerifyRan 每轮入账喂活 idle 判定，`runLoop` 永不返回。builder「4 条与终验现场同构」的真实性由此双向证明（基线全红 / 修复后全绿）。

## 3. 修复点逐项对照

### R4a-1 重派上限 + designer 出口 — 证实

- **计数从原始事件流重放**（`src/runner/loop.ts:223-238` `consecutiveIntegrationFails`）：`SpecSubmitted` → 该 unit 清零；`VerifyRan` → fail 时 `previous+1`、pass 清零。按 `payload.unitId` 逐 unit 记账。主循环每轮 `new EventLedger(...).readAll()` + `fold(events)` 一体装载（loop.ts:701-702），与 `loadLedger` 逐行等价（load.ts:31-36 同为 readAll+fold；循环入口已保证账本存在，无行为差）。计数不经 fold 投影的原因属实：`SequencedUnitProjection` 的 specs/verifyRuns 是平行数组，跨类型相对顺序已丢失（fold.ts 不在 diff 中，未改）。
- **上限判定**（loop.ts:277-288）：内部节点、子全 verified、`consecutiveFails >= 2` → `role="designer"`（不派集成）；否则照旧集成。**无 off-by-one**：fail#1 后计数 1 < 2 → 第 2 次集成照发（回归1 证实恰 2 次）；fail#2 后计数 2 ≥ 2 → designer 出口（回归2 证实无第 3 次；影子基线证明修复前是无限次）。
- **三类 designer 任务书**（loop.ts:552-560）：`spec-frozen` → `integrationDriftTasks`（fx-2 契约漂移处置）；`created && specs>0` → `reReviewTasks`（fx-1 R2 补审）；`created && specs==0` → 首派模板。判定口径与 `computeDispatchTargets` 同一投影、同入口状态。

### R4a-2 designer brief 内容 — 证实

`integrationDriftTasks`（loop.ts:488-543）：

- **契约清单来自最近集成报告**：取最后一条 `runId.startsWith("integrate-")` 的 fail run，经 `readIntegrateReport`（integrate.ts:219-232）读 `integrate-report.json`；路径构造与写入端同源（`evidenceDir(cwHome, cwd, rootId, runId)` + 同名文件）。报告内 `contracts.failures` 为机器判定原文（contract-match.ts:75 含契约 id + signature + 期望 file），失败验收 id 从 `acceptanceBatches` 提取（带 unit 归属）。
- **形状守卫**（integrate.ts:235-259）：unknown → IntegrateReport，只校验消费端字段。运行时探针四路径：runId 不存在 → null；JSON 损坏 → null；kind 错 → null；`contracts.failures` 非数组 → null；合法报告 → 正确解析（含 guidance 段）。
- **不可读降级**：null → 列当前冻结 spec 契约全集（无契约时如实说明 fail 来自验收红/可达性）+ 指向 `cw report --unit <id>` 查证命令——错误可操作闭环成立。
- **二选一处置文案单一出处**：`integrationRecoveryGuidance`（integrate.ts:202-212）唯一定义、导出，loop.ts:56 导入；brief 侧（integrationDriftTasks 末段）与 stderr 侧（integrate.ts:177-179 push 进 failures → loop.ts:427-435 透传 stderr）同函数同 unitId 调用，文本恒等。回归2 双出口断言均绿。

### R4a-3 处置后恢复 — 证实（端到端）

回归3 全链绿（两遍）：designer 重提修正契约（`export function` → `export async function`）的 spec + spec-review pass → `SpecSubmitted` 清零计数 → root 回 spec-frozen → 第 3 次集成在新契约下 pass → root verified → reviewer exec-review pass → root+leaf 全 closed、exit 0；派发序列 designer → reviewer、全程无 builder。

### R4b idle 兜底恢复 — 证实（最小化）

- idle 判定段（loop.ts:793-802）**未改动**（diff 无该区 hunk）——R4b 无独立代码改动属实，修复即上限本身：上限后集成不再写 fail VerifyRan → `totalEvents` 停止自我喂食 → maxIdleMs 正常触发。
- 回归4 实测：maxIdleMs=3000ms，noop designer 下恰 2 次集成后 idle exit 1，elapsed 3593/3543ms < 20s。

## 4. 行为对抗抽查（5 项）

1. **计数跨 unit 隔离**（运行时探针）：root 子树外旁观者 unit 在 root 第 1 次集成 fail 落账后注入一条 VerifyRan pass（事件真实入账）。结果：root 集成序列仍恰 `["fail","fail"]`、designer 出口照常触发——计数只数该 unit 自身事件，任何其他 unit 的 pass 不清零。若实现有跨 unit 污染会出现第 3 次集成，未出现。
2. **上限后不再派集成**（运行时探针）：noop designer 秒退 → 循环反复重派 designer（5s idle 窗口内 230 次 spawn），期间**零**新增集成（仍恰 2 次）——上限切断审计事件回路后无任何「重新 spec 前又跑一次集成」的路径；最终有界退出（elapsed 5404ms ≈ maxIdleMs 5000ms，exit 1，stderr 含「无账本进展」）。
3. **off-by-one 边界**：fail#1 与 fail#2 之间无停（回归1 恰 2 次）；fail#2 后即停（回归2 恰 2 次且 idle 窗口约百轮重算无第 3 次；影子基线修复前为无限次）。两向夹逼，「恰在第 2 次 fail 后停」成立。
4. **guidance 双出口一致性**：同函数同 unitId 单一出处（§3 R4a-2）；stderr 实跑含①②全文、brief 断言含命令原文与「closed 的 provider 无自动回退通道」边界披露。
5. **报告守卫与降级**：探针四路径全符合预期（§3 R4a-2）；降级分支代码路径清晰（fallback → 冻结 spec 契约全集 + `cw report` 指引）。

与验收文档矛盾项：无。

## 5. builder 声明逐项核实

| # | 声明 | 核实 |
|---|------|------|
| 1 | 计数从原始事件流重放（SpecSubmitted 清零 / fail +1 / pass 清零）；主循环 readAll+fold 一体装载 | ✅ loop.ts:223-238, 697-702；fold.ts 未改 |
| 2 | 连续 fail ≥2 → designer 出口；guidance 单一出处；三类 designer 任务书按入口状态区分 | ✅ §3 R4a-1/R4a-2 |
| 3 | R4b 无独立代码改动，idle 判定未动 | ✅ diff 无 idle 段 hunk |
| 4 | 4 条 fixture 与终验现场同构（async 签名差）；u8 零适配；fx-1 零回退 | ✅ fixture 契约 `export function renderMarkdown(` vs 实现 `export async function renderMarkdown(` 与 final-gate-2-report §4/L134 根因现场一致；u8/fx-1 文件零改动且测试绿 |
| 5 | 222 全绿 | ✅ 36 文件 / 222 测试，2 遍 exit 0 |

## 6. 观察项（不构成失败）

1. **失败计数文案虚高 1**（minor，`src/runner/loop.ts:429-430`）：`runIntegrationVerify` 在 !ok 时把 guidance 追加进 `failures`（验收文档 sanctioned），loop 的 stderr 头行 `失败（${result.failures.length} 项` 把 guidance 也计入——「失败（2 项」实为 1 项失败 + 1 段恢复指引。仅审计文案观感，不影响任何判定/断言（回归测试断言的是内容非计数）。
2. **上限后 designer 每轮重派**（behavior note）：designer 进程退出且未写事件时，下轮重算再次派发（探针 5s 内 230 次），直至 idle 到期。有界、与 u7 既有「四态退出可重派」语义一致、不违验收硬性要求（≤2 次集成、不无限循环、maxIdleMs 内 exit 1）；验收口径行「1 次 designer 派发」按场景素描理解（回归4 测试也只断言 ≥1）。若终验认为应「派一次后静默等 idle」，属产品决策非本修复缺陷。

## 7. 结论

**PASS**。fx-2 交付满足 `fx-2-acceptance.md` 全部条目：R4a 恢复出口（上限 + designer brief + 处置后全链恢复）、R4b 有界退出（上限即修复，idle 语义回归）、4 条回归测试真实（基线全红/修复后全绿）、218 既有测试零回退（u8/fx-1 零适配零改动）。可流转 verified → commit。
