# v1 wave 层 Code Review

## Critical

无。状态机、主流程 gate 编排、replan 旁路、evidence 跨阶段填充核心逻辑正确。tsc 通过，94/94 测试绿。

## Major

### M1. 缺 test-cases-executed gate
- 文件：src/v1/rules/gates/test.ts + src/v1/handlers/test.ts:44-48
- wave 附录 A line 1244 的 WAVE_TEST_GATES 有 4 个 gate，实现只跑 3 个，缺 test-cases-executed（验所有非 manual WaveTestCase 都真跑 + manual 类在 sufficiencyMet.note 有验收记录）
- **修复**：补 testCasesExecuted gate + 在 handleTest gateResults 补上

### M2. abort handler 未 append abandonedRefs
- 文件：src/v1/handlers/abort.ts:67-95
- model §5.6.2 Step 3 要求级联 abort 时追加 abandonedRefs，实现未写
- wave 是叶子无子孙，当前无害。标注 wave-only stub

### M3. computeImpact 未实现级联传播
- 文件：src/v1/rules/replan.ts:59-91
- model §5.6.2 Step 2 要求父→子孙级联传播，实现只做单层命中
- wave 叶子影响面恒空，当前无害。标注 wave-only stub

### M4. freeze 未保护 abandoned 条目的 status 字段
- 文件：src/v1/rules/freeze.ts
- abandoned→active 状态翻转不被捕获，废弃条目可被"复活"
- **修复**：collectViolations 额外校验 before.status==="abandoned" 的条目 after.status 必须仍为 abandoned

## Minor

- m1: ExecuteInput 扁平 vs 文档嵌套 { executeResult: { commitHash } }
- m2: execute 未校验 evidence.commitHash === executeResult.commitHash + changedFiles 应 cw 自动填
- m3: gitValidator 类型重复定义（V1Deps vs gates/test.ts）
- m4: retrospect-covers-judgments 只覆盖 designReviewJudgment（文档要求覆盖三处）
- m5: dispatch loadExecutionUnit 无运行时结构校验
- m6: handleCreate 返回 { unit } 但 dispatch 声明 ActionResult
- m7: handlePlan 回流改 plan 未失效旧 designReviewJudgment
- m8: evidence.generatedAt 初始化空串

## 总结

架构清晰（五层严格分层，core 零依赖，rules 零 IO，handlers 编排），类型安全（无 any，tsc 通过），wave 主流程与 v5 设计高度一致。4 个 major 中 M1/M4 是真实逻辑缺失需修复，M2/M3 是 wave-only stub 需标注。8 个 minor 是形状/品味问题，不影响正确性。
