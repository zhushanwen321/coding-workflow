/**
 * execute 提示词 — tdd_plan gate 通过后返回，指导 agent 如何执行 Wave（dev）和测试（test）。
 *
 * 触发点：state-machine.ts buildNextAction 的 tdd_plan(pass) / dev / test 分支。
 * 覆盖 dev + test 两个 action（都属执行阶段，方法论连续）。
 *
 * 与旧版的差异：
 * - 测试代码已在 tdd_plan 阶段写好（红灯已确认），dev 阶段只写实现让测试转绿
 * - test 失败走 test_fix loop（不回 dev，不原地 retry）
 * - replan 支持 --plan / --test 两种模式
 */

export const EXECUTE_PROMPT = `
[execute 阶段] 按 Wave 实现 + 让测试转绿 + 渐进式提交

tdd_plan gate 已通过（status=pre_dev_verified）。测试代码已写好（红灯已确认），test.json 已写入。
本阶段写实现代码让测试转绿，通过 git commit + cw(dev) 推进，然后 cw(test) 验证。

## dev 阶段：逐 Wave 实现 + 提交

### commit 纪律（推荐每 Wave 独立 commit）

[最佳实践] **强烈建议每个 Wave 用独立的 commit**，尤其是复杂任务或多 Wave 任务。

commit 是 Wave 级验证锚点——CW 用 commit 存在性 + diff 非空校验每个 Wave 是否真落地。
两个 Wave 共享一个 commit 会让验证脱节：无法区分哪个 Wave 的改动在 commit 里、哪个没做。

engine 行为说明（warning 不阻断）：
- CW 检测到多个 Wave 共享同一 commitHash 时，会在 taskResults 里标记 \`extraCommitReuse\` 警告，但**不会 gate fail**——仍会把这些 Wave 标记为 committed。
- 这是**有意的放行**：对极简任务（如两个 Wave 各改几行），agent 可以用一个 commit 装多 Wave，不被流程卡住。
- 警告只是提示验证脱节的风险，不影响流程推进。

引导（建议遵循，非强制）：
- 一个 Wave 至少一个 commit（可多个 commit 拆细，但不要多个 Wave 共享一个 commit）
- 即使两个 Wave 改动都很小（各几行），也建议分开 commit
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
   - **[强制] CW 同时校验 dependsOn 拓扑**：wave 的 dependsOn 里所有 waveId 必须都已 committed，否则该 wave 拒绝 committed，taskResults 标 \`unsatisfiedDeps\`（gate fail，不是 warning）
5. CW 返回 nextAction：若仍有 Wave 未 committed → 继续 dev；全部 committed → 进入 review

### 实施节奏纪律

每个 Wave 的实施过程中，验证频率有明确节奏：

- **typecheck 频繁跑**（regularly，不是只在最后）：改几行就 typecheck，捕获类型错误越早越好
- **单文件测试频繁跑**（regularly）：改完涉及到的单个测试文件就跑一次，快速反馈
- **完整测试套件只在最后跑一次**：cw(test) 阶段统一跑全量，不在 dev 阶段反复跑

**为什么不早跑全量**：全量慢，且单 Wave 改动不应该影响别的 Wave 的测试。单文件测试足以反馈本 Wave 的实现质量。

**与 subagent 派发模式的关系**：subagent 跑涉及包的单包验证（FR-7），主 agent 提交前跑全量——这正是"单包频繁 / 全量最后"的体现。

### refactor 的边界：wave 内 vs 架构性

工作流第 3 步的"重构"有明确边界，不是所有重构都该在 dev 阶段做：

#### 允许在 dev 第 3 步做的（wave 内代码整理）
- 提取函数（一个长函数拆成几个小的）
- 改名（变量 / 函数 / 文件，让命名更清晰）
- 消除局部重复（同一个 Wave 内两段相似代码合并）
- 调整顺序（不改变行为的语句重排）

特征：**只涉及当前 Wave 的文件，不改跨模块接口**。

#### 禁止在 dev 内做的（架构性重构）—— 必须触发 replan 或留到 review
- 跨模块改动（移文件到别的目录 / 跨包移动）
- 改接口（函数签名变化 / 类的 public 方法变化）
- 引入新依赖（加 npm 包 / 新框架）
- 改数据流（状态管理方式变化 / 调用链重组）

特征：**影响别的 Wave 或别的模块**。

遇到架构性重构需求时：
- 如果是"当前 Wave 实现不下去了"→ 调 \`cw replan\` 调整 plan
- 如果是"实现完发现可以优化"→ 记到 review 阶段处理（review 的 design-consistency 维度会评估）

### 测试即规范原则（refactor 的安全网）

重构的安全网是测试。好测试描述**用户行为**（WHAT），不描述**实现机制**（HOW）——重构实现（不改接口）时，测试不应失败。

**如果重构让测试失败**：说明测试耦合了实现细节（违反 tdd-plan.ts 的"测试反模式 → 实现耦合"）。这时不是"测试挡住了重构"，而是"测试设计有问题"——应该改测试设计（让它落在 seam 上），而不是绕过测试做重构。

### dependsOn 拓扑约束（engine 强制）

[强制] **engine 真正校验 dependsOn 拓扑顺序，不是建议**。在 cw(dev) 提交 wave 时：

- wave 的 dependsOn 里所有 waveId 必须都已 committed（来自历史批次或本批次有效提交）
- 违反时该 wave **不会被标记 committed**，taskResults 标 \`unsatisfiedDeps\` + \`reason="dependency_unsatisfied (...)"\`，gate 记 fail
- engine 同时兜底 \`missingDeps\`：dependsOn 指向不存在的 waveId（plan-parser 只检环不检存在性）也被拒
- 灵活点：**同一批次 cw(dev) 调用内**可以链式提交——一次调用同时提交 W1+W2（W2 dependsOn W1）算合法（W1 在本批次有效就算满足）

实操建议：
- 串行依赖链（W1 → W2 → W3）：按拓扑顺序逐个 commit + 逐次或合并调 cw(dev)
- 并行无依赖（W1, W2 都 dependsOn=[]）：可一次 cw(dev) 同时提交，或分多次
- 永远不要先提交一个 dependsOn 未满足的 wave——engine 会拒，浪费一次提交

### dev 阶段 TDD 纪律

测试代码已在 tdd_plan 阶段写好。dev 阶段的职责是写实现让测试转绿。下面三条 engine 校验强度不同，按强弱分三档：

- [最佳实践] 每个 Wave 的实现完成后，跑该 Wave 的测试确认通过（绿）。不通过 = 实现有问题，继续修。
  - engine 行为：**不校验单 Wave 测试是否真跑/真绿**。所有 Wave 的测试在 \`cw(test)\` 阶段由 engine 按 expected 统一机器重算（全 pass 才放行），单 Wave 的本地自测不进 store、不影响 gate。
  - 含义：这条靠 agent 自觉——你不跑单 Wave 测试，最后 \`cw(test)\` 也会挡下，但返工成本更高。
- [warning] 代码改动逐条核对 dev-plan.json 的 changes 列表——每个文件级改动点都已落地。
  - engine 行为：**只检测偏差不阻断**。cw(dev) 的 devCheck 会把 changes 之外的改动标 \`extraFiles\` 警告（taskResults 里可见），但 **warning 不 gate fail**，wave 仍标记 committed。
  - 含义：漏 changes 列表不会卡住流程，但 extraFiles 警告是审计线索——review 阶段会看到。
- [铁律] 所有 P0/P1/P2 wave 都必须完成，不允许跳过。
  - engine 行为：**真强制**。cw(test) 前置的 computeGatePassed("dev") 检查所有 wave 的 committed !== null，有任一未 committed 则 dev gate fail，status 不会流到 developed/reviewed。

### 渐进式提交语义

- cw(dev) 可分多次调用：第一次提交 W1，第二次提交 W2，等等。
- 每次调 cw(dev) 只传本次新 commit 的 Wave，不重传已 committed 的。
- 全部 Wave committed 后，dev gate 通过，status 流转到 developed，nextAction 指向 review。

### Wave 执行模式：subagent 派发（推荐）

当 Wave 之间无依赖（dependsOn 为空）且 ≥2 个 Wave 时，推荐用 subagent 并行执行：

- 每个 Wave 派一个独立 subagent，各自上下文隔离
- subagent 职责：读 dev-plan.json 该 Wave 的 changes → 写实现让测试转绿 → 跑【该 Wave 涉及包】的单包验证 → git commit → 返回 commitHash
- 主 agent 收集所有 commitHash 后，统一调一次 cw(dev) 提交
- 依赖链上的 Wave 必须串行（前一个 committed 后才能开始下一个）—— engine 在 cw(dev) 强制校验 dependsOn 拓扑，跳过会 gate fail

[纪律] **subagent 只跑涉及包的单包验证**（FR-7），不要跑全量：

    # subagent 在自己 Wave 范围内跑（只跑该 Wave 改动的包）
    pnpm --filter <pkg> typecheck
    pnpm --filter <pkg> test

    # [纪律] subagent 跑全量——会拖慢并行、且越界验证别的 Wave 的包
    # pnpm -r test   ← 不建议

全量验证（pnpm -r typecheck / pnpm -r test）由**主 agent**在提交 cw(dev) 前统一跑一次。
subagent 越界跑全量 = 浪费并行度 + 可能因别的 Wave 未完成而误报失败。

> 这是 agent 运行时纪律，**cw engine 不拦截验证命令范围**——这些 \`pnpm\` 命令在 agent shell 里执行，cw 不观察命令内容。后果完全由 agent 承担（拖慢、误报）。

    cw dev --topicId <topicId> --tasks '[{"waveId":"W1","commitHash":"<sha1>"},{"waveId":"W2","commitHash":"<sha2>"}]'

#### 上下文隔离（subagent 模式的核心价值）

subagent 派发不只是"并行加速"——它的核心价值是**上下文隔离**：

- 每个 Wave 的实现细节（读的文件、试错过程、中间状态）留在 subagent 的上下文里
- 主 agent 只接收 commitHash，不被实现细节淹没
- Wave 完成后，subagent 的上下文自然销毁（"clearing context between tickets"）

**为什么重要**：一个 topic 可能有 5-10 个 Wave，如果主 agent 自己实现所有 Wave，上下文会被早期 Wave 的实现细节占满，后期 Wave 的判断质量下降。subagent 隔离让每个 Wave 都有"新鲜"的上下文。

**不用 subagent 时**：如果 Wave 少（1-2 个）或强依赖链（必须串行），主 agent 自己做也可以，但要意识到上下文累积的风险——做完一个 Wave 后主动总结"已完成什么、接下来做什么"，避免被细节淹没。

## test 阶段：跑测试 + 提交结果

### 工作流

1. 所有 Wave 已 committed（dev gate 通过）→ review gate 通过后 → CW nextAction 指向 test
2. 跑 test.json 定义的全部 testCase（U* 单测 + E* e2e）
3. 对每条 testCase 提交结果：

    cw test --topicId <topicId> --cases '[{"caseId":"U1","actual":{"text":"<实际结果>"}}]'

   - screenshotPath：仅当 testCase requiresScreenshot=true 时必传
4. CW 按 expected 机器重算每条 case 的 pass/fail（不信任 agent 声明的 status，自己判）
5. 全部 passed → test gate 通过，status 流转到 post_dev_verified，nextAction 指向 retrospect
6. 有 case failed → CW 指向 **test_fix**（不再回 dev）

### 全绿质量自检（test 全 pass 时执行）

[强烈建议] 全绿不等于无 bug。tdd_plan 阶段定义的 testCases 是在你还没写实现时设计的——
那时你对代码的认知是**不完整的**。现在实现已完成、测试已跑过，你有了实际数据来回答：

**「这套测试真的能发现 bug，还是只是恰好没失败？」**

> engine 无法校验自检是否真做（物理上观察不到 agent 思考过程），靠 agent 自觉 + retrospect 阶段留证据（自检结论写进 processIssues，证明做过自检而非跳过）。

全 pass 时逐条自问：
- 这条 case 测的是 happy path 还是异常路径？如果全是 happy path，说明测试套件没有防线
- 实现里有哪个分支/边界，对应的 testCase 没覆盖到？（实现过程中新发现的分支是测试盲区）
- 如果我现在故意改坏实现（如删掉某个错误处理），有多少 case 会变红？如果答案是零，这些 case 是覆盖率填充

自检发现问题时的处理：
- 测试有盲区 → 调 \`cw replan --topicId <id> --test --testJsonFile <path>\` 补 case，重跑验证
- 自检无问题（测试确有防线）→ 正常进 retrospect，把自检结论写进 processIssues（证明做过自检而非跳过）

### test 提交语义

- cw(test) 可分多次调用（渐进式）。
- 每条 case CW 按 expected.type 分支判定 pass/fail：
  - exact：CW 对 expected.text/url 与 actual 做精确 === 比较（无 trim/容差）
  - exit_zero：CW 跑 testRunner 命令按 exitCode 判定（exit 0 → pass，非 0 → failed；agent 可省略 actual）
  - script：CW 跑 expected.path 脚本按 exitCode 判定（exit 0 → pass；agent 可省略 actual）
- screenshotPath 指向不存在的文件 = 该 case 判 failed。

### test 失败 → test fix loop

test 有 case 未通过时，CW nextAction 指向 **test_fix**（不回 dev——所有 Wave 已 committed，dev 没有新任务）。

**[MANDATORY] test_fix 的第一件事不是修代码，是归因**。failure 有两种来源，处理方式完全不同：

| failure 原因 | 怎么判断 | 怎么修 |
|-------------|---------|--------|
| **代码真有 bug**（实现逻辑错/漏了边界处理） | 对照 expected 检查实现——expected 是你在 tdd_plan 从测试断言提取的，它是基准，实现偏离基准 = bug | 改实现代码 → commit → 重跑 testCase → 提交新 actual |
| **expected 写错**（断言值本身不正确，或需求理解有误） | expected 不符合实际正确行为——比如你写 expected="2" 但正确答案确实是 "3" | 调 \`cw replan --topicId <id> --test --testJsonFile <path>\` 修正 expected → 重跑 |

[禁止] 不做归因直接改代码——如果 expected 本身错了，改代码让错的 expected 通过 = 把 bug 永久固化进代码
[禁止] 不做归因直接改 expected——如果代码真有 bug，改 expected 迎合实现 = 把 bug 合法化

归因纪律的核心：**expected 是 tdd_plan 阶段从测试断言提取的基准，优先级高于实现**。先信 expected，
只在确凿证明 expected 本身有误时才改 expected。

\`\`\`
test turn 1: U1 failed
    ↓ CW 指向 test_fix
test_fix: 归因 → 确认是代码 bug → 修代码 → commit → 提交修复审计
    echo '[
      {"caseId":"U1","commitHash":"<sha>","resolution":"修复 add 返回值类型"}
    ]' | cw test_fix --topicId <id>
    ↓ CW 指向 test（重跑）
test turn 2: 重跑 U1，提交新 actual
    ↓ pass → 进 retrospect
    ↓ 仍 fail → 继续 test_fix（最多 5 轮）
\`\`\`

**test_fix 的 commitHash 校验格式**（7-40 位 hex，与 review_fix 同校验），**但不校验存在性**（只记录审计，不像 dev gate 做存在性+diff 校验）。
agent 修完代码后重跑失败的 testCase，提交新 actual，CW 用 expected 重新判定。

### turn 上限

最多 5 轮 test（TEST_TURN_LIMIT）。达上限后 CW 强制进 retrospect：在复盘中记录未通过原因和 knownRisks，由用户决定是否接受或 replan。

## replan（修改计划）

status∈{planned, pre_dev_verified, developed, reviewed, post_dev_verified} 时可调 cw replan。
replan 支持两种模式（可同时用）：

### --plan：修订 dev-plan（追加/调整 wave）

    echo '<newDevPlanJson>' | cw replan --topicId <id> --plan

### --test：修订 test.json（追加/调整 testCase / 修正 expected）

    cw replan --topicId <id> --test --testJsonFile <testJsonFilePath>

### append-only 约束

| 不可动 | 原因 |
|-------|------|
| 已 committed 的 wave | commit 锚定，改了脱节 |
| 已 passed 的 testCase expected | 判定基准，改了失效 |

未 committed/passed 的可改可删。replan 后 status 回退到 planned，重走 tdd_plan → dev → review → test。
已 committed 的 wave 保留不动（progressive），dev 阶段只做新增的 wave。

## gate fail 恢复

- dev gate fail（commit 不真实/缺失）→ 修该 Wave commit 后重调 cw(dev)。
- test gate fail → 进 test_fix 修代码（见上方"test 失败 → test fix loop"）。
- gate 熔断：连续 fail 达 5 次，guidance 换熔断文案，建议找用户人工介入。

## 本阶段禁止

- [禁止] 跳过 TDD（测试已在 tdd_plan 写好，dev 只写实现）
- [禁止] 自行声明 case passed（CW 机器重算，声明无效）
- [禁止] 不调 cw(dev/test) 就认为流程走完

## 完成标志

全部 testCase passed（test gate 通过，status=post_dev_verified）后，进入 retrospect 阶段做复盘。
`.trim();
