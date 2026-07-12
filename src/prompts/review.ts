/**
 * review 提示词 — dev 全 committed 后返回，指导 agent 做代码审查。
 *
 * 触发点：state-machine.ts buildNextAction 的 dev（全 committed）和 review（retry）分支。
 * 交付物：review.md，落在 {workspacePath}/.xyz-harness/{slug}/changes/review.md，由 cw(review) 消费。
 *
 * 设计意图：复盘反复证明「不强制 = 被跳过」（如 agent 认为「测试全绿 = 代码没问题」就跳过 review）。
 * review gate 用文件存在性强制审查环节存在，内容深度由 agent 按规模判断。
 */

export const REVIEW_PROMPT = `
[review 阶段] 代码审查 + plan 覆盖核对

所有 Wave 已 committed（dev gate 通过）。在进入 test 之前，必须审查代码质量。
复盘反复证明：跳过 review = 测试全绿但功能/边界缺失，到 closeout 才暴露。

## 审查内容（5 维度 + 覆盖核对）

### 5 维度代码审查

对本次 topic 的所有 commit（git log <dev 前的 base>..HEAD）做审查：

1. **业务逻辑正确性**：实现是否对齐 objective？核心路径逻辑对不对？
2. **类型安全**：有没有 any/as 滥用？类型签名是否准确？
3. **边界条件**：空值/零值/最大值/并发竞争/异常分支有没有处理？
4. **测试覆盖**：plan 的每条 testCase 是否都有对应测试代码？有没有只测 happy path？
5. **代码规范**：是否符合项目现有约定（grep 同类写法对照）？

审查推荐用 subagent（如支持）——派独立 reviewer 做对抗性审查，主 agent 自己写的代码自己审容易盲区。

### plan 覆盖核对（逐条对照）

逐条核对 plan.json 每个 wave 的 changes 列表：
- 每个文件级改动点是否都已落地（不只主路径，含 fallback / 边界 / 异常分支）
- plan 列了但代码没实现的 = 未完成，必须补实现后重新 commit + cw(dev)
- 代码改了但 plan 没列的 = 范围蔓延，确认是否必要

## 产出 review.md

审查结果写入 review.md（落 .xyz-harness/<slug>/changes/ 目录），格式：

\`\`\`markdown
# Code Review — <slug>

## 审查范围
- commits: <base>..HEAD（N 个 commit）

## 发现的问题
| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 业务逻辑 | xxx | must_fix/should_fix/nit | src/xxx.ts:42 |

## plan 覆盖核对
- [x] W1 changes[0]: 已落地
- [ ] W2 changes[1]: 未落地（缺异常分支处理）

## 结论
- must_fix 数量 > 0 → 修完后重新 cw(dev) 提交修正 commit
- must_fix = 0 → 调 cw(review) 提交本文件路径
\`\`\`

## 提交 review

review.md 写完后提交：

    cw review --topicId <topicId> --reviewPath <review.md 的绝对路径>

- CW 校验 review.md 存在 + 非空（与 retrospect gate 同模式）
- gate 通过 → status 流转到 reviewed，下一步跑 test
- gate fail（文件不存在/空）→ 重写后重调 cw(review)

## 本阶段禁止

- [禁止] 跳过 review 直接调 cw(test)（状态机 guard 会拒绝 illegal_transition）
- [禁止] 写空的 review.md 应付（gate 只校验非空，但跳过实质审查 = 违背流程意图）
- [禁止] review 发现 must_fix 但不修就调 cw(review)（先修代码，重新 commit + cw(dev)）
`.trim();
