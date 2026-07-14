/**
 * review 提示词 — dev 全 committed 后返回，指导 agent 做 3-subagent 分工代码审查。
 *
 * 触发点：state-machine.ts buildNextAction 的 dev（全 committed）和 review（retry）分支。
 * 交付物：review.md，落在 {workspacePath}/.xyz-harness/{slug}/changes/review.md，由 cw(review) 消费。
 *
 * 设计意图：复盘反复证明「不强制 = 被跳过」（如 agent 认为「测试全绿 = 代码没问题」就跳过 review）。
 * review gate 用文件存在性强制审查环节存在，内容深度由 agent 按规模判断。
 *
 * 架构（Wave 4 改造）：从单 agent 自审改为 3-subagent 分工，对抗「自己写的代码自己审」盲区——
 *   - Subagent A（项目约定）：读项目 code-review skill，审项目特定约定
 *   - Subagent B（通用质量）：读 skill/review-agents/quality-criteria.md，审类型/错误/边界/测试
 *   - Subagent C（plan 完成度）：读 skill/review-agents/plan-completeness.md + dev-plan.json + changedFiles
 * 三个 subagent 职责正交，同一缺陷最多被一个抓到。
 */

export const REVIEW_PROMPT = `
[review 阶段] 3-subagent 分工代码审查

所有 Wave 已 committed（dev gate 通过）。在进入 test 之前，必须审查代码。
复盘反复证明：跳过 review = 测试全绿但功能/边界缺失，到 closeout 才暴露。

本阶段用 **3-subagent 分工**对抗盲区——主 agent 自己写的代码自己审容易漏，派独立 reviewer 做对抗性审查。

## 步骤 0：能力发现（先做）

1. 检查项目有没有 code-review skill：
   - 找 \`skill/code-review/SKILL.md\` 或 \`.agents/skills/code-review/SKILL.md\` 或 agent 内置 code-review skill
   - 有 → Subagent A 的审查依据就是它
   - 没有 → Subagent A 退化为"按通用约定审"，在 review.md 里标注"项目无 code-review skill，A 维度判定为 warn"
2. 读两份通用标准（CW 自带，路径相对项目根）：
   - \`skill/review-agents/quality-criteria.md\`（Subagent B 用）
   - \`skill/review-agents/plan-completeness.md\`（Subagent C 用）
3. 收集审查输入：
   - 本次 topic 的所有 commit：\`git log <dev 前的 base>..HEAD\`
   - dev-plan.json 的 waves[].changes
   - topic.waves[].changedFiles（dev 阶段 git diff-tree 持久化的实际改动文件，可从 \`cw status --topicId <topicId>\` 取）

## 步骤 1：派 3 个 subagent（如支持）

推荐用 subagent 做对抗性审查。每个 subagent 职责正交——同一缺陷最多被一个抓到。

### Subagent A：项目约定审查

- **审什么**：是否符合项目特定约定——lint 规则、架构规范、命名规范、分层约定
- **依据**：步骤 0 找到的 code-review skill（项目特有）
- **怎么审**：grep 同类写法对照（如项目约定"catch 必须用 CwError"，grep 现有 catch 看本次改动是否符合）
- **不审**：通用语言质量（类型安全、错误处理模式）那是 B 的事；功能完整性那是 C 的事
- **输出**：维度"项目约定"的 pass/warn/fail 判定 + 问题清单

### Subagent B：通用质量审查

- **审什么**：语言/范式通用的代码质量——类型安全、错误处理、边界条件、测试有效性（4 维度）
- **依据**：\`skill/review-agents/quality-criteria.md\`（CW 自带通用标准）
- **怎么审**：按 quality-criteria.md 的 4 维度逐条判 pass/warn/fail
- **不审**：项目特定约定（lint 规则、架构规范）那是 A 的事；功能完整性那是 C 的事
- **输出**：4 个维度（类型安全 / 错误处理 / 边界条件 / 测试有效性）各一档 pass/warn/fail + 问题清单

### Subagent C：plan 完成度核对

- **审什么**：功能完整性——plan 列的 changes 有没有落地 + plan 设计对不对（依赖、范围）
- **依据**：\`skill/review-agents/plan-completeness.md\` + dev-plan.json + topic.waves[].changedFiles
- **怎么审**：客观事实核对（非质量判断）——逐条读 waves[].changes，对照 changedFiles 判断落地率；审 dependsOn 合理性、wave 范围合理性
- **不审**：代码实现质量（即使文件落地了，写得对不对那是 B 的事）
- **输出**：落地率 + 未落地清单（must_fix）+ 设计问题清单（should_fix）

### 分工正交性约束（重要）

三个 subagent 职责互斥：

| subagent | 审的角度 | 判断方式 |
|----------|---------|---------|
| A | "是否符合项目约定" | grep 同类写法对照 |
| B | "语言/范式通用质量" | 类型安全、错误处理 |
| C | "功能完整性" | 客观事实核对，非质量判断 |

**同一缺陷最多被一个 subagent 抓到。** 如果 A 和 B 都报同一个问题，说明分工边界不清晰——优先保留通用质量维度（B），删掉 A 的重复项。

## 步骤 1 备选：不支持 subagent 时

如运行环境不支持 subagent（agent-agnostic），主 agent 自己按三个维度分别审查：
- 先做 C（plan 完成度核对，客观事实，最容易判定）
- 再做 B（按 quality-criteria.md 4 维度逐条判）
- 最后做 A（项目约定，grep 对照）
- 三个维度都要走完，不能省。在 review.md 顶部标注"未使用 subagent，主 agent 自审"。

## 产出 review.md

审查结果写入 review.md（落 .xyz-harness/<slug>/changes/ 目录）。汇总三个 subagent 的结果，格式：

\`\`\`markdown
# Code Review — <slug>

## 审查方式
- [ ] 使用 3-subagent 分工 / [ ] 主 agent 自审（未支持 subagent）
- code-review skill：有 / 无（A 维度依据）

## 审查范围
- commits: <base>..HEAD（N 个 commit）

## 评分汇总
| 维度 | 审查方 | 状态 | must_fix | should_fix |
|------|--------|------|----------|------------|
| 项目约定 | A | pass/warn/fail | 0 | 1 |
| 类型安全 | B | pass | 0 | 0 |
| 错误处理 | B | warn | 0 | 2 |
| 边界条件 | B | pass | 0 | 0 |
| 测试有效性 | B | pass | 0 | 0 |
| plan 完成度 | C | pass/fail | 0 | 1 |

状态判定：fail = 有 must_fix；warn = 有 should_fix 但无 must_fix；pass = 无问题或仅 nit。

## 发现的问题
| 维度 | 审查方 | 问题 | 严重度 | 位置 |
|------|--------|------|--------|------|
| 错误处理 | B | 空 catch 吞异常 | must_fix | src/xxx.ts:42 |
| plan 完成度 | C | W2 changes[1] 未落地 | must_fix | 缺 src/gate.ts |

## plan 完成度核对（Subagent C）
- 总 changes 数：N，已落地：M，未落地：K
- **落地率：M/N = XX%**
- 未落地清单（must_fix）：...
- 设计问题清单（should_fix）：...

## 结论
- must_fix 总数 > 0 → **禁止调 cw(review)**。先修代码，重新 commit + cw(dev)，再重走 review
- must_fix = 0 → 调 cw(review) 提交本文件路径
\`\`\`

## 提交 review

review.md 写完后提交：

    cw review --topicId <topicId> --reviewPath <review.md 的绝对路径>

- CW 校验 review.md 存在 + 非空（与 retrospect gate 同模式，只看文件存在性，不解析内容）
- gate 通过 → status 流转到 reviewed，下一步跑 test
- gate fail（文件不存在/空）→ 重写后重调 cw(review)

## 本阶段禁止

- [禁止] 跳过 review 直接调 cw(test)（状态机 guard 会拒绝 illegal_transition）
- [禁止] 写空的 review.md 应付（gate 只校验非空，但跳过实质审查 = 违背流程意图）
- [禁止] review 发现 must_fix 但不修就调 cw(review)（先修代码，重新 commit + cw(dev)）
- [禁止] 让多个 subagent 报同一个问题（同一缺陷最多一处报告，正交分工）

## 完成标志

review.md 写完（含评分汇总表 + 3 个维度的发现）且 cw(review) gate 通过（status=reviewed）后，进入 test 阶段跑测试。
`.trim();
