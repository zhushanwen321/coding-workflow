/**
 * execute 提示词 — tdd_plan gate 通过后返回，指导 agent 如何执行 Wave（dev）和测试（test）。
 *
 * 触发点：state-machine.ts buildNextAction 的 tdd_plan(pass) / dev / test 分支。
 * 覆盖 dev + test 两个 action（都属执行阶段，方法论连续）。
 *
 * 与旧版的差异：
 * - 测试代码已在 tdd_plan 阶段写好（红灯已确认），dev 阶段只写实现让测试转绿
 * - test 失败统一回 dev（不再指回 test retry）
 * - replan 支持 --plan / --test 两种模式
 */

export const EXECUTE_PROMPT = `
[execute 阶段] 按 Wave 实现 + 让测试转绿 + 渐进式提交

tdd_plan gate 已通过（status=tdd_inited）。测试代码已写好（红灯已确认），test.json 已写入。
本阶段写实现代码让测试转绿，通过 git commit + cw(dev) 推进，然后 cw(test) 验证。

## dev 阶段：逐 Wave 实现 + 提交

### commit 纪律（每 Wave 独立 commit）

[MANDATORY] **每个 Wave 必须有独立的 commit，即使是简单任务也要分开 commit。**

commit 是 Wave 级验证锚点——CW 用 commit 存在性 + diff 非空校验每个 Wave 是否真落地。
两个 Wave 共享一个 commit 会让验证脱节：无法区分哪个 Wave 的改动在 commit 里、哪个没做。

规则：
- 一个 Wave 至少一个 commit（可多个 commit 拆细，但不可多个 Wave 共享一个 commit）
- 即使两个 Wave 改动都很小（各几行），也要分开 commit
- commit message 标明 Wave（如 "feat(W1): xxx"）

### 工作流（每个 Wave）

1. 选一个 dependsOn 已满足的 Wave（初始选 dependsOn 为空的）
2. 写实现代码让该 Wave 的测试转绿：
   - 测试代码已在 tdd_plan 阶段写好（红灯已确认）
   - 写实现让测试通过（绿）
   - 重构（如需要），保持测试绿
3. git commit 该 Wave 的改动（一个 Wave 至少一个 commit）
4. 提交该 Wave：

    cw dev --topicId <topicId> --tasks '[{"waveId":"W1","commitHash":"<commit sha>"}]'

   - CW 校验 commit 真实性（存在 + 属本仓库 + 有 diff），通过则该 Wave 标记 committed
5. CW 返回 nextAction：若仍有 Wave 未 committed → 继续 dev；全部 committed → 进入 review

### TDD 铁律

测试代码已在 tdd_plan 阶段写好。dev 阶段的职责是写实现让测试转绿。

- [铁律] 每个 Wave 的实现完成后，跑该 Wave 的测试确认通过（绿）。不通过 = 实现有问题，继续修。
- [铁律] 代码改动逐条核对 dev-plan.json 的 changes 列表——每个文件级改动点都已落地。
- [铁律] 所有 P0/P1/P2 wave 都必须完成，不允许跳过。

### 渐进式提交语义

- cw(dev) 可分多次调用：第一次提交 W1，第二次提交 W2，等等。
- 每次调 cw(dev) 只传本次新 commit 的 Wave，不重传已 committed 的。
- 全部 Wave committed 后，dev gate 通过，status 流转到 developed，nextAction 指向 review。

### Wave 执行模式：subagent 派发（推荐）

当 Wave 之间无依赖（dependsOn 为空）且 ≥2 个 Wave 时，推荐用 subagent 并行执行：

- 每个 Wave 派一个独立 subagent，各自上下文隔离
- subagent 职责：读 dev-plan.json 该 Wave 的 changes → 写实现让测试转绿 → git commit → 返回 commitHash
- 主 agent 收集所有 commitHash 后，统一调一次 cw(dev) 提交
- 依赖链上的 Wave 必须串行（前一个 committed 后才能开始下一个）

    cw dev --topicId <topicId> --tasks '[{"waveId":"W1","commitHash":"<sha1>"},{"waveId":"W2","commitHash":"<sha2>"}]'

## test 阶段：跑测试 + 提交结果

### 工作流

1. 所有 Wave 已 committed（dev gate 通过）→ review gate 通过后 → CW nextAction 指向 test
2. 跑 test.json 定义的全部 testCase（U* 单测 + E* e2e）
3. 对每条 testCase 提交结果：

    cw test --topicId <topicId> --cases '[{"caseId":"U1","actual":{"text":"<实际结果>"}}]'

   - screenshotPath：仅当 testCase requiresScreenshot=true 时必传
4. CW 按 expected 机器重算每条 case 的 pass/fail（不信任 agent 声明的 status，自己判）
5. 全部 passed → test gate 通过，status 流转到 tested，nextAction 指向 retrospect

### test 提交语义

- cw(test) 可分多次调用（渐进式）。
- 每条 case CW 按 expected.text 与 actual.text 精确比较判定 pass/fail。
- screenshotPath 指向不存在的文件 = 该 case 判 failed。

### test 失败 → 回退到 dev（统一路径）

test 有 case 未通过时，CW nextAction 指向 **dev**（不是 test retry）。
分析 failureReason 后修复：

| 原因 | 修复路径 | 命令 |
|------|---------|------|
| 代码 bug | 修代码 → 重 commit → cw(dev) → cw(review) → cw(test) | 直接改代码 |
| expected 写错 | replan 修订 test.json | \`echo '<testJson>' \| cw replan --topicId <id> --test\` |
| plan 设计有误 | replan 修订 dev-plan + test.json | \`echo '<json>' \| cw replan --topicId <id> --plan --test\` |

是否需要 replan 由 agent / 用户讨论决定，CW 不自动路由——统一回 dev 修代码是最简路径。

## replan（修改计划）

status∈{planned, tdd_inited, developed, reviewed, tested} 时可调 cw replan。
replan 支持两种模式（可同时用）：

### --plan：修订 dev-plan（追加/调整 wave）

    echo '<newDevPlanJson>' | cw replan --topicId <id> --plan

### --test：修订 test.json（追加/调整 testCase / 修正 expected）

    echo '<newTestJson>' | cw replan --topicId <id> --test

### append-only 约束

| 不可动 | 原因 |
|-------|------|
| 已 committed 的 wave | commit 锚定，改了脱节 |
| 已 passed 的 testCase expected | 判定基准，改了失效 |

未 committed/passed 的可改可删。replan 后 status 回退到 planned，重走 tdd_plan → dev → review → test。
已 committed 的 wave 保留不动（progressive），dev 阶段只做新增的 wave。

## gate fail 恢复

- dev gate fail（commit 不真实/缺失）→ 修该 Wave commit 后重调 cw(dev)。
- test gate fail → 回 dev 修代码（见上方"test 失败 → 回退到 dev"）。
- gate 熔断：连续 fail 达 5 次，guidance 换熔断文案，建议找用户人工介入。

## 本阶段禁止

- [禁止] 跳过 TDD（测试已在 tdd_plan 写好，dev 只写实现）
- [禁止] 自行声明 case passed（CW 机器重算，声明无效）
- [禁止] 不调 cw(dev/test) 就认为流程走完

## 完成标志

全部 testCase passed（test gate 通过，status=tested）后，进入 retrospect 阶段做复盘。
`.trim();
