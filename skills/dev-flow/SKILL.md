---
name: dev-flow
description: >-
  Use when 一份已通过对抗式审查的技术设计文档（tech-design 产出）需要落地为可运行代码。
  触发短语：「按设计文档开发」「实施这个设计」「按设计实现」「设计已经好了，开始开发」「根据 design doc 写代码」。
  Not for 编写或审查设计文档本身（用 tech-design）；结构化 topic/unit 台账式开发（用 cw-cli / coding-workflow）；
  无设计文档的 bug 修复、小改动（直接编码）；只出计划不写代码（用 lite-plan）。
---

# dev-flow

把通过对抗式审查的设计文档变成已验收的代码——主 agent 只调度，subagent 完成全部开发与验收。

**首次进入 → read `flow/plan.md`。**

## 核心原则

1. **编排者零编码**：主 agent 只做规划、派发、验证、commit、状态记录；一切 src/tests 编写修改走 subagent
2. **门只认证据**：阶段推进只承认命令输出、diff、逐行签收清单；无证据的「已完成」一律退回
3. **领地锁定**：subagent 只允许改计划中白名单内的文件；发现领地外必改时停下上报，禁止顺手改
4. **git 单点**：subagent 禁止一切 git 写操作；只有主 agent 在核验通过后按精确路径 `git add`，禁 `-A`/`.`
5. **基线先行**：计划文档 commit 基线后才可派发；流转前主 agent 核对属地区间 diff 干净

## 流水线六阶段

| 阶段 | 产物 | 推进门（gate） |
|------|------|----------------|
| 0 预检 | 设计文档可用性确认 | 结构四节齐全 + 对抗式审查 must_fix==0 证据 |
| 1 执行计划 | `<同名>.impl-plan.md`（DAG+单元表+状态表） | 用户评审确认后基线 commit |
| 2 开发循环 | 各单元 committed | 属地 diff 干净 + 测试真实跑绿 |
| 3 一致性审查 | 合理/不合理偏差清单 | 每条结论带 file:line 证据 |
| 4 修复循环 | unreasonable 与 doc_errors 清零 | 定向复审（只审影响面）收敛 |
| 5 双级验收 | 全量测试绿 + §8 场景逐行签收 | Gate A 与 Gate B 双绿 |

## 路由

| 用户意图 | read |
|----------|------|
| 开始实施（拿到设计文档路径）/ 中断后恢复 | `flow/plan.md`（恢复走其末尾「状态恢复」节） |
| 计划就绪，派发开发单元 / 循环中途卡住 | `flow/execute.md` |
| 全部单元完成，开始一致性审查与修复 | `flow/consistency-review.md` |
| 进入测试与端到端验收 | `flow/acceptance.md` |
| 单元怎么拆 / 并行串行怎么判 / worktree 要不要开 / DAG 怎么画 | `references/dag-authoring.md` |

## 关键约束

- [MANDATORY] 派发遵守全局 AGENTS.md 的 subagent 约束：并发 ≤5；模型按全局路由表选、thinking max；task 三段式（背景/目标/验收）。环境中看不到指定模型时列出实际可见项请用户选择
- [MANDATORY] 数字阈值：同一单元 dev→fix 超 2 轮未绿即冻结升级用户；一致性审查累计 ≥3 轮未收敛即暂停升级。两种情况都禁止自行突破或无声放弃
- [MANDATORY] 收尾阶段跑全量测试套件（项目收尾场景）；单元开发期内增量测试即可
- [MANDATORY] 偏差三分类处理：合理不一致 → 计划登记表固化（必要时同步设计文档措辞）；不合理偏差 → 打回 dev 修；doc_errors → 主 agent 改设计文档并记变更历史
- [OPTIONAL] 高风险大单元可开 worktree 隔离（判据见 dag-authoring），建/并优先项目既有工具；subagent 零 git 不变量不变

## 状态恢复

进度唯一事实源 = 计划文档内「状态表」。中断恢复时以 git log 与工作区实际文件校准之，表项冲突以实物为准；无 committed 证据的一律按 pending 重算。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则 | 本 skill 暂无；一旦标记不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
