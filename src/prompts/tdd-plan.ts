/**
 * tdd-plan 提示词 — dev-plan gate 通过后 / tdd-plan gate fail retry 时返回。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan 分支（gate pass）和 tdd_plan 分支（retry）。
 * 交付物：test.json（testCases + 可选 testRunner），由 cw tdd_plan 消费。
 *
 * 本阶段核心：agent 已知要实现什么（dev-plan.json 的 waves），先写测试代码（红灯），
 * 再写 test.json 定义 testCases + expected。expected 来源于测试断言，不是猜的。
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
      "expected": { "text": "<预期结果>" },
      "executor": "<vitest|pytest|junit|shell|custom>",
      "redCheck": true,
      "requiresScreenshot": false,
      "dependsOn": []
    },
    {
      "id": "E1",
      "layer": "real",
      "priority": "P1",
      "scenario": "<集成场景>",
      "steps": "<怎么测>",
      "expected": { "text": "<预期结果>" },
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
- **expected**: 机器判定基准。expected.text 会被 CW 做**精确字符串比较**（===），不是给人看的描述
  - 正确："text": "2"、"text": '{"status":"ok"}'
  - 错误："text": "返回正确结果"、"text": "passed"（gate 拒绝模糊值）
- **executor**: 谁跑这个测试（vitest / pytest / junit / shell / custom）
- **redCheck**: tdd_plan 阶段是否对此 case 做红灯校验
  - mock 层通常 true（纯逻辑，可立即跑）
  - real 层通常 false（需环境，tdd_plan 时跑不了）
- **requiresScreenshot**: 是否要求截图（mock 层 false，real 层视用例需要）
- **dependsOn**: 测试调度依赖（前置 case 先通过）

### testRunner（可选）

定义项目级测试执行策略。不配置时 agent 自己跑测试后提交 actual（agent 模式）。

| mode | command 示例 | 适用 |
|------|------------|------|
| nodejs | "npx vitest run" | Node.js 生态（vitest/jest/mocha） |
| python | "python -m pytest" | Python 生态（pytest/unittest） |
| java | "mvn test" | Java 生态（JUnit/TestNG/Maven） |
| custom | path: ".cw/run-tests.sh" | 自定义脚本（任何语言/框架） |

## expected 撰写规范（重要）

expected.text 会被 CW engine 做**精确字符串比较**（===），不是给人看的描述，是机器判定基准。

agent 先写了测试代码（如 \`expect(add(1,1)).toBe(2)\`），expected 直接从测试断言取值：
- 测试断言 \`.toBe(2)\` → expected: \`{ "text": "2" }\`
- 测试断言 \`.toBe("hello")\` → expected: \`{ "text": "hello" }\`

不要猜输出值——从你写的测试断言里取。这就是 tdd_plan 阶段的价值：expected 有据可依。

## tdd_plan gate 校验

- testCases 非空
- mock 层 + real 层各至少 1 个
- expected.text 不可填 passed/ok/success 等结论词
- 环形 dependsOn 检测

gate fail 时返回 mustFix，status 不变（planned），修后重调 cw(tdd_plan)。

## 红灯校验（TDD 核心）

[MANDATORY] 每个测试文件写完后必须跑一次，确认**红灯**（测试因实现不存在而失败）。
如果测试已经 pass（绿灯）= 违反 TDD（先写了实现再补测试），必须回退。

redCheck=true 的 case，CW 会在后续版本自动跑红灯校验（exit code ≠ 0 确认红灯）。
当前版本红灯校验由 agent 自行执行（跑测试确认 fail），CW 只做结构校验。

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

test.json 写完且 cw(tdd_plan) gate 通过（status=tdd_inited）后，进入 dev 阶段写实现。
`.trim();
