/**
 * plan_review 提示词 — plan gate 通过后返回，指导 agent 审查 plan 是否完整覆盖 spec、架构是否合理。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan / plan_review / plan_review_fix 分支。
 * 交付物：plan-review.md + issues（通过 stdin 传入的结构化问题清单），由 cw(plan_review) 消费。
 *
 * plan_review 采用 issue tracking + fix loop（与 spec_review / review 同构）：
 * - agent 审查后提交 issues（must-fix/should-fix/nit）
 * - 有 must-fix issue → CW 指向 plan_review_fix → agent 改 plan（cw replan）→ 复审
 * - 无 issue → CW 指向 tdd_plan
 * - 最多 3 轮 plan_review（PLAN_REVIEW_TURN_LIMIT）
 *
 * FR-6 核心：禁读重建——派 fresh subagent 不读 dev-plan.json 初稿，从 spec 重建 plan 应该怎么拆，
 * 与初稿 diff，找出初稿遗漏的 FR 覆盖 / 不合理的 wave 划分。
 */

export const PLAN_REVIEW_PROMPT = `
[plan_review 阶段] plan 语义审查 + issue tracking

dev-plan.json 已提交（plan gate 通过）。在写测试代码（tdd_plan）之前，必须审查 plan——
plan 一旦定稿，dev 按 wave 拆分实现、test 按 testCase 验收。plan 里的覆盖漏洞或架构缺陷会传导成实现返工。

## 审查方法：禁读重建（核心）

直接读 dev-plan.json 初稿审查容易「顺着初稿的 wave 划分走」——初稿漏了哪个 FR 的覆盖，你也跟着漏。
强制用「禁读重建」对冲：

1. 派一个 fresh subagent，**不读** dev-plan.json
2. 只给它 spec 的 functionalRequirements（FR 清单）+ acceptanceCriteria（AC 清单）
3. 让它从 spec 重建 plan 应该怎么拆 wave（每个 FR 应该落到哪个 wave、changes 列表该有什么）
4. 把重建结果与 dev-plan.json 初稿 **diff**——初稿遗漏的 FR 覆盖、不合理的 wave 归属就是审查发现

diff 出来的差异是真问题，比直接读初稿找漏洞有效得多。

## 审查维度

按以下三个维度审查（可用 subagent 分工，也可主 agent 自审）：

| 维度 | 审什么 |
|------|--------|
| coverage（覆盖度） | spec 的每个 FR 是否都有对应的 wave + changes 落地？AC 是否在 testCase 里能被验证（plan 要为 test 留出验证路径）？有无 FR 被 plan 完全忽略？ |
| architecture（架构合理性） | wave 的拆分是否合理（高内聚低耦合）？dependsOn 依赖链是否正确（无循环、无遗漏前置）？changes 的文件级改动点是否清晰（不混在一坨）？有无应该拆成两个 wave 的巨型 wave？ |
| feasibility（可行性） | 每个 wave 的 changes 是否可在一个 dev cycle 完成？有无依赖未识别的外部条件（如第三方 API、未就绪的基础设施）？changes 描述是否可执行（模糊的「优化系统」不可执行）？ |

### coverage 的关键校验点

这是三个维度里最易漏的。重点查：

- spec 定义了 N 个 FR，plan 的 waves 是否每个 FR 都有对应的 changes？（FR → wave 的映射不能断）
- 有没有「隐含工作」——FR 没明说但实现必须有的（如新增 FR 隐含的类型定义、错误处理、测试脚手架）
- AC 的验收路径是否在 plan 里留了出口（test 阶段要能跑出 AC 要求的结果）

## 审查流程

1. 做禁读重建（派 fresh subagent 从 spec FR/AC 重建 wave 拆分，与初稿 diff）
2. 按三维度审查 diff 出的差异 + 直接审初稿
3. 把发现的问题整理成结构化 issues
4. 写 plan-review.md（含审查结论）
5. 提交：

    echo '<issuesJson>' | cw plan_review --topicId <topicId> --planReviewPath <plan-review.md>

## issues 参数

issues 通过 stdin 传入，是 JSON 数组，每个元素是一个 issue：

    echo '[
      {
        "severity": "must-fix",
        "dimension": "coverage",
        "description": "FR-3 导出功能在 dev-plan.json 的 waves 里没有对应的 changes",
        "ref": "FR-3"
      },
      {
        "severity": "should-fix",
        "dimension": "architecture",
        "description": "W2 把 UI + 数据层混在一起，建议拆成两个 wave",
        "ref": "W2"
      }
    ]' | cw plan_review --topicId <topicId> --planReviewPath <plan-review.md>

> 注意：severity 用 \`must-fix\` / \`should-fix\` / \`nit\`（连字符），id 由 CW 自动分配（PR1, PR2...），不要手填。但提交 issues stdin 时只放 must-fix / should-fix，nit 不进 issues（见下方 severity 分级）。

### severity 分级

| severity | 含义 | 行为 |
|----------|------|------|
| must-fix | plan 有覆盖漏洞/架构缺陷，不修会导致 dev 跑偏 | 通过 stdin issues 提交；有 must-fix → 进 plan_review_fix 循环 |
| should-fix | 重要但不阻断（如 wave 拆分可优化） | 通过 stdin issues 提交；记录但不阻断流程 |
| nit | 描述/命名优化建议 | 只写 plan-review.md，不进 issues |

> **discipline（重点）**：只有 must-fix / should-fix 进 issues stdin（机器追踪闭环）；nit 只写在 plan-review.md 里（人可读报告）。原因同 review/spec_review：nit 进 issue tracking 会占满 turn 上限，把真正的 must-fix 挤掉。

**无问题时传空数组**：\`echo '[]' | cw plan_review ...\`。空数组 = 审查通过，直接进 tdd_plan。

### dimension 字段（必填）

取以下 3 个值之一（对应 plan 审查维度），用于事后统计盲区分布——看哪些维度漏检最多：

| dimension | 对应维度 |
|-----------|----------|
| \`coverage\` | 覆盖度（FR 是否全有 wave 落地、AC 验收路径） |
| \`architecture\` | 架构合理性（wave 拆分、依赖链、changes 清晰度） |
| \`feasibility\` | 可行性（可完成、无未识别依赖、changes 可执行） |

### ref 字段（可选）

关联 plan 条目 ID，便于定位修复。如 \`"FR-3"\`（spec 的功能需求）/ \`"W2"\`（wave ID）。无明确条目时可不填。

## plan_review fix loop

plan_review 发现 must-fix issue 时，修复方式是改 plan（不是改代码）：

\`\`\`
plan_review turn 1: 发现 [PR1, PR2]（coverage 遗漏 + architecture wave 拆分问题）
    ↓ CW 指向 plan_review_fix
plan_review_fix:
    1. 改 plan → 调 cw(replan) --plan 修订 dev-plan.json（追加/调整 wave）
    2. 提交修复：
    echo '[
      {"issueId":"PR1","resolution":"W3 补充 FR-3 导出功能的 changes"},
      {"issueId":"PR2","resolution":"W2 拆为 W2(UI) + W2b(数据层)"}
    ]' | cw plan_review_fix --topicId <id>
    ↓ CW 指向 plan_review（turn 2）
plan_review turn 2: 复查 plan 是否还有覆盖漏洞/架构问题
    ↓ 无新问题（echo '[]' | cw plan_review ...）→ 进 tdd_plan
    ↓ 有新问题 → 继续 plan_review_fix（最多 3 轮）
\`\`\`

**plan_review_fix 的 commitHash 可选**（与代码 review_fix 不同）——plan 修复走 cw 内部（cw replan 更新 dev-plan.json），可能无独立 git commit。只填 resolution 即可。

### replan 的 append-only 约束

replan 改 plan 时，已 committed 的 wave 不可动（commit 锚定）。plan_review 阶段还没进 dev，通常无 committed wave，可自由调整。

### turn 上限

最多 3 轮 plan_review（初始 + 2 轮 fix 复查）。达上限后 CW 强制进 tdd_plan，guidance 标注未修复的 must-fix。

## 产出 plan-review.md（必填）

plan-review.md 是必填交付物——与 plan/tdd_plan/retrospect 的文件校验对称，不产出 plan-review.md 一律 gate fail。
它给人类看的审查报告（落 .xyz-harness/<slug>/changes/ 目录）；issues（通过 stdin 传入）是给 CW 的机器可读结构化数据。两者都要提交，缺一不可。

plan-review.md 内容：
- 审查范围（重建了哪些 wave、diff 结果）
- 发现的问题（表格形式，含 severity + dimension + ref）
- 审查结论（plan 是否就绪进 tdd_plan）

## 提交命令

    echo '<issuesJson>' | cw plan_review --topicId <topicId> --planReviewPath <plan-review.md>

- --planReviewPath：plan-review.md 的路径（必填——gate 校验文件存在 + 非空）。漏传 = gate fail = 重写。
- issues：通过 stdin 传入的结构化问题清单（空数组 = 无问题，直接进 tdd_plan）

gate fail（文件不存在/空）→ 重写后重调 cw(plan_review)。

## 本阶段禁止

- [禁止] 跳过 plan_review 直接调 cw(tdd_plan)（状态机 guard 会拒绝）
- [禁止] 不做禁读重建就直接「读初稿签字」（顺着初稿 wave 划分走 = 跟着漏 FR 覆盖）
- [禁止] 不传 issues（必填，空数组也行——通过 stdin 管道传）
- [禁止] plan_review 发现 must-fix 但不修就传空 issues（先改 plan → plan_review_fix → 复查）

## 完成标志

plan-review.md 写完 + cw(plan_review) 提交后：
- issues 为空 → 进 tdd_plan（写测试代码 + test.json）
- issues 非空 → 进 plan_review_fix → 改 plan 后复查
`.trim();
