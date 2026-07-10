---
verdict: APPROVED
slug: clarity
topic: cw-cli-extract
phase: mid-plan
merged_from:
  - review-mid-plan-requirements.md（需求完整性路，初始 CHANGES_REQUESTED，3 must_fix）
  - review-mid-plan-rebuild.md（禁读重建路，初始 CHANGES_REQUESTED，1 must_fix）
review_round: 1
route_count: 2
must_fix_status: all_resolved
---

# review-clarity.md — CW clarify gate 面向文件

> 合并需求完整性路 + 禁读重建路的 review 结论。两路初始均 CHANGES_REQUESTED，
> 共 4 项 must_fix（去重后），主 agent 已全部修复（见 must_fix 章节的 resolved 标注）。
> 修复后无残留阻断项 → verdict: APPROVED。

## must_fix（已全部解决）

| # | 来源路 | 类型 | 问题 | 修复 |
|---|--------|------|------|------|
| M1 | 需求路 + 重建路 | MISSING/K | replan action 全程缺席 requirements（违反 G1「全部 action 可触发」） | ✅ 新增 UC-6（replan append-only）+ F8 + AC-5.3（replan e2e）+ AC-6.1~6.3 |
| M2 | 需求路 | D-可逆 | exit code 契约未定义（gate-fail 和 illegal_transition 都非零，无法区分） | ✅ AC-2.4 定义分层契约（exit 0=正常含JSON / ≥1=程序错误+stderr）+ 约束 C-1 |
| M3 | 需求路 | D-可逆 | _cw.json 完整路径未指定（encoded-cwd 子目录是 multi-workspace 关键）+ UC-4 前置条件事实错误 | ✅ 约束 C-2 明确 `$CW_HOME/<encoded-cwd>/_cw.json` + UC-4 前置条件修正 |

## should_fix（已采纳，不阻断）

| # | 来源路 | 处理 |
|---|--------|------|
| test lite/mid 分歧 AC 未体现 | 重建路 S2 | ✅ AC-3.3/3.4 补 lite（judgeByExpected+screenshot）/mid（commitHash+claimedStatus）分支 |
| UC-4 status/list 是 CLI 新增非 engine action | 红队 S6 + 重建路 S1 | ✅ UC-4 标注「CLI 新增便利命令，非 G3 等价范围」+ F10 |
| worktree cwd 防护未继承 | 需求路 S3 + 重建路 S4 | ✅ 约束 C-3 + architecture D-F + decisions D-006 |
| mid 集成测试残留风险 | 需求路 S7 | ✅ AC-5.4 风险登记 |
| StringEnum 解耦点 | 需求路 S4 | ✅ F9 + architecture §11 grep 补替换指引 |

## 溯源

- 需求完整性路报告：`changes/review-mid-plan-requirements.md`
- 禁读重建路报告：`changes/review-mid-plan-rebuild.md`
