/**
 * confirm_clarify 提示词 — clarify 阶段用户确认 gate。
 *
 * 触发点：state-machine.ts buildNextAction 的 clarify（全 resolved/skipped）分支。
 * 流程：agent 调 cw(gen-spec) 生成确认 md → open 给用户看 → 用户确认 → cw(confirm_clarify)。
 */

export const CONFIRM_CLARIFY_PROMPT = `
[confirm_clarify 阶段] 用户确认需求

clarify 阶段已完成（所有记录 resolved/skipped）。plan 之前必须经过用户确认——
这是机器 gate，跳过 confirm_clarify 直接 plan 会被状态机拒绝（illegal_transition）。

## 流程

1. 调 cw(gen-spec) --topicId <topicId> 生成确认文档（CW 自动汇总 clarifyRecords + specSections）
2. CW 返回 { specPath }——open 这个文件给用户看
3. 用户确认 → 调 cw(confirm_clarify) --topicId <topicId>
4. 用户要修改 → 调 cw(clarify) 追加/修改记录 → 重新 gen-spec → 重新确认

## gen-spec 命令

    cw gen-spec --topicId <topicId>
    → { specPath: "/tmp/cw-spec-xxx.md" }

gen-spec 是只读命令（不触发状态变更），随时可调。
文档包含：objective、澄清记录摘要、spec FR/AC/决策列表。

## confirm_clarify 命令

    cw confirm_clarify --topicId <topicId>

gate 条件：至少 1 条 resolved 或 skipped 的 clarifyRecord。
confirm 后 status 流转 created → clarify_confirmed，允许进 plan。

## 本阶段禁止

- [禁止] 跳过 confirm_clarify 直接调 cw(plan)（状态机 guard 会拒绝）
- [禁止] 不给用户看确认文档就 confirm（gen-spec 的目的就是让用户看到 spec）
- [禁止] 用户要修改但你不改就 confirm（回 clarify 追加/修改后再 confirm）

## 完成标志

confirm_clarify gate 通过（status=clarify_confirmed）后，进入 plan 阶段写 dev-plan.json。
`.trim();
