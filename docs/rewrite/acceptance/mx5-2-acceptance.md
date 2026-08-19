# mx5-2 验收标准：解析失败回炉投影 + 派发链 + D6 文案诚实化

> **本文件是防篡改基线：§1-§7 禁止修改；§8 status 由主 agent 流转更新，不属于防篡改范围。**
> 依据：`docs/rewrite/design-spec-contract-replan.md` D2（投影与派发语义，含两维度判定形式化、flakeReview 并存语义与逃逸面、同构条目）+ D6 + mx5-2 拆分行（commit `97804d5`）。前置：mx5-1 已交付（`e29238e`，`VerifyRanPayload.parseFailedAcceptanceIds` 已入事件）。

## 1. 目标

消费 mx5-1 的事件字段，建成 verify 阶段回炉通道的投影与派发链：解析失败连挂 ≥2 → 新 frontier 维度 `specContractBroken` 派 designer 修复（任务书内嵌解析失败原文）；回炉代数 ≥2 且当前周期再连挂 ≥2 → `specContractDeadlock` 停派转人工（防活锁）；flake 连挂输入排除解析失败条目；TIMEOUT 结算文案在停派态诚实化。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/readonly/frontier.ts` | 修改 | ①新投影函数（解析失败连挂事实 + 回炉代数，语义见 §4）②`computeFrontier` spec-frozen 分支新增两维度：`specContractBroken` / `specContractDeadlock`，判定序先于 flakeReview（分支单组归属，序即裁决）③`GROUP_ORDER` 展示序插入（flakeReview 之前）④flake 连挂输入排除 `parseFailedAcceptanceIds` 条目 ⑤只读输出（frontier/status）含新分组 |
| `src/runner/loop.ts` | 修改 | ①DISPATCH_SHAPE：specContractBroken → designer 修复形态（复用 specFixPending 派发形态）②specContractDeadlock 进派发排除清单（specReviewDeadlock 同款）③escalation 文案（代数 ≥2 转人工：含 2 代回炉与恢复指引，签名去重沿用 mx-3 模式）④D6：`describeExit` 增停派态输入，TIMEOUT 结算行在停派态改述真实行为（「该 unit 当前处于 X 停派态，本次超时不触发重派；恢复动作：……」）——**只改文案不改优先级行为** |
| `src/runner/brief.ts` | 修改 | ①新回炉任务书模板（designer 修复形态复用 specFixPending 模板骨架 + 内嵌全部解析失败验收 id 与错误原文 + 规则⑨式恢复指引）②角色类型 Exclude 增 specContractDeadlock（与 loop 排除清单联动）③顺带修复现存「连续 2 次」过时文案（与 rv-4 MAX=1 / mx-4 预算语义对齐） |
| `tests/mx5-2-contract-replan.test.ts` | 新建 | §5 F 系条款 |
| `tests/mx5-1-spec-rule9.test.ts` | 增用例 | 顺带补 R2b（mx5-1 verifier finding 1）：`--reporter=json-verbose`（含 json 子串、非恰 json）→ 拒绝。**只准新增用例，禁改既有用例** |

## 3. 禁改清单（违反 = FAIL）

- `src/testrun/`（全部）、`src/verify/`（全部）、`src/gates/`、`src/events/types.ts`、`src/handlers/`（全部——含 verify.ts 的字段提取，已随 mx5-1 定型）、`src/core/`、`src/store/`、`src/runner/{integrate,worktree,human-loop}.ts`、`src/runner/spawn/`、`src/cli.ts`、`src/dispatch.ts`
- 既有语义锁定：`flakeReviewFacts` 对断言失败条目的既有语义（per-acceptance、中间 pass 清零、SpecSubmitted 周期锚、排除 integrate-）只增「排除解析失败条目」一点；`specReviewFailCounts` / 打回代数 / `SPEC_REVIEW_DEADLOCK_FAILS=10` 零变更；`INTEGRATION_MAX_CONSECUTIVE_FAILS=1` 不动；mx5-3 交付的 reviewer 模板逐字节不动（brief.ts 只准新增回炉模板与改 D6 过时文案）
- `docs/rewrite/acceptance/` 既有文档（本文件 §8 除外）、`docs/rewrite/design-spec-contract-replan.md`

## 4. 关键口径（锁定，出处设计文档 D2）

- **解析失败连挂（与 flakeReviewFacts 同构）**：per-acceptance 粒度逐条计数；该条目中间一次解析成功（该 id 不在 parseFailedAcceptanceIds 的 VerifyRan）即清零；周期边界 = SpecSubmitted **事件**（不比 specHash，同内容重提同开新周期）；排除 `integrate-` 前缀 runId；无 spec 周期锚的 VerifyRan 忽略（与 flake 同款防御）。
- **回炉代数**：每发生一次「解析失败连挂 ≥2 → 新 SpecSubmitted」计 1 代；**累计绝不清理**（新 spec 只清连挂计数）。实现口径：spec-frozen 态下某 unit 的历史中「连挂达成 2 的次数 × 其后跟随新 SpecSubmitted」——具体算法 developer 定，验收锁语义（F5/F6 用例可判）。
- **两维度判定（形式化，消除谓词歧义）**：解析失败连挂 ≥2 ∧ 回炉代数 <2 → `specContractBroken`（派 designer，developer 共获 2 次修复机会且每次经 verify 检验）；解析失败连挂 ≥2 ∧ 回炉代数 ≥2 → `specContractDeadlock`（停派转人工，不再派 designer）。**deadlock 需当前周期连挂再次 ≥2**——代数满 2 但新 spec 尚未再连挂时既非 broken 也非 deadlock（unit 正常进行 verify）。
- **与 flakeReview 并存**：spec-frozen 分支单组归属，specContractBroken/deadlock 在前。混合 unit（断言失败条目连挂 ×2 + 解析失败条目连挂 ×2 同真）归 broken 组、flakeReview 不再列该 unit（此为已知逃逸面的行为面：新 spec 入账清全部连挂——设计已记档，实现如实落地即可，不做 per-acceptance 分条目跟踪）。
- **回炉任务书取数检查点（设计文档待验证①）**：解析失败原文不在 VerdictSubmitted——developer 先读 verify 落盘产物结构（`<id>.report.json` 顶层 parseError/reason、VerifyRan payload）决定取数路径，交付说明列出所选路径与理由。底线：任务书必须含全部解析失败验收 id + 每条错误原文（reason）+ 恢复指引；取不到原文时降级为 id + 产物文件路径，需在交付说明备案。
- **D6 边界**：只改文案与 describeExit 签名（增停派态输入），超时后是否重估停派优先级**不做**（列观察项）。

## 5. 新增测试条款（真实事件账本 + tmp + CW_HOME 隔离，零 mock；直写账本构造优先）

### tests/mx5-2-contract-replan.test.ts（F 系）

- **F1 连挂触发**：spec-frozen unit，同 id 两次 VerifyRan 带 `parseFailedAcceptanceIds` → `cw frontier` 出现 specContractBroken。
- **F2 中间解析成功清零**：fail(parse) → pass（该 id 无解析失败）→ fail(parse) → 不触发（计数 1，未满 2）。
- **F3 周期边界与代数**：连挂 2 → 新 SpecSubmitted（代数 1、连挂清零）→ 新周期连挂 1 → 不触发；再连挂 1（满 2）→ broken（代数 1 <2）。
- **F4 integrate 排除**：`integrate-` 前缀 runId 的 VerifyRan 携带解析失败字段 → 不计数。
- **F5 代数满转人工**：两轮完整回炉（代数 2）→ 新 spec 周期再连挂 2 → `specContractDeadlock`（非 broken）；escalation 文案含 2 代回炉与恢复指引。
- **F6 deadlock 谓词**：代数 2 且当前周期连挂 0 或 1 → 既非 broken 也非 deadlock（unit 处于正常维度）。
- **F7 flake 排除与并存**：混合 unit（e2e 条目 X 断言失败连挂 2 + 条目 Y 解析失败连挂 2）→ 归 specContractBroken、flakeReview 不列该 unit；对照 unit（仅条目 X 断言失败连挂 2、无解析失败）→ flakeReview 照旧列出（既有语义不回归）。
- **F8 派发映射**：broken → DISPATCH_SHAPE 派 designer（human spawn 模式下任务书落盘）；deadlock → 该 unit 零派发（loop 排除清单生效）。
- **F9 回炉任务书内容**：渲染产物含全部解析失败验收 id、错误原文（reason 或产物路径）、恢复指引、spec diff 要求与「新 spec 照旧过独立 reviewer」提示（复用 specFixPending 模板骨架的既有字段）。
- **F10 D6 文案**：TIMEOUT 结算在停派态输出「处于 X 停派态，本次超时不触发重派 + 恢复动作」；非停派态文案与现状语义一致（仅措辞对齐）；brief.ts「连续 2 次」过时文案消失。
- **F11 只读输出**：`cw status` / `cw frontier` 对 broken/deadlock unit 的分组与提示在场（JSON 与文本两形态）。

### 顺带（tests/mx5-1-spec-rule9.test.ts）

- **R2b 子串拒收**：`--reporter=json-verbose` → exit 1（含 json 子串但非恰 json——堵 mx5-1 verifier 红性抽查③暴露的用例缺口）。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/mx5-2-contract-replan.test.ts tests/mx5-1-spec-rule9.test.ts
npx eslint src/readonly/frontier.ts src/runner/loop.ts src/runner/brief.ts tests/mx5-2-*.test.ts
全量 npm test → 全绿
```

## 7. 波后验收（verifier 执行，V2 + V2b 场景，human spawn 真实 dispatch 全链）

- **V2 回炉全链**：构造「无标记产出且 exit 0」e2e 验收 spec（能过规则⑨）→ `cw run --spawn human` 快速扮演 developer/designer → 第 2 次 verify 解析失败后 runner 改派 designer、任务书含两轮解析失败原文 → 新 spec 入账 → reviewer 环照常 → 断言：账本 parseFailedAcceptanceIds 字段在场、specContractBroken 出现、回炉后连挂清零代数不清零（账本事件序列推导）、flakeReview 未触发。
- **V2b 防活锁出口**：走满两轮回炉后代数 2 → 新周期再连挂 2 → specContractDeadlock 出现（此前 broken 恰累计 2 次）、停派出声、此后零派发。

## 8. status

pending → building（2026-08-19 developer 交付：src 3 文件 +721/-182 + 新测试 15 用例 + R2b×2，全量 68 文件 527 绿。**越界备案 4 项（测试侧最小调整，先例依据 rv-5 `ef4ee67` / mx5-3 基线 §3 明文，待 verifier 深查）**：①mx5-3 测试 B3 快照同步 brief 文案修复 ②u1b-e2e toEqual 补空键 ③rv5 fixture 改恒可解析 JSON（解析失败归回炉后 flake 场景被抢的语义必然；T5 断言 buildReady→specContractBroken）④D6 停派态范围——TIMEOUT 封顶转人工为单进程内存态不进 describeExit（代码注释记档）。另：loop.ts 四个纯投影函数逐字节搬移 frontier.ts（eslint max-lines 触顶 977/1000，frontier 本是派发判定单一出处）。取数路径选定 verify 产物 report.json 的 parseError/reason，降级路径有测试；待 verifier）
