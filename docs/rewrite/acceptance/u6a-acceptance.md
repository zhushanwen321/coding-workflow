# u6a 验收标准：AgentSpawn 生命周期原语（lifecycle）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付进程管理原语 `spawnProcess`：真实 OS 子进程的 spawn / stdio 管道直写落盘 / 进程树超时 kill / 四态退出语义。它是 human/pi 等全部适配器的公共底座（适配器只做命令拼装）。canon 依据：附录 B.1（契约已在 `src/runner/spawn/types.ts` 预建，只 import 禁修改）、子文档 design-child-spawn.md §6.3/§7（runner 侧统一超时、detached+pgid 树 kill、产物落盘写入方是 spawn 实现而非 agent）。探针 P4/P6/P8 归本 unit。

## 规格锁定

### `src/runner/spawn/lifecycle.ts`

```ts
export interface SpawnProcessRequest {
  command: string;            // 可执行（适配器拼装完成）
  args: readonly string[];
  cwd: string;                // 工作目录（worktree）
  env?: Record<string, string>;
  timeoutMs: number;
  stdoutPath: string;         // 落盘路径（调用方 = 适配器，按 .cw-spawn/ 约定）
  stderrPath: string;
}
export function spawnProcess(req: SpawnProcessRequest): SpawnHandle;  // 同步返回 handle
```

- **stdio 管道直写**：`stdio: ["ignore", createWriteStream(stdoutPath), createWriteStream(stderrPath)]`——OS 层写入、无用户态缓冲；`.cw-spawn/` 目录不存在则先建。
- **进程组隔离**：`detached: true`，记录 pgid（= child.pid）。
- **超时**：timeoutMs 到 → `process.kill(-pgid, "SIGKILL")`（整树）→ wait() 返回 `exitCode: "TIMEOUT"`；已退出则不误杀（kill 抛 ESRCH 时静默处理）。
- **四态**：
  - 正常退出 → 数字 exitCode；被信号杀死（exitCode=null 且 signal，非超时 kill 路径）→ `"CRASH"`
  - spawn 同步失败（ENOENT 等）→ spawn() 抛带可执行名的 Error（适配器转 SPAWN_ERROR 语义；lifecycle 不吞）
  - 超时 kill 后子进程 exit 事件带 signal=SIGKILL → 归因为 `"TIMEOUT"`（时序竞争：kill 由本模块发起，须区分外部 SIGKILL=CRASH 与自己的超时 kill=TIMEOUT——内部记 kill 原因标志）
- **wait() 契约**：resolve 前保证 stdout/stderr 流已 flush 落盘（P8：`close` 事件先于 wait resolve；SIGKILL 后已输出内容仍在文件，P6）。
- kill()：手动终止（与超时同路径），幂等（重复调用无害）。
- 进程退出后 after 逻辑：不做 worktree 清理（那是 runner 重派语义的事，u7）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/runner/spawn/lifecycle.ts` | spawnProcess + SpawnHandle 实现 |
| `tests/u6a-lifecycle.test.ts` | 单测（真实进程，见下） |

## 单测验收（全部真实 OS 进程，禁 mock）

1. 正常退出：`node -e "console.log('out'); process.exit(0)"` → wait() exitCode=0、stdout 文件含 `out`（P8 断言：wait resolve 后立即可读全文）。
2. exit≠0：`node -e "process.exit(3)"` → exitCode=3。
3. 超时：`node -e "setInterval(()=>{},1000)"` + timeoutMs=500 → exitCode="TIMEOUT"；**P4**：wait 后 `ps` 检查该 node 进程（及它 spawn 的子进程——用 `node -e "spawnSync('sleep',['50'])"` 场景）无残留。
4. 外部 SIGKILL：起 `node -e "setInterval..."`，测试侧 `process.kill(pid, "SIGKILL")` → exitCode="CRASH"；**P6**：进程先 `console.log('before-kill')` 再进入循环，杀后 stdout 文件仍含该行。
5. 树 kill：父进程 spawn 长活子进程（node 嵌套 spawn sleep），超时 kill 后两进程均无残留（pgid 整组）。
6. ENOENT：command="no-such-bin-xyz" → spawn() 抛 Error 含可执行名。
7. cwd/env：cwd 指向 tmp 目录（子进程 `process.cwd()` 打印断言）；env 传入自定义变量子进程可读。
8. kill() 幂等 + wait() 可重复调用（同结果）。
9. stdout 追加模式：同路径二次 spawn 不覆盖前次内容（append flags）。

## 通过命令

```
npm run check:all
npm test          # 并行期以 u6a 自有测试全绿为准
npm run lint      # u6a 领地零输出
```

## 禁改清单

`src/runner/spawn/types.ts`（契约层）；`src/runner/human-loop.ts`、`src/handlers/run.ts`、`src/handlers/index.ts`（M0 已验收领地，本 unit 不碰——适配器接线属 u6b/u6c/u7）；其余全部已验收源域、archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock；禁 any。
