# lv-2 验收标准：buildDrift 缓慢进展停派维度 + spawn 超时可调入口

> 设计依据：`M6 自治运行活性与契约防护设计`（`.tmp/design-autonomy-liveness.md`）§3.3 D1/D2 / §4 S1/S5 / §5 波次 lv-2。
> **builder 与 verifier 禁止修改本文件**（防篡改锚点，基线已先行入 git）。

## 1. 目标

补「做不完的单元」的有限成本出口（回溯 G1）：frontier 新停派维度 `buildDrift`——本 spec 周期内 build 证据 ≥K 且无 pass verify → 停派转人工（账本态、跨 run 持久，对照 u4 案例 6×30min≈3h 无限重派）；同时补 `--spawn-timeout-ms` / `CW_SPAWN_TIMEOUT_MS` 可调入口（escalation 文案自认缺口的补齐，D2）。零新事件类型（纯投影既有事件）。

## 2. 交付物（文件级）

| 文件 | 变更 |
|------|------|
| `src/readonly/frontier.ts` | `BUILD_DRIFT_MAX_ATTEMPTS` 常量 + `BuildDriftFact` + `buildDriftFacts()` 投影 + `FrontierGroups.buildDrift` + `GROUP_ORDER` 位次 + `computeFrontier` opts/叶子分支 + `stoppedDispatchState` 第四维 + `frontierHandler` 接线 |
| `src/runner/loop.ts` | `RunLoopOptions.maxBuildAttempts?/spawnTimeoutMs?` + 缺省回落 + assertPositive + 启动行 + `computeDispatchTargets` 黑名单与传参 + spawn `timeoutMs` 用注入值 + escalation 调用传参 |
| `src/runner/escalations.ts` | `buildDriftEscalationMessage` 文案 + `escalationMessage` 第 3 条改写（实际值 + flag 入口）+ `announceManualEscalations` 扩展（新 facts 参数 + dedup + 返回值） |
| `src/handlers/run.ts` | `--max-build-attempts` / `--spawn-timeout-ms` 解析 + `CW_SPAWN_TIMEOUT_MS` env 合流 + usage 文案 + runLoop 传参 |
| `tests/u1b-e2e.test.ts` | 两处 frontier JSON 全对象断言机械适配（加 `buildDrift: []`） |
| `tests/`（若全量发现） | 其他 frontier 全对象断言同款机械适配（§5 授权条款） |
| `CONTEXT.md` | 仅环境变量表 + run 命令表 + 新词条（§4.G 精确锁定） |
| `AGENTS.md` | 仅 runner 循环行（frontier 维度清单 + escalation 家族 + 双 flag） |
| `tests/lv2-build-drift.test.ts` | 新增（零 mock，真实 CLI + 真实 loop） |

## 3. 禁改清单（违反 = FAIL）

- `src/gates/spec-rules.ts`（lv-1 并行领地）、`src/testrun/e2e-sh.ts`、`src/runner/brief.ts`（lv-3 领地）、`src/` 其余未列文件
- `tests/` 既有文件——**唯一例外 = frontier 全对象 `toEqual` 断言的机械适配**（加 `buildDrift` 键，预期必中 `tests/u1b-e2e.test.ts` 两处；其余逐处列入汇报）。非此形态的翻红 = 缺陷，修实现不改测试
- `docs/rewrite/acceptance/` 其余基线、`docs/rewrite/ledger.md`
- CONTEXT.md / AGENTS.md 中 §4.G 之外段落（spec gate 规则段是 lv-1 领地）

## 4. 实现形状（锁定）

### A. 投影函数 `buildDriftFacts`（frontier.ts，范式对齐 flakeReviewFacts）

```ts
export const BUILD_DRIFT_MAX_ATTEMPTS = 5;
export interface BuildDriftFact {
  buildCount: number;   // 当前 spec 周期内 EvidenceSubmitted 计数（返回值恒 ≥ K）
  specEpoch: number;    // 该 unit 累计 SpecSubmitted 次数（出声去重签名的周期维度）
}
export function buildDriftFacts(
  events: readonly LedgerEvent[],
  maxAttempts: number = BUILD_DRIFT_MAX_ATTEMPTS,
): Map<string, BuildDriftFact>;
```

口径锁定（对齐设计 D1 与 flakeReviewFacts 周期实现）：

- **事实源**：`EvidenceSubmitted` 事件即 build 证据（spec 提交走独立的 SpecSubmitted 事件——payload 无 kind 区分，仓内事实源如此），逐条 +1；
- **周期锚**：`SpecSubmitted` 入账即重置（buildCount=0、hasPass=false；specEpoch 累计 +1）——对齐 flakeReviewFacts 的 `frontier.ts:450-457` 周期重置锚（入账只保证过 gate，与 reviewer 过审无关）；
- **pass 豁免**：非集成 `VerifyRan` 且 `result === "pass"` → `hasPass = true`（**不清零 buildCount**——设计 D1 字面「计数 ≥K 且无 pass」是谓词合取，pass 过的 unit 能完成，不属「做不完」；已知边界：pass 后 exec-review 打回再卡 build 循环不触发，注释记档不静默）；
- **集成排除**：`runId` 以 `integrate-` 开头的 VerifyRan 跳过（不计数、不清零、不置 pass——对齐 flakeReviewFacts `frontier.ts:458-460` 的跳过口径，防口径漂移）；
- **外露**：仅 `buildCount ≥ maxAttempts ∧ !hasPass` 的 unit 进 map（谓词不成立不外露，同 flakeReviewFacts 只外露 active 的范式）；
- **回炉边界**（维度注释记档）：specContractBroken 回炉重提 spec 时计数随周期清零、预算重建——最坏「回炉 × buildDrift」交织成本 ≤ 2 代回炉上限 × K，有界不发散，specContractDeadlock 兜底。

### B. 组归属（computeFrontier 叶子分支）

- `FrontierGroups` 加 `buildDrift: string[]`；`GROUP_ORDER` 位次 = **flakeReview 之后、buildReady 之前**（「flake 转人工 → build 预算转人工 → build 推进」的生命周期序，位次写进 GROUP_ORDER 注释）。
- 判定位置 = 既有 `childrenAllClosed` 分支内先查 `buildDriftFacts` 入参命中 → `groups.buildDrift.push`，否则 `buildReady.push`（自引用叶子同走本分支，语义一致）。单组归属由既有 if/else 链天然保持。
- `computeFrontier` opts 加 `buildDriftFacts?: ReadonlyMap<string, BuildDriftFact>`（缺省恒空组——纯函数调用方语义，对齐 flakeReviewFacts opts 注释）；opts 加 `maxBuildAttempts?: number`（缺省回落常量——**注意**：K 的注入点在 `buildDriftFacts` 调用侧而非 computeFrontier 内部，computeFrontier 只消费已算好的 facts map；loop 把 `--max-build-attempts` 值传给 `buildDriftFacts(events, maxBuildAttempts)`）。
- 只读命令（`frontier` handler）恒用默认 K（转人工预算是运行策略，默认值是投影展示语义——对齐 maxSpecRejects 先例注释）。

### C. stoppedDispatchState 第四维

检查序 = specContractDeadlock → flakeReview → specReviewDeadlock → **buildDrift**（追加在末位；单组归属下各维互斥、位次是防御性文档化——注释锁定「buildDrift 插入位次 = 第四，理由：与三个停派维度单组互斥，序不裁决语义」）。文案：`buildDrift（build 证据达预算无 pass，缓慢进展转人工）`。接线同既有三味（传入结算时刻最新事件流，默认 K）。

### D. loop 消费

- `RunLoopOptions` 加 `maxBuildAttempts?: number` / `spawnTimeoutMs?: number`（注释风格对齐 maxSpecRejects：只影响本循环，只读命令恒用默认）。
- `runLoopMain`：缺省回落（`?? BUILD_DRIFT_MAX_ATTEMPTS` / `?? AGENT_SPAWN_TIMEOUT_MS`）；`assertPositive` 扩两参；启动配置行（现 `poll=… max-spec-rejects=…`）补 `max-build-attempts=N spawn-timeout-ms=Nms`；`assertPositive` 的非法参数文案 flag 清单句同步补两 flag 名。
- 每轮 `announceManualEscalations` 与 `computeDispatchTargets` 消费同一份 `buildDriftFacts(events, maxBuildAttempts)` 结果（facts 只算一次传两处——对齐既有 flakes/contractFacts 复用模式）。
- `computeDispatchTargets`：参数加 buildDrift facts、传入 computeFrontier；转人工黑名单 `dimension ===` 集合加 `"buildDrift"`。
- spawn 调用处 `timeoutMs: AGENT_SPAWN_TIMEOUT_MS` → `timeoutMs: spawnTimeoutMs`（本循环解析后的值）。

### E. escalation 出声与文案（escalations.ts）

- 新增 `buildDriftEscalationMessage(rootId, unitId, fact, maxBuildAttempts)`，文案 = 设计 §3.1 成功路径全文锁定：

```
cw run: unit "<id>" 的 build 证据已达 <buildCount> 次（--max-build-attempts 预算 <K>）
且本 spec 周期内无 pass verify——判定缓慢进展（每轮有产出但期望完成时间发散），
停止自动重派，转人工处理（本循环继续处理其余 unit）。恢复动作（按序）：
  1. 人工接手：cw run --root <root> --spawn human（账本即状态，<buildCount> 次证据的进度不丢）
  2. 定位卡点：~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/<unitId>.developer.stdout（历次输出）
  3. 三选一：人工完成该 unit；或拆小任务另建 unit（cw create 深度上限内）；
     或确认可继续自动跑：cw run --root <root> --max-build-attempts <更大值>
```

（artifactDir 实参接入第 2 行的 stdout 路径，对齐 escalationMessage 的 join(artifactDir, …) 既有形态。）

- `escalationMessage` 第 3 条改写：删除「cw run 暂无调大入口」句，改为显示实际值 + 入口——`（--spawn-timeout-ms / CW_SPAWN_TIMEOUT_MS 可调，当前 <spawnTimeoutMs/60000>min）`；签名加 `spawnTimeoutMs: number` 参数，loop 调用处传本循环值。
- `announceManualEscalations`：签名加 `buildDriftFacts` 与 `maxBuildAttempts` 参数（放 maxSpecRejects 后）；dedup 加 `buildDrift: Map<string, string>`；签名 = `` `${fact.specEpoch}:capped` ``（**必须含 specEpoch**——新 spec 周期再次达预算时签名变化重出声，防「回炉后二次触发静默」）；返回值加 `buildDrifts`。出口形态同 flake（「审计-不喂-idle」：停派后无新 developer spawn 即无新 build 证据，空转由 maxIdleMs 收束；人工处置 `--max-build-attempts` 续跑或新 spec 入账后投影自然消失）。

### F. CLI 入口（run.ts）

- `--max-build-attempts`（正整数「次」，`parsePositiveIntFlag` 缺省 `BUILD_DRIFT_MAX_ATTEMPTS`）；`--spawn-timeout-ms`（正整数「毫秒」，缺省 `AGENT_SPAWN_TIMEOUT_MS`）。
- **env 合流在 handleRun 层**（与 CW_REVIEWER_MODEL 在 loop 层合流不同，差异理由写注释：数字校验与 exit 1 可操作错误天然属 CLI 层）：flag 优先 > `CW_SPAWN_TIMEOUT_MS`（须 `/^\d+$/ 且 >0，非法 = fail 可操作文案含原文与合法形态）> 缺省常量。usage 文案（缺 --root 的恢复句）补两 flag。
- `runLoop` 调用传两值。

### G. 文档同步（精确锁定）

1. `CONTEXT.md` 环境变量表加 `CW_SPAWN_TIMEOUT_MS` 行（形态对齐 `CW_REVIEWER_MODEL` 行：优先级 flag > env > 缺省 30min，作用 = 单次 agent spawn 超时）。
2. `CONTEXT.md` 命令表 `cw run` 行补 `[--max-build-attempts <n>] [--spawn-timeout-ms <毫秒>]`。
3. `CONTEXT.md` 词条区新增 `buildDrift` 词条（维度语义：本 spec 周期内 build 证据 ≥K 且无 pass verify → 停派转人工；K 默认 5 经 `--max-build-attempts` 注入；周期锚 SpecSubmitted 清零、集成 run 跳过、pass 豁免；跨 run 持久——账本态非进程态）。
4. `AGENTS.md` runner 循环段：frontier 维度清单补 `buildDrift`（在 flakeReview 与 buildReady 语义位之间提一句）；「四类转人工维度」表述更新为五类（TIMEOUT 封顶 / spec 打回活锁 / flake 连挂 / 解析失败回炉活锁 / buildDrift 缓慢进展）；补两 flag 半句。

### H. 机械适配授权条款（既有测试）

frontier 全对象 `toEqual` 断言加 `buildDrift` 键（预期必中 `tests/u1b-e2e.test.ts` 两处 frontier JSON 断言；其余文本断言 `renderFrontier` 恒显组标题不影响 `toContain` 类断言）。逐处列入汇报；任何其他形态翻红修实现不改测试。

## 5. 新增测试条款（`tests/lv2-build-drift.test.ts`，零 mock）

D 系（投影函数级，真实事件账本 tmp + CW_HOME 隔离，范式对齐 `tests/rv5-flake-escalation.test.ts` / `tests/mx5-2-contract-replan.test.ts`）：

- **D1** K-1 次证据 + verify fail → unit 仍在 buildReady（无误杀）；第 K 次 → 进 buildDrift 组。
- **D2** K 次证据 + 一次 pass verify（非集成）→ 不进 buildDrift（pass 豁免）；pass 后继续加证据也不触发（已知边界行为锁定）。
- **D3** 新 SpecSubmitted 后计数清零（K 次又 spec 重提又 K 次 → 第二周期第 K 次才触发，specEpoch=2）。
- **D4** 集成 run（runId `integrate-*` 的 VerifyRan pass/fail）不置 hasPass、不清零、不计数。
- **D5** 跨 run 持久：同一账本两次独立进程调用（子进程 CLI frontier 两次）结果一致——账本态实证（Ctrl-C 重跑计数不丢的机制等价）。
- **D6** `--max-build-attempts K+3` 注入后 frontier --json 不变（只读恒默认）而 `cw run` 派发恢复：真实 loop（--spawn human + 脚本化提交证据）在 K 时停派该 unit、stderr 出现 buildDrift 文案（含三选一恢复动作原文与实际 buildCount），以 K+3 重跑后该 unit 恢复自动派发。
- **D7** 同 root 其余 unit 在停派期间继续派发（双叶 fixture，一叶 drift 一叶正常）。
- **D8** `stoppedDispatchState` 对 buildDrift unit 返回第四维描述、对三既有维度回归不变。
- **F1** `--spawn-timeout-ms` 非法值（`abc`/`0`/`-5`/`1.5`）→ exit 1 可操作文案；合法值进 runLoop（`CW_SPAWN_TIMEOUT_MS` env 同测：flag 覆盖 env、env 覆盖缺省、env 非法 exit 1）。
- **F2** `--max-build-attempts` 非法值同 F1 形态。
- **S5 兼容**：本仓旧账本副本（或 fixture 无 buildDrift 命中的账本）`cw status`/`cw tree`/`cw report` 输出与改造前逐字节一致（基线 worktree 对照或 golden 快照）；`cw frontier` 文本输出**唯一预期差异** = 新增 `buildDrift:\n  (无)` 组行（显式断言该差异存在且仅此）。

## 6. 通过命令

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split
npm run check:all
npx vitest run tests/lv2-build-drift.test.ts tests/u1b-e2e.test.ts tests/rv5-flake-escalation.test.ts tests/mx5-2-contract-replan.test.ts
npm run lint
npm test   # 全量（并行期 lv-1 中途态挂则记录归因；串行后必须全绿）
```

## 7. 波后验收（verifier 执行，真实场景）

1. **S1 真跑**（设计 §4）：tmp git 仓 root+leaf，leaf spec 过审后脚本化提交 K-1 次 build 证据（每次 commit 微改）且 verify 恒挂 → 第 K 次证据后 `cw run --spawn human` stderr 出现 buildDrift 转人工指引（三选一原文）、该 leaf 停派、root 侧其余推进不受阻；`--max-build-attempts K+3` 重跑恢复派发。
2. **投影纯度**：buildDriftFacts 对同一事件数组两次调用结果全等（无隐藏态）；无 spec 锚的 EvidenceSubmitted 不 crash（防御分支）。
3. **S5 兼容**：`frontier` 新组行是唯一输出差异（status/tree/report 逐字节）。
4. **文档一致性**：§4.G 四处比对。

## 8. status

| 字段 | 值 |
|------|-----|
| status | pending → building → built → verifying → verified → committed |
| 验收基线 commit | 本文件入 git 时的 commit |
