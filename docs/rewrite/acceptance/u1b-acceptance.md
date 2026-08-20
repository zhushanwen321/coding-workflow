# u1b 验收标准：只读命令（status / frontier / tree / report）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件；主 agent 流转状态只改 status 与 ledger。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付 4 个只读命令：对 fold 投影的人可读渲染与 --json 机器输出。canon 依据：§3.4 命令面；frontier 语义 = 对投影算就绪集合（specReady / buildReady）。复用 u1（EventLedger/fold/deriveStatus）、u3（checkSpecRules 作为注入 gate）、契约层 dispatch。

## M0 命令规格（锁定）

- **`cw status [--unit <id>] [--json]`**：无 --unit 时每 unit 一行：`<unitId>  <status>  specs:<n> evidences:<n> lastVerify:<pass|fail|->`；--unit 时输出该 unit 详情（briefRef、全部 spec 的 hash 前 12 位、每条 verdict、每条 evidence 的 commit/runId、verify 覆盖的验收 id）。unit 不存在 → exit 1。--json 输出投影结构化 JSON（字段名与 types.ts 一致，Map 序列化为数组或对象并注明）。
- **`cw frontier [--json]`**：分组输出 `specReady:`（状态 created 的 unit——待 spec 提交/审查）与 `buildReady:`（状态 spec-frozen——待构建证据）。deriveStatus 需注入 specGate：用 u3 的 checkSpecRules 真实实现（此为两 unit 首个接线点）。--json 输出 `{specReady: string[], buildReady: string[]}`。
- **`cw tree`**：按 parentId 缩进渲染整树，每节点 `<unitId> (<status>)`；孤儿 parent（parentId 指向不存在 unit）以根层级展示并标 `!?`。空账本输出「(空账本)」exit 0。
- **`cw report [--unit <id>]`**：每 unit 证据链汇总：spec hash、验收清单（id/type/core + verify 覆盖标记 ✓/✗）、evidences（commit/runId/文件 sha256 前 12 位）、verifyRuns（result + acceptanceIds）。--unit 限定单个。
- 通用：全部只读（不 append 任何事件）；账本不存在时输出「(空账本)」类提示 exit 0（不 crash）；`src/readonly/index.ts` 填充四个注册。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/readonly/status.ts` / `frontier.ts` / `tree.ts` / `report.ts` | 四命令 |
| `src/readonly/index.ts` | 注册表填充（替换占位） |
| `tests/u1b-status.test.ts`、`tests/u1b-frontier.test.ts`、`tests/u1b-tree.test.ts`、`tests/u1b-report.test.ts`（或合并为 ≤2 文件） | dispatch 级单测 |
| `tests/u1b-e2e.test.ts` | 真实 CLI 子进程 e2e |

## 单测验收

1. status：多 unit 账本 → 每行含 unitId/status；--unit 详情含 briefRef 与 verdict 数；不存在 unitId exit 1；--json 可 JSON.parse 且字段对得上。
2. frontier：构造三种状态 unit（created / spec-frozen / verified）→ specReady 恰含 created 者、buildReady 恰含 spec-frozen 者；specGate 用真实 checkSpecRules（弱 spec → 停在 created 进不了 buildReady）。
3. tree：三层含孤儿的账本 → 缩进层级正确、孤儿标 `!?`；空账本不 crash。
4. report：完整链 unit → 验收覆盖标记正确（verify 过的 ✓、未跑的 ✗）；--unit 限定。

## E2E real（tests/u1b-e2e.test.ts）

- tmp 目录 + 隔离 CW_HOME；**用 EventLedger API 直写构造 fixture**（不依赖 u2 的 CLI 命令——并行保护）：两 unit（根 created + 叶 spec-frozen，含 spec/verdict/evidence/verify 全事件）。
- 真实子进程跑 `node dist/cli.js status`、`frontier`、`tree`、`report`，断言 exit 0 且输出含预期行（unitId、状态字、分组标题）。
- 空账本目录：四命令全部 exit 0 且不抛栈。

## 通过命令（verifier 逐条实跑）

```
npm run check:all
npm test          # u2 并行时以其自有测试文件全绿为准
npm run lint
```

## 禁改清单

- `src/dispatch.ts`、`src/cli.ts`、`src/handlers/**`（u2 并行领地）；`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`（已验收 unit）；archive/、docs/rewrite/ 其余、tests/ 既有文件。
- 禁 git 写操作；禁 mock；禁 `any`。
