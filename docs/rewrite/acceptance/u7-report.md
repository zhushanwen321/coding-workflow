# u7 验收报告：通用调度循环（AgentSpawn 后端无关）

> verifier 独立验收报告。基线：`docs/rewrite/acceptance/u7-acceptance.md`（commit `9c6af01`）。
> 验收时 HEAD：`3ed963b9efa8fdc327306d327eadb881c76d92d2`；验收时间：2026-08-15T13:14Z。

## 总结论：PASS（2026-08-15 复审改判——首验唯一阻塞项已修复并实证，见文末「复审附录」）

**阻塞项：`runLoop` 收尾路径存在产品级间歇崩溃——`killAll` 对「已自然退出的 in-flight」调 kill，macOS 上 `process.kill(-pgid, SIGKILL)` 对该场景返回 EPERM（非 ESRCH），异常未捕获直接从 `runLoop` 冒出。** 验收实测 `npx vitest run tests/u7-loop.test.ts tests/u7-e2e.test.ts` 连跑 10 次、2 次失败（20%），直接违反验收文档「通过命令」对 u7 自有测试稳定性的要求（详见 §5）。builder 汇报「复跑 3 全量 + 4 e2e 均绿、间歇失败未能复现、对唯一可疑路径（测试侧 waitExit）实证修复」——测试侧修复属实，但产品侧路径未覆盖，本次复现即为其未覆盖路径。

除该项外：防篡改、领地边界、命令实跑、条款对照、u5b 两文件适配裁决、行为对抗抽查 10 条全部通过。

## 1. 防篡改核对

| 项 | 结果 |
|----|------|
| `git diff 9c6af01 -- docs/rewrite/acceptance/u7-acceptance.md` | 空（无篡改） |
| 验收文档 sha256（基线 vs 工作区） | `20d35748434319334707d1fe07f0c9bae4e33137403fac559cffe1c3cc3b821f` 一致 |
| `git diff 9c6af01 --stat`（已提交部分） | 仅 u6b/u6c 领地 + 其报告 + ledger 流转，符合预期 |
| 工作区未提交改动（`git diff HEAD --stat` + untracked） | `src/handlers/run.ts`、`tests/u5b-e2e.test.ts`、`tests/u5b-loop.test.ts`（修改）+ `src/runner/loop.ts`、`tests/u7-loop.test.ts`、`tests/u7-e2e.test.ts`（新建）——全部在 u7 领地 + 预授权 u5b 适配范围内 |
| 已验收源域零改动核对 | `src/handlers/index.ts`、`src/handlers/types.ts`、`src/runner/human-loop.ts`、`src/runner/spawn/human.ts`、`src/runner/spawn/pi.ts`、`src/runner/spawn/lifecycle.ts` 对比 HEAD 无 diff |
| 认知外改动（不归属 u7，需主 agent 裁量） | `AGENTS.md` 1 行措辞改动（e2e 测试规范中 runCwCli/createCwCliEnv 的内联说明）；未跟踪文件 5 个：`wave-endstate-execution.drawio/.png/.svg`、`.$wave-endstate-execution.drawio.bkp`、`wave-endstate-execution.png` |

## 2. 命令实跑

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（tsc src + tests 双过） |
| `npm test` | exit 0，**28 文件 / 195 测试全绿**，33.27s |
| `npm run lint` | exit 0，零输出 |
| `npx vitest run tests/u7-loop.test.ts tests/u7-e2e.test.ts` 第 1 遍 | 7/7 绿，双叶重叠 402ms（leaf1:[1786799057862,1786799058370] leaf2:[1786799057968,1786799058581]，派发间隔 1ms） |
| 同命令第 2 遍起连跑共 10 次 | **2 次失败（§5），8 次全绿**；单跑 `tests/u7-loop.test.ts` 另 6 次全绿 |

## 3. 规格锁定条款对照（验收文档逐条）

### `src/runner/loop.ts`

| 条款 | 对照结果 |
|------|---------|
| `RunLoopOptions` 签名 + 默认值（poll 1000 / idle 30min / concurrency 3） | PASS：L49-56 与 L41-47 逐字段一致 |
| root closed → 0；无进展超时 → stderr + 1 | PASS：L329-334 / L382-386；u7-loop#2/#4 实证 |
| 循环逻辑 1（派发规则：created 无 spec→designer；spec-frozen→builder；verified→reviewer；spec 已提交未过审不重派） | PASS：`computeDispatchTargets` L130-159——`created && specs.length===0` 才派 designer（specs>0 时无 role 匹配即不重派）；builder 受 `childrenAllClosed` 约束（rootLast）；实测「同 (unitId,role) 无重复派发」（§6 C3） |
| 循环逻辑 2（brief 落 `<workdir>/.cw-spawn/<unitId>.<role>.brief.md`，内容 = unit 上下文 + role 任务书） | PASS：`writeBriefFile` L217-226 + `renderBrief` L188-214；u7-loop#2 断言三份 brief 存在且含原始任务书内容 |
| 循环逻辑 3（经 adapter.spawn，同批 ≤ maxConcurrency） | PASS：L337-357 派发闸门；验收#3 峰值恰 2 |
| 循环逻辑 4（轮询或 wait 先到者唤醒重算） | PASS：L360-363 `Promise.race`；`lifecycle.wait()` 幂等（`waitPromise ??=`，L241），每轮重复调用安全 |
| 循环逻辑 5（root closed 汇总每 unit 状态行） | PASS：`emitSummary` L237-249 |
| 循环逻辑 6（human 兼容：不感知适配器类型） | PASS：loop 无任何后端分支；u7-e2e human 回归全链 exit 0 |
| SPAWN_ERROR/TIMEOUT/CRASH 语义 | PASS：SPAWN_ERROR 回收返回 1（L370-374，D 组实证恰 1 次派发不重试）；TIMEOUT/CRASH 无特殊处理 = 下轮重算自然重派（与文档一致） |
| root 不存在 → 抛可操作错误 | PASS：L300-305；u7-loop#5 rejects 断言 + 适配器零调用 |

### `src/handlers/run.ts`

| 条款 | 对照结果 |
|------|---------|
| `--spawn` 路由（human/pi/未知） | PASS：`BACKEND_SPECIFIERS` 变量说明符 + 动态 import；未知后端 exit 1 可操作（§6 B2 实证文案含后端名/可选值/恢复动作） |
| 两族导出形态探测 | PASS：L86-90 `<name>Adapter` 常量与 `create<Name>Adapter()` 工厂都探测，`isAgentSpawnAdapter` 契约收窄（无编译期类型下的运行时守卫） |
| 模块缺席可操作错误 | PASS：L76-83 catch 转三段式错误（说明缺席原因 + build 恢复动作 + 替代方案）；变量说明符使 tsc 不做存在性检查（领地独立可编译，check:all 实证） |
| `--poll-ms/--max-idle-ms` 透传 + 新增 `--max-concurrency` | PASS：`parsePositiveIntFlag` 显式非法值（boolean/非数字/≤0）报错而非静默回退（B3 实证 `--max-concurrency 0` exit 1） |

## 4. u5b 两测试文件适配裁决

### tests/u5b-loop.test.ts 的 4 处（builder 超额披露项）

4 处全部位于「验收3 终止判定」「验收4 参数校验与注册」两组——均走 run handler dispatch 路径，run.ts 切换新 loop 后旧断言文本必然消失。逐条裁决：

| # | 位置 | 原断言 | 新断言 | 裁决 |
|---|------|--------|--------|------|
| 1 | 验收3 首测 | `待人工步骤=无`（M0 快照行） | `[runner] 循环启动：root=u-done` | **合理必然适配，强度等价**。M0 快照行随直连路径退役消失；替换断言同为「进入循环」存在性检查，主断言（exit 0 / closed / lastVerify:pass / cw report 提示）原样未动 |
| 2 | 验收3 空转测 | stderr 含 `无进展` | stderr 含 `无账本进展` | **合理必然适配，纯文案映射**。exit 1 + 恢复动作断言不变；且保留 `cw evidence submit --kind spec --unit u-stall --file spec.json` 指令断言（该行现由 humanAdapter 打印，与 u6b `src/runner/spawn/human.ts` L63 文案核对一致）——**指令生成断言零弱化** |
| 3 | 验收4 | `--spawn pi` → `M0 仅支持 human` | `--spawn nosuch-backend` → 后端名 + 恢复动作 | **合理必然适配，强度略增**。pi 自 u7 起为合法后端，旧反例语义已死；新断言直接回归验收文档锁定的「未知 → exit 1 可操作错误」新行为 |
| 4 | 验收4 同义测 | stderr 含 `无进展` | stderr 含 `无账本进展` | 同 #2，文案映射 |

**结论：4 处均为 run.ts 改造的必然适配，无一处为迁就新行为而弱化断言强度。** 验收1/2 组（buildStepInstruction/renderSnapshotLine 纯函数测试，不经过 run dispatch）零改动，与「文档只预授权 u5b-e2e 最小适配」的差异由此可解释：这两组恰恰是 builder 披露理由中「直接断言 run handler dispatch 行为」的部分。判定为合理超授权范围，建议主 agent 事后追认。

### tests/u5b-e2e.test.ts（文档预授权「最小改动并列理由」）

改动幅度大于字面「最小」（-37/+22 于全链测试），逐项核对：

- `waitExit` 增加 `child.exitCode !== null` 前置结算：**实证属实的竞态修复**（run 切 300ms poll 循环后人机赛跑窗口），与 u7-e2e 同款防护两处齐备。
- 删除 `waitForNewOutput` 同步等待机制、全链改为直线序列：**loop 模型变化的必然**——新 loop 无「待人工步骤=」阶段快照，无同步点可等。收敛断言（exit 0 / root closed / `cw status` closed / impl 与 demo 的 verify 真实 pass）全部保留。
- 指令文本断言（`cat brief.md` / `cw create --id impl` / `cw verify --unit impl`）删除：**转移而非丢失**——`tests/u6b-human-adapter.test.ts` L145 起对 humanAdapter 定点指令文本有专测；中断路径新增断言 `designer 指令：unit "stall"` 直接锚定 u6b 输出。
- `maybeIt`（dist/runner/spawn/human.js 缺席时 it.todo）：当前 u6b 已 committed + build，两测真实执行（npm test 195 全绿实证）。
- 弱化点披露：新版不再验证「指令内容与账本状态同步推进」（原版每步等指令再操作），收敛与 verify 真实性断言未弱化。判定可接受。

## 5. 阻塞项：间歇崩溃实证（kill EPERM）

**复现命令**：`npx vitest run tests/u7-loop.test.ts tests/u7-e2e.test.ts`，10 次连跑 2 次失败（另 6 次单跑 u7-loop 全绿；builder 自测期的「未能复现」与复跑次数/组合有关）。

**完整栈（留存 /tmp/u7-repro-2.log，iter2）**：

```
FAIL tests/u7-loop.test.ts > u7 验收#3 并发上限（另一失败为验收#2，详情未留存）
Error: kill EPERM
  at killTree (src/runner/spawn/lifecycle.ts:181:15)
  at Object.kill (src/runner/spawn/lifecycle.ts:248:7)
  at killAll (src/runner/loop.ts:232:19)
  at runLoop (src/runner/loop.ts:331:7)   ← root closed 分支的兜底 killAll
```

**机理**：loop.ts L329-334 在 root closed 时无条件 `killAll(inFlight)`；此时 in-flight 中可能存在「进程已自然退出、但其 wait() 尚未被本轮 race 结算」的 flight（race 每轮只结算一个，或 sleep 分支先到）。对已消亡进程组 `process.kill(-pgid, "SIGKILL")` 在 macOS 上可返回 EPERM 而非 ESRCH（实测行为；推测与 zombie/组消亡时序相关），lifecycle.ts L183 只豁免 ESRCH，EPERM 重抛，异常冒出 `runLoop` → 测试 reject（期望返回 0）。

**影响**：真实使用中 root 收敛时刻若有 agent 恰刚退出（并发场景必然存在的窗口），`cw run` 以未捕获异常崩溃而非 exit 0 + 汇总。账本无损（append-only），但进程出口违反契约。同类触发点还有两处：SPAWN_ERROR 回收的 `killAll`（L372）、idle 出口的 `killAll`（L384）。

**归责与修复建议**（verifier 不修，仅定位）：`lifecycle.ts` 属 u6a 禁改领地；但 `loop.ts:331` 的无条件 killAll 在 u7 领地内可修——例如仅对「未结算退出」的 flight kill、或在 loop 层捕获 kill 的 EPERM/ESRCH 类错误按「已退出」处理。修复后需连跑 ≥10 次双文件组合验证。

## 6. 行为对抗抽查（真实调用 + tmp repo + 隔离 CW_HOME，探针在 /tmp/cw-u7-adv/）

| # | 场景 | 结果 |
|---|------|------|
| A1 | `cw run --root ghost`（root 不存在，run.ts 前置层） | PASS：exit 1，stderr 含恢复动作 + cw status 指引 |
| B1/B2 | `cw run --root <real> --spawn no-such-backend` | PASS：exit 1，stderr `未知 --spawn 后端 "no-such-backend"（可选：human、pi）…恢复动作：…` |
| B3 | `--max-concurrency 0` | PASS：exit 1，`须为正整数` 可操作错误 |
| C1 | maxConcurrency=1 双叶 spec-frozen fixture 直调 runLoop | PASS：全链收敛 exit 0 |
| C2 | 两叶 [EvidenceSubmitted, VerifyRan] 区间重叠 | PASS：**严格不重叠**，overlap=-761ms（与验收#3/u7-e2e 的并发场景互补：上限生效时不重叠，上限放开时重叠 402ms） |
| C3 | 同 (unitId,role) 重复派发 | PASS：全部 6 组 (unitId,role) 恰各 1 次（账本无进展的 in-flight 期间不重派） |
| C4 | rootLast | PASS：root builder 派发时刻（…7245）晚于两叶 reviewer 最晚时刻（…7073） |
| D1-D4 | pi 后端 PATH 不可解析（node 可解析、pi 不可解析的隔离 PATH） | PASS：runLoop 返回 1；SPAWN_ERROR 文案 + 恢复动作；**builder 恰派发 1 次不重试**；`退出 SPAWN_ERROR` 归因行存在 |

双叶子重叠断言真实性核对（验收文档 E2E 条件 2）：区间取自账本事件信封 ts（`eventTs` → `Date.parse(hit.ts)`，非测试进程自记时间）；`overlapMs = min(end) − max(start)` 数学正确；断言 `toBeGreaterThan(0)` 严格大于零（非 ≥0、非存在性）；辅以同批派发间隔 <1000ms 断言。实测 402ms。**真实。**

并发上限计数包裹点核对（验收#3）：适配器 `spawn()` 进入即 `inFlightCount += 1` 并更新 peak，`wait()` 首次完成经 `decremented` 守卫减一（重复 wait 不重复减）；峰值断言 `toBe(2)`（恰 2，非 ≤2 的弱断言，另有一个 ≤ 语义在同断言注释中）。**真实。**

### 探针自纠记录（避免误判产品 bug）

- 首版 B/D 探针因 macOS `/var` vs `/private/var` realpath 差异，CLI 子进程与直调 seed 落到不同编码账本目录——探针环境问题（u7 测试文件自身用 `realpathSync` 规避），修正后通过。
- 首版 D 探针清空 PATH 同时打坏了 spec gate 规则③（e2e command 首 token 须 PATH 可解析，`src/gates/spec-rules.ts` L93 读 `process.env.PATH`），导致状态退化 created、空转 10s 走 idle 出口——探针设计问题，改用「node 可解析、pi 不可解析」的隔离 PATH 后 SPAWN_ERROR 路径真实触发。

## 7. 其余超额披露核对

| 披露项 | 核对结果 |
|--------|---------|
| Node 竞态（子进程退出后挂 exit 监听不触发）→ waitExit 前置 `exitCode !== null` | 属实：`tests/u7-e2e.test.ts` L151-158 与 `tests/u5b-e2e.test.ts` waitExit 两处齐备，注释一致 |
| human-loop.ts 保留未动、run.ts 不再调用、退役建议待 M1 收口 | 属实：human-loop.ts 零 diff；run.ts import 仅 loop/spawn-types；`buildStepInstruction` 仍被 u5b-loop（纯函数组）与 u7-e2e humanDrive 消费 |
| SPAWN_ERROR/TIMEOUT/CRASH/exit≠0 语义 | 属实（§3、§6 D 组） |

## 8. 结论

- **FAIL**：唯一阻塞项为 §5 的 kill EPERM 间歇崩溃（产品代码，u7 领地内可修）。修复并连跑 10 次双文件组合全绿后可复审，其余项无需返工。
- u5b-loop 4 处适配：全部合理必然，无断言弱化。
- u5b-e2e 适配：幅度超「最小」但逐项有据，建议主 agent 追认。
- 认知外改动（AGENTS.md 措辞行 + drawio 系列未跟踪文件）移交主 agent 裁量，verifier 未触碰。


## 复审附录（2026-08-15，针对性复审：仅验修复项与回归，其余项沿用首验结论）

**复审结论：PASS。** 首验唯一阻塞项（§5 kill EPERM 间歇崩溃）的修复属实、可证伪、无回归，总结论由 FAIL 改判 PASS。

### 修复核对

| 项 | 结果 |
|----|------|
| `killAll` 改 best-effort（src/runner/loop.ts L238-249） | 属实：逐 flight try/catch，单个 kill 异常写 stderr 一行可见性（含 role / unitId / 错误消息，文案「兜底 kill 失败…目标进程多半已退出，忽略」），不抛、不影响返回码；未改 lifecycle.ts（对比 HEAD 零 diff） |
| 出口覆盖 | 三出口共用同一 `killAll`，实际调用点 4 处：root 中途消失（L341）/ root closed（L348）/ SPAWN_ERROR 回收（L389）/ idle 超时（L400）——声明列三出口，root 消失分支走同一函数同样被覆盖，无遗漏 |
| 领地边界 | `lifecycle.ts` / `human-loop.ts` / `spawn/human.ts` / `spawn/pi.ts` / `handlers/index.ts` / `handlers/types.ts` 对 HEAD 零 diff；`run.ts` 与 `u5b-e2e` / `u5b-loop` 的工作区 diff 与首验 §3/§4 记录逐项吻合（u7 开发期适配，非修复阶段引入）；认知外改动（AGENTS.md 措辞行 + drawio 系列未跟踪文件）维持首验时原样未扩大 |
| 新回归测试 | `tests/u7-loop.test.ts` 末 describe「修复回归：killAll 兜底清理是 best-effort」：真实 stale worker 一步直推 root closed 后退出 + 适配器 `wait()` 永不结算（钉死 race 未消费时序）+ `kill()` 先转发真实 `handle.kill()` 再抛模拟 EPERM——红性不依赖 OS 对死组返回 EPERM 还是 ESRCH，确定性构造成立；断言返回 0 / root closed / killCalled / stderr 含「兜底 kill 失败」 |

### 命令实跑（首验失败口径 + 全量）

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u7-loop.test.ts tests/u7-e2e.test.ts` 连跑 10 次 | **10/10 全绿**（每轮 8/8：u7-loop 6 + u7-e2e 2；首验同口径 2 败/20%） |
| `npm test` | exit 0，28 文件 / **196 passed**（首验 195 + 新回归 1） |
| `npm run check:all` / `npm run lint` | 均 exit 0、零输出 |

### 红性验证（缺陷行为复现）

临时把 `killAll` 恢复为裸调用（无 try/catch）→ build → 跑新回归测试：**红**，栈精确命中 `killAll src/runner/loop.ts:240 → runLoop src/runner/loop.ts:339`（root closed 分支），错误即模拟 `kill EPERM（模拟：macOS 已自然退出但未结算的进程组）`。还原后 `cmp` 与复审开始时逐字节一致（RESTORED_BYTE_IDENTICAL），重跑双文件组合 8/8 全绿，结束时工作区 `git status` 与复审开始时完全一致。

builder 声明的失败栈行号（killAll 231 / runLoop 331）与本轮实测（240/339）差 9 行：声明取修复前原始文件行号，本轮红性恢复版保留了修复版注释块（多 9 行所致），命中形态一致（killAll → runLoop root closed 分支），不构成矛盾。

### 行为对抗（真实调用直调 dist + tmp repo + 隔离 CW_HOME，探针 /tmp/u7-recheck-adv.mjs，10/10）

| # | 场景 | 结果 |
|---|------|------|
| A1-A5 | idle 超时出口：挂住真实 worker 不写账本 → maxIdleMs 出口 killAll，适配器 kill 转发真实 kill 后抛模拟异常 | PASS：runLoop 返回 1 不抛；stderr 含空转文案 + 「兜底 kill 失败」可见性行（含 `designer unit "root"` 与错误消息）；真实挂住进程被 kill 回收（pid 实证死亡） |
| B1-B5 | SPAWN_ERROR 回收出口：同批 sroot（lifecycle 同步抛转 SPAWN_ERROR，仿 pi 适配器真实形态）+ stall（挂住真进程 + kill 抛异常） | PASS：runLoop 返回 1 不抛；SPAWN_ERROR 归因文案 + 恢复动作在；stall 的 kill 异常被吞且留可见性行（含 `designer unit "stall"`）；stall 真实进程被回收（wait() settle CRASH 带 pid） |

探针自纠记录（避免误判产品 bug）：B5 首版从 stall stdout 文件读 pid 得 NaN——kill 与 spawn 同毫秒，node runtime 尚未执行到打印行；改经幂等 `handle.wait()` 的 CRASH settle 结果取真实 `child.pid`（产物落盘与进程死活本就解耦），属探针设计问题非产品问题。

### 复审结论

- **PASS**：修复（best-effort killAll + stderr 可见性）覆盖全部收尾出口，回归测试确定性钉死契约且红性已实证；首验失败口径 10 连跑全绿，全量 196 绿，check:all / lint 过；行为对抗 10/10。
- 红性验证的临时改动已完全还原，复审未修改复审附录与总结论行之外的任何内容。
