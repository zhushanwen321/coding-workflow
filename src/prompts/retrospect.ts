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
 * 四段结构（W4 / FR-2）：buildNextAction 在本常量之前注入 buildDerivedSummary 摘要，
 * agent 进 retrospect 前先看客观数据。本 prompt 的四段承接那份数据，引导从「数据」走向
 * 「可泛化模式 / 设计级风险 / 未闭环评估」，防止 processIssues 退化为 bug 复述、
 * knownRisks 聚焦代码细节。
 *
 * 结构化数据的长期价值：与 post-closeout assessment 交叉比对，算"自省准确度"——
 * 如果实际缺陷大部分没在 knownRisks 登记，说明自省流程太浅。
 */

export const RETROSPECT_PROMPT = `
[retrospect 阶段] 复盘 + 结构化风险登记

test gate 已通过（或达上限强制进复盘）。closeout 前的最后一步：复盘执行过程，
登记已知风险和流程问题。这不是走过场——retrospect 是质量预测的来源之一，
knownRisks 的准确度直接影响后续 quality-criteria 的校准。

上方注入的「derived 摘要」列出了本 topic 的客观数据（totalWaves / gateFailCount /
devRetryCount / testRetryCount / firstTryPassRate 等）。**先读数据再写反思**——
不要凭记忆自省，要对着数据回答"为什么"。下面的四段结构围绕这份摘要展开。

## 复盘四段结构（retrospect.md 自由格式，建议按此顺序组织）

### 第 1 段：derived 异常归因（必填，对应上方 derived 摘要）

对着 derived 摘要的异常指标逐条回答"为什么"。derived 异常数（见上方 derived 摘要，
即 gateFailCount / devRetryCount / testRetryCount > 0 或 firstTryPassRate < 1 的项）
每一条都要给出至少 1 条归因——把"数字异常"翻译成"可执行的改进点"。

- gateFailCount=N：哪些 gate 反复 fail？是 gate 设计太严/太松，还是 commit 真的不合规？
- devRetryCount=N：dev 重试，Wave 拆分不合理？commit 质量不稳定？
- testRetryCount=N：test 重试，tdd_plan 的测试设计有问题？
- firstTryPassRate=X：哪个 phase 首次失败？为什么没一次性过？

如果 derived 全 pass（无异常），本段可简短说明"执行指标干净"，但仍需复盘过程问题。

### 第 2 段：可泛化流程模式（processIssues，必填）

从操作失误抽象出可泛化流程模式——不是复述具体 bug，而是提炼"在别的 topic 里也会犯"
的流程性问题。每条标 type=pattern（可泛化、跨 topic 可复现、有迭代 quality-criteria 的价值）
或 type=oneOff（一次性失误，仅记录）。建议至少 1 条 type=pattern（缺失不阻断 gate，但会记
warning——说明未从失误抽象出可泛化模式）。

判断方法：把失误描述里的具体文件名/变量名替换成占位符后，如果结论还成立，就是 pattern。

### 第 3 段：设计级风险（knownRisks，必填）

从代码位置抽象到架构/接口/数据流层面，设计级风险优先于代码细节风险。
knownRisks 要标注是设计级还是代码级——设计级（如并发模型、数据一致性、错误传播路径）
排在前面，代码级（如某个函数缺空值检查）排在后面。

多数交付至少有 1 个 unverified 假设（待 post-closeout 验证），标 unverified=true。

### 第 4 段：未闭环评估（承接 review issue 提醒）

评估 CW 返回的未闭环 issue（status=open 的 should-fix/nit）。判断哪些需在本次交付前处理，
哪些接受不修。接受不修的要在 processIssues 里记录「哪些 should-fix/nit 被有意跳过及原因」，
避免静默遗忘。closeout 的 coverage 会如实记录通过率，不强制 100% passed。

## retrospectData 格式

agent 只填 knownRisks + processIssues，**不要填 derived**（cw 自动算并覆盖）：

{
  "knownRisks": [
    {
      "severity": "high",
      "area": "并发写入",
      "description": "store.ts 的 flock 在高并发下未压测，可能存在竞争（设计级：锁模型未验证）",
      "unverified": true
    },
    {
      "severity": "medium",
      "area": "错误处理",
      "description": "JSON.parse 失败时返回空库，大文件损坏可能静默丢数据（代码级：单点缺降级）",
      "unverified": false
    }
  ],
  "processIssues": [
    {"type": "pattern", "description": "subagent 指令未约束切分支，导致 W5 自作主张切分支——指令模板缺「禁止切分支」约束"},
    {"type": "oneOff", "description": "replaceSpec flag 误用为 stdin，一次性参数理解失误"}
  ]
}

### 字段说明

- **knownRisks**：交付时已知但未完全解决的风险（设计级优先）
  - severity：high（阻塞级）/ medium（重要）/ low（观察即可）
  - area：涉及的模块/功能区域
  - description：具体风险描述，需在文本里写明是设计级（架构/接口/数据流层面）还是代码级细节风险
  - unverified：是否为未经证实的假设（待 post-closeout 验证）
- **processIssues**：本次 topic 暴露的流程问题（供 quality-criteria 迭代参考）
  - 对象数组，每条带 type 分类
  - type=pattern：可泛化流程模式（跨 topic 可复现，有迭代价值）——建议至少 1 条（缺失记 warning）
  - type=oneOff：一次性失误（偶发，仅记录）
  - type=observation：观察性陈述（非问题性陈述，记录现象）
  - type=uncategorized：旧 string[] 迁移兜底标签，新数据禁止用

### derived（cw 自动算，不要填）

derived 段由 cw 从执行数据自动派生（即上方注入的 derived 摘要），包含：
- totalWaves / totalCases / gateFailCount / devRetryCount / testRetryCount
- redLightConfirmed（TDD 红灯是否 pass）
- firstTryPassRate（各 phase 首次通过率）

即使填了 derived 也会被 cw 覆盖——不信任 agent 自报的执行数据。

## retrospect.md 与 retrospectData 的分工

| 产物 | 给谁读 | 内容 |
|------|--------|------|
| retrospect.md | 人（你自己/团队成员） | 自由格式复盘叙述，含上下文和思考过程（四段结构） |
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
- [禁止] processIssues 只复述具体 bug（要抽象成可泛化流程模式，标 type=pattern）
- [禁止] knownRisks 只列代码细节（设计级风险优先，标注是设计级还是代码级，在 description 里写明）
- [禁止] 手填 derived（cw 会覆盖，填了白填）

## 完成标志

retrospect.md 写完 + cw(retrospect) gate 通过（status=retrospected）后，调 cw(closeout) 归档。

## 相关 skill（按需调用）

本阶段如遇以下情况，可调 \`cw skill <name>\` 获取方法论：

- **复盘时发现架构问题**（本 topic 暴露的"没好的 test seam / 模块边界划错 / 浅模块"等可泛化模式）→ \`cw skill improve-codebase-architecture\`（找深化机会 + 候选评估，用于规划下一个 topic 做架构深化）
  - 注：retrospect 只记录问题（knownRisks / processIssues），不直接实施深化——深化走单独的 cw topic
`.trim();
