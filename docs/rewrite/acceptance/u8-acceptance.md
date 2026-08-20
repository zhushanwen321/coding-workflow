# u8 验收标准：内部节点集成 verify（merge + 受影响验收 + 契约比对）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending

## 目标

交付 D6 集成验证：内部节点的 build = 子树集成（commit 可达性核验）+ 受影响验收重跑 + 契约机器比对，产物 = 内部节点自身的 VerifyRan。canon 依据：§3.3 D6（集成 = 内部节点的 verify）、§1.3（机器验「切得闭不闭合」：契约配对）。复用 u4a/u4b（checkout/runAcceptances/VerifyRan 语义）、u7（loop 派发）。

## 规格锁定

### 1. `src/verify/contract-match.ts`（纯函数）

```ts
export interface ContractMatchInput {
  contracts: Contract[];          // root ∪ 各子 spec 冻结的契约集合（跨节点承诺由提供方 spec 冻结；2026-08-16 按 verifier 实证修订，原注释「root spec 冻结」与 E2E 条款矛盾）
  checkoutDir: string;            // 干净 checkout 树根
}
export interface ContractMatchResult {
  ok: boolean;
  failures: string[];             // 每条含契约 id + 期望文件（或全树）+ 恢复动作
}
export function matchContracts(input: ContractMatchInput): ContractMatchResult;
```

- 每条契约：`signature` 文本在 `file`（相对 checkoutDir，M2 新增字段）中存在 → 过；`file` 缺省 → 全树文本搜索（遍历文本文件，跳过二进制/node_modules/.git）存在 → 过；不存在 → failures 追加。
- 多契约独立判定不短路；空契约列表 → ok=true。

### 2. `src/runner/integrate.ts`

```ts
export interface IntegrateResult { ok: boolean; failures: string[]; runId: string; reportPath: string; }
export async function runIntegrationVerify(opts: {
  cwd: string; rootId: string; children: readonly {unitId: string; commit: string}[];
  rootAcceptance: AcceptanceItem[]; contracts: Contract[]; timeoutMs: number;
}): Promise<IntegrateResult>;
```

流程：
1. **commit 可达性**：每个子 commit 在当前分支可达（`git merge-base --is-ancestor <commit> HEAD`）→ 不可达 = failure（附恢复动作：merge 子分支/重新提交）。
2. **干净 checkout**：HEAD（集成时刻的最终树）→ mktemp（复用 cleanCheckout 语义）。
3. **受影响验收重跑（M2 保守口径）**：全部子节点验收 ∪ root 自身验收，逐条执行（复用 runAcceptances 的适配器路由与 nameMatch 判定）——**诚实标注**：这是「全量重跑」保守版（漏跑率 0，代价多跑）；「变更文件→验收覆盖」的精准选择策略留待真实集成案例校准（canon 待验证检查点）。
4. **契约比对**：matchContracts 在 checkout 树上执行。
5. 汇总：全过 → ok=true；产物落 `evidence/<rootId>/integrate-<runId>/`（逐验收产物 + integrate-report.json：受影响验收结果 + 契约结果 + 子 commit 可达性）。

### 3. `src/runner/loop.ts` 改造（对齐 canon 派发时机）

- 内部节点（有 split 子节点）的 builder 派发条件从「子全 closed」改为「**子全 verified**」（rootLast 语义升级：集成的物理前提是子证据齐）。
- 内部节点 builder 阶段的行为分叉：叶子 → 现行 agent 派发不变；内部节点 → **不派 agent**，直接执行 `runIntegrationVerify`（确定性代码，无智能），成功后以集成结果写 root 的 `VerifyRan`（acceptanceIds = 覆盖的验收 id ∪ root manual）——投影推进 verified，后续 reviewer 走 exec-review → closed（子节点各自的 exec-review 由其 reviewer 推进，root 的 closed = root verified ∧ root exec-review ∧ 子全 closed，与 deriveStatus 既有语义对齐）。
- 集成失败（任一验收红/契约漂移/commit 不可达）：不写 VerifyRan（或写 fail 的 VerifyRan——**选定：写 fail VerifyRan 留审计**，与 u4a「pass/fail 都入账」语义一致），stderr 列失败项，下轮重派集成（可重试，与 builder 重派同待遇）。

## 交付物

`src/verify/contract-match.ts`、`src/runner/integrate.ts`、改造 `src/runner/loop.ts`（派发时机 + 内部节点分叉）、`tests/u8-contract-match.test.ts`、`tests/u8-integrate.test.ts`、`tests/u8-e2e.test.ts`。

## 单测验收

1. contract-match：file 定位命中/未命中（错误含契约 id 与文件路径）；全树搜索命中（无 file 字段）/未命中；多契约不短路；空契约 ok；node_modules 与二进制跳过（树内放置 fixture 验证）。
2. integrate：commit 不可达 → failure 附恢复动作；全部可达 + 验收全绿 + 契约全中 → ok=true + 报告落盘（JSON 结构断言）；任一子验收红 → ok=false 且报告指明红项；契约漂移（signature 改一字）→ ok=false 指明契约 id。
3. loop 派发时机：子全 verified（未全 closed）→ 内部节点集成已触发（不等子 closed）；集成 fail → 重派一轮后修复（fixture 可控）→ verified → exec-review → closed 全链。

## E2E real（tests/u8-e2e.test.ts）

- tmp git 项目：root + 两叶，两叶各自完成真实 build+verify（预置事件，spec 含契约 C1：leaf-a 提供 `export function capitalize(` 签名、file 指向 src/capitalize.js；leaf-b 的 spec 无契约）→ `runLoop`（测试专用适配器或人肉预置推进）触发集成 → 断言：集成 VerifyRan 入账（root verified）、契约命中、产物目录存在、root exec-review 后 closed。
- 契约违背路径：同 fixture 但 leaf-a 实现改名（capitalize → capitalise）→ 集成 fail、VerifyRan(result=fail) 留痕、stderr 指明 C1 与期望文件。

## 通过命令

`npm run check:all` / `npm test` 全量全绿 / `npm run lint`。

## 禁改清单

契约层（types.ts——file 字段已由主 agent 追加，禁再改）；`src/handlers/**`、`src/verify/{checkout,run,name-match,red-phase}.ts`（已验收，只 import；发现缺陷上报）；`src/runner/spawn/**`、`src/readonly/**`、`src/store/**`、`src/core/**`、`src/gates/**`、archive/、docs/rewrite/ 其余、tests/ 既有文件（u7 系列若因 loop 派发时机改动需断言适配，逐条列理由，仅限直接受影响断言）。禁 git 写操作；禁 mock；禁 any。
