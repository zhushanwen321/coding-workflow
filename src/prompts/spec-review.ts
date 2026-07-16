/**
 * spec_review 提示词 — clarify_confirmed 后返回，指导 agent 审查 spec 的完整性、一致性、合理性。
 *
 * 触发点：state-machine.ts buildNextAction 的 confirm_clarify / spec_review / spec_review_fix 分支。
 * 交付物：spec-review.md + issues（通过 stdin 传入的结构化问题清单），由 cw(spec_review) 消费。
 *
 * spec_review 采用 issue tracking + fix loop（与 review 同构）：
 * - agent 审查后提交 issues（must-fix/should-fix/nit）
 * - 有 must-fix issue → CW 指向 spec_review_fix → agent 改 spec（cw clarify 更新 specSections）→ 复审
 * - 无 issue → CW 指向 plan
 * - 最多 3 轮 spec_review（SPEC_REVIEW_TURN_LIMIT）
 *
 * FR-6 核心：禁读重建——派 fresh subagent 不读 spec 初稿，从源头（objective + clarifyRecords）
 * 重建 spec 后与初稿 diff，找出初稿遗漏的 FR/AC/决策。
 */

export const SPEC_REVIEW_PROMPT = `
[spec_review 阶段] spec 语义审查 + issue tracking

需求已确认（clarify_confirmed），gen-spec 已生成确认文档。在写 dev-plan.json 之前，必须审查 spec——
这是进 plan 之前的最后校验窗口。spec 一旦定稿，plan/dev/test 都基于它展开，spec 里的漏洞会放大成实现缺陷。

## 审查方法：禁读重建（核心）

直接读 spec 初稿审查容易「顺着初稿的思路走」——初稿漏了什么，你也跟着漏。
强制用「禁读重建」对冲这个偏差：

1. 派一个 fresh subagent，**不读** topic 的 specSections / confirmSpec 文档
2. 只给它 objective + clarifyRecords（源头信息）
3. 让它从源头**重建** spec 应该长什么样（FR/AC/决策清单）
4. 把重建结果与初稿 specSections **diff**——初稿遗漏/偏离的条目就是审查发现

diff 出来的差异是真问题（初稿没覆盖到），比直接读初稿找漏洞有效得多。
重建可以只做关键章节（FR + AC），不必全量重建。

## 审查维度

按以下三个维度审查（可用 subagent 分工，也可主 agent 自审）：

| 维度 | 审什么 |
|------|--------|
| completeness（完整性） | FR 是否覆盖 objective 的全部诉求？AC 是否每个 FR 都有验收标准？决策是否记录完整？有没有 clarifyRecords 里讨论过但没落进 spec 的结论？ |
| consistency（一致性） | FR 之间有无矛盾？AC 与 FR 是否对齐（AC 验收的是 FR 声明的功能）？术语是否前后统一（同一个概念不能一会叫 A 一会叫 B）？ |
| reasonableness（合理性） | FR 是否可实现、可验收（模糊的「系统应该很快」「体验要好」不可验收）？AC 是否可机器判定（能写成 test.json 的断言）？有无过度设计或明显遗漏的边界场景？ |

### completeness 的关键校验点

这是三个维度里最易漏的。重点查：

- objective 里的每个诉求，是否有对应的 FR 落地？（诉求 → FR 的映射不能断）
- clarifyRecords 里 resolved 的记录，其结论是否已沉淀进 spec？（讨论了但没写进 spec = 白讨论）
- 有没有「隐含需求」——用户没明说但功能必须有的（如「创建」隐含「校验输入」「错误反馈」）

## 审查流程

1. 做禁读重建（派 fresh subagent 从 objective + clarifyRecords 重建 spec，与初稿 diff）
2. 按三维度审查 diff 出的差异 + 直接审初稿
3. 把发现的问题整理成结构化 issues
4. 写 spec-review.md（含审查结论）
5. 提交：

    echo '<issuesJson>' | cw spec_review --topicId <topicId> --specReviewPath <spec-review.md>

## issues 参数

issues 通过 stdin 传入，是 JSON 数组，每个元素是一个 issue：

    echo '[
      {
        "severity": "must-fix",
        "dimension": "completeness",
        "description": "objective 要求支持批量导入，但 specSections 没有 FR 覆盖此诉求",
        "ref": "FR"
      },
      {
        "severity": "should-fix",
        "dimension": "reasonableness",
        "description": "AC-3 验收标准「响应快」不可机器判定，需量化为具体阈值",
        "ref": "AC-3"
      }
    ]' | cw spec_review --topicId <topicId> --specReviewPath <spec-review.md>

> 注意：severity 用 \`must-fix\` / \`should-fix\` / \`nit\`（连字符），id 由 CW 自动分配（SR1, SR2...），不要手填。但提交 issues stdin 时只放 must-fix / should-fix，nit 不进 issues（见下方 severity 分级）。

### severity 分级

| severity | 含义 | 行为 |
|----------|------|------|
| must-fix | spec 有遗漏/矛盾，不修会导致 plan/dev 跑偏 | 通过 stdin issues 提交；有 must-fix → 进 spec_review_fix 循环 |
| should-fix | 重要但不阻断（如 AC 不可量化） | 通过 stdin issues 提交；记录但不阻断流程 |
| nit | 措辞/格式优化建议 | 只写 spec-review.md，不进 issues |

> **discipline（重点）**：只有 must-fix / should-fix 进 issues stdin（机器追踪闭环）；nit 只写在 spec-review.md 里（人可读报告）。原因同 review：nit 进 issue tracking 会占满 turn 上限，把真正的 must-fix 挤掉。

**无问题时传空数组**：\`echo '[]' | cw spec_review ...\`。空数组 = 审查通过，直接进 plan。

### dimension 字段（必填）

取以下 3 个值之一（对应 spec 审查维度），用于事后统计盲区分布——看哪些维度漏检最多：

| dimension | 对应维度 |
|-----------|----------|
| \`completeness\` | 完整性（FR/AC/决策是否覆盖全部诉求） |
| \`consistency\` | 一致性（FR 间矛盾、术语统一、AC-FR 对齐） |
| \`reasonableness\` | 合理性（可实现、可验收、无过度设计） |

### ref 字段（可选）

关联 spec 条目 ID，便于定位修复。如 \`"FR-3"\` / \`"AC-2"\` / \`"D1"\`（决策 ID）。无明确条目时可不填。

## spec_review fix loop

spec_review 发现 must-fix issue 时，修复方式与代码 review 不同——spec 的「代码」是 specSections 本身：

\`\`\`
spec_review turn 1: 发现 [SR1, SR2]（completeness 遗漏 + consistency 矛盾）
    ↓ CW 指向 spec_review_fix
spec_review_fix:
    1. 改 spec → 调 cw(clarify) 追加/修改 clarifyRecord 或 replaceSpec 更新 specSections
    2. 提交修复：
    echo '[
      {"issueId":"SR1","resolution":"补充 FR-5 覆盖批量导入诉求"},
      {"issueId":"SR2","resolution":"修正 FR-2 与 FR-4 的术语冲突，统一为 X"}
    ]' | cw spec_review_fix --topicId <id>
    ↓ CW 指向 spec_review（turn 2）
spec_review turn 2: 复查 spec 是否还有遗漏/矛盾
    ↓ 无新问题（echo '[]' | cw spec_review ...）→ 进 plan
    ↓ 有新问题 → 继续 spec_review_fix（最多 3 轮）
\`\`\`

**spec_review_fix 的 commitHash 可选**（与代码 review_fix 不同）——spec 修复走 cw 内部（cw clarify 更新 specSections），可能无独立 git commit。只填 resolution 即可。

### turn 上限

最多 3 轮 spec_review（初始 + 2 轮 fix 复查）。达上限后 CW 强制进 plan，guidance 标注未修复的 must-fix。

## 产出 spec-review.md（必填）

spec-review.md 是必填交付物——与 plan/tdd_plan/retrospect 的文件校验对称，不产出 spec-review.md 一律 gate fail。
它给人类看的审查报告（落 .xyz-harness/<slug>/changes/ 目录）；issues（通过 stdin 传入）是给 CW 的机器可读结构化数据。两者都要提交，缺一不可。

spec-review.md 内容：
- 审查范围（重建了哪些章节、diff 结果）
- 发现的问题（表格形式，含 severity + dimension + ref）
- 审查结论（spec 是否就绪进 plan）

## 提交命令

    echo '<issuesJson>' | cw spec_review --topicId <topicId> --specReviewPath <spec-review.md>

- --specReviewPath：spec-review.md 的路径（必填——gate 校验文件存在 + 非空）。漏传 = gate fail = 重写。
- issues：通过 stdin 传入的结构化问题清单（空数组 = 无问题，直接进 plan）

gate fail（文件不存在/空）→ 重写后重调 cw(spec_review)。

## 本阶段禁止

- [禁止] 跳过 spec_review 直接调 cw(plan)（状态机 guard 会拒绝）
- [禁止] 不做禁读重建就直接「读初稿签字」（顺着初稿思路走 = 跟着漏）
- [禁止] 不传 issues（必填，空数组也行——通过 stdin 管道传）
- [禁止] spec_review 发现 must-fix 但不修就传空 issues（先改 spec → spec_review_fix → 复查）

## 完成标志

spec-review.md 写完 + cw(spec_review) 提交后：
- issues 为空 → 进 plan（写 dev-plan.json）
- issues 非空 → 进 spec_review_fix → 改 spec 后复查
`.trim();
