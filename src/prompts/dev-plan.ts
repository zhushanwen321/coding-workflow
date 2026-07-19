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

### tracer-bullet 切片思想（Wave 设计的本质）

Wave 的"垂直切片"本质是 tracer bullet（端到端探测弹）：

- **端到端贯通**：每个 Wave 应该穿层（schema → API → UI → tests 都碰到），不是横向分层（"做 schema 层" / "做 UI 层"）
- **可独立 demo 或验证**：每个 Wave 完成后应该能独立演示或验证一个完整行为
- **单 agent session 内可完成**：通常 1-3 文件，能在一次 agent 会话内做完

**反模式**：横向切片（"先做完全部 schema，再做完全部 API，再做完全部 UI"）——批量验证的是想象中的行为，对真实变更迟钝。

### 深模块三自问（每个 Wave 设计完后自检）

每个 Wave 的 changes 设计完后，对着三自问检查是不是"深模块"（大量行为藏在小接口后面）：

1. **能减少方法数量吗？** —— 如果一个 Wave 引入的公共 API 很多，问自己能不能合并
2. **能简化参数吗？** —— 如果一个函数签名参数很多（>3 个），问自己能不能打包成对象或拆成多个函数
3. **能把更多复杂度藏进去吗？** —— Wave 应该藏住实现细节，只暴露必要接口；如果 caller 需要知道 Wave 内部的实现细节才能用它，说明接口太宽

**判据**：深模块 = 接口小 + 实现大（caller 学一点接口就能驱动很多行为）。浅模块 = 接口大 + 实现薄（只是 pass-through）。

## priority 字段（可选）

每个 wave 可标 priority：P0（核心）/ P1（重要）/ P2（增强）。
priority 是排序和评估用，**不是跳过的理由——全部 P0/P1/P2 都必须完成**。

### 可测试性三原则（写 changes 时自检）

Wave 的 changes 设计时，对照可测试性三原则，避免设计出难测的代码：

1. **接收依赖，不要创建依赖**
   - 好：\`processOrder(order, paymentGateway)\` —— 依赖从参数传入，测试时可注入 mock
   - 坏：\`processOrder(order)\` 内部 \`new StripeGateway()\` —— 依赖写死，测试时无法替换

2. **返回结果，不要制造副作用**
   - 好：\`calculateDiscount(cart): Discount\` —— 纯计算，返回结果
   - 坏：\`applyDiscount(cart): void\` —— 直接改 cart，副作用不可见，测试时要检查 cart 的状态变化

3. **小表面积**
   - 方法少 = 测试少（每个公共方法都要测）
   - 参数少 = setup 简单（每个参数都要构造测试数据）

这三条对应 tdd_plan 的 mock 边界纪律（只在 system boundary mock）——如果 Wave 的 changes 设计违反这三条，tdd_plan 阶段会发现"该 mock 的没法 mock"。

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

## 特殊场景

### shared 前置识别

拆 Wave 时主动识别"多个 Wave 共享的前置工作"：
- 共享类型定义（多个 Wave 都用的新类型）
- 共享工具函数（多个 Wave 都用的 helper）
- 共享配置（多个 Wave 都依赖的 config 改动）

这些 shared 前置应该拆成**独立 Wave**，其他 Wave 的 dependsOn 指向它。

**注意（TODO）**：当前 dependsOn 是声明但不强制执行（见 commit-discipline-dependsOn-gaps.md handoff）。shared 前置的强制性依赖该修复落地。这里先按思维引导：拆 Wave 时识别 shared，声明 dependsOn，agent 自觉按拓扑顺序实施。

### wide refactor（爆炸性机械变更）

当一次变更的 blast radius 扫过整个 codebase（单次编辑破上千 call site、没有纵向切片能单独 green），用 expand-contract 三段式：

1. **Expand**：在旧形式旁加新形式，什么都不破（Wave 1，dependsOn=[]）
2. **Migrate**：按 blast radius 分批迁移 call site（Wave 2/3/...，每批一个 Wave，都被 Expand 阻塞；旧形式还在所以 CI 批批 green）
3. **Contract**：无 caller 后删旧形式（最后一个 Wave，被所有 Migrate 阻塞）

**判定标准**：如果普通 tracer-bullet 切片能单独 green，不要用 expand-contract（那是过度工程）。只在"任何单切片都会让上千 call site 变红"时用。

### prefactoring（让 change easy 的前置重构）

发现 Wave N 的实现被 Wave M 的现有结构阻碍时，先做一个"让 change easy"的前置重构 Wave：

- 不是功能 Wave，是结构整理 Wave（提取接口 / 调整模块边界 / 消除阻碍实现的耦合）
- 放在 Wave N 之前，Wave N dependsOn 它
- principle: "Make the change easy, then make the easy change"

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
