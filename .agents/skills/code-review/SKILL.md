---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 coding-workflow 项目。
---

# Code Review

## 角色

本 skill 是 coding-workflow 的代码审查指南，定义审查维度和 checklist。
当前项目无 review agent / review-fix-loop 工作流，AI 按维度在当前会话中逐一覆盖。

## 审查维度

当前项目是纯 TypeScript CLI 引擎（状态机 + gate + plan-parser + store + dispatch），审查按以下 5 个维度逐项覆盖：

| 维度 | 关注点 | 核心文件 |
|------|--------|----------|
| 状态机正确性 | 状态转换、action 合法性、guard 拦截 | `state-machine.ts`、`actions.ts`、`types.ts` |
| Gate 检查完备性 | 每个 action 的 gate 是否覆盖关键不变式、GitValidator 校验逻辑 | `gate.ts` |
| 类型安全 | schema 校验、禁止 any、CwError vs 普通 Error 边界 | `types.ts`、`plan-parser.ts` |
| 测试覆盖 | 新逻辑有测试、edge case 覆盖、e2e 真实子进程验证 | `tests/` |
| CLI 边界 | 入参解析、exit code 映射、错误消息可读性 | `cli.ts`、`dispatch.ts` |

### 直接使用

当用户说 "review" 时，AI 应：

1. **收集变更**：
   ```bash
   git diff main...HEAD --stat
   git log main..HEAD --oneline
   ```

2. **按维度逐一审查**：参考下方各维度的 checklist，在当前会话中依次覆盖所有维度

3. **输出格式**：表格形式，每维度一节，列出发现的问题和建议

---

## 审查 Checklist

### 1. 状态机正确性 `[MANDATORY]`

状态机是 CW 的核心，转换规则错误会导致整个流程崩坏。

- [ ] **新增/修改 Action**：`types.ts` 的 `Action` union 新增成员时，`state-machine.ts` 的转换表（`TRANSITIONS`）必须同步添加对应转换，否则 guard 拦截 `illegal_transition`
- [ ] **新增/修改 Status**：`Status` union 新增成员时，确认所有 `status === "xxx"` 的 switch/if 分支是否需要补充 case
- [ ] **guard 覆盖**：每个 action 流转前必须经过 guard 检查（`actions.ts` 各 handler 入口调对应 check 函数），无 guard 的 action 等于状态机失守
- [ ] **replan 旁路**：replan 是唯一的「回退/追加」action，确认 replan 的 append-only 约束（已 committed 的 wave 不可改）没有被破坏
- [ ] **nextAction 完整**：`actions.ts` 各 handler 返回的 `nextAction` 必须给出合法的下一步 action + guidance。新增 action 时确认所有前置状态的 nextAction 都指向它

### 2. Gate 检查完备性 `[MANDATORY]`

Gate 是 CW 的核心价值（机器检查门，防 AI 谎报）。

- [ ] **新增 check 函数**：gate.ts 新增具名 check 函数（如 `xxxCheck`）时，确认对应的 handler 调用了它，且 gate 结果写入了 `gateHistory`
- [ ] **gateHistory 记录**：每次 gate 执行（pass/fail）都必须记录到 `gateHistoryEntry`，用于 closeout 回溯。遗漏记录 = 审计断链
- [ ] **judgeByExpected 严格度**：`testCheck` 调用 `judgeByExpected` 做精确匹配。如果改了匹配逻辑（如加 trim/substring 容差），必须确认是否破坏「防 AI 谎报」的设计意图——容差一开，机器重算门失去意义
- [ ] **GitValidator 边界**：`devCheck` 的 `validate()` 检查 commit 存在/在 repo/非空。改 commit 校验逻辑时确认 `extraFiles`/`extraCommitReuse` 警告（非 fail）的语义没变
- [ ] **execFileSync 安全**：`runTestRunner`/`redLightCheck` 调 `execFileSync` 执行外部命令。确认 command 来自 `TestRunnerConfig`（用户配置），不存在命令注入风险（不拼 shell 字符串）

### 3. 类型安全 `[MANDATORY]`

- [ ] **禁止 any**：全局规范要求用 `unknown` 或具体类型替代 `any`。`tsconfig.json` 应开启 `noImplicitAny`
- [ ] **schema 校验**：`plan-parser.ts` 的 `parseDevPlan`/`parseTestJson` 用 typebox schema 校验外部输入（plan.json/test.json）。新增字段时必须同步更新 `DevPlanSchema`/`TestJsonSchema`，否则外部输入绕过类型检查
- [ ] **CwError vs Error 边界**：`CwError` 标记预期错误（exit 1），普通 Error 标记内部异常（exit 2）。新增 throw 时确认分类正确——参数缺失/topic not found/JSON 解析失败 抛 CwError；不变式违反/lock 失败 抛普通 Error
- [ ] **type-only import**：跨模块的纯类型引用用 `import type`（如 `types.ts` 反引 `CwStore`/`GitValidator`），避免循环依赖被打包进运行时

### 4. 测试覆盖 `[MANDATORY]`

- [ ] **新逻辑有测试**：新增 check 函数 / handler / parser 逻辑，必须有对应的 `*.test.ts`
- [ ] **edge case**：gate 检查的边界场景（空数组、缺字段、非法 JSON、文件不存在）必须有测试覆盖
- [ ] **e2e 覆盖**：`tests/e2e.test.ts` 跑真实 CLI 子进程。涉及 CLI 行为变更（新参数/新 exit code/新输出格式）时，必须更新或新增 e2e case
- [ ] **gate 历史断言**：涉及 gate 流转的测试，应断言 `gateHistory` 的记录完整性（phase/action/gate/result 四元组）

### 5. CLI 边界 `[MANDATORY]`

- [ ] **exit code 映射**：`cli.ts` 的 `mapExitCode` 按 `instanceof CwError` 判定 exit 1（预期错误）vs exit 2（内部异常）。新增错误类型时确认映射正确
- [ ] **参数解析**：`cli.ts` 用 `minimist` 解析参数。新增参数时确认 `--help` 输出同步更新，且参数透传到 `dispatch` 的路径完整
- [ ] **dispatch 纯函数**：`dispatch.ts` 是 platform-agnostic 入口。确认新增逻辑不引入 Node.js 特定依赖（fs/path 可，但不应直接依赖 pi/claude-code runtime）。引擎层必须保持 agent-agnostic
- [ ] **错误消息可读性**：CLI 面向人类 + agent。错误消息应包含「如何修正」的指引（如 "expected field X in plan.json, got: ..."），而非只报「失败」

---

## 项目特点

- **纯逻辑引擎**：CW 是 agent-agnostic 的状态机 + gate，不含 UI / 数据库 / 网络请求。审查重点是逻辑正确性和类型安全，不涉及运行时环境
- **gate 是核心价值**：gate 检查防 AI 谎报，任何 gate 逻辑的弱化（加容差、跳过检查、丢失记录）都是严重回归
- **schema 是契约边界**：plan.json / test.json 是外部输入，必须经 typebox schema 校验。schema 与内部类型不同步 = 契约破裂

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
