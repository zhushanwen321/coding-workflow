# u6b 验收标准：human 适配器（AgentSpawnAdapter 实现）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending

## 目标

把 M0 的 human 模式升级为标准 `AgentSpawnAdapter` 实现：spawn() 打印该 unit/role 的完整人肉指令，wait() 轮询账本推进视为完成。canon 依据：附录 B.1、design-child-spawn.md §5.1/§10-u3。复用 u6a（lifecycle 的产物落盘约定——human 无子进程，stdout/stderr 落盘打印的指令文本自身）、u5b（human-loop.ts 的指令生成函数，只读 import）。

## 规格锁定

### `src/runner/spawn/human.ts`

- `export const humanAdapter: AgentSpawnAdapter`（name: "human"）。
- `spawn(req)`：
  - 建目录 `<workdir>/.cw-spawn/`；把「指令清单全文」写入 `stdoutPath`（`<unitId>.<role>.stdout` 约定）并同步打印到控制台——指令内容：cd workdir → cat briefPath → 按 role 分步的人肉操作指引（designer=写 spec.json+提交+review；builder=干活 commit+evidence+verify；reviewer=审查+review submit）+ 信任边界提示（human 无自动 reviewer，人自任）。
  - 指令生成尽量复用 `src/runner/human-loop.ts` 既有导出（只读 import；其函数不满足处在本文件内写变体，注明差异）。
  - 立即返回 SpawnHandle（不阻塞）。
- `wait()`：轮询账本（间隔 min(1000, timeoutMs/10)，cwd 推导账本路径）直至**该 unit 出现 role 对应的进展事件**即返回 `{exitCode: 0, stdoutPath, stderrPath, pid: process.pid}`：
  - designer → 新 SpecSubmitted（晚于 spawn 起始时间戳）
  - builder → 新 EvidenceSubmitted
  - reviewer → 新 VerdictSubmitted
  - 超时 timeoutMs → `{exitCode: "TIMEOUT", ...}`。
- `kill()`：置停止标志，wait() 尽快返回 `{exitCode: "CRASH", ...}`（人肉无进程可杀，语义=手动中止）。
- stderrPath 落盘空文件（human 无 stderr）。

## 交付物

`src/runner/spawn/human.ts` + `tests/u6b-human-adapter.test.ts`。

## 单测验收（真实账本 + 真实子进程读 stdout 文件）

1. spawn 后 stdoutPath 文件存在且含三类要素：workdir cd 命令、briefPath 路径、role 对应操作步骤关键词（designer 含 spec）。
2. designer wait()：另一真实子进程向账本 append 一条 SpecSubmitted → wait() 在轮询窗口内 resolve exitCode 0。
3. builder wait() 对 SpecSubmitted 不误判（事件类型按 role 过滤）。
4. 超时：timeoutMs=800 无事件 → TIMEOUT。
5. kill() 后 wait() 返回 CRASH。
6. 注册形态：humanAdapter 满足 AgentSpawnAdapter 类型（tsc 即证）。

## 通过命令

`npm run check:all` / `npm test`（并行期以 u6b 自有测试全绿为准）/ `npm run lint`（u6b 领地零输出）。

## 禁改清单

契约层（types.ts/dispatch/cli）、`src/runner/spawn/pi.ts、lifecycle.ts`、`src/runner/loop.ts`、`src/handlers/run.ts`、tests/u6c-*、tests/u7-*（并行领地）；`src/runner/human-loop.ts`（只读 import，禁改）；其余已验收源域、archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock；禁 any。
