/**
 * dev-plan 提示词 — create 后 / dev-plan gate fail retry 时返回。
 *
 * 触发点：state-machine.ts buildNextAction 的 create 分支（首次）和 plan 分支（retry）。
 * 交付物：dev-plan.json，由 cw plan 消费。
 *
 * dev-plan.json 只管 dev 规划（waves），testCases 已移到 test.json（tdd_plan 阶段提交）。
 * 旧版 plan.json（同时含 waves + testCases）仍兼容：cw plan 会自动提取 testCases。
 */

export const DEV_PLAN_PROMPT = `
[dev-plan 阶段] 写 dev-plan.json（只管 dev 规划）

dev-plan.json 是 CW 状态机的输入之一。CW 解析它的 waves 写入 _cw.json，
dev-plan gate 通过后状态从 created 流转到 planned。

## dev-plan.json 结构

{
  "format": "lite",
  "objective": "<一句话业务目标>",
  "waves": [
    {
      "id": "W1",
      "changes": [
        { "file": "src/store.ts", "action": "modify", "description": "加 fileLock 方法" },
        { "file": "src/types.ts", "action": "modify", "description": "加 WaveChange 类型" }
      ],
      "dependsOn": [],
      "priority": "P0"
    }
  ]
}

**注意：dev-plan.json 不含 testCases。** testCases 在下一步 tdd_plan 阶段通过 test.json 提交。

## Wave 拆分原则

- 垂直切片：每个 Wave 产出一个可独立验证的功能增量，不是横向分层。
- 依赖明确：dependsOn 列出前置 Wave。无环依赖。
- 粒度适中：一个 Wave 改 1-3 个文件为宜。
- changes 必须结构化：每个元素是 \`{ file, action, description }\`——file 是文件路径，action 是 create/modify/delete 三值之一，description 是该文件的改动说明。不写裸字符串。
  - action 三值语义：
    - \`create\`：新建文件（file 必须不存在，gate 校验）
    - \`modify\`：修改已有文件（file 必须存在，gate 校验）
    - \`delete\`：删除文件（file 必须存在，gate 校验）
  - action 必填。不填或填非法值（如 \`update\`、大写 \`MODIFY\`）会被 schema 拒绝（literal union 大小写敏感）。
- **spec FR 覆盖**：如果 clarify 阶段提交了 spec 的 functionalRequirements，plan 的 waves 必须覆盖所有 FR。每个 FR 的 id 或 title 应出现在某个 wave change 的 description 里。无法覆盖的 FR 必须明确告知用户，禁止静默缩范围。

## priority 字段（可选）

每个 wave 可标 priority：P0（核心）/ P1（重要）/ P2（增强）。
priority 是排序和评估用，**不是跳过的理由——全部 P0/P1/P2 都必须完成**。

## dev-plan gate 校验

- format === "lite"
- waves 非空
- 每个 wave 有 id / changes（{file, action, description}[] 结构化）/ dependsOn
- 环形依赖检测（dependsOn 不可成环）
- **文件存在性校验**（基于 action）：
  - modify/delete 的 file 必须存在——不存在=幽灵文件 must-fix
  - create 的 file 必须不存在——已存在=与意图矛盾 must-fix

gate fail 时返回 mustFix，status 不变，修后重调：

    echo '<devPlanJson>' | cw plan --topicId <topicId>

## 向后兼容

旧版 plan.json（同时含 waves + testCases）仍可提交。CW 自动提取 testCases 到 store，
等效于跳过 tdd_plan 阶段（testCases 直接写入，status 流转到 planned，nextAction 指向 tdd_plan 或 dev）。

## 本阶段禁止

- [禁止] 写实现代码
- [禁止] 写测试代码（test.json 在 tdd_plan 阶段写）
- [禁止] 在 dev-plan.json 里放 testCases（放 test.json 里）

## 完成标志

dev-plan.json 写完且 cw(plan) gate 通过（status=planned）后，进入 tdd_plan 阶段。
`.trim();

/**
 * PLAN_PROMPT — 向后兼容别名，等同 DEV_PLAN_PROMPT。
 * @deprecated 使用 DEV_PLAN_PROMPT 代替
 */
export const PLAN_PROMPT = DEV_PLAN_PROMPT;
