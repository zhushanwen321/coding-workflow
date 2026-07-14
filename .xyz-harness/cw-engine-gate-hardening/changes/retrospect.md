---
verdict: pass
phase: retrospect
---

# 复盘 — cw-engine-gate-hardening

## 执行摘要

强化 cw-cli engine gate 硬强制层，覆盖 5 个 Wave：plan 结构校验加强（环检测+测试分层）、commitHash 唯一性 warning、新增 review action、replan 放开 tested/reviewed、配套 prompt 强化。106/106 测试通过。

## 做得好的

- **engine + prompt 成对原则贯穿全程**：每个事后 engine 校验（环检测、测试分层、commitHash 重复、replan 状态）都配了事前 prompt 强化（PLAN_PROMPT、EXECUTE_PROMPT COMMIT_DISCIPLINE、REVIEW_PROMPT）。不是孤立的 engine 改动
- **commit 拓扑分析到位**：用户提了"并行 subagent 各自 worktree commit 不在同一线性链"的边界。分析后确认 isAncestorOfAny 会误判并行 commit，改为只做 commitHash 唯一性 warning（不阻断），配合 prompt 事前预防。没有盲目上 DAG 校验
- **review action 一次到位**：6 个源文件 + 3 个测试文件的改动，build + test 一次通过（subagent 协助适配既有测试）

## 出过的问题

### 1. 测试分层 hard fail 的连锁影响（预估不足）

- **现象**：planCheck 加测试分层后，20 个既有测试红——它们的 planJson 只有 mock 层
- **根因**：既有测试的 `makeValidPlanJson` / `makePlanJson` helper 默认只有 1 个 mock testCase，测试分层 hard fail 后全部触发
- **修复**：更新所有 helper 默认含 mock+real 两层，inline plan 也逐个补 real 层。用了 2 个 subagent 批量处理 dispatch.test.ts 和 e2e.test.ts
- **教训**：hard fail 类的 gate 加强，影响面是所有"用最小合法 plan"的测试。设计时应预估"既有测试的最小 plan 是否满足新约束"

### 2. EXECUTE_PROMPT 模板字符串内的反引号冲突

- **现象**：build 报 `',' expected` 语法错误
- **根因**：EXECUTE_PROMPT 是反引号包裹的模板字符串，内部文本里写了 `` `cw replan` ``（带反引号），被解析为模板字符串结束
- **修复**：去掉内部反引号
- **教训**：模板字符串内的 prompt 文本不能用反引号包裹代码引用，要么转义 `` \` ``，要么不用反引号

### 3. subagent 改动量超出预期

- **现象**：review 状态机适配的 subagent 用了 43 次工具调用
- **根因**：3 个文件的多处 setup 都需要加 review gate pass 步骤，改动点分散
- **修复**：结果正确，但效率低。这类机械式批量改动更适合给 subagent 更精确的 diff 指令

## 验证证据

- `npm run build`（tsc）：通过
- `npm run check`（tsc --noEmit）：通过
- `npm test`：106/106 passed
- CW test gate：12/12 testCase passed
