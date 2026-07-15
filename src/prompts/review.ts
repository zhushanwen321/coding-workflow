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

1. 做代码审查（按下方维度）
2. 把发现的问题整理成结构化 issues
3. 写 review.md（含审查结论）
4. 提交：

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <path>

## 审查维度

按以下维度审查（可用 subagent 分工，也可主 agent 自审）：

| 维度 | 审什么 |
|------|--------|
| 类型安全 | 禁 any、schema 同步、CwError vs Error 边界、type-only import |
| 错误处理 | catch 不吞异常、exit code 映射、错误消息可读性 |
| 边界条件 | 空数组/缺字段/非法 JSON/文件不存在 |
| 测试覆盖 | 新逻辑有测试、edge case 覆盖、e2e 覆盖 |
| plan 完成度 | dev-plan.json 的 changes 是否全部落地 |

## issues 参数

issues 通过 stdin 传入，是 JSON 数组，每个元素是一个 issue：

    echo '[
      {
        "severity": "must-fix",
        "description": "store.ts 的 appendReviewIssues 没有做 turn 校验",
        "file": "src/store.ts:142"
      },
      {
        "severity": "should-fix",
        "description": "错误消息缺用法示例",
        "file": "src/cli.ts:268"
      }
    ]' | cw review --topicId <topicId> --reviewPath <path>

> 注意：severity 用 \`must-fix\` / \`should-fix\` / \`nit\`（连字符），id 由 CW 自动分配（R1, R2...），不要手填。

### severity 分级

| severity | 含义 | 行为 |
|----------|------|------|
| must-fix | 阻断性问题 | 有 must-fix → 进 review_fix 循环 |
| should-fix | 重要但不阻断 | 记录但不阻断流程 |
| nit | 风格/优化建议 | 记录但不阻断流程 |

**无问题时传空数组**：\`echo '[]' | cw review ...\`。空数组 = 审查通过，直接进 test。

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

## 产出 review.md

review.md 是给人类看的审查报告（落 .xyz-harness/<slug>/changes/ 目录）。issues（通过 stdin 传入）是给 CW 的机器可读结构化数据。两者都要提交。

review.md 内容：
- 审查范围（哪些 commit / 文件）
- 发现的问题（表格形式，含 severity + 位置）
- 评分汇总

## 提交命令

    echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <review.md>

- --reviewPath：review.md 的路径（gate 校验文件存在 + 非空）
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
