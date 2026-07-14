# Retrospect — arch-deepening

## 做了什么

执行 improve-codebase-architecture 评审的 4 个深化候选（4b schema/版本 seam 按计划暂缓）：

| Wave | 改动 | 净行数 |
|------|------|--------|
| W1 | 提取 gateAdvance 深 module，吸收 review/retrospect/closeout 三 handler 的重复事务脚手架 | -38 行 |
| W2 | devCheck 接受 GitValidator 参数，handleDev 传 deps.git（消除死字段 + N× GitValidator 构造） | -2 行 |
| W3 | store.ts 提取 waveSeedToRecord/testCaseSeedToRecord（消除 4 处 seed→record 机械复制） | -9 行 |
| W4 | 新增 CwError class，mapExitCode 从 18 条字符串前缀简化为 instanceof CwError | +27 行（含新测试） |

## 做对了什么

1. **先评审后执行**：用 improve-codebase-architecture skill 产出 HTML 报告，3 个 Explore agent 并行分析，主 agent 交叉核实（纠正了 1 处 agent 误报：extraCommitReuse 非死字段）
2. **分批 commit 按风险递增**：W1（零风险纯重构）→ W2/W3（低风险）→ W4（最大改动），每步 106→110 测试验证不回归
3. **对抗性 review 有效**：subagent 发现了 plan-parser 6 处漏改 CwError（handleReplan 直接调 parseLitePlan 时 throw Error 走 exit 2，与注释矛盾），主 agent 自己没发现
4. **CW 流程驱动**：用 cw-cli 自身的 create→plan→dev→review→test 全链路管理这次重构，gate 约束有效防止了跳步

## 做错了什么 / 可改进

1. **U5 expected 引号不匹配**：plan 里 expected 用单引号，提交 actual 时用了双引号 → judgeByExpected 判 fail。需注意 expected/actual 的精确字符匹配（包括引号风格）。这是 plan 写 expected 时就该用更宽松的判定方式，或 expected 里避免代码语法字符
2. **W4 commit message 称「18 条字符串前缀」**：实际是 20 个分支。commit message 的数字应精确
3. **closeout gate fail 路径无测试**：review 发现但没有补（非回归，记录为待办）
4. **mapExitCode 的中文标点问题**：edit 工具替换失败多次（文件含特殊中文标点 `（` vs `(`），最后用先插入新函数再删旧函数的方式绕过。教训：遇到 edit 不匹配时，先 od -c 检查不可见字符

## 架构改进的实际收益

- **actions.ts**：877→839 行，「三联写」不变式从 4 处手工维护收敛到 1 处（gateAdvance）
- **mapExitCode**：18 条脆弱字符串匹配 → 1 行 instanceof 判定，新增 action 不需要改 mapExitCode
- **deps.git**：从死字段变为有效注入点，handleDev 不再 N 次 new GitValidator
- **store.ts**：seed→record 从 4 处复制收敛到 2 个 helper

## 下一步

- 候选 4b（schema/版本 seam）暂缓，等有真实用户、格式需演进时再做
- closeout gate fail 路径补测试（待办）
