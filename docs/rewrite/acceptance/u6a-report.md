# u6a 验收报告：AgentSpawn 生命周期原语（lifecycle）

> verifier 独立对抗式验收。基线 commit `78fa351`，验收时 HEAD = `7beb570`（基线后仅主 agent 的 ledger hygiene commit）。
> 验收文档：`docs/rewrite/acceptance/u6a-acceptance.md`（锁定文件，sha256 见 §1）。

## 总结论：PASS

全量 24 文件 173 测试绿；check:all / lint 零问题；u6a 单文件 3 遍复跑全绿；防篡改零违规（builder 领地严格限于两文件）；9 组单测条款全部真实存在且断言强度达标；7 条行为对抗抽查 + 1 条前提探针全部符合验收文档；两处字面偏离经实测证实为唯一可行实现，timeoutMs 数值偏离评判合理。

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff 78fa351 -- docs/rewrite/acceptance/u6a-acceptance.md` | 空（无篡改） |
| 工作区文件 sha256 | `c1baff50bcd4340d443868b2f993b4902387a08c0003a94865efe38d4281c250` |
| `git diff 78fa351 --stat -- src/` | 空（已跟踪源码零改动，含禁改清单全部文件） |
| `git diff 78fa351 --stat -- tests/` | 空 |
| `git diff 78fa351 --stat -- docs/` | 仅 `docs/rewrite/ledger.md`（2 行） |

- ledger.md 差异内容 = 删除 stale u1b pending 行 + M0 gate 表格形状修复，来自基线后主 agent commit `7beb570`（docs(rewrite): ledger hygiene），**非 builder 改动**。验收文档自身零变化。
- 契约层 `src/runner/spawn/types.ts` 零改动（基线 78fa351 已含，lifecycle.ts 仅 import）✓；`src/runner/human-loop.ts`、`src/handlers/`、`src/dispatch.ts`、`src/cli.ts` 及其余已验收源域零改动 ✓。
- untracked 定性：builder 领地仅 `src/runner/spawn/lifecycle.ts` + `tests/u6a-lifecycle.test.ts`（与交付物清单完全一致）；认知外（非 builder 产物，归因主 agent/用户，verifier 按防护规则不动，交主 agent 判断来源）：`AGENTS.md` 工作区 1 行修改（e2e 测试基建描述更新）、`wave-endstate-execution.drawio/png/svg` 及 `.$wave-endstate-execution.drawio.bkp`。

**结论：builder 零越界。**

## 2. 命令实跑

| 命令 | 结果 |
|----|------|
| `npm run check:all`（tsc src + tests） | exit 0 |
| `npm test` | exit 0，**24 文件 / 173 测试全绿**（25.9s；与任务预期「24 文件 173 测试」一致） |
| `npm run lint` | exit 0，零输出 |
| `npm run build` | exit 0（对抗抽查用 dist） |
| `npx vitest run tests/u6a-lifecycle.test.ts` 连跑 3 遍 | RUN1/2/3 全部 exit 0，1 文件 9 测试 ×3 全绿 |

## 3. 条款对照（验收文档 9 组单测逐项）

| # | 验收条款 | 测试落点 | 判定 |
|---|---------|---------|------|
| 1 | 正常退出 exitCode=0 + P8 | `tests/u6a-lifecycle.test.ts:109-125`：`console.log('out'); process.exit(0)`；wait resolve 后同步 `readFileSync` 即得全文 | ✓ |
| 2 | exit=3 透传 | :127-137 | ✓ |
| 3 | 超时 TIMEOUT + P4 | :185-208：spawnSync("sleep",["10"]) 同组子进程；`assertNoResidue` 用真实 `ps ax -o pid,pgid` 快照按 **pgid 整组**断言（组内任何成员残留即 fail，非只查主 pid） | ✓ |
| 4 | 外部 SIGKILL → CRASH + P6 | :238-257：子进程先打印 before-kill → 测试**先读文件确认内容落盘** → `process.kill(pid,"SIGKILL")` → wait=CRASH → 杀后再读仍含 before-kill（时序真实） | ✓ |
| 5 | 树 kill 父+子无残留 | :210-234：父 node 嵌套 spawn sleep 30，stdout 打印 parent/child 双 pid；断言 `[parent, child]` 双 pid + pgid 组都在 `assertNoResidue` 里 | ✓ |
| 6 | ENOENT 同步抛含可执行名 | :281-292：`toThrow(/no-such-bin-xyz/)` | ✓ |
| 7 | cwd + env | :139-156：子进程打印 `process.cwd()`（realpath 兼容 macOS /var symlink）+ 自定义 env 变量值 | ✓ |
| 8 | kill() 幂等 + wait() 重复 | :259-277：kill×2 不抛；`expect(again).toBe(first)` 引用相等（同一 promise 缓存） | ✓ |
| 9 | append 二次 spawn 不覆盖 | :158-181：first-run 与 second-run 共存且顺序正确 | ✓ |

实现条款对照：接口签名与验收文档规格逐字段一致；`detached:true` + `kill(-pgid,"SIGKILL")` + ESRCH 静默；四态 `number|"TIMEOUT"|"CRASH"|"SPAWN_ERROR"` 与契约层 `SpawnResult` 完全匹配；wait() 的 P8 门（`Promise.allSettled(streamClosed)` 屏障先于 resolve）真实存在；kill() 幂等（killCalled 标志）；无 worktree 清理逻辑 ✓。

TIMEOUT vs CRASH 归因（builder 声明 2）**证实**：`timeoutKillInitiated` 仅在超时 timer 回调置位（lifecycle.ts:190-193）；exit 事件里 `code===null` 时按该标志二分（:219-226）。超时路径（验收#3/#5 断言 TIMEOUT）与外部 SIGKILL 路径（验收#4 断言 CRASH）两条测试分别存在、断言不同 exitCode ✓；手动 kill() 不置位 → 归 CRASH（验收#8 断言）✓。

异步 spawn 失败兜底（builder 声明 3）**证实**：`child.on("error")` → settle SPAWN_ERROR、`pid: child.pid ?? -1`（lifecycle.ts:229-237）；行为实测见 §5-A6。

## 4. 两处字面偏离评判（builder 声明 1）+ timeoutMs 偏离（声明 5）

### ① stdio 用 `openSync(path,"a")` 先拿 fd 再包 createWriteStream —— 判定：唯一可行，合理

验收文档字面写 `createWriteStream(stdoutPath)`。两点实测证据：

- **惰性流同步抛**：实测（§5-A5）裸 `createWriteStream(path)`（构造期不 open、fd=null）直接传 spawn stdio → 同步抛 `TypeError [ERR_INVALID_ARG_VALUE]`。`spawnProcess` 契约要求同步返回 handle，字面写法做不到。
- **文档内部自相矛盾**：裸 `createWriteStream` 默认 flags `"w"`（truncate），与验收#9「追加模式（append flags）」互斥。`openSync(path,"a")` + `createWriteStream(path,{fd})` 是同时满足 stdio 直写与 append 的唯一形态。

### ② ENOENT 用 execvp 语义预检实现同步抛 —— 判定：唯一可行，合理

实测探针（/tmp，node v24）：裸 `spawn("no-such-bin-xyz")` → **不同步抛**，1s 内收到异步 `error` 事件（code=ENOENT）且 **exit 事件从未发出**。验收文档要求「spawn() 抛带可执行名的 Error」同步抛，预检是唯一实现路径。预检覆盖两分支（§5-A7 行为实测）：含 `/` 按路径（绝对原样 / 相对 join(cwd)）校验、裸名沿**子进程 env** 的 PATH 逐段查找；PATH undefined 时放行走异步 error 兜底（注释说明 confstr 回退无法静态复刻，且 wait() 归 SPAWN_ERROR 不会挂起）——边界处理完备。

### ⑤ 测试侧 timeoutMs=3000 而非文档示例 500 —— 判定：合理偏离（数值非锁定语义）

验收文档自身锁定「kill 抛 ESRCH 时静默处理」（幂等不重发）——这意味着 kill 若落在子进程 exec/setsid 完成之前，会静默漏杀：高负载下 500ms 内 node 未完成启动 → 漏杀 → wait() 挂到 testTimeout → flaky。实现采用 waitChildPid 前置（等子进程打印 pid，证明 exec 已完成）+ 3s 裕量，使 kill 必落在存活进程树；「子进程活过超时点」的结构由 sleep 10 / timeout 3000 同构保持（对应文档示例 sleep 50 / timeout 500）。超时语义（TIMEOUT + 整组无残留）不变，数值非语义。flaky 修复后 3 遍复跑 + 全量全绿（本次实测）；builder 声称的 8+6 遍未复现（超出任务要求的 3 遍），以其自测声明备案。

## 5. 行为对抗抽查（/tmp 脚本 import dist，7/7 PASS）

| # | 场景 | 结果 |
|---|------|------|
| A1 | wait() 重复调用 | `h.wait()===h.wait()` 且两次 await 结果**同一对象引用**（`r1===r2`），exitCode=7 原样 |
| A2 | 同路径二次 spawn | 文件内容 `"ADV-FIRST\nADV-SECOND\n"` 共存有序 |
| A3 | 立刻退出 + timeoutMs=50 连跑 10 次 | 10/10 全归数字 exitCode=0（先完成不误归 TIMEOUT，竞争归因稳定） |
| A4 | kill() 连调 3 次后 wait() | CRASH，无抛错（幂等） |
| A5 | 裸 createWriteStream 惰性流传 stdio | 同步抛 `ERR_INVALID_ARG_VALUE`（TypeError）——证实偏离①前提 |
| A6 | cwd 不存在（预检放行的形态） | wait() = SPAWN_ERROR、pid=-1——证实异步兜底（声明 3） |
| A7 | 预检分支 | `./no-such-rel-bin` 同步抛且 message 含名；`./adv-hello.sh`（chmod +x）正常执行出 stdout；裸名 `echo` 沿 PATH 正常 |

补充探针：裸 node spawn ENOENT → gotError=true(ENOENT)、gotExit=false、无同步抛（证实偏离②前提）。

## 6. 观察项（不阻塞）

- **归因竞争固有窗口（minor，备案）**：进程恰在 timer 置位 `timeoutKillInitiated` 之后、`killTree()` 之前自然退出 → 误归 TIMEOUT。A3 实测 10 次立刻退出场景全归数字，窗口极小；且这是「kill 发起方声明归因」设计的固有属性（验收文档明示时序竞争须靠内部标志区分），非缺陷。
- **认知外工作区文件**（AGENTS.md 1 行修改、drawio 系列产物）：非 builder 领地，verifier 不动，交主 agent 判断来源后处置。
- builder 声称的「负载 8 遍 + 空载 6 遍」未独立复现（任务要求 3 遍已满足且全绿）。

## 7. 结论

u6a 通过验收：实现真实（三探针落点核对无误）、契约零篡改、9 组单测断言强度达标、全部声明的偏离经实测证实合理、行为对抗零矛盾。**PASS**——建议流转 verified 并 commit。
