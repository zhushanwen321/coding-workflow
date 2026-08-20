# u7 验收标准：通用调度循环（AgentSpawn 后端无关）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending

## 目标

把 human-loop 泛化为后端无关的调度循环：frontier → 按 role 派发 adapter.spawn → 等退出/轮询账本 → 重算，直至 root closed。canon 依据：§3.3 D4（runner 无智能无状态：状态全在账本）、§3.4 组件分层（调度循环 = frontier→全量批次 spawn→等退出→证据回收→重算）。复用 u1b（loadLedger/状态）、u6a（SpawnHandle）、并行中的 u6b/u6c（适配器——测试自备测试专用适配器，真实 OS 进程，不算 mock）。

## 规格锁定

### `src/runner/loop.ts`

```ts
export interface RunLoopOptions {
  rootId: string;
  adapter: AgentSpawnAdapter;
  cwd: string;
  pollMs?: number;          // 账本轮询，默认 1000
  maxIdleMs?: number;       // 无事件进展上限，默认 30min
  maxConcurrency?: number;  // 同批 spawn 上限，默认 3
}
export async function runLoop(opts: RunLoopOptions): Promise<number>;  // root closed → 0；无进展超时 → 1
```

循环逻辑（每轮读账本投影）：
1. root 子树内找「下一步待派发」集合：created 无 spec → designer 派发对象；spec-frozen → builder；verified 未 closed → reviewer（exec-review）。spec 已提交未过审 → 不重复派 designer（等 review 事件）。
2. 对每个待派发对象生成 brief（文件落到 `<workdir>/.cw-spawn/<unitId>.<role>.brief.md`——workdir 取 `<root 仓库>/…/`：M1 简化 = cwd 本身（无独立 worktree，M2 集成时升级）；brief 内容 = unit 上下文 + role 任务书模板）。
3. 派发经 `adapter.spawn({role, unitId, workdir, briefPath, timeoutMs: 30min})`；同批 ≤ maxConcurrency。
4. 等待：轮询账本事件推进或 SpawnHandle.wait() 完成；任一 unit 状态推进 → 重算下一轮。
5. 退出：root closed → 汇总（每 unit 状态行）返回 0；超过 maxIdleMs 无任何账本进展 → stderr 提示 + 返回 1。
6. **对 human 后端的兼容**：runLoop 不感知适配器类型；`cw run --spawn human` 切换到本循环 + humanAdapter（M0 的 human-loop.ts 直连路径退役——保留文件与导出兼容既有测试，run.ts 不再调用它；处置在汇报中说明）。

### `src/handlers/run.ts` 改造

- `--spawn <name>`（默认 human）路由：human → humanAdapter（u6b）；pi → createPiAdapter()（u6c）；未知 → exit 1 可操作错误。
- 保留 --poll-ms/--max-idle-ms 透传；新增 --max-concurrency（可选）。
- **接 u6b/u6c 的 import 在其 committed 后自然可用——你开发期间若并行未合入，可先写路由骨架 + 动态 import 形态（await import），保证你领地独立可测**。

## 交付物

`src/runner/loop.ts` + 改造 `src/handlers/run.ts` + `tests/u7-loop.test.ts` + `tests/u7-e2e.test.ts`。

## 单测验收（测试专用适配器 = 真实 OS 进程包装，禁 mock 框架）

1. 测试适配器（文件内定义）：spawn 真实 `node` 进程按 role 对账本执行真实写入（designer 写 SpecSubmitted 等）——用 dist 的 EventLedger API。
2. 单 unit 全链：root create（fixture 预置）→ runLoop → 测试适配器按状态逐 role 推进 → root closed 返回 0。
3. 并发上限：5 个待派发 unit + maxConcurrency=2 → 任一时刻 in-flight spawn ≤2（适配器内计数断言）。
4. 空转超时：适配器不动作 → maxIdleMs（小值）→ 返回 1。
5. root 不存在 → 抛可操作错误（run.ts 层转 exit 1）。

## E2E real（tests/u7-e2e.test.ts，真实子进程 + 隔离 CW_HOME）

- `node dist/cli.js run --root <id> --spawn human --poll-ms 300`：测试进程按 u5b-e2e 的既有模式扮演人推进全链 → runner exit 0（human 后端走新 loop + u6b 适配器的回归验证；若 u6b 未合入导致 import 失败，此条允许推迟到集成波次并在汇报标注）。
- 测试专用适配器直调 runLoop（import dist）跑双叶子 feature：两 builder 并行区间重叠 ≥1 对（时间戳断言）——**A2 并行场景的最小版**。

## 通过命令

`npm run check:all` / `npm test`（并行期以 u7 自有测试全绿为准）/ `npm run lint`。

## 禁改清单

契约层（types.ts/dispatch/cli）、`src/runner/spawn/lifecycle.ts`、`src/runner/spawn/human.ts`、`src/runner/spawn/pi.ts`、tests/u6b-*、tests/u6c-*（并行领地）；`src/runner/human-loop.ts` 禁改（保留兼容既有测试；只在汇报中说明退役处置）；`src/handlers/index.ts` 禁改（run 注册已在）；其余已验收源域、archive/、docs/rewrite/ 其余、tests/ 既有文件（u5b-e2e 若因 run.ts 改造需断言适配，允许最小改动并列理由）。禁 git 写操作；禁 mock；禁 any。
