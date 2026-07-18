/**
 * no-verify 提示词 — doc-only shape 的 tdd_plan 阶段引导。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan_review pass 出口 + tdd_plan retry 分支，
 * 按 taskShape='doc-only' 分流到本提示词（替代 full-tdd 的 TDD_PLAN_PROMPT）。
 *
 * 交付物：无（review-only 策略 preDevCheck 恒 pass，不要求 test.json / existence.json）。
 * doc-only 是纯文档任务（写 ADR / README / 迁移文档），无可机器验证的产物——
 * 验证完全靠人工 review，所以 tdd_plan 阶段无需声明任何验证契约。
 *
 * 流程：tdd_plan（提交任意 payload 即 pass）→ dev（写文档）→ review → test（恒 pass）→ closeout。
 */

export const NO_VERIFY_PROMPT = `
[tdd_plan 阶段] 无需 dev 前验证（review-only 策略）

本任务是 doc-only shape——纯文档任务（写 ADR / README / 迁移文档 / 架构说明），
没有可机器验证的产物（无测试逻辑、无文件存在性约束）。验证完全靠后续的人工 review，
所以 tdd_plan 阶段无需写 test.json 或 existence.json。

## 工作流

直接进 dev 阶段写文档即可。tdd_plan 命令仍需调一次（推进状态机到 tdd_inited），
但提交任意 payload 都会 pass（review-only 策略的 preDevCheck 恒 pass）：

    echo '{}' | cw tdd_plan --topicId <topicId>

## 后续阶段

- **dev**: 写 / 改文档文件，commit 后调 cw(dev)
- **review**: 人工审查文档（设计一致性——文档描述 vs 实际系统行为），提交 review.md
- **test**: postDevVerify 返回空（无可机器验证），isDevVerified 恒 true → test gate pass
- **closeout**: coverage=0（无机器验证产物，不适用——靠 review 兜底）

## 与 full-tdd / delete-only 的区别

| 维度 | full-tdd | delete-only | doc-only |
|------|----------|-------------|----------|
| dev 前交付物 | test.json | existence.json | 无 |
| dev 后验证 | 跑测试 | existsSync | 无（恒 pass） |
| 验证责任 | 机器 | 机器 | 人工 review |

## 禁止

- [禁止] 写测试代码（文档任务无逻辑可测）
- [禁止] 声明 existence.json（文档无文件存在性契约）

## 完成标志

cw(tdd_plan) gate 通过（status=tdd_inited）后，进入 dev 阶段写文档。
`.trim();
