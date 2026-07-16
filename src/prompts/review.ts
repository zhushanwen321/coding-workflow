/**
 * review 提示词 — dev 全 committed 后返回，指导 agent 做代码审查 + issue tracking。
 *
 * 触发点：state-machine.ts buildNextAction 的 dev（全 committed）和 review（retry/fix loop）分支。
 * 交付物：review.md + issues（通过 stdin 传入的结构化问题清单），由 cw(review) 消费。
 *
 * review 采用 issue tracking + fix loop：
 * - agent 审查后提交 issues（must-fix/should-fix/nit）
 * - 有 must-fix issue → CW 指向 review_fix → agent 修代码 → review turn 2 复查
 * - 无 issue → CW 指向 test
 * - 最多 3 轮 review（REVIEW_TURN_LIMIT）
 */

export const REVIEW_PROMPT = `
[review 阶段] 代码审查 + issue tracking

所有 Wave 已 committed（dev gate 通过）。在进入 test 之前，必须审查代码。

## 审查流程

1. 做代码审查（按下方维度，推荐用禁读重建法查 design-consistency）
2. 把发现的问题整理成结构化 issues
3. 写 review.md（含审查结论）
4. 提交：

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <path>

## 审查方法：禁读重建（design-consistency 维度专用）

design-consistency（设计一致性）维度最易漏——直接读实现容易「顺着代码思路走」，
看不出实现偏离了 spec。强制用「禁读重建」对冲：

1. 派一个 fresh subagent，**不读**实现代码
2. 只给它 spec 的 functionalRequirements + acceptanceCriteria
3. 让它从 spec 反查「实现完整性」——每个 FR/AC 对应的代码路径是否存在、行为是否正确
4. 把反查结果与实际实现 **diff**——实现遗漏/偏离 spec 的点就是审查发现

其余维度（类型安全/错误处理/边界条件/测试质量/plan 完成度）直接读代码审查即可。

## 审查维度

按以下维度审查（可用 subagent 分工，也可主 agent 自审）。dimension 字段必填，取 6 值之一：

| dimension | 维度 | 审什么 |
|-----------|------|--------|
| \`type-safety\` | 类型安全 | 禁 any、schema 同步、CwError vs Error 边界、type-only import |
| \`error-handling\` | 错误处理 | catch 不吞异常、exit code 映射、错误消息可读性 |
| \`edge-case\` | 边界条件 | 空数组/缺字段/非法 JSON/文件不存在 |
| \`test-coverage\` | 测试质量 | 测试能否发现真 bug（见下方「测试质量审查」专节，不只是覆盖率数字） |
| \`plan-completeness\` | plan 完成度 | dev-plan.json 的 changes 是否全部落地 |
| \`design-consistency\` | 设计一致性 | spec 的 FR/AC 是否被正确实现（用禁读重建法） |

### 测试质量审查（review 阶段是测试跑之前的最后校验窗口）

test 还没跑，test.json 已在 tdd_plan 阶段定稿。review 是用「已完成的实现」反查「测试设计」的最后机会——
test 一旦跑起来全绿，弱测试会被当成功放过。在此时审查测试设计质量：

- **盲区检查**：实现里有 N 个分支/错误处理，testCase 覆盖了几个？漏的分支在 test 阶段不会被触发
- **防线检查**：如果 testCase 全是 happy path（正常输入 → 正常输出），它们是覆盖率填充，不是 bug 防线
- **对称性检查**：成功路径有守门（如校验输入），失败路径有没有？（如「创建有校验，删除有没有」）

发现问题时的处理：
- 测试设计有盲区 → 补 case 再进 test（replan --test），而非让弱测试全绿通过
- 测试质量 OK → 在 review.md 里说明测试覆盖了哪些风险路径（证明审过而非跳过）

## issues 参数

issues 通过 stdin 传入，是 JSON 数组，每个元素是一个 issue：

    echo '[
      {
        "severity": "must-fix",
        "dimension": "edge-case",
        "description": "store.ts 的 appendReviewIssues 没有做 turn 校验",
        "ref": "src/store.ts:142"
      },
      {
        "severity": "should-fix",
        "dimension": "error-handling",
        "description": "错误消息缺用法示例",
        "ref": "src/cli.ts:268"
      }
    ]' | cw review --topicId <topicId> --reviewPath <path>

> 注意：severity 用 \`must-fix\` / \`should-fix\` / \`nit\`（连字符），id 由 CW 自动分配（R1, R2...），不要手填。但提交 issues stdin 时只放 must-fix / should-fix，nit 不进 issues（见下方 severity 分级）。

### severity 分级

| severity | 含义 | 行为 |
|----------|------|------|
| must-fix | 阻断性问题 | 通过 stdin issues 提交；有 must-fix → 进 review_fix 循环 |
| should-fix | 重要但不阻断 | 通过 stdin issues 提交；记录但不阻断流程 |
| nit | 风格/优化建议 | 只写 review.md，不进 issues |

> **discipline（重点）**：只有 must-fix / should-fix 进 issues stdin（机器追踪闭环）；nit 只写在 review.md 里（人可读报告）。
> 原因：nit 是风格/优化建议，进 issue tracking 会占满 turn 上限（3 轮），把真正的 must-fix 挤掉、被强制推到 test。nit 在 review.md 里提就足够让人看到。

**无问题时传空数组**：\`echo '[]' | cw review ...\`。空数组 = 审查通过，直接进 test。

### dimension 字段（必填）

FR-6 升级：原可选的 \`category\` 字段改为必填的 \`dimension\`（命名也更准确——它就是审查维度本身）。
取以下 6 个值之一（对应代码审查维度），用于事后统计 review 盲区分布——看哪些维度漏检最多，反过来校准审查重点。

| dimension | 对应维度 |
|-----------|----------|
| \`type-safety\` | 类型安全 |
| \`error-handling\` | 错误处理 |
| \`edge-case\` | 边界条件 |
| \`test-coverage\` | 测试覆盖 |
| \`plan-completeness\` | plan 完成度 |
| \`design-consistency\` | 设计一致性（核对 spec FR/AC，推荐禁读重建法） |

> dimension 必填——不填会被 gate 的 schema 校验拒绝（reviewIssueCheck 逐元素校验）。

### ref 字段（可选）

FR-3 泛化：原 \`file\` 字段（限代码路径）改为 \`ref\`（泛化引用）。代码审查填文件路径（如 \`"src/store.ts:142"\`）。
spec/plan 审查（spec_review/plan_review）填条目 ID（如 \`"FR-3"\` / \`"W2"\`）。三阶段共用此字段。

## review fix loop

\`\`\`
review turn 1: 发现 [R1, R2]
    ↓ CW 指向 review_fix
review_fix: 修 R1 + R2 → commit → 提交修复
    echo '[
      {"issueId":"R1","commitHash":"<sha>","resolution":"加 turn 校验"},
      {"issueId":"R2","commitHash":"<sha>","resolution":"补用法示例"}
    ]' | cw review_fix --topicId <id>
    ↓ CW 指向 review（turn 2）
review turn 2: 复查是否还有新问题
    ↓ 无新问题（echo '[]' | cw review ...）→ 进 test
    ↓ 有新问题 → 继续 review_fix（最多 3 轮）
\`\`\`

**review_fix 的 commitHash 只记录审计，不校验真实性**（不像 dev gate 做存在性+diff 校验）。
这是有意设计：review 修复是代码质量改进，不是功能实现——audit 链足够追溯。

### turn 上限

最多 3 轮 review（初始 + 2 轮 fix 复查）。达上限后 CW 强制进 test，guidance 标注未修复的 must-fix。

## 产出 review.md（必填）

review.md 是必填交付物——与 plan/tdd_plan/retrospect 的文件校验对称，不产出 review.md 一律 gate fail。它是给人类看的审查报告（落 .xyz-harness/<slug>/changes/ 目录）；issues（通过 stdin 传入）是给 CW 的机器可读结构化数据。两者都要提交，缺一不可。

review.md 内容：
- 审查范围（哪些 commit / 文件）
- 发现的问题（表格形式，含 severity + 位置）
- 评分汇总

## 提交命令

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <review.md>

- --reviewPath：review.md 的路径（必填——gate 校验文件存在 + 非空）。代码签名上 reviewPath 可选，但 prompt 层面纪律要求必须写 review.md 并通过 --reviewPath 提交，与 plan/tdd_plan/retrospect 的文件校验对称。漏传 = gate fail = 重写。
- issues：通过 stdin 传入的结构化问题清单（空数组 = 无问题，直接进 test）

gate fail（文件不存在/空）→ 重写后重调 cw(review)。

## 本阶段禁止

- [禁止] 跳过 review 直接调 cw(test)（状态机 guard 会拒绝）
- [禁止] 不传 issues（必填，空数组也行——通过 stdin 管道传）
- [禁止] review 发现 must-fix 但不修就传空 issues（先修 → review_fix → 复查）

## 完成标志

review.md 写完 + cw(review) 提交后：
- issues 为空 → 进 test
- issues 非空 → 进 review_fix → 修复后复查
`.trim();
