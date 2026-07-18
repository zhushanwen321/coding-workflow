/**
 * tdd-plan 提示词 — dev-plan gate 通过后 / tdd-plan gate fail retry 时返回。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan 分支（gate pass）和 tdd_plan 分支（retry）。
 * 交付物：test.json（testCases + testRunner 必选），由 cw tdd_plan 消费。
 *
 * 本阶段核心：agent 已知要实现什么（dev-plan.json 的 waves），先写测试代码（红灯），
 * 再写 test.json 定义 testCases + expected。expected 是判别联合（exact/exit_zero/script 三模式），
 * 从测试断言决定模式与取值，不是猜的。
 */

export const TDD_PLAN_PROMPT = `
[tdd_plan 阶段] 写测试代码 + test.json

dev-plan gate 已通过（status=planned）。你已经知道要实现什么（dev-plan.json 的 waves）。
本阶段先写测试代码（TDD 红灯），再写 test.json 定义 testCases + expected。

## 工作流

1. 读 dev-plan.json 的 waves，理解每个 wave 要实现什么
2. 为每个 wave 写对应的测试代码（vitest .test.ts / pytest / JUnit 等）
3. 跑测试确认红灯（全部 fail）——测试应该因为实现不存在而失败
4. 写 test.json：从测试断言提取 expected，定义 testCases
5. 提交：

    echo '<testJson>' | cw tdd_plan --topicId <topicId>

## test.json 结构

{
  "testCases": [
    {
      "id": "U1",
      "layer": "mock",
      "priority": "P0",
      "scenario": "<测什么场景>",
      "steps": "<怎么测>",
      "expected": { "type": "exact", "text": "<预期结果>" },
      "executor": "<vitest|pytest|junit|shell|custom>",
      "redCheck": true,
      "requiresScreenshot": false,
      "dependsOn": []
    },
    {
      "id": "E1",
      "layer": "real",
      "priority": "P1",
      "scenario": "<命令整体成功>",
      "steps": "<跑集成命令>",
      "expected": { "type": "exit_zero" },
      "executor": "shell",
      "redCheck": false,
      "requiresScreenshot": true
    }
  ],
  "testRunner": {
    "mode": "nodejs",
    "command": "npx vitest run",
    "cwd": "."
  }
}

## 字段说明

### testCases

- **id**: U 前缀=单测，E 前缀=e2e/集成
- **layer**: "mock"（隔离依赖验逻辑）或 "real"（真实集成验契约）。**必须同时含 mock 和 real 层（各≥1）**
- **priority**: P0/P1/P2，全部必须完成
- **scenario**: 测什么场景（AC 级可判定）
- **steps**: 怎么测
- **expected**: 机器判定基准（判别联合，**type 字段必填**）。3 种模式见下方「expected 撰写规范」：
  - \`{ "type": "exact", "text": "2" }\`：精确字符串 === 比较
  - \`{ "type": "exit_zero" }\`：退出码判定（exit 0 → pass）
  - \`{ "type": "script", "path": ".cw/judge-E1.sh" }\`：判定脚本（exit 0 → pass）
  - exact 模式的 text 不可填结论词（passed/ok/success），gate 拒绝模糊值
- **executor**: 谁跑这个测试（vitest / pytest / junit / shell / custom）
- **redCheck**: tdd_plan 阶段是否对此 case 做红灯校验
  - mock 层通常 true（纯逻辑，可立即跑）
  - real 层通常 false（需环境，tdd_plan 时跑不了）
- **requiresScreenshot**: 是否要求截图（mock 层 false，real 层视用例需要）
- **dependsOn**: 测试调度依赖（前置 case 先通过）

### testRunner（必选）

定义项目级测试执行策略。**必填**——CW 用它跑红灯校验（tdd_plan 阶段）和 test 机器重算（test 阶段）。
没有测试框架的项目不适用 CW（CW 的核心价值就是 TDD + 机器验证）。

| mode | command 示例 | 适用 |
|------|------------|------|
| nodejs | "npx vitest run" | Node.js 生态（vitest/jest/mocha） |
| python | "python -m pytest" | Python 生态（pytest/unittest） |
| java | "mvn test" | Java 生态（JUnit/TestNG/Maven） |
| custom | path: ".cw/run-tests.sh" | 自定义脚本（任何语言/框架） |

## expected 撰写规范（重要）

expected 支持 **3 种判定模式**（type 字段必填）。从你写的测试断言决定用哪种模式——不要猜值。

### 1. exact（精确字符串，默认/现状语义）

\`\`\`
expected: { "type": "exact", "text": "2" }
\`\`\`

CW 对 \`expected.text\` 与 \`actual.text\` 做**精确 === 比较**（无 trim/容差）。
适用：单元测试断言值。从断言直接取值：
- 测试断言 \`.toBe(2)\` → \`{ "type": "exact", "text": "2" }\`
- 测试断言 \`.toBe("hello")\` → \`{ "type": "exact", "text": "hello" }\`

text 仍受 FUZZY_EXPECTED_RE 约束——不可填 passed/ok/true 等结论词。

### 2. exit_zero（退出码判定）

\`\`\`
expected: { "type": "exit_zero" }
\`\`\`

CW 跑 testRunner 命令一次，所有 exit_zero case 共享结果（exit 0 → pass，非 0 → failed）。
actual 可省略（CW 自己跑命令）。适用：
- 布尔/状态类断言（如 \`.toBe(true)\`——无合法字符串值可填）
- 命令行测试（命令整体成功即 pass）

exit_zero 解决了「布尔断言无合法字符串值可填」的死锁——exit code 是确定的，仍是机器重算。

### 3. script（判定脚本）

\`\`\`
expected: { "type": "script", "path": ".cw/judge-E1.sh" }
\`\`\`

CW 跑 \`path\` 指向的脚本，exit 0 即 pass。约束：
- 脚本**自包含**（不接收 agent actual，自己读系统状态/产出物）
- 须有可执行权限 + shebang（\`#!/usr/bin/env bash\` 等）
- path 相对 workspace，resolve 后必须在 workspace 内（沙箱校验，逃逸路径会被 gate 拒绝）

适用：复杂判定（正则匹配、JSON 字段提取、多字段组合）。

### 选型决策

| 测试断言形态 | 用哪种模式 |
|---|---|
| \`.toBe(具体值)\` / \`.toEqual(对象)\` | exact（从断言取 text） |
| \`.toBe(true)\` / \`.toBeTruthy()\` / 命令整体成功 | exit_zero |
| 正则 / JSON 字段 / 多条件组合 | script |

## 测试设计思路（测出 bug，不是凑覆盖率）

[MANDATORY] 测试的首要目标是**发现真 bug**（代码中被违反的隐含约定、数据不一致、流程断裂），
而非提升覆盖率数字。写每个 testCase 前问自己：**「它在防什么 bug？」**——答不上来的就是覆盖率填充。

### 该测什么

1. **异常路径优先于 happy path**：happy path 只证明「正常能跑」。真 bug 藏在：
   - 非法输入（空值 / null / 越界 / 错误类型）
   - 错误分支（异常处理 / 降级 / 超时）
   - 边界条件（0 / 1 / 最大值 / 空集合 / 单元素）

2. **隐含约定**：代码里没写但「大家以为成立」的规则。例如：
   - 「已 completed 的不可重复完成」——测重复提交同一操作
   - 「回退后旧状态应清空」——测操作→回退→重做后是否有脏数据残留
   - 「分批提交不应丢数据」——测只提交一部分时，已处理的部分是否保留

3. **对称性**：相似功能应该有对称的校验。例如「创建有校验，删除有没有？」「成功路径有守门，失败路径有没有？」

4. **状态累积**：跨步骤的数据流转。例如「步骤 A 改了数据，步骤 B 读到的是新值还是旧值？」

### 不该测什么

- **只复述 happy path 的多个变体**：5 个测试都用正常输入、都断言成功——只证明了同一件事 5 次
- **测语言/框架内置功能**：不需要测「Array.push 能不能加元素」
- **测 mock 的行为**：mock 掉核心逻辑再测，等于什么都没测

### 对照清单

写完 testCases 后逐条核对：每个 case 能否说出它在防什么具体 bug？
如果一组测试「全绿通过」但你对代码的信心没有实质增长，说明它们是覆盖率填充。

## tdd_plan gate 校验

- testCases 非空
- testRunner 必选（mode 合法 + command 或 path 有值）
- mock 层 + real 层各至少 1 个
- **expected.type 必填**（exact / exit_zero / script 三选一）
- exact 模式：text 不可填 passed/ok/success 等结论词（FUZZY_EXPECTED_RE 拦截）
- exit_zero / script 模式：跳过 FUZZY 检查（无 text 字段）
- script 模式：path 必填，resolve 后必须在 workspace 内（沙箱校验，逃逸路径拒绝）
- 环形 dependsOn 检测

gate fail 时返回 mustFix，status 不变（planned），修后重调 cw(tdd_plan)。

## 红灯校验（TDD 核心）

[MANDATORY] 每个测试文件写完后必须跑一次，确认**红灯**（测试因实现不存在而失败）。
如果测试已经 pass（绿灯）= 违反 TDD（先写了实现再补测试），必须回退。

### CW 自动红灯校验

CW 在 tdd_plan gate 通过后自动跑红灯校验（testRunner 必选）：
- 执行 testRunner.command 一次（整体跑），确认 exit code ≠ 0（红灯——实现尚未写，测试应全 fail）
- **红灯校验阻断 status 流转**——绿灯（exit code=0）时 status 回退到 planned，nextAction 指回 tdd_plan retry
- 红灯 pass → status 流转到 pre_dev_verified，结果记录到 gateHistory（gate 名 tdd-red-light）

绿灯 = 你先写了实现再补测试 = 违反 TDD。必须删除实现代码，确保测试在实现缺失时 fail，再提交。

## testRunner 各语言配置示例

### TypeScript + vitest
\`\`\`json
{
  "mode": "nodejs",
  "command": "npx vitest run --reporter=verbose",
  "cwd": "."
}
\`\`\`

### Python + pytest
\`\`\`json
{
  "mode": "python",
  "command": "python -m pytest tests/ -v",
  "cwd": "."
}
\`\`\`

### Java + Maven + JUnit
\`\`\`json
{
  "mode": "java",
  "command": "mvn test -pl .",
  "cwd": "."
}
\`\`\`

### 自定义脚本
\`\`\`json
{
  "mode": "custom",
  "path": ".cw/run-tests.sh"
}
\`\`\`
脚本接收 testCase 信息，执行测试，退出码 0=全部 pass，非 0=有 fail。

## 本阶段禁止

- [禁止] 写实现代码（那是 dev 阶段的事）
- [禁止] 跳过红灯（测试必须先 fail，证明实现还不存在）
- [禁止] 猜 expected 值（从测试断言取）

## 完成标志

test.json 写完且 cw(tdd_plan) gate 通过（status=pre_dev_verified）后，进入 dev 阶段写实现。
`.trim();
