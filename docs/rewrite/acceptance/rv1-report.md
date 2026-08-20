# rv-1 验收报告：spawn/loop 健壮性（EPERM 兜底 + Ctrl-C 孤儿清理）

> verifier 独立验收报告（对抗式；builder 自报逐项证实）。验收基线：`docs/rewrite/acceptance/rv1-acceptance.md` @ 9023076。
> 验收时间：2026-08-18。verifier 工作区 HEAD：`1bbbf4d`。

## 总结论：**PASS**

## 1. 基线与防篡改

| 项 | 结果 |
|----|------|
| `git diff 9023076 -- docs/rewrite/acceptance/rv1-acceptance.md` | **空**（无篡改） |
| 验收文档 sha256 | `3449be0a6ecfff60e61ba7c4cbca3d2dc238cd1a918f2aa59c6bf558c62675b8` |
| `git diff 9023076 --stat` 领地限定 | rv-1 领地 3 文件之外仅豁免项：rv-2 领地 9 文件（src/events/types.ts、src/gates/spec-rules.ts、src/handlers/{evidence,review}-submit.ts、src/testrun/e2e-sh.ts、src/verify/{checkout,run}.ts、tests/u2-review.test.ts、tests/u5b-e2e.test.ts）+ 主 agent 已 commit 的 rv-3 工作（1bbbf4d：contract-match 等 5 文件）+ ledger.md 主 agent 记账（fx-3 行）+ 主 agent 预写未跟踪 docs（rv4/rv5/mx2-acceptance.md） |
| 越界扫描（`git status`） | rv-1 builder 无越界写入。既有测试文件（u6a/u6b/u7/u7b）零适配零改动——handler 设计未破坏既有断言，符合验收 §2「仅限必要适配」 |

复核中途工作区出现的其他改动（tests/fx4-topic-artifacts、u7-e2e、wt5-parallel-contamination 被修改；docs/rewrite/design-independent-review.md 未跟踪消失）属并行 agent（rv-2 builder / 主 agent）中途态，时间线与内容均与 rv-1 领地无关，verifier 未触碰。

## 2. runLoopMain 重构零行为变化核实（本 unit 最大风险点）

对 `git diff 9023076 -- src/runner/loop.ts` 逐行核对，全部 hunks 仅四类改动：

1. 新增 `LOOP_SIGNAL_EXIT_CODES` 常量与 `makeLoopSignalHandler`（模块私有，不触碰既有逻辑）；
2. 新增外壳 `export async function runLoop`（注册 SIGINT/SIGTERM → try/finally 中 `await runLoopMain` → `process.off`）；
3. 原主体仅签名变化：`export async function runLoop(opts)` → `async function runLoopMain(opts, inFlight)`；
4. 原主体仅删除一行：内部 `const inFlight: InFlightSpawn[] = [];`（提升为外壳入参）。

**主体其余逻辑（约 1043-1300 行区域）零改动。** 关键引用安全核实：`inFlight` 在 runLoopMain 内仅 `push`（L1251）/`splice`（L1264）/`map`（L1259）/`length` 判断 / `killAll`——**无任何重绑定**，外壳与 handler 持有的数组引用全程有效。

行为差异清单（全部为设计内特性，非回归）：

| 差异 | 判定 |
|------|------|
| runLoop 运行期间注册信号 handler（新特性本体） | 验收 §2 要求 |
| 外壳多一跳 async 调用（微任务级延迟） | 无语义影响 |
| throw 路径先经 finally 移除 handler 再向调用方传播 | 调用方所见异常与返回值不变；u7「root 不在账本抛可操作错误」等语义由 35/35 绿证实未破坏 |
| 信号到达时 handler `process.exit` 不经过 finally | 注释已声明设计行为（process.exit 不回卷栈），非泄漏 |

调用方唯一（`src/handlers/run.ts:150`），正常出口返回值（0/1）与退出码全部不变。

## 3. 限定命令实跑（verifier 本机，2026-08-18）

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/rv1-spawn-robustness.test.ts tests/u6a-lifecycle.test.ts tests/u6b-human-adapter.test.ts tests/u7-loop.test.ts tests/u7b-loop-timeout-reset.test.ts tests/u5b-e2e.test.ts` | **35/35 绿**（6 文件，17.51s；红灯复核后复跑再次 35/35 绿） |
| `npx eslint src/runner/spawn/lifecycle.ts src/runner/loop.ts tests/rv1-spawn-robustness.test.ts` | **0 问题**（exit 0） |
| `npm run check`（tsc --noEmit） | **0 错误** |

注：验收文档 §6 命令中的 `tests/u6b-human.test.ts` / `tests/u7b-timeout.test.ts` 为基线文档文件名笔误（9023076 时实际文件即 `u6b-human-adapter.test.ts` / `u7b-loop-timeout-reset.test.ts`），按实际文件执行，非 builder 过错。

## 4. 真实性抽查（builder 自报证实）

- **T3/T4 真实子进程**：证实。`startSignalRunner` 用 `child_process.spawn` 跑真实 `node dist/cli.js run --root <r> --spawn human --max-idle-ms 60000`，stdout/stderr 落盘（openSync fd 重定向），等派发行出现后 `child.kill(signal)`——非进程内模拟。
- **退出码断言真实性**：证实。断言 `exited.code === 130/143` 且 `exited.signal === null`（handler 主动 process.exit 的证据，与默认信号死亡区分）；2s 超时拒绝并附 stderr 现场。
- **无残留断言真实性**：证实。`ps ax -o command=` 全表快照（BSD ps 非 tty 输出不截断命令列）按场景 tmp 路径正则过滤——任何命令行含该路径的进程即残留，语义真实。
- **T2 竞态真实性**：证实。22 次真实循环（存活期 22→60ms 阶梯横跨 timeoutMs=50ms 两侧 + 2×300ms 示例形态），每次真实 spawn `node -e "setTimeout(() => process.exit(0), N)"`。
- **账本完整可读**：EventLedger readAll 解析 + 真实 `cw status` exit 0 双断言，真实。
- **builder 本机探针自报**（200 窗口 2 EPERM + 8 ESRCH）：verifier 无法复算其原始数据，但红灯形态 1 下独立复现 EPERM（见 §6），事实成立。

## 5. 行为对抗抽查记录（真实子进程 + tmp，verifier 自建脚本于 /tmp）

| # | 场景 | 结果 |
|---|------|------|
| 1 | 连续快速双 SIGINT（back-to-back 两连发） | **PASS**：exit 130、signal null、提示行恰 1 次（第二发落在 process.exit 后）、无 stacktrace、ps 零残留——无二次 killAll 异常 |
| 2 | 派发行出现后 +60ms（human 指令打印窗口内）发 SIGINT | **PASS**：exit 130、无残留；**提示行完整落盘**——正则全文匹配至结尾「…重跑 cw run --root \<id\> 即续。\n」，writeSync 同步写证实（异步 write 在 process.exit 时会丢，此处无丢失面） |
| 3 | 极早期信号（spawn 后 300ms 固定延迟） | **PASS（观察）**：派发已发生、exit 130、零残留 |
| 4 | 空 inFlight 窗口扫描（spawn 后 40-280ms × 7 档 × 3 次 = 21 次） | **零命中「回收 0 个」**：160-280ms 段稳定 130/「回收 1 个」——handler 注册到首派发之间为微任务级间隔，外部信号结构性不可落入；≤120ms 信号落在 handler 注册前 = Node 默认 SIGINT 死亡（此时零派发零孤儿，无回收需求，Node 固有窗口，非缺陷）。handler 对空集的语义（killAll 空数组 for 循环 no-op + 提示行 + 约定码退出）由代码结构保证。补充 in-process 自信号形态：SIGINT/SIGTERM 均 130/143、提示行与 rootId 指引正确 |
| 5 | timer 回调竞态定向加量（独立于 builder 的 22 次） | **PASS**：形态 A「活 300ms / timeoutMs 50ms」×50 + 形态 B 死组阶梯（存活 20-49ms）×30，共 80 次 × 2 轮 = **160 次零 uncaughtException/unhandledRejection**，全部合法四态（TIMEOUT=80/78，其余自然退出——TIMEOUT 占多数是 lifecycle 既有结算归因，非本次改动） |

## 6. 红灯复核（临时改动后字节级还原）

**形态 2——移除信号 handler**（loop.ts 外壳去 process.on/off 后重建 dist）：

- T3 红：`expected null to be 130`（默认信号死亡，无 handler 退出码为 null）
- T4 红：`expected null to be 143`
- T5 红：`listenerCount("SIGINT")` 运行中 0 ≠ 基线+1
- T1/T2 绿（lifecycle 未动）

**形态 1——killTree 豁免码还原仅 ESRCH + timer 回调去 try/catch**（lifecycle.ts 直改，测试从 src 导入无需重建）：

- 第 1-3 轮全绿（EPERM 概率性未命中，与 builder 披露一致）
- **第 4 轮 T2 红：`uncaughtException: kill EPERM`**——原始缺陷（timer 回调内 EPERM = 进程级 uncaught）由 verifier 独立复现，非仅 builder 自报
- T3/T4/T5 不受该形态影响（绿，符合预期）

**还原验证（字节级）**：

| 校验 | 复核前 | 复核后 |
|------|--------|--------|
| `shasum -a 256 src/runner/spawn/lifecycle.ts` | `2837e27d…b84ac` | 一致 |
| `shasum -a 256 src/runner/loop.ts` | `fbee229a…2e4` | 一致 |
| `git diff 9023076 -- <两文件> \| shasum -a 256` | `f06da0bb…d7a` | 一致 |
| dist（loop.js 含 handler / lifecycle.js 含 EPERM×3） | — | 重建后一致 |
| rv1 文件复跑 | 5/5 绿 | 5/5 绿；全套 35/35 绿 |

## 7. 条款对照表（rv1-acceptance.md §5）

| 条款 | 要求 | 结果 |
|------|------|------|
| T1 | 短命真实子进程结算后 kill() 不抛 ×3 | **绿**；红灯形态 1 下 T1 未单独红（EPERM 概率性，T2 兜住同一豁免码路径） |
| T2 | 竞态 ≥20 次零 uncaught + 合法四态 | **绿**（22 次）；verifier 加量 160 次零未捕获；红灯形态 1 第 4 轮红（EPERM 现场）——测试对原缺陷有真实检出力 |
| T3 | SIGINT → 2s 内 exit 130 + 提示行 + 无残留 + 账本可读 | **绿**；红灯形态 2 红 |
| T4 | SIGTERM → exit 143 | **绿**；红灯形态 2 红 |
| T5 | runLoop 正常收敛后 handler 恢复基线 | **绿**（含运行中恰 +1 的中间断言）；红灯形态 2 红 |
| T6 | u6a/u6b/u7/u7b/u5b 零回归 | **绿**（6 文件 35/35，两轮） |

## 8. 观察与瑕疵（均不阻塞 PASS）

1. 验收文档 §6 命令文件名笔误（§3 注）——基线文档自身瑕疵，建议终验回收时由主 agent 勘误。
2. 空 inFlight 信号窗实测为微任务级不可观察（§5#4）——非缺陷；验收 §4「handler 生命周期」口径中「循环未起来时的信号」的实证上限已探明，结构保证成立。
3. T2 对 EPERM 的单轮检出力不稳定（本机 4 轮才命中 1 次）——概率性测试固有，验收条款已按「≥20 次 + 行为级」口径覆盖，无需整改。
4. lifecycle timer 兜底文案/注释、loop 外壳注释均与实现一致，未发现文档-代码漂移。

## 9. 结论

六条款全过、防篡改通过、重构零行为变化核实通过、命令全绿、对抗抽查 5 项通过（1 项结构性观察）、红灯两形态命中且字节级还原验证一致。**PASS**。
