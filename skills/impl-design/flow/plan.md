# 执行计划 — 预检门与 DAG 规划

> 阶段 0+1。输入：一份设计文档绝对路径。产出：用户确认、已基线 commit 的 `<设计文档同名>.impl-plan.md`。

## 阶段 0：预检门 [MANDATORY 不可跳过]

### 0.1 结构完整性

read 设计文档全文，核对四类内容存在（容忍编号漂移，按实质匹配）：

| 必备节 | 用途（缺失即打回） |
|--------|-------------------|
| 背景/目标（§1-2 一带） | 单元验收条款的回溯锚点 |
| 终态/机制（§5-7 一带） | dev 实现的内容来源 |
| 验收场景表（§8 一带） | 双级验收 Gate B 的剧本；无此节无法验收 |
| 下一层拆分表（§10 一带） | 单元切分的种子 |

任一缺失 → 停止，告知用户回 tech-design 流程补文档。本 skill 不接管文档写作。

### 0.2 对抗式审查通过的证据

向用户询问或查找旁路报告（常见 `.review/design-review-*.md`）：

- **有记录且 must_fix == 0** → 通过；把报告路径写进计划
- **有记录但 must_fix > 0** → 停止；列出问题清单，等文档修复后重来
- **从未审查过** → 现场补一轮完整对抗式审查再继续。派发方式按 tech-design 的 `flow/review.md`（agent 名 `tech-design-review`；其 SKILL 与 rubric 的绝对路径从 available_skills 中 tech-design 的 location 解析）。补审后仍 must_fix > 0 → 同样停止

门设在此处的原因：拿未经审查的设计直接开发，问题会在阶段 3 以「设计与实现双重返工」的代价暴露。

## 阶段 1：写执行计划

单元拆分/边界判定/worktree 决策/DAG 画法 → `references/dag-authoring.md`。

产出文件放设计文档同目录：`<basename>.impl-plan.md`，章节固定为：

```markdown
# <名称> 实施计划
基线: <计划 commit hash> | 来源设计: <路径> | 日期: <date>
## 1 目标快照     # 摘录设计 §1 目标 + Out-of-scope，逐字摘录禁止改写
## 2 单元列表
| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离(plain/worktree) | 验收条款 |
# u-foundation 固定为共享契约根节点（类型/接口模块），所有波次起点
## 3 DAG 图       # mermaid
## 4 测试策略     # 测试命令从项目 AGENTS.md / package.json scripts 真实读取；增量与全量分开列
## 5 合理偏差登记表  # 初始为空
## 6 状态表
| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
## 7 残留风险与变更历史
```

### 用户评审 [MANDATORY]

展示 DAG 图与单元表，显式请用户确认三件事：切分粒度是否合理、worktree 标记是否符合预期、验收条款有无遗漏。确认后才能开工——高风险编排，禁止不评审就破土。

### 基线 commit

只 add 计划文档本身（精确路径）→ commit（message 例 `docs(impl-plan): baseline for <name>`）。工作区若有本会话之外的改动一律不碰、不裹挟。

之后的会话中断恢复依赖：基线 hash + 状态表。
