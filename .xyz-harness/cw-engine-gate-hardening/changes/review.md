# Code Review — cw-engine-gate-hardening

## 审查范围
- commits: 2fe1a9b..39bf410（5 个 commit，W1-W5）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| plan-parser | assertAcyclicDeps 对不存在的 dep id 跳过（`!color.has(dep)` continue），不报"引用不存在"错 | nit | src/plan-parser.ts:83 |
| gate.ts | 测试分层校验在 planCheck 内（gate 层），不在 parseLitePlan 内（parser 层）——分层是 gate 判定不是解析，位置正确 | — | 确认正确 |
| actions.ts | handleReview 的 passed 变量用 `!` 非空断言（`if (!passed!)`），与 handleRetrospect/handleCloseout 一致，但不够严谨 | nit | src/actions.ts:501 |
| state-machine | review/test 分支注入了 replan alternative，但 replan 完成后会重新指向 dev/review，可能形成 alternative 循环提示——实际无害（alternative 只是提示） | nit | 确认无害 |

## plan 覆盖核对

- [x] W1: assertAcyclicDeps（DFS 环检测 wave+testCase）+ planCheck 测试分层 hard fail + PLAN_PROMPT 强化
- [x] W2: commitHash 唯一性 warning（extraCommitReuse）+ EXECUTE_PROMPT COMMIT_DISCIPLINE
- [x] W3: review action 状态机（types/state-machine/actions/cli/dispatch）+ REVIEW_PROMPT
- [x] W4: replan expectedStatuses 加 reviewed+tested + EXECUTE_PROMPT test 阶段 replan 提示
- [x] W5: SKILL.md review 行 + replan 状态范围更新

## 结论

must_fix = 0。所有 plan changes 已落地。4 个 nit 不阻断（assertAcyclicDeps 的 dep 存在性交回 schema 层，passed! 断言是既有模式一致性）。
