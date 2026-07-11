/**
 * plan 提示词 — create 后 / plan gate fail retry 时返回，指导 agent 如何写 plan.json。
 *
 * 触发点：state-machine.ts buildNextAction 的 create 分支（首次）和 plan 分支（retry）。
 * 交付物：plan.json，落在 {workspacePath}/.xyz-harness/{slug}/plan.json，由 cw(plan) 消费。
 */

export const PLAN_PROMPT = `
[plan 阶段] 写结构化计划 plan.json

plan.json 是 CW 状态机的输入。CW 解析它的 waves + testCases 写入 _cw.json，
plan gate 通过后状态从 created 流转到 planned。写完 plan.json 后提交：

    echo '<planJson>' | cw plan --topicId <topicId>

## plan.json 结构

plan.json 必须包含以下顶层字段（format 固定为 "lite"）：

{
  "format": "lite",
  "objective": "<一句话业务目标，呼应 spec 阶段弄清的第一件事>",
  "waves": [
    {
      "id": "W1",
      "changes": ["<文件级改动点描述>", ...],
      "dependsOn": []              // 依赖的前置 wave id 数组，无依赖传空数组
    }
  ],
  "testCases": [
    {
      "id": "U1",                  // U 前缀=单测，E 前缀=e2e
      "layer": "mock",             // "mock" 或 "real"（mock 验证逻辑，real 验证集成）
      "scenario": "<测什么场景>",
      "steps": "<怎么测>",
      "expected": { "text": "<预期结果>" },
      "executor": "<谁跑这个测试>",
      "requiresScreenshot": false
    }
  ]
}

## Wave 拆分原则

- 垂直切片：每个 Wave 产出一个可独立验证的功能增量，不是横向分层（不是"先写所有 model，再写所有 controller"）。
- 依赖明确：每个 Wave 的 dependsOn 列出必须先完成的前置 Wave。无环依赖（W1 依赖 W2、W2 依赖 W1 = 非法）。
- 粒度适中：一个 Wave 改 1-3 个文件为宜。过大难并行，过碎管理开销高。
- changes 要文件级：写"修改 src/store.ts 加 fileLock 方法"，不写"加锁"（太抽象，无法验证）。

## 测试设计（plan 的重中之重）

[先探索后提问] 写测试用例前，先读涉及的 fixture/mock 数据进上下文。
预期值对照真实 fixture 推算，不从功能描述正向猜——这是 discoverable 类信息，
不该靠提问获取，也不该靠猜。

测试用例设计不达标 = plan 未完成。验收全绿的前提是 plan 里有可执行、可判定的测试清单。

- 单测（U 前缀）：验证单个函数/模块的逻辑正确性。每条必须是 AC 级可判定（能明确说 pass 还是 fail）。
- e2e（E 前缀）：验证端到端流程跑通。layer 标 mock（快速验证逻辑）或 real（真实集成验证）。
- 覆盖核心路径 + 边界 + 异常分支。只测 happy path = 测试设计不合格。
- expected.text 必须具体可判定。写"返回正确结果"= 无法判定；写"返回 { status: 'planned' }"= 可判定。
- e2e 副作用标注：real 层用例标 none（纯读）/ cache-only（只写缓存目录）/ mutating（写 DB/发请求/改文件）。
  mutating 的必须在 scenario 或 steps 里标注清理策略，避免跑完污染环境。mock 层默认 none。
- 依赖关系：testCase 可标 dependsOn（某测试依赖另一个先通过）。

## decision complete 标准（plan 完整性的终极检查）

plan.json 写完后自检：execute 阶段的 implementer 读 plan.json 后，是否需要做任何业务/技术决策
才能开始 TDD？如果需要 = plan 还不完整，还有隐含决策点。

plan 必须达到 decision complete——implementer 零决策即可执行。检查：
- 每个 wave 的 changes 职责明确，不写"待定""看情况""届时决定"
- testCase 的输入/预期关键值已确定，不留给执行阶段猜
- 边界条件在 testCase 里已具化（不在执行时才发现"这个 case 没考虑"）
- 若有无法确定的决策点 → 不默默留坑，明确在 objective 或 changes 里标注 [需用户确认] 并列出

plan gate 检查结构完整性（字段齐全），decision complete 检查语义完整性（可零决策执行）。
两者都过才算 plan 真正完成。

## plan gate 会校验什么（engine 侧最基础结构校验）

CW plan gate 只做最基础结构校验，不判质量（质量靠本提示词的方法论约束）：
- format 字段 === "lite"
- waves 数组非空（至少 1 个 wave）
- testCases 数组非空（至少 1 个 testCase）
- 每个 wave 有 id / changes / dependsOn
- 每个 testCase 有 id / layer / scenario / steps / expected / executor

gate fail 时 CW 返回 mustFix（逐条 fail 原因），status 不变（仍 created），修 mustFix 后重调：

    echo '<fixedPlanJson>' | cw plan --topicId <topicId>

## 本阶段禁止

- [禁止] 写实现代码（plan 只设计，不实现）
- [禁止] 写测试代码（只设计用例的输入/预期/类型，测试代码由 execute 阶段 TDD 写）
- [禁止] 把多个 Wave 合成一个巨型 Wave（失去并行/渐进式提交能力）

## 完成标志

plan.json 写完且 cw(plan) gate 通过（status 流转到 planned）后，CW 返回 nextAction 指向 dev。
进入 execute 阶段，按 Wave 逐步实现 + TDD。
`.trim();
