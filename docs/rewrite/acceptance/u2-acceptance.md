# u2 验收标准：写命令（create / evidence submit / review submit）+ dispatch 填充

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件；主 agent 流转状态只改 status 与 ledger。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付 4 写命令中的 3 个（verify 属 u4a）与写命令域注册。canon 依据：`design-rewrite-architecture.md` §3.4（命令面 4 写 1 跑 4 只读）、附录 B.4（命令最小契约）。复用已验收的 u1（EventLedger / project 路径）、u3（checkSpecRules）、契约层 dispatch（`src/dispatch.ts`，已存在）。

## M0 命令规格（本文档锁定，实现不得偏离）

### `cw create --id <slug> --brief <path> [--parent <unitId>]`

- slug 规则 `^[a-z][a-z0-9-]*$`；违反或已存在（账本内 UnitCreated 同 unitId）→ exit 1，错误含恢复动作。
- brief 文件必须存在可读；内容原样不解析（路径存入 briefRef）。
- --parent 给出时该 unit 必须已存在；深度限制：M0 上限 2 层（根 + 叶），--parent 的目标 unit 自身不得再有 parent → 违反 exit 1（错误说明深度上限）。
- 成功：append UnitCreated，stdout 输出一行确认（含 unitId），exit 0。

### `cw evidence submit`（两种形态，--kind 区分）

**spec 形态**：`cw evidence submit --kind spec --unit <id> --file <spec.json>`
- spec.json 结构：`{ acceptance: AcceptanceItem[]; contracts: Contract[]; split: SplitEntry[] }`（类型见 src/events/types.ts；用 @sinclair/typebox 做 schema 校验，字段类型不符 → exit 1 列出具体字段错误）。
- 校验链：unit 存在 → schema 校验 → checkSpecRules（u3）→ 全过才 append SpecSubmitted{specHash = sha256(spec.json 原始字节), acceptance/contracts/split 原样}。
- gate 不过：stderr 逐条打印 failures（u3 的可操作信息），exit 1，**不入账**（账本只记被接受的进展）。
- split 为声明性数据，无副作用（子 unit 仍走 create --parent）。

**build 形态**：`cw evidence submit --kind build --unit <id> --commit <hash> --run-id <runId> [--file <path>]...`
- unit 存在；commit 在 cwd 的 git 仓库真实存在（`git cat-file -e <hash>^{commit}`）→ 不存在 exit 1；每个 --file 路径存在可读 → 计算 sha256。
- append EvidenceSubmitted{commit, paths, sha256, runId, exitCode: 0}（账本层幂等拒绝同 unitId+runId 由 u1 承担，handler 透传错误）。
- 成功 stdout 确认行（unitId + runId + 产物数），exit 0。

### `cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail> [--comment <text>] [--evidence-refs <runId,...>]`

- unit 存在；verdict-kind/verdict 枚举外 exit 1；--evidence-refs 每个 runId 必须已存在于该 unit 的 EvidenceSubmitted → 引用不存在 exit 1（错误列出缺失 runId）。
- append VerdictSubmitted。成功 exit 0。

### 通用约定

- 所有 handler 经 dispatch（CommandContext.cwd 定位账本；CW_HOME 沿用 project.ts 语义）。
- exit code：0 成功 / 1 校验失败（stderr 可操作信息：缺什么 + 恢复动作）。
- `src/handlers/index.ts` 填充三个命令注册（name: "create" / "evidence submit" / "review submit"，含 summary）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/handlers/create.ts` / `evidence-submit.ts` / `review-submit.ts` | 上述三命令 |
| `src/handlers/spec-schema.ts`（或并入 evidence-submit.ts） | typebox schema + 校验函数 |
| `src/handlers/index.ts` | 注册表填充（替换占位） |
| `tests/u2-create.test.ts`、`tests/u2-evidence.test.ts`、`tests/u2-review.test.ts` | 函数/dispatch 级单测 |
| `tests/u2-e2e.test.ts` | 真实 CLI 子进程 e2e |

## 单测验收（每条真实存在）

1. create：合法 → UnitCreated 入账、briefRef 正确；重复 slug 拒；非法 slug（大写/下划线/空）拒且信息含规则；--parent 不存在拒；三层嵌套拒（根→叶→再叶）；brief 文件缺失拒。
2. evidence spec：合法 spec → SpecSubmitted 入账且 specHash 等于文件 sha256；schema 类型错（acceptance 缺 id、type 枚举外）拒且列出字段；gate 不过（空 acceptance / core manual）→ 拒、不入账、stderr 含 u3 failures 原文。
3. evidence build：commit 不存在拒；文件缺失拒；合法 → sha256 与实际一致；同 runId 二次提交被账本层拒（错误透传）。
4. review：verdict-kind 枚举外拒；evidence-refs 引用不存在 runId 拒（列出缺失项）；合法入账。
5. dispatch 注册：三个命令可被 findCommand 命中（"evidence submit" 空格子命令形式）。

## E2E real 验收（tests/u2-e2e.test.ts，真实子进程跑 dist/cli.js）

- tmp git 仓库 + 隔离 CW_HOME；完整序列：create（根）→ create（--parent）→ evidence submit --kind spec（合法 spec.json）→ evidence submit --kind build（真实 commit + 产物文件）→ review submit --verdict-kind spec-review --verdict pass。
- 断言：每步 exit 0；完成后 events.log 恰含预期事件序列（5 条，类型序 = UnitCreated×2 → SpecSubmitted → EvidenceSubmitted → VerdictSubmitted）；`node dist/cli.js status`（若 u1b 未并入则跳过此断言）或直接 readAll 验证。
- 负路径：同一 e2e 内跑一条 gate 不过的 spec 提交，断言 exit 1 且 events.log 行数不变。

## 通过命令（verifier 逐条实跑）

```
npm run check:all
npm test          # 全量（u1b 并行时以其自有测试文件全绿 + 全量中 u2 系列全绿为准）
npm run lint
```

## 禁改清单

- `src/dispatch.ts`、`src/cli.ts`（契约层，已接线）；`src/readonly/**`（u1b 并行领地）；`src/events/types.ts`、`src/store/**`、`src/core/**`、`src/gates/**`（已验收 unit，发现其缺陷报告主 agent，不擅改）；archive/、docs/rewrite/ 其余、tests/ 既有文件。
- 禁 git 写操作；禁 mock 框架；禁 `any`。
