# Code Review — arch-deepening

## 审查范围
- commits: f24b305..2a2069b（5 个 commit：W1-W4 + review 修复）
- 审查方式：subagent 对抗性 review + 主 agent 交叉核实

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 行为等价 | W1 closeout evidence 快照时机：onPass 回调在事务内、三联写后执行，loadTopic 拿到含 closeout-pass 记录的 gateHistory | 验证通过 | actions.ts:215 | 无需修 |
| 行为等价 | W2 devCheck cwd：validator.workspacePath === deps.workspacePath（同字符串构造） | 验证通过 | gate.ts:302 | 无需修 |
| 行为等价 | W3 seed→record 字段默认值：`?? []` / `=== true` 全部保留 | 验证通过 | store.ts | 无需修 |
| 行为等价 | W4 plan-parser 6 处 throw 漏改 CwError → handleReplan 直接调 parseLitePlan 时 throw Error 走 exit 2，与注释「exit ≥1」矛盾 | should_fix → 已修 | plan-parser.ts | 2a2069b 已修 |
| 文档 | W1 gateAdvance 注释引用不存在的 loadTopicInTx | nit → 已修 | actions.ts:181 | 2a2069b 已修 |
| 测试 | closeout gate fail 路径（topicDir 不存在）无测试覆盖 | should_fix | 暂不补（非回归） | 记录待办 |
| 正向副作用 | W4 修复了一个 latent bug：旧 mapExitCode 有 `startsWith("未知 action")` 但 throw 的是 `"unknown action"`（英文），永不匹配 → exit 2。W4 改为 CwError 后正确走 exit 1 | 验证通过 | cli.ts | 无需修 |

## plan 覆盖核对

- [x] W1 changes[0]: gateAdvance 提取 — 已落地（actions.ts:171-233）
- [x] W1 changes[1-3]: handleReview/Retrospect/Closeout 改为调 gateAdvance — 已落地（各 ~20 行）
- [x] W2 changes[0]: devCheck 接受 GitValidator — 已落地（gate.ts:283-284）
- [x] W2 changes[1]: handleDev 传 deps.git — 已落地（actions.ts:342）
- [x] W2 changes[2]: ActionDeps.git 不再是死字段 — 已验证（grep deps.git 有读取）
- [x] W3 changes[0]: waveSeedToRecord 提取 — 已落地（store.ts:463-471）
- [x] W3 changes[1]: testCaseSeedToRecord 提取 — 已落地（store.ts:473-488）
- [x] W4 changes[0]: CwError class — 已落地（types.ts:250-269）
- [x] W4 changes[1]: 预期错误 throw CwError — 已落地（cli/dispatch/actions/store/plan-parser 全覆盖）
- [x] W4 changes[2]: mapExitCode 简化为 instanceof CwError — 已落地（cli.ts:412-414）

## 结论
- must_fix: 0
- should_fix: 2（plan-parser CwError 漏改 + 注释错误），已在 2a2069b 修复
- 110/110 测试全绿，行为零回归
- 候选 4b（schema/版本 seam）按计划暂缓
