# Code Review — unit-test-coverage

## 审查范围
- commits: 7896160..b9fe474（4 个 commit：W1-W3 + review 修复）
- 审查方式：subagent 对抗性 review + 主 agent 修复

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 类型契约 | makeTopicWithFails 的 gateHistory.id 用 string 违反 number 类型 | must_fix | pure-functions.test.ts:14 | b9fe474 已修 |
| 可移植性 | stale-lock PID=999999 在 Linux 容器可能命中真实进程 | should_fix | store.test.ts:423 | b9fe474 已修 |
| 代码规范 | require("node:fs") 而非顶部 ESM import | should_fix | store.test.ts:402,422 | b9fe474 已修 |
| 测试脆弱性 | 熔断断言 toContain("5") 钉死魔法数 | should_fix | pure-functions.test.ts:267 | b9fe474 已修 |
| 系统性漏洞 | tsconfig exclude tests 导致类型违规不被发现 | should_fix（记录） | tsconfig.json:19 | 记录待办 |

## plan 覆盖核对

- [x] W1 changes: encodeCwd/judgeByExpected/fileExistsCheck/testCheck/validate/熔断/assertSafeSize — 全部 25 测试已落地
- [x] W2 changes: 4 DAO 测试 + 文件损坏兜底 + isAncestorOfAny 删除 + helper 提取 — 全部落地
- [x] W3 changes: export buildParams + cli-params 13 测试 + stale-lock 测试 — 全部落地

## 结论
- must_fix: 1（类型契约违规），已修
- should_fix: 4，全部已修
- 154/154 测试全绿
