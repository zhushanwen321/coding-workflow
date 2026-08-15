# u6c 验收标准：pi 适配器（真实 harness 第一个接入）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending

## 目标

pi 无头 CLI 接入 AgentSpawn 缝：命令拼装 + env 翻译层 + 经 lifecycle 真实起进程。canon 依据：附录 B.1、design-child-spawn.md §7（适配器差异只在 spawn 内部命令拼装）。

## 实测事实（2026-08-15 已核实，实现必须以此为准）

- pi 位于 PATH（`~/.nvm/.../bin/pi`）；无头形态：`pi --model <provider/id> -p --no-session "<prompt>"` 实测可用（mimo-v2.5-pro 真实回复、exit 0）
- **pi 无 `PI_MODEL` 环境变量**（源码 grep 确认）；`-m` 简写不存在
- brief 文件传递：`@<briefPath>` 形式（pi help 明示 `[@files...]`）；stdin 亦可——本适配器锁定 `@file` 形态（file-based，防注入）
- 本地扩展（pi-rename-session）会向 stderr 写报错噪音，但 exitCode 与 stdout 不受影响——判定只看 exitCode + stdout

## 规格锁定

### `src/runner/spawn/pi.ts`

```ts
export interface PiAdapterOptions { model?: string; extraArgs?: readonly string[]; }
export function createPiAdapter(opts?: PiAdapterOptions): AgentSpawnAdapter;  // name: "pi"
```

- **env 翻译层**：模型取值优先级 `opts.model` > `req.env.CW_AGENT_MODEL` > `process.env.CW_AGENT_MODEL` > 默认 `"xiaomi-token-plan-cn/mimo-v2.5-pro"`。
- 命令拼装（纯函数 `buildPiCommand(req, model)` 导出可测）：`pi --model <model> -p --no-session @<briefPath>` + opts.extraArgs；cwd=req.workdir；env 合并（req.env 覆盖 process.env 子集）。
- spawn()：经 `lifecycle.spawnProcess`（stdout/stderr 落 `<workdir>/.cw-spawn/<unitId>.<role>.stdout/.stderr`）；ENOENT 预检错误转译为 SPAWN_ERROR 语义（catch 后返回 `{exitCode:"SPAWN_ERROR"}` 的 handle——由 lifecycle 抛错形态适配）。
- timeoutMs 透传（默认 30min 由调用方给）。

## 交付物

`src/runner/spawn/pi.ts` + `tests/u6c-pi-adapter.test.ts`。

## 单测验收

1. buildPiCommand：默认模型 = mimo-v2.5-pro；opts.model 覆盖 > req.env.CW_AGENT_MODEL > process.env 三级优先级各一断言；@briefPath 形态（非 stdin 重定向、非 $(cat)）。
2. env 合并：req.env 变量出现在子进程 env。
3. **真实微调用 E2E**（1 条，控成本）：tmp 目录写 brief 文件（内容=「请只输出两个字：可用」）→ createPiAdapter 起真实 pi → wait() → 断言 exitCode=0 且 stdout 文件非空含模型回复（真实网络调用，单条约 10-60s，testTimeout 放宽 120s；跳过条件：环境无 pi 时 it.skip 并 console.warn——CI 可重复）。
4. SPAWN_ERROR 转译：PATH 隔离（env.PATH=/nonexistent）下 spawn → wait() 返回 exitCode="SPAWN_ERROR"（不挂死）。

## 通过命令

`npm run check:all` / `npm test`（并行期以 u6c 自有测试全绿为准；E2E 条真实跑不 skip——本地环境 pi 已确认可用）/ `npm run lint`。

## 禁改清单

契约层（types.ts）、`src/runner/spawn/lifecycle.ts`（u6a 领地，只 import）、`src/runner/spawn/human.ts`、`src/runner/loop.ts`、`src/handlers/run.ts`、tests/u6b-*、tests/u7-*（并行领地）；其余已验收源域、archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock（pi E2E 真实调用）；禁 any。
