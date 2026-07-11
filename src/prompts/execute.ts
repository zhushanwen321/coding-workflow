/**
 * execute 提示词 — plan gate 通过后返回，指导 agent 如何执行 Wave（dev）和测试（test）。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan(dev) / dev / test 分支。
 * 覆盖 dev + test 两个 action（都属执行阶段，方法论连续）。
 * 交付物：git commit（dev）+ 测试结果（test），渐进式调 cw(dev) / cw(test) 提交。
 */

export const EXECUTE_PROMPT = `
[execute 阶段] 按 Wave 实现 + TDD + 渐进式提交

plan gate 已通过（status=planned）。本阶段把 plan 的 waves 和 testCases 变成代码 + 测试，
通过 git commit + cw(dev) / cw(test) 渐进式推进状态机。

## dev 阶段：逐 Wave 实现 + 提交

### 工作流（每个 Wave）

1. 选一个 dependsOn 已满足的 Wave（初始选 dependsOn 为空的）
2. 严格 TDD：
   - 先写该 Wave 涉及的失败测试（对应 plan 的 testCase）
   - 跑测试确认它确实失败（红）
   - 写实现代码让测试通过（绿）
   - 重构（如需要），保持测试绿
3. git commit 该 Wave 的改动（一个 Wave 至少一个 commit）
4. 调 cw(action=dev, topicId, tasks=[{ waveId: "W1", commitHash: "<commit sha>" }])
   - CW 校验 commit 真实性（存在 + 属本仓库 + 有 diff），通过则该 Wave 标记 committed
5. CW 返回 nextAction：若仍有 Wave 未 committed → 继续 dev；若全部 committed → 进入 test

### TDD 铁律

- [铁律] 先写失败测试，跑确认失败，再写实现，再跑通过。不接受"先写代码后补测试"。
- [铁律] 测试覆盖 plan 的每条 testCase。plan 列了但没测 = 未完成。
- [铁律] 代码改动逐条核对 plan 的 changes 列表——每个文件级改动点都已落地（含 fallback / 边界 / 异常分支）。

### 渐进式提交语义

- cw(dev) 可分多次调用：第一次提交 W1，第二次提交 W2，等等。
- 每次调 cw(dev) 只传本次新 commit 的 Wave，不重传已 committed 的。
- 全部 Wave committed 后，dev gate 通过，status 流转到 developed，nextAction 指向 test。
- 没全部完成就调 cw(test) 会被状态机 guard 拒绝（illegal_transition）——按 nextAction 走不会撞这个。

## test 阶段：跑测试 + 提交结果

### 工作流

1. 所有 Wave 已 committed（dev gate 通过）后，CW nextAction 指向 test
2. 跑 plan 设计的全部 testCase（U* 单测 + E* e2e）
3. 对每条 testCase 调 cw(action=test, topicId, cases=[...]) 提交结果：
   - 单条入参：{ caseId: "U1", actual: { text: "<实际结果>" }, screenshotPath?: "<路径>" }
   - screenshotPath：仅当 plan 该 testCase requiresScreenshot=true 时必传，指向已存在的截图文件
4. CW 按 expected 机器重算每条 case 的 pass/fail（不信任 agent 声明的 status，自己判）
5. 全部 passed 后，test gate 通过，status 流转到 tested，nextAction 指向 retrospect

### test 提交语义

- cw(test) 可分多次调用（渐进式）：第一次提交 U1-U5，第二次提交 E1-E4，等等。
- 每条 case CW 按 expected.text 与 actual.text 判定 pass/fail，不信任 agent 传入的 status 字段。
- 有 case 未 passed 时，nextAction 指回 test 继续；全部 passed 才流转到 tested。
- screenshotPath 指向不存在的文件 = 该 case 判 failed（即使 actual 文本对了）。

## gate fail 恢复

- dev gate fail（commit 不真实/缺失）→ CW 返回 taskResults[].reason，修该 Wave commit 后重调 cw(dev)。
- test gate fail（某 case 实际结果 != 预期）→ CW 返回 caseResults[].failureReason，修代码或修测试后重跑该 case，重调 cw(test)。
- gate 熔断：同一 action 连续 fail 达 5 次，nextAction guidance 换熔断文案，建议找用户人工介入（不阻断，只告警）。

## 本阶段禁止

- [禁止] 跳过 TDD（先代码后测试）
- [禁止] 自行声明 case passed（CW 会机器重算，声明无效）
- [禁止] 不调 cw(dev/test) 就认为流程走完（状态机不流转，进不了 retrospect）

## 完成标志

全部 testCase passed（test gate 通过，status=tested）后，进入 retrospect 阶段做复盘。
`.trim();
