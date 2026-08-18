# rv-1 验收标准：spawn/loop 健壮性（EPERM 兜底 + Ctrl-C 孤儿清理）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 设计-实现五角度对抗审查（spawn/worktree 角度 A1、A2）；`design-child-spawn.md` §6.3「runner 侧统一 kill」；`docs/rewrite/design-worktree-isolation.md` §「Ctrl-C 中断、cw run 重跑即续」核心承诺。
> 来源缺陷：①超时 timer 回调裸调 killTree，killTree 只豁免 ESRCH——macOS 对已退出进程组返回 EPERM（该事实已由 `src/runner/loop.ts:666-673` 注释实测记录），timer 回调内未捕获异常 = runner 进程整体 crash（src 全库无 process.on 兜底）；②子进程 `detached: true` 且 runLoop 无信号处理，Ctrl-C 后 agent 子进程成孤儿继续写账本，用户重跑 `cw run` 对同一 worktree reset + 二次 spawn——双 agent 混卷正是 wt 设计明言要防的回归。

## 1. 目标

超时 kill 路径对「目标已死」的所有_errno_形态幂等不炸；Ctrl-C/SIGTERM 触发 runner 主动回收全部在飞 spawn 后以约定退出码退出，「重跑即续」承诺对进程维度也成立。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/spawn/lifecycle.ts` | 修改 | ①`killTree` 豁免码从 `{ESRCH}` 扩为 `{ESRCH, EPERM}`（注释注明 macOS 已退出进程组事实与 loop.ts 佐证）；②超时 timer 回调整体包 try/catch：kill 失败 stderr 记录一行后放行（timer 回调抛出 = 进程级 uncaught，任何失败模式都不允许炸 runner）；③其余语义（timeoutKillInitiated 置位、四态归因、手动 kill() 的 rethrow-其余-错误码）不变 |
| `src/runner/loop.ts` | 修改 | ①`runLoop` 入口注册 `SIGINT`/`SIGTERM` handler：触发即 stderr 同步 writeSync 提示行（含已收到的信号名）→ best-effort `killAll(inFlight)` → `process.exit(130|143)`（SIGINT=130 / SIGTERM=143）；②runLoop 全部正常出口（root closed 汇总退出 / idle 超时 / 无可派发 exit 1 等）与异常出口移除 handler（`process.off`），防止库化复用（tests 直接调 runLoop）后 handler 泄漏；③killAll 本体不改 |
| `tests/rv1-spawn-robustness.test.ts` | 新建 | §5 条款 |
| `tests/u6a-lifecycle.test.ts` / `tests/u7-loop.test.ts` 等既有 | 适配 | 仅限因新增信号 handler 引起的必要适配（如 runLoop 直接调用后 handler 清理断言），禁改既有断言语义 |

## 3. 禁改清单（违反 = FAIL）

- `src/verify/`、`src/gates/`、`src/handlers/`、`src/core/`、`src/events/`、`src/store/`、`src/readonly/`、`src/testrun/`、`src/runner/{integrate.ts, worktree.ts, human-loop.ts}`、`src/runner/spawn/{types.ts, pi.ts, human.ts}`
- killAll 的 best-effort 结构、四态退出语义、TIMEOUT/CRASH 归因、连续 2 次 TIMEOUT 转人工计数——零变更
- `docs/`、`archive/`、配置文件；`tests/` 既有文件除 §2 列明的必要适配外禁改

## 4. 关键口径（锁定）

- **豁免码语义**：ESRCH（进程组不存在）与 EPERM（对已退出/僵尸进程组的 macOS 形态）都视为「已清理，幂等成功」；其余 errno（如 EACCES 于无关进程）仍 rethrow——手动 `kill()` 调用方保留可观测性。
- **timer 回调兜底与 killTree 豁免是双层防线**：killTree 豁免已知两码；timer 回调 catch-all 兜住其余未知失败（stderr 一行记录，不抛）。
- **信号退出码**：SIGINT → 130，SIGTERM → 143（shell 惯例 128+signum）。提示行先于 killAll 打印（用户立即看到响应）。
- **handler 生命周期**：注册在 runLoop 函数体内、任何出口都清理；信号到达时若 killAll 中单个 kill 失败，沿用 killAll 既有 best-effort 语义（记录继续），不因清理失败改变退出码。
- **平台口径**：POSIX（darwin/linux）；EPERM 语义按 POSIX kill(2)。
- **「重跑即续」不回退**：信号 handler 只做回收，不写任何账本事件、不动 worktree/分支（回收 worktree 是既有延迟回收逻辑的事，信号路径不额外触发 reclaim）。

## 5. 新增测试条款（tests/rv1-spawn-robustness.test.ts，真实子进程 + tmp + CW_HOME 隔离，零 mock）

- **T1 kill 幂等扩展**：spawn 短命真实子进程（如 `node -e "process.exit(0)"`），wait() 结算完成后再次 `handle.kill()`——断言不抛（覆盖 ESRCH 或 EPERM 任一实际返回码）；对同 handle 第三次 kill 仍不抛。
- **T2 超时 kill 不炸（行为级）**：spawn 一个存活期短于 timeoutMs 的真实子进程并让 timeoutMs 极短（如进程活 300ms、timeoutMs 50ms），使超时 kill 与自然退出竞态窗口重叠——连跑 ≥20 次，断言 runLoop/spawnFromAdapter 调用方零未捕获异常（process 级 unhandledRejection/uncaughtException 监听断言零触发）、每次都拿到合法四态结果。
- **T3 SIGINT 回收（E2E）**：`child_process.spawn` 真实跑 `node dist/cli.js run --root <r> --spawn human --max-idle-ms <长>`（tmp git 项目 + CW_HOME 隔离），循环起来后向其发 SIGINT——断言：进程在 2s 内退出且 exit code 130；stderr 含中断提示行；`pgrep -g <pgid>` 或 ps 扫描确认无 cw 起的残留子进程；账本文件完整可读（重跑即续前提）。
- **T4 SIGTERM 同语义**：同 T3 发 SIGTERM，exit code 143。
- **T5 handler 清理**：直接调用 runLoop 正常走完（human 模式全链收敛 root closed 的既有形态）后，断言 SIGINT/SIGTERM handler 已移除（`process.listenerCount("SIGINT")` 恢复基线值）。
- **T6 正常路径零回归**：u6a/u7/u5b 既有测试全绿（限定范围跑本 unit 相关文件）。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/rv1-spawn-robustness.test.ts tests/u6a-lifecycle.test.ts tests/u6b-human.test.ts tests/u7-loop.test.ts tests/u7b-timeout.test.ts tests/u5b-e2e.test.ts
npx eslint src/runner/spawn/lifecycle.ts src/runner/loop.ts tests/rv1-spawn-robustness.test.ts
```
