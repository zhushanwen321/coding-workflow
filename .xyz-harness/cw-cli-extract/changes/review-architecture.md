---
verdict: APPROVED
slug: architecture
topic: cw-cli-extract
phase: mid-plan
merged_from:
  - review-mid-plan-architecture.md（架构合理性+边界路，初始 APPROVED，0 must_fix）
  - review-mid-plan-redteam.md（红队·反过度设计路，初始 CHANGES_REQUESTED，2 must_fix）
review_round: 1
route_count: 2
must_fix_status: all_resolved
---

# review-architecture.md — CW clarify gate 面向文件

> 合并架构合理性路 + 红队的 review 结论。架构路初始 APPROVED（0 must_fix），
> 红队初始 CHANGES_REQUESTED（2 must_fix，均为搭便车清单事实错误）。
> 主 agent 已全部修复 → verdict: APPROVED。

## 核心验证结论（两路共识）

架构主线经源码 5 文件交叉验证成立，无结构性缺陷：
- **状态机**：§5 转换表 9 行 vs state-machine.ts TRANSITIONS 逐行 1:1 一致
- **D-A deletion test 通过**：dispatch(CwParams,ActionDeps)→ActionResult 是真 seam，CLI 协议边界当前不抽象为 interface 判断正确
- **依赖边界**：grep 确认 pi import 仅在 index.ts adapter 层，engine 核心 0 命中
- **模型完整性**：CwTopic 聚合根 + Wave/TestCase 内实体不变式正确（Wave 不变式事实错误已修正）

## must_fix（已全部解决）

| # | 来源路 | 类型 | 问题 | 修复 |
|---|--------|------|------|------|
| M1 | 架构路 should_fix + 红队 M1 | 伪需求 | schema 下沉搭便车与源码不符（业务 schema 已在 plan-parser 单源） | ✅ 搭便车改为「CwParamsSchema 信封下沉到 protocol.ts」（业务 schema 无需动）+ §11 grep 修正 |
| M2 | 红队 M2 | 夸大 | 序列化搭便车夸大（ActionResult 本是结构化对象，JSON.stringify 即可） | ✅ 搭便车改为「CLI 输出=JSON.stringify(ActionResult)，renderSummary 不迁移」 |

## should_fix（已采纳，不阻断）

| # | 来源路 | 处理 |
|---|--------|------|
| Wave 不变式「(除非 replan)」事实错误 | 重建路 S3 | ✅ 改为「committed 不变；replan 为 append-only，已 committed 不可删改」 |
| ADR-029 worktree 守卫去向未交代 | 架构路 + 需求路 | ✅ §10 新增 D-F（继承防御）+ decisions D-006 |
| §6 CLI 协议 Port 命名矛盾 | 架构路 nit | ✅ 改名「CLI 协议边界（非 interface port）」 |
| §8 git 关系标签不一致 | 重建路 N1 | ✅ 统一为「客户-供应商」 |
| §11 grep 补 StringEnum/exit code/worktree | 架构路 nit | ✅ 追加 3 条 grep 验收项 |

## 红队 deletion test 结论（参考）

红队建议删 §4 classDiagram / §5 转换表 / §9 泳道图（搬迁复述噪音）。**不删**——这些是 architecture deliverable 模板必备章节，删了 CW gate 机器检查会判缺章节。保留但内部已压缩（转换表标注「搬迁不变，见 state-machine.ts」）。

## 溯源

- 架构合理性路报告：`changes/review-mid-plan-architecture.md`
- 红队报告：`changes/review-mid-plan-redteam.md`
