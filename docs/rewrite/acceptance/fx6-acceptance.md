# fx-6 验收标准：minor 清账（挂账 4 条 + 四跑观察 2 条）

> **本文件是防篡改基线：§1-§7 禁止修改；§8 status 由主 agent 流转更新，不属于防篡改范围。**
> 依据：M4 收官后 minor 清账（用户 2026-08-20 裁决「继续进行 minor 问题修复」）。来源：mx5-4 F1 / mx5-5 F1 / mx-4 挂账 / doc-4 挂账 / m4-gate4-report 异常清单。

## 1. 目标

清掉全部挂账 minor：4 条静态（常量名 / 过时描述 ×2 / 注释重复）+ 2 条四跑观察（flake 消息重复出声 = 唯一行为级修复、末位 reviewer 结算行缺失 = cosmetic）。

## 2. 交付物

| # | 文件 | 动作 | 内容 |
|---|------|------|------|
| X1 | `tests/u5b-e2e.test.ts` | 改 | 常量 `BUILDER_IMPL_DISPATCH_LINE` → `DEVELOPER_IMPL_DISPATCH_LINE`（mx5-4 F1：全大写旧角色词在 N4 grep 口径盲点外） |
| X2 | `AGENTS.md` | 改 | L29 附近 mx-1 段「fail 累计 ≥2 转人工」等过时口径 → 打回代数 ≥ 预算（默认 10）口径（与 CONTEXT.md 一致；doc-4 挂账） |
| X3 | `src/runner/loop.ts` | 改 | L1298-1304 附近注释重复段删除（mx-4 挂账存量）；**X5 末位结算行**：root 全树终态收束路径若跳过最后一个 reviewer spawn 的结算行输出——补齐（收束判定与结算打印的顺序调整或收束分支补打印；session/verdict 在场仅缺行，cosmetic） |
| X4 | `src/runner/brief.ts` | 改 | 「（与 spec gate 规则⑨同口径）」括注 → 「（gate 规则⑨口径更严：--reporter 仅等号形态放行）」或等义精确措辞（mx5-5 F1） |
| X5 | `src/runner/loop.ts` | 改 | **flake 消息重复修复（行为级）**：`announceManualEscalations` 的去重比较从「完整消息文本」改为「稳定签名」——flake 维度签名 = unitId + 排序后 acceptanceId 集合（连挂 runId 单调追加不再是重出理由）；specContractDeadlock 维度同款（签名 = unitId + acceptanceId 集合 + 代数档）；**spec 打回维度维持现状**（各代 fail 意见不同是有意重出，mx-3 设计）。消息文本本身不变（仍含 runIds 与恢复指引，信息不降级）；签名与消息分离实现（dedup map 存签名串）。四跑实证：flake 连挂 runId 增长致 19 条重复出声，纯噪音 |
| `tests/fx6-minor-cleanup.test.ts` | 新建 | §5 条款 |

## 3. 禁改清单（违反 = FAIL）

- `src/testrun/`、`src/verify/`、`src/gates/`、`src/events/`、`src/handlers/`、`src/core/`、`src/store/`、`src/readonly/`（frontier 的 flakeReviewFacts/specContractFacts 事实函数零变更——修复只在 loop 的出声去重层）、`src/runner/spawn/`、`src/cli.ts`、`src/dispatch.ts`、`CONTEXT.md`
- 语义锁定：三类转人工的**判定条件与派发排除零变更**（只改出声去重）；escalation 消息文本内容零降级；spec 打回维度重出语义保持；X5 收束行为本身不变（只补打印行）
- `docs/rewrite/acceptance/` 既有文档（本文件 §8 除外）

## 4. 关键口径

- **X5 签名语义**：「本质事实变化才重出」——flake：同一 unit 同一组 acceptanceId 连挂（无论 runId 追加多少次）只出声一次；新增 acceptanceId 进入连挂（本质变化）重出一次。contract：同款 + 代数档（<上限 / ≥上限 只在跨越时变）。测试按此构造。
- X2 勘误范围：只改 mx-1 段内的过时计数描述，不动该段其他历史记述。

## 5. 测试条款（零 mock）

- **G1 签名去重（flake）**：直写账本构造某 unit 条目 X 连挂 3 次（3 个不同 runId）→ runLoop（stepped/human 模式）轮询窗口内 flake escalation 恰出声 1 次（四跑形态修复的直接断言）。
- **G2 本质变化重出**：连挂 2 次（出声 1 次）→ 条目 Y 新加入连挂 → 再出声 1 次（累计 2 次，消息含 Y）。
- **G3 spec 维度不受影响**：spec 打回代数从 N 到 N+1（新代意见）→ 照常重出（mx-3 语义回归）。
- **G4 contract 签名**：deadlock 态 runId 追加不重出（构造达上限后追加一次解析失败 verify）。
- **G5 X1-X4 静态项**：grep 断言（常量新名在场旧名零残留；AGENTS.md mx-1 段含「预算」口径零「≥2 转人工」残留；loop 注释重复段消失；brief 措辞更新）。
- **G6 回归**：rv5-flake-escalation 套件不红（若既有用例断言了「文本变化重出」旧语义——基线授权最小迁移并逐处标注）；全量绿。

## 6. 通过命令

```
cd <仓库根> && npm run check:all && npm run lint
npx vitest run tests/fx6-minor-cleanup.test.ts tests/rv5-flake-escalation.test.ts
全量 npm test → 全绿
```

## 7. 波后验收（verifier 执行）

G1-G6 独立复跑 + 红性抽查（删签名去重改回文本比较 → G1 红）+ X1-X5 静态 grep 复核。

## 8. status

pending → building → **verified（2026-08-20：verifier 7/7 PASS，报告 fx6-report.md——红性复验精确复现四跑异常-1、X4 偏离裁定成立、X5 语义/消息零降级/判定零变更全核实；X3a 结算行模板逐字节一致 + wait() 缓存主张核实）**。**F1 备案更正（verifier 实测推翻 developer 备案）**：lint warning 非「存量」——基线 `239537c` 版 loop.ts eslint 零 warning，X5/X3a 使物理行 1521→1599（eslint 计 1038 > 1000）为**本次引入**。处置（主 agent 流转区授权）：escalation 出声函数族（escalationMessage / escalationExitMessage / flakeEscalationMessage / specDeadlockEscalationMessage / specContractDeadlockEscalationMessage / announceManualEscalations 及其类型）整体搬迁至新文件 `src/runner/escalations.ts`（单一职责：转人工出声；先例 = mx5-2 四函数迁 frontier），搬移逐字节语义零变化，loop.ts 回到 1000 行内、lint 零 warning。搬迁后 G1-G5 + 全量复跑。

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。
