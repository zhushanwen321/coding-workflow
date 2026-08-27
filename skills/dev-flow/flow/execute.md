# 开发循环 — 编排者派发

> 阶段 2。输入：已基线 commit 的实施计划。不变量：subagent 零 git；主 agent 零编码；每个单元双锁——领地 diff 干净 + 测试真实跑绿。

## dev 角色的生成方式

不依赖专门注册的全局 agent：调 subagent 工具时省略 agent 参数（默认 general-purpose，继承项目上下文），行为指令全部由 task 内嵌。thinking=max；模型按全局 AGENTS.md 路由表选（常规编码用表中的简单档）。

会话策略：host 支持 subagent 会话保持时，dev 以会话保持模式启动，存活覆盖本单位 committed 及后续修复轮；轮空间隔超时自动失效不算异常，走下方接替程序。不支持会话保持的环境每次现启现收。
接替程序（原 dev 不可用时的第一等路径，非兜底）：补派新 dev，task 附前任证据包 = 计划状态表中该单位最后一轮 files_changed/test_evidence/deviations + 当前 `git diff --stat` 输出，令其先核验现状再续作。

## 八步循环

1. **算就绪集**：read 计划状态表，所有前驱单元 committed 的单元为就绪
2. **分波**：就绪集按领地互斥分组为波（同波 ≤5 个）；worktree 单元单独一波处理
3. **派发**：task 三段式模板——

```text
背景：项目根 <cwd>。你是 unit <id> 的开发执行者。开工前依次 read：
  实施计划 <绝对路径>：「0 章节映射」（确定设计文档定位坐标）、单元列表中本单元的职责/领地/验收条款
  设计文档 <绝对路径> 的 <映射表中「终态/机制」对应的实际节>
  项目 AGENTS.md（编码规范、测试框架与命令约定）
目标：完成「职责」并逐条达成「验收条款」。测试要求：
  增量测试覆盖所改模块，命令按计划 §4 执行；
  验收条款每条要么有代码级断言覆盖，要么给出可复现的演示步骤。
验收（按此结构返回结果）：
{status, files_changed:[精确路径], test_evidence:"命令+真实输出关键行",
 deviations:[与设计的偏离点+原因], blockers:[无法继续的原因]}
宿主无 structured-output 工具时，在回复中用 ```json 代码块返回同构对象；
解析失败视同本次汇报无效，打回重报。
约束：
- 只允许修改领地清单内的文件；发现必须动领地外 → 不动手，写进 blockers 说明
- 禁止一切 git 写操作（add/commit/checkout/stash 全部禁止）
- 构建的临时脚本/探针收尾前清理，不得遗留仓库
- deviations 为强制字段，无偏离填空数组；静默偏差一经发现按返工计
```

4. **接收后硬核验 [MANDATORY 每单元]**（防假完成的唯一闸口）：
   - `git status --short` + `git diff --stat` 核对改动文件集合 == files_changed 且 ⊆ 领地
   - 重跑其核心测试命令至少 1 次，确认输出与 test_evidence 相符
   - 有疑点 → 打回重验；允许通过的测试类文件（fixture 等）须能解释归属
5. **流转 commit**：核验过 → 主 agent 按 files_changed 清单 + 计划文档精确 add → commit（英文 message 含 unit id、对应设计章节、测试结论一行）。同步更新状态表
6. **失败打回**：原 dev 会话仍存活则续聊定向修（贴 diff/失败输出/违反条款）；否则走「接替程序」。轮次 +1；超 2 轮未绿 → 冻结该单元，升级用户（附已尝试方案清单）
7. **波间推进**：整波 committed 才开下一波
8. **循环至状态表全 committed** → 转入 `flow/consistency-review.md`

## worktree 单元的差异

派发 cwd = 该 worktree 绝对目录；核验、commit 都在该 worktree 内由主 agent 完成；合并回工作分支的操作与时机遵循项目既有约定——无既定约定时用原生 `git merge --no-ff`，何时合并拿不定则先问用户。集成性质的下游单元必须在合并完成后才能开工。

## 中断恢复

回到第 1 步。以 git log 与工作区实物校准状态表（无 commit 证据=未完成），再继续派发。
