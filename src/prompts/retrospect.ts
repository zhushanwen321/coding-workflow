/**
 * retrospect 提示词 — test gate 通过后 / retrospect gate fail retry 时返回。
 *
 * 触发点：state-machine.ts buildNextAction 的 test 分支（gate pass）和 retrospect 分支（retry）。
 * 交付物：retrospect.md（人读 markdown）+ retrospectData（机读 JSON），由 cw(retrospect) 消费。
 *
 * 双写设计（与 clarify 阶段的 clarifyJson + ADR 同模式）：
 *   - retrospect.md：自由格式复盘，给人读
 *   - retrospectData：结构化 knownRisks + processIssues，给机器读
 *   - derived 段由 cw 自动算（从 gateHistory/waves/testCases），agent 不填
 *
 * 结构化数据的长期价值：与 post-closeout assessment 交叉比对，算"自省准确度"——
 * 如果实际缺陷大部分没在 knownRisks 登记，说明自省流程太浅。
 */

export const RETROSPECT_PROMPT = `
[retrospect 阶段] 复盘 + 结构化风险登记

所有 testCase 已 passed（test gate 通过）。closeout 前的最后一步：复盘执行过程，
登记已知风险和流程问题。这不是走过场——retrospect 是质量预测的来源之一，
knownRisks 的准确度直接影响后续 quality-criteria 的校准。

## 工作流

1. 回顾执行过程：翻 gateHistory 的 fail 记录、replan 的改动、dev/test 返工点
2. 识别已知风险：本次交付中已知但未完全解决的问题/假设
3. 提取流程问题：CW 流程本身暴露的不足（plan 拆分不合理？test 覆盖不够？review 漏了什么？）
4. 写 retrospect.md（自由格式复盘，给人读）
5. 构造 retrospectData（结构化 JSON，给机器读）
6. 提交：

    echo '<retrospectDataJson>' | cw retrospect --topicId <topicId> --retrospectPath <retrospect.md 绝对路径>

## retrospectData 格式

agent 只填 knownRisks + processIssues，**不要填 derived**（cw 自动算并覆盖）：

{
  "knownRisks": [
    {
      "severity": "high",
      "area": "并发写入",
      "description": "store.ts 的 flock 在高并发下未压测，可能存在竞争",
      "unverified": true
    },
    {
      "severity": "medium",
      "area": "错误处理",
      "description": "JSON.parse 失败时返回空库，大文件损坏可能静默丢数据",
      "unverified": false
    }
  ],
  "processIssues": [
    "plan 阶段没考虑到 git diff-tree 的性能，大 commit 导致 devCheck 慢",
    "test 的 expected 太严格，精确匹配导致 false positive"
  ]
}

### 字段说明

- **knownRisks**：交付时已知但未完全解决的风险
  - severity：high（阻塞级）/ medium（重要）/ low（观察即可）
  - area：涉及的模块/功能区域
  - description：具体风险描述
  - unverified：是否为未经证实的假设（待 post-closeout 验证）
- **processIssues**：本次 topic 暴露的流程问题（供 quality-criteria 迭代参考）
  - 字符串数组，每条一个问题

### derived（cw 自动算，不要填）

derived 段由 cw 从执行数据自动派生，包含：
- totalWaves / totalCases / gateFailCount / devRetryCount / testRetryCount
- redLightConfirmed（TDD 红灯是否 pass）
- firstTryPassRate（各 phase 首次通过率）

即使填了 derived 也会被 cw 覆盖——不信任 agent 自报的执行数据。

### 未闭环的 review issues

如果 CW 返回的 nextAction 或 topic 数据中有未闭环的 should-fix/nit issue（status=open），
retrospect 应该评估它们：
- 判断是否需要在本次交付前处理（如 should-fix 涉及重要质量风险）
- 如果接受不修，在 processIssues 里记录「哪些 should-fix/nit 被有意跳过及原因」
- 这样保证 issue 不会被静默遗忘

## retrospect.md 与 retrospectData 的分工

| 产物 | 给谁读 | 内容 |
|------|--------|------|
| retrospect.md | 人（你自己/团队成员） | 自由格式复盘叙述，含上下文和思考过程 |
| retrospectData | 机器（cw stats / post-closeout assessment） | 结构化 risks + issues，可聚合分析 |

两者不是替代关系——md 讲"为什么"，JSON 记"是什么"。

## 提交 retrospect

retrospect.md 写完 + retrospectData 构造好后提交：

    echo '<retrospectDataJson>' | cw retrospect --topicId <topicId> --retrospectPath <retrospect.md 绝对路径>

- CW 校验 retrospect.md 存在 + 非空（gate 门）
- retrospectData **必填**——不传则 gate fail，必须通过 stdin 传入
- gate 通过 → status 流转到 retrospected，下一步 closeout

## 本阶段禁止

- [禁止] 写空的 retrospect.md 应付（gate 只校验非空，但空复盘 = 失去质量预测数据）
- [禁止] 在 knownRisks 里填"无风险"（无风险 = 没认真想。多数交付至少有 1 个 unverified 假设）
- [禁止] 手填 derived（cw 会覆盖，填了白填）

## 完成标志

retrospect.md 写完 + cw(retrospect) gate 通过（status=retrospected）后，调 cw(closeout) 归档。
`.trim();
