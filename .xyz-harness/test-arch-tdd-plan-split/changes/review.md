# Review: test-arch-tdd-plan-split

## 改动范围

9 个 Wave，跨 6 个源文件 + 6 个测试文件 + 1 个 SKILL.md。核心：新增 tdd_plan 阶段，拆分 plan.json 为 dev-plan.json + test.json。

## 架构审查（5 维度）

### 1. 正确性

- **状态机完整性**：TRANSITIONS 新增 tdd_plan {planned→tdd_inited}，dev 从 tdd_inited 开始。replan 的 expectedStatuses 加了 tdd_inited。8 个 status + 9 个 action 形成完整链路。
- **向后兼容**：旧格式 plan.json（含 testCases）仍可通过 cw plan 提交，parseDevPlan 提取 legacyTestCases，handlePlan 兼容写入。LegacyPlanSchema 保留。
- **append-only 约束**：replan --plan 和 --test 都走 validateAppendOnly 校验，已 committed 的 wave 和已 passed 的 testCase 不可改。
- **test 失败回退**：buildNextAction 的 test 分支 gate fail 时 action=dev（不再指回 test），alternatives 保留 replan。

### 2. 测试覆盖

214 个测试全绿。新增覆盖：
- tdd_plan handler（pass/gate fail/分层缺失）—— dispatch.test.ts
- tdd_plan 转换规则（guard 测试）—— state-machine.test.ts
- replan --test / --plan 参数构造 —— cli-params.test.ts
- tddPlanCheck / redLightCheck / runTestRunner —— gate.test.ts
- parseDevPlan / parseTestJson —— plan-parser.test.ts
- priority / redCheck 持久化 —— store.test.ts
- e2e 全流程含 tdd_plan 步骤 —— e2e.test.ts

### 3. 一致性

- prompt 引用：buildNextAction 在 create/plan 分支用 DEV_PLAN_PROMPT，tdd_plan 分支用 TDD_PLAN_PROMPT，dev/test 分支用 EXECUTE_PROMPT。无遗留的 PLAN_PROMPT 引用（state-machine.ts import 已更新）。
- 类型一致性：Action union 含 tdd_plan，Status union 含 tdd_inited，TRANSITIONS 是 Record<Action, TransitionRule> 所以 exhaustive。
- 命名一致：dev-plan.json / test.json / tdd_plan / tdd_inited 在 prompt + SKILL.md + code 中统一。

### 4. 边界/异常

- tddPlanCheck 对空 testCases 返回 fail + mustFix
- redLightCheck 处理 spawn error（ENOENT + exit 127）
- runTestRunner 处理 custom 模式缺 path 抛 CwError
- replan 无 --plan 且无 --test 抛 CwError
- parseTestJson 对环形 dependsOn 检测

### 5. 技术债 / TODO

- **红灯校验未接入 tdd_plan gate**：当前 tdd_plan gate 只做结构校验（tddPlanCheck），不跑实际红灯校验。redLightCheck 函数已实现但 handleTddPlan 没调用它。JSDoc 标注了 TODO。原因是红灯校验需要知道测试命令（testRunner 配置），而 testRunner 的存储和使用尚未完全接入 handler。
- **testRunner 存储未接入**：parseTestJson 解析了 testRunner，但 handleTddPlan 没把 testRunner 存到 topic（Topic 类型没有 testRunner 字段）。testRunner 配置目前只解析不存储。
- **plan.ts 已删除但 dist/ 可能残留**：build 后旧 dist/prompts/plan.js 可能残留，npm publish 前需 clean build。

## 结论

核心架构改造完成，8 阶段流程接通，214 测试全绿。两个 TODO（红灯校验接入 + testRunner 存储）是已知的后续完善项，不阻塞当前流程。
