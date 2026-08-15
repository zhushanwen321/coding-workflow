# u8 验收报告：内部节点集成 verify（contract-match + integrate + loop 改造）

> verifier 独立验收报告。验收对象：`docs/rewrite/acceptance/u8-acceptance.md`（锁定文件）。
>
> **总结论：PASS**（可流转 verified → commit）。1 条文档侧瑕疵上报（不阻塞，见 §7）。

## 0. 基线与防篡改

| 项 | 值 |
|----|----|
| 验收基线 commit | `21da1e17c14155086b9f33b888a7afe9f4d58904`（HEAD 即基线） |
| 验收文档 sha256 | `d9254eda11e558846dcf0e474a29ea0fdaedd871a19e0a579284efc8dc20b51c` |
| `git diff 21da1e1 -- docs/rewrite/acceptance/u8-acceptance.md` | 空（未篡改） |

`git diff 21da1e1 --stat`（已跟踪）+ untracked 全量核对：

| 改动 | 归属 |
|------|------|
| `src/runner/loop.ts`（+240 行）、`src/runner/integrate.ts`、`src/verify/contract-match.ts`、`tests/u8-{contract-match,integrate,e2e}.test.ts` | u8 领地（交付物与验收文档「交付物」清单一一对应） |
| `tests/u7-e2e.test.ts`（+34 行） | 授权适配（派发时机改动直接受影响的断言 + 1 行 fixture，见 §5） |
| `docs/rewrite/ledger.md`（+3 行） | 主 agent 状态流转（u8 pending → building + 中断备注），非 builder 越界 |
| `AGENTS.md`（1 行） | 认知外（测试规范描述改动），不属于 u8 交付 |
| `*.drawio` / `*.png` / `*.svg` | 认知外 |

零改动核验：`git diff 21da1e1 --name-only -- src/ tests/` 仅 `loop.ts` + `u7-e2e.test.ts`；禁改清单全部干净——`types.ts`（file 字段已在基线 commit `21da1e1` 内：`src/events/types.ts +2`）、`src/handlers/**`、`src/verify/{checkout,run,name-match,red-phase}.ts`、`src/runner/spawn/**`、`src/readonly/**`、`src/store/**`、`src/core/**`、`src/gates/**`、`tests/` 其余既有文件（含 `tests/u7-loop.test.ts`）均无改动。

## 1. 通过命令实跑（verifier 本机实跑，非转抄 builder 自报）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0 |
| `npm test` | **31 文件 / 208 测试全绿**（29.32s）；208 = 既有 196 + u8 新增 12（contract-match 6 + integrate 4 + e2e 2） |
| `npm run lint` | 零输出 exit 0 |
| `npx vitest run tests/u8-contract-match.test.ts tests/u8-integrate.test.ts tests/u8-e2e.test.ts tests/u7-loop.test.ts tests/u7-e2e.test.ts` | 第 1 遍 20/20 绿（6.27s）；**第 2 遍复跑 20/20 绿**（6.01s，loop 时序敏感场景无抖动） |

## 2. 单测验收条款对照（读测试源码逐条核实，非只看绿）

### contract-match（验收文档单测验收 1，6 条）
- file 定位命中/未命中：验收 1/2 覆盖，未命中 failure 断言含 `C1`、`src/capitalize.js`、`恢复动作`；「期望文件不存在」分支同测（`src/nope.js`）。
- 全树搜索命中/未命中：验收 3（命中深层 `pkg/deep/hidden.txt`）/验收 4。
- node_modules 与二进制跳过：验收 5 有**对照组反证**——诱饵树（签名仅在 node_modules 诱饵 + NUL 头二进制尾部）判未命中（防假阳性），同结构对照树（正常文件含签名）判命中（防跳过规则误伤正常文件）。真实 fixture，非 mock。
- 多契约不短路 + 空契约 ok：验收 6（C1 过 C2 挂 → failures 恰 1 条且指向 C2；`contracts: []` → ok）。

### integrate（单测验收 2，4 条）
bogus commit 不可达 → failure 含 unitId/commit/恢复动作（merge 方向）+ 报告 `reachable:false`；全绿 → ok=true + 报告 JSON 结构断言（kind/rootId/runId/head/children/acceptanceBatches/contracts/ok/failures + 逐 unit 产物子目录 `leaf/AA1.stdout`、`report.json`）；子验收红 → 报告精确指明红项（root 批次照常判定不误伤）；契约漂移改一字 → `contracts.failures` 含 C1 且验收批次全绿（漂移归因不串扰）。全部真实 git 子进程 + 真实账本（子验收从账本读取是规格一部分：`childAcceptanceFromLedger`）。

### loop 派发时机（单测验收 3）
- 前半（子全 verified 未全 closed → 集成已触发）：u8-e2e 成功路径以**账本 seq 断言**——root 集成 VerifyRan seq > 两叶 VerifyRan seq，且 < 两叶 exec-review seq（若仍等子 closed，集成事件不可能先于 review 入账）。
- 后半（fail → 重派 → 修复 → 全链）：u8-e2e 契约违背路径（见 §3）。

## 3. E2E real 真实性抽查

### 成功路径（tests/u8-e2e.test.ts 373-433）
真实 tmp git 仓库（3 commit）+ 预置账本（root spec-frozen split 两叶、两叶 verified 未 closed、C1 冻结在 leaf-a spec / root 无契约）→ 进程内直调 `runLoop`（真实派发）。断言逐条核实为真：
- 集成 VerifyRan 入账：`feat.verifyRuns.at(-1).runId` 匹配 `^integrate-`、result=pass、**acceptanceIds = {AA1,AA2,AB1,AB2,AR1,AR2} = 子∪root 全部 id**（保守口径实证）。
- 产物：`evidence/<rootId>/integrate-<runId>/integrate-report.json` + 三个 unit 子目录 `report.json` 均存在；报告内 children 两条 reachable=true、batches 顺序 `[leaf-a, leaf-b, feat]` 全 pass、contracts `{ok:true,failures:[]}`。
- 全链 closed（root + 两叶）。

### 契约违背路径（439-479）
- fixture 真实改名：leaf-a commit 写入 `capitalise`（CAPITALISE_DRIFT），非改断言绕过。
- 集成 fail：`integrateRuns[0].result === "fail"` 且 `acceptanceIds = []`（fail 轮机器判定 pass 集为空）；stderr 断言含 `集成验证 unit "feat" 失败`、`C1`、`src/capitalize.js`（failure 文本带恢复动作全文，源码 contract-match.ts L75-78）。
- 受控修复真实发生：root 验收脚本 import 失败分支把正确实现写回 origin 仓库（cleanCheckout 是 `git clone` 语义，checkout 树的 origin 指向 fixture 仓库——机制核实成立）并 commit，`rev-list --count` ≥ 4 实证 HEAD 前进；下轮重派集成在修复后的 HEAD 上 pass。
- 全链收尾：fail 轮与 pass 轮产物目录均在（审计留痕）；三 unit 全 closed；全程 spawn 仅 reviewer。

### 「内部节点不派 agent」的证明强度
reviewer-only worker（role !== reviewer → exit 3）+ adapter 内 spawn 记录：若 loop 误派 builder 给 root，worker exit 3 且记录中出现 builder role，`spawned().every(r => r.role === "reviewer")` 即失败。该机制**真能证明 root 无 builder spawn**（误派会被双层捕获：退出码 + 记录断言）。派发循环里 integration 分支在 `inFlight.length >= maxConcurrency` break 之前处理——**内部节点集成不占并发额度**（源码核实）。

### fail → spec-frozen 停留的机制核实
`deriveStatus`（core/fold.ts L110-121）：verified 要求「最后一条 **result=pass** 的 VerifyRan 覆盖全部验收 id」——fail VerifyRan 不推进状态，root 停在 spec-frozen，下轮 `computeDispatchTargets` 重算自然重派集成。与 builder 声明一致，u8-e2e 契约违背路径（fail→重派→pass 序列）实证。

## 4. u7 三项已验收行为原样

- killAll：loop.ts root closed 退出分支保留（适配后包在 subtree 全 closed 判定内，见 §5）。
- 并发闸门：`if (inFlight.length >= maxConcurrency) break` 原样。
- 去重：`computeDispatchTargets` 的 in-flight (unitId, role) 去重原样。
- 佐证：`tests/u7-loop.test.ts` **零改动**且两遍全绿；u7-e2e 除授权断言适配外其余场景零改动。

## 5. 裁量与适配评判

### 裁量 1：集成契约集合 = root spec 契约 ∪ 各子 spec 契约（loop.ts `collectIntegrationContracts`，同 id 冲突 root 先）
**判定：裁量正确且必要。** 验收文档 E2E 条款把 C1 冻结在 leaf-a 的 spec（root 无契约）；若实现只取 root spec 契约，E2E 的「契约命中」与「契约违背」两条路径全部失效（契约比对恒过，违背路径根本不会因契约 fail）。「root ∪ 子」是让 E2E 条款成立的唯一口径，且语义自洽（跨节点承诺由 provider 的 spec 冻结，恰是「切分时冻结的承诺」）。
代价：验收文档 §1 `ContractMatchInput` 注释「contracts: root spec 冻结的契约」与实现不一致——**文档侧瑕疵**，见 §7。

### 适配 2：u7-e2e rootLast 断言从「派发时刻」改「账本 seq」
**判定：必要适配，强度等价、无弱化。**
- 旧断言对象（root builder 的 spawn 时刻）在新语义下消失——root 内部节点不再派 agent。
- 新断言两条：a) root 集成 VerifyRan seq > max(两叶 VerifyRan seq)（集成等子证据齐）；b) root 无 builder spawn 且最后一条 VerifyRan 是 `integrate-` pass（内部节点不派 agent 的直接证据）。
- 旧断言未覆盖而新语义需要的「集成早于子 exec-review」断言，在 u8-e2e 预置 verified fixture（无两 builder 完成时刻先后的竞争窗口）补上——u7 fixture 中该顺序天然不确定，注释已如实说明。
- fixture 追加 1 行 `app.js`：root 验收 A1 = `node app.js`，u7 时代 root builder 假跑验收不需要它，u8 集成真实重跑需要——最小必要适配。

### 适配 3：root closed 退出条件补「子树全 closed」（loop.ts）
派发时机升级后 root 的 exec-review 可能先于子的 exec-review 入账（u7 时代不可能）。若沿用旧退出条件，root 先 closed 会在退出时 kill 未收尾的子 reviewer，子永远停在 verified。补齐为 `subtreeUnits.every(closed)`，无进展由 maxIdleMs 兜底。u7 各场景 rootLast 排序下两者同时成立，行为不变（u7-loop/u7-e2e 全绿佐证）。**判定：正确的必要防御，非行为改变。**

### 声明「前任五产物基本零改动保留」
前任中断未 commit，无中间 git 快照可逐行对比——这是机制限制，无法独立证实「零改动」本身。可核实部分全部吻合：五文件齐全且自洽；「u7-e2e 删未使用 import」→ 当前 diff 无 import 残留且 tsc 过；「两个 u8 测试 evidenceDir 统一 dist 导入」→ u8-e2e L53、u8-integrate L23 均 `from "../dist/store/project.js"`；import 排序 lint 零输出。

## 6. 行为对抗抽查（verifier 独立编写探针，node 直调 dist + tmp git + 隔离 CW_HOME，零 mock，4 组 18 断言全过）

1. **契约 file 指向不存在文件**（直调 `matchContracts`）：`src/ghost.js` 不存在 → ok=false，failure 含 C9 + 相对路径 + 绝对路径定位 + 恢复动作全文（含「重新走 spec 冻结」出口）。附带验证**空 signature 防御**：`signature: "   "` → failure 指明 C10「signature 为空」。
2. **split 声明两子、仅创建一子并推 verified**（直调 `runLoop`，reviewer-only worker）：leaf-b 未创建 → 集成**不触发**（root 零 VerifyRan，idle 超时 exit 1 且文案带 totalEvents 与恢复动作——宁可出声等待不放行缺子集成）；已存在的 leaf-a 正常 reviewer 收尾不受影响；全部 spawn 仅 reviewer。**对照组**：两子齐 verified → 集成 pass、acceptanceIds = 子∪root 全部 6 id、全链 closed、全程无 builder spawn。实证「split 权威集合（非 parentId）」口径——parentId 口径下 leaf-a 单个 verified 即会放行缺子集成。
3. **报告结构与混合可达性**（直调 `runIntegrationVerify`）：一可达子 + 一 bogus 子 → ok=false；报告 children 两条分列 reachable true/false（精确记录）；不可达 failure 附 merge 恢复动作；不可达**不阻断**其余批次（三批全跑全绿，failures 精确归因）；契约比对独立不受牵连；逐 unit 产物子目录落盘。

## 7. 上报事项（不修，主 agent 决策）

1. **文档侧瑕疵（minor）**：`u8-acceptance.md` §1 `ContractMatchInput.contracts` 注释「root spec 冻结的契约」与实现口径（loop 传 root ∪ 子）不一致，且与本文档 E2E 条款（C1 冻结在 leaf-a spec、root 无契约）内在矛盾。实现取了让 E2E 成立的正确口径；`src/verify/contract-match.ts` L27 注释沿用了同一过窄表述。建议后续修正两处注释/文档表述（验收文档是锁定文件，须由主 agent 走修订流程）。
2. **观察（非缺陷）**：split 声明的子未创建时循环以 idle 超时 exit 1 出声（M2 口径：循环不负责子 unit 创建，模块头注释已声明）。idle 消息自带 totalEvents 与恢复动作，行为可接受。
3. **观察（非缺陷）**：`contract-match.ts` 二进制嗅探只看前 8000 字节——尾部含 NUL 的超大文件会被当文本搜索（理论上存在大二进制中字节序列碰撞出 signature 的假阳性命中面）；对源码级 signature 实际风险极低，窗口对典型文件足够。

## 8. 结论

**PASS。** 防篡改基线完好；交付物与验收文档规格锁定逐条对应且真实（无 mock、真实 git/进程/账本）；全部通过命令实跑绿（208 = 196 + 12，时序敏感测试两遍复跑稳定）；builder 五项关键声明全部证实；行为对抗抽查 4 组无一与验收文档矛盾。1 条文档侧瑕疵已上报（§7.1），不构成打回依据。
