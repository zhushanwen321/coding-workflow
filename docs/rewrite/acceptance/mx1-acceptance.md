# mx-1 验收标准：独立 spec-review 派发（异源 reviewer）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：docs/rewrite/design-independent-review.md v1.1（设计对抗审查 MF1-MF3 + S1-S7 全吸收版）+ 用户裁决「补异源派发机制」。canon :221（VerdictSubmitted ← 独立 reviewer）、§1.3 信任链。
> 依赖：rv-5 committed 后派发（loop.ts 领地串行链尾：rv-1 → rv-4 → rv-5 → mx-1）。

## 1. 目标

spec-review 的 VerdictSubmitted 由独立 reviewer spawn 提交（不同进程、审查视角 brief、可选异源模型）；designer 任务书不再含任何 review submit 步骤；fail 打回循环收敛（ping-pong 活锁有账本级出口）；verdict 带自报 role 字段可审计。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/readonly/frontier.ts` | 修改 | 维度重排（created 态单组互斥内按序判定）：`specReviewPending`（有 spec ∧ 最后 spec 后无任何 spec-review verdict → reviewer）/ `specFixPending`（最后 spec 后最近 spec-review verdict 是 fail → designer）/ 既有 `reReview` 谓词被上两维分流后的剩余态（若不可达则删除并在注释说明推导，设计 §3.1）；`specReviewDeadlock` 投影（本 run 账本内该 unit 的 spec-review fail verdict 总数 ≥2，**不因新 SpecSubmitted 清零**，范式对齐 consecutiveIntegrationFails 账本重放） |
| `src/runner/loop.ts` | 修改 | ①DISPATCH_SHAPE：specReviewPending/reReview → reviewer（spec-review 形态）、specFixPending → designer（修 spec 形态）②designerFirstTasks 删自审步骤（human.ts 指令同步删）③新 brief 模板：reviewer spec-review 任务书（内嵌 attachments **绝对路径**（attachmentsDir 计算）+ 审查语义 + `--role reviewer` 提交命令 + fail 时 comment 逐条要求）；specFixPending designer 任务书（内嵌 fail verdict 的 comment 全文 + 修 spec 指令）④派发 gate：同 unit 存在任意 role in-flight 时本轮缓派（S1，顺带修复既有 designer→builder 竞态）⑤specReviewDeadlock 出口：停止派发该 unit + stderr escalation（新文案变体：两次 fail 的 comment 摘要 + 人工处置动作；审计事件不喂 idle，对齐 fx-2 上限出口模式）⑥抢答警告：VerdictSubmitted(spec-review) 入账轮次该 unit 无 in-flight reviewer spawn 且非 specFixPending 流转 → stderr 一行警告（不阻断）⑦exec-review 任务书/文案补 `--evidence-refs`（rv-2 披露的协调项，loop.ts:462 附近 + human-loop.ts:137 由本 unit 一并修——human-loop.ts 为本 unit 新增领地）⑧reviewer spawn 的 req.env 注入 CW_AGENT_MODEL=reviewerModel（RunLoopOptions.reviewerModel 存在时；pi.ts 零改动） |
| `src/runner/human-loop.ts` | 修改 | exec-review 命令模板补 --evidence-refs（领地新增，仅此一处文案修复） |
| `src/runner/spawn/human.ts` | 修改 | designer 指令删自审步骤（第 3 步）；reviewer 指令核对 spec-review 触发点（PROGRESS_MATCHERS 已有 VerdictSubmitted 匹配）；指令含 --role |
| `src/handlers/run.ts` | 修改 | `--reviewer-model <m>` 可选参数 → RunLoopOptions.reviewerModel；进程环境 CW_REVIEWER_MODEL 启动时读取（flag 优先） |
| `src/handlers/review-submit.ts` | 修改 | `--role` 可选 flag（reviewer/designer/builder/human 枚举校验）→ payload.role |
| `src/events/types.ts` | +字段 | `VerdictSubmittedPayload.role?: "reviewer" \| "designer" \| "builder" \| "human"`（注释：提交者自报、可伪造、审计载体非信任边界——canon :221 落地为弱声明） |
| `src/handlers/spec-schema.ts` | ~~修改~~ | **勘误（2026-08-19 回收审计二跑备案，主 agent 修订）**：本行为笔误——该文件只含 spec 文件 TypeBox schema，VerdictSubmitted 的 role 校验实际在 `src/handlers/review-submit.ts` 内联实现（见上两行）；本行作废 |
| `tests/mx1-independent-review.test.ts` | 新建 | §5 A 系条款的测试化（A1-A5） |
| `tests/mx1-model-chain.test.ts` | 新建 | A4 模型链（spawn 命令行断言） |
| `tests/u7*.test.ts`、`tests/u5b*.test.ts`、`tests/fx3*.test.ts` | 迁移 | designer 任务书断言反转（不再含 review submit）；reviewer 派发新增断言；fx3 R5.3 兜底出口与 specFixPending 的交互核对 |

## 3. 禁改清单（违反 = FAIL）

- `src/verify/`、`src/gates/spec-rules.ts`、`src/testrun/`、`src/core/fold.ts`（fold 状态机零变更——specFixPending/specReviewDeadlock 全在 frontier 投影层）、`src/store/`、`src/runner/{integrate,worktree}.ts`、`src/runner/spawn/{types.ts,lifecycle.ts,pi.ts}`（pi.ts 零改动是设计锁定——模型注入走 req.env 复用既有四级链）、`src/cli.ts`、`src/dispatch.ts`
- 事件 schema 除 role 可选字段外零变更；timeoutStreaks 既有语义零变更（reviewer spawn 计入即可）
- `docs/`、`archive/`

## 4. 关键口径（锁定）

- **维度互斥**：created 态内 if/else 序保证单组归属（dimensionOf 单值映射成立）；specReviewPending 与 specFixPending 谓词精确按设计 §3.1 表。
- **deadlock 计数不清零**：fail verdict 总数 ≥2 转人工——designer 重提 1 字节新 spec 不能清零计数（MF2 教训）；但「人工处置后新事件自然重算」指人工提交 pass verdict 或修改后的投影重算，不是自动恢复循环。
- **派发 gate 保守**：同 unit 任意 role in-flight → 缓派（不派该 unit 任何新 role）；等待窗口 ≤ 一个 poll 周期，无死等（spawn 必然结算或 TIMEOUT）。
- **role 字段是弱声明**：不校验、不信任、只记录；抢答警告是唯一可见性增强（stderr 一行，不阻断不入账）。
- **reviewer 默认模型回落 builder 同款**：未配置时不注入 env（spawn 与 builder 同 model）——异源达成路径 = --reviewer-model / CW_REVIEWER_MODEL。
- **designer 任务书与 human designer 指令双双不含 review submit**（A2 断言覆盖两个产物）。
- **spec-review fail 的 comment 是 specFixPending 任务书的失败事实来源**（内嵌全文，不退化成「见报告」）。

## 5. 新增测试条款（两个新文件，真实子进程 + tmp + CW_HOME 隔离，零 mock）

### tests/mx1-independent-review.test.ts
- **T1 打回循环全链（human E2E）**：root 微任务 → designer 提 spec → **reviewer 派发**（brief 含 attachments 绝对路径可解析）→ 人扮演 reviewer 提交 fail（comment 含不合格项）→ **specFixPending 派 designer**（任务书含 fail comment 全文、不含 review submit 字样）→ 新 spec → reviewer pass → spec-frozen。时序断言：verdict 事件 ts 晚于 reviewer brief 文件 mtime。
- **T2 deadlock 两种形态**：①不重提的两连 fail ②fail → designer 重提（改 1 字节）→ fail——两种形态都触发 specReviewDeadlock（frontier --json 可见）+ escalation 含两次 fail comment 摘要 + 该 unit 停止派发（loop 继续 poll ≥3 轮无新派发）。
- **T3 抢答警告**：无 in-flight reviewer 时人为提交 spec-review verdict → loop stderr 出现警告行（不阻断，循环继续）。
- **T4 派发 gate**：designer spawn 存活期间（构造慢完成信号）frontier 出现 specReviewPending 但本轮不派 reviewer；designer 结算后下轮派发。
- **T5 exec-review 文案修复回归**：loop.ts 与 human-loop.ts 的 exec-review 模板含 --evidence-refs；按模板执行的 human 全链收敛 closed 不再被 refs 校验卡住。
- **T6 role 字段**：--role reviewer 入账 payload.role=reviewer；--role boss 非法值被拒含恢复动作；缺省无 role 键。

### tests/mx1-model-chain.test.ts
- **T7 三级链**：CW_REVIEWER_MODEL 进程环境 → reviewer spawn 的 pi 命令行含对应 --model；--reviewer-model flag 优先于环境；都未设 → reviewer 与 designer spawn 命令行同 model（对照断言）。
- **T8 pi.ts 零改动**：git diff 确认 src/runner/spawn/pi.ts 无变化（设计锁定的验证锚点）。

## 6. 通过命令

```
cd <仓库根> && npm run check && npm run check:tests
npx vitest run tests/mx1-independent-review.test.ts tests/mx1-model-chain.test.ts tests/u7*.test.ts tests/u5b*.test.ts tests/fx3*.test.ts
npx eslint src/readonly/frontier.ts src/runner/loop.ts src/runner/human-loop.ts src/runner/spawn/human.ts src/handlers/{run,review-submit}.ts src/events/types.ts tests/mx1-*.test.ts
全量 npx vitest run → 全绿
```
