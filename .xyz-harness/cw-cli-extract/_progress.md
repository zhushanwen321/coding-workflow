---
topic: cw-cli-extract
complexity_tier: L2
created_at: 2026-07-10
---

# 设计进度 — cw-cli-extract（coding-workflow engine 外置化为通用 CLI）

**当前阶段：** mid-plan 完成（clarify gate passed），下一步 mid-detail-plan
**主题目录：** `.xyz-harness/cw-cli-extract/`
**复杂度档位：** L2（范围守门原始打分 20=L3，用户确认收窄为 L2：单形态 CLI 先跑通，MCP/多 runtime 留后续 topic）

## 已完成阶段
| 阶段 | 交付物 | 审查 |
|------|--------|------|
| mid-plan（需求+架构） | requirements.md + system-architecture.md + clarify.json | ✅ clarify gate passed（4 路 reviewer CONVERGED + 机器检查 pass） |

## 下阶段必读
- 下阶段 SKILL：mid-detail-plan（issues + nfr + code-arch + execution-plan）
- 本主题全部上游交付物：requirements.md + system-architecture.md + decisions.md

## 不可推翻的决策
- 直接 read `decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策（D-001~D-004，权威源）

## 范围守门记录
- 8 信号打分：系统数=3、用例数=2、NFR=2、技术选型=3、Wave数=3、领域成熟度=2、状态复杂度=2、跨边界=3，总分 20 → 原始 L3
- 用户决策（ask_user）：收窄范围为单形态 CLI 跑通（MCP/多 runtime 留后续），按 L2 mid 执行
- 收窄依据：core engine 零 pi 耦合已确认可整层复用，真正工作量在 CLI 适配层单点

## mid-plan review 记录
- 4 路 reviewer：需求完整性路 / 架构合理性路 / 禁读重建路 / 红队路
- 初始：架构路 APPROVED，其余 3 路 CHANGES_REQUESTED
- must_fix 8 项全部修复（replan UC 覆盖 / exit code 契约 / 路径结构 / test lite-mid 分歧 / Wave 不变式事实 / schema 序列化搭便车修正 / worktree 守卫 / UC-4 标注）
- CW clarify gate 首次 FAIL（占位符 + Reason 缺失）→ 修后二次 pass
