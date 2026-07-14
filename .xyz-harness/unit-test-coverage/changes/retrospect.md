# Retrospect — unit-test-coverage

## 做了什么

分 3 Wave 补充 cw-cli 单测覆盖，从 110 测试提升到 154 测试（+44）。

| Wave | 内容 | 新增测试 |
|------|------|---------|
| W1 | 纯函数测试 pure-functions.test.ts（encodeCwd/judgeByExpected/fileExistsCheck/testCheck/validate/熔断/assertSafeSize） | +25 |
| W2 | store DAO 测试（setArtifacts/setEvidence/insertTestCases/replaceUnpassed + 文件损坏兜底）+ isAncestorOfAny dead code 删除 + helper 提取 | +6 |
| W3 | export buildParams + cli-params.test.ts（8 action 参数校验）+ stale-lock 清理测试 | +14 |

## 做对了什么

1. **按可测性分层**：纯函数（零成本）→ DAO 直接测试 → 架构改动（export）。先补零成本高收益的纯函数，再做需要 export 的架构改动
2. **helper 提取消除 3 处重复**：setupGitRepo 在 3 个文件重复定义，提取到 tests/helpers/git.ts + plan.ts，统一了 user.email/name 和 commitFile 的父目录创建
3. **对抗性 review 发现了真实问题**：subagent 发现了类型契约违规（id: string vs number）、PID 硬编码不可移植、require 而非 ESM import、断言钉死魔法数——全部修复
4. **dead code 清理**：isAncestorOfAny 零调用零测试，注释自认"用途无"，删除后减少 gate.ts 认知负担

## 做错了什么 / 可改进

1. **U1 expected 值写错**：plan 里 expected 写了 `encodeCwd('/a/b')==='#a-b--'`，但 `#` 应该是 `--`（encodeCwd 的输出是 `--a-b--` 不是 `#a-b--`）。test 阶段才发现，导致 replan 修正。教训：写 expected 前先跑一次实际函数确认输出
2. **replan append-only 约束踩坑**：第一次 replan 时重写了 wave changes 的文字描述（想简化），被 append-only 校验拒绝（已 committed 的 wave changes 不能改）。需要保持原始 wave changes 逐字一致，只改未 passed 的 testCase expected
3. **review 揭示的系统性漏洞**：tsconfig.json `exclude: ["tests"]` 导致类型违规不被发现。根因是项目缺 `test:typecheck` 脚本——记录为待办
4. **stale-lock 测试覆盖不全**：只测了死进程 PID 清理，没测 30s 超时清理（等 30s 太慢）和锁竞争等待（需要并发进程）

## 测试覆盖改进

- **110 → 154**（+40%），覆盖了之前零测试的纯函数（encodeCwd/judgeByExpected/fileExistsCheck/testCheck/validate）
- **熔断路径**（零测试 → 3 case）：gate 连续 fail 5 次的 circuitBreaker 触发
- **安全防护**（零测试 → 2 case）：assertSafeSize 的 1MB 限制 + 正常大小
- **buildParams 参数校验**（零单测 → 13 case）：8 个 action 的缺参/冲突/非 JSON 路径
- **stale-lock 清理**（零测试 → 1 case）：死进程 PID 的 lockfile 自动清理

## 待办

- tsconfig.json 加 tests 到 typecheck 范围 + `test:typecheck` 脚本（系统性漏洞）
- 30s 超时 stale-lock 清理测试（需要 mock 时间或降低超时阈值）
