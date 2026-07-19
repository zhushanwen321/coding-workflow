/**
 * confirm_clarify 提示词 — clarify 阶段用户确认 gate。
 *
 * 触发点：state-machine.ts buildNextAction 的 clarify（全 resolved/skipped）分支。
 * 流程：agent 调 cw(gen-spec) 生成确认 md → cw 自动打开给用户审查 → 用户确认 → cw(confirm_clarify)。
 */

export const CONFIRM_CLARIFY_PROMPT = `
[confirm_clarify 阶段] 用户确认需求

clarify 阶段已完成（所有记录 resolved/skipped）。plan 之前必须经过用户确认——
这是机器 gate，跳过 confirm_clarify 直接 plan 会被状态机拒绝（illegal_transition）。

## 流程

1. 调 cw(gen-spec) --topicId <topicId> 生成确认文档（CW 自动汇总 clarifyRecords + specSections）
2. cw 自动用系统默认应用打开 specPath——**告诉用户「确认文档已打开，请审查」并等待用户确认**。用户在另一个窗口/应用里看 md。
   - 无 GUI 环境（CI/容器）：cw 自动打开会 no-op（open 无界面可启动）。agent 应把 specPath 显式展示给用户——读出关键段落（FR/AC/决策）或 \`cat <specPath>\` 贴出来——再问确认。
3. 用户确认 → 调 cw(confirm_clarify) --topicId <topicId>
4. 用户要修改 → 调 cw(clarify) 追加/修改记录 → 重新 gen-spec → 重新确认

## gen-spec 命令

    cw gen-spec --topicId <topicId>
    → { specPath: "/tmp/cw-spec-xxx.md" }
    # 默认自动打开 specPath 给用户；--no-open 跳过（CI/自动化场景）

文档包含：objective、澄清记录摘要、spec FR/AC/决策列表。

**FR-8: gen-spec 现在有写副作用**——调 cw(gen-spec) 会记 artifacts.confirmSpec（路径 + 时间戳）。
confirm gate 校验 confirmSpec 存在：**不调 gen-spec 直接 confirm 会 gate fail**。
所以必须先调 gen-spec，再 confirm_clarify，顺序不可颠倒。

## confirm_clarify 命令

    cw confirm_clarify --topicId <topicId>

gate 条件：
1. 至少 1 条 resolved 或 skipped 的 clarifyRecord
2. artifacts.confirmSpec 存在（即 cw(gen-spec) 已被调用过——FR-8）

confirm 后 status 流转 created → clarify_confirmed，允许进 plan。

## 本阶段禁止

- [禁止] 跳过 confirm_clarify 直接调 cw(plan)（状态机 guard 会拒绝——机器 gate）
- [禁止] 不调 cw(gen-spec) 就直接 confirm（FR-8: confirm gate 校验 confirmSpec 存在，不调 gen-spec 会 gate fail——机器 gate）
- [人机交互纪律] gen-spec 后不等用户审查确认就 confirm（cw 已自动打开文档，但你要等用户说「确认/没问题」后才能 confirm_clarify）。**engine 不校验用户是否真审查**——物理上观察不到用户行为，靠 agent 在此把关。
- [人机交互纪律] 用户要修改但你不改就 confirm（回 clarify 追加/修改后再 gen-spec → 再确认）。同样靠 agent 自觉。

## 完成标志

confirm_clarify gate 通过（status=clarify_confirmed）后，进入 spec_review 阶段审查 spec 完整性。
`.trim();
