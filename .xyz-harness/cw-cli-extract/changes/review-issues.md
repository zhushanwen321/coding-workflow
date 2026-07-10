---
verdict: APPROVED
slug: issues
topic: cw-cli-extract
phase: mid-detail-plan
review_round: 1
route_count: 1
must_fix_status: all_resolved
---

# review-issues.md — CW detail gate 面向文件

> 合并 issues 覆盖重建路的 review 结论。初始 APPROVED（0 must_fix），6 条 should_fix 均已采纳。

## must_fix

无。

## should_fix（已采纳）

| # | 问题 | 处理 |
|---|------|------|
| 1 | replan CLI 命令无独立 issue | 已在 execution-plan W4 明确覆盖 |
| 2 | exit code 分层契约独立验收点 | 已在 code-arch §3 mapExitCode 签名 + §6 T7.9/T7.10 覆盖 |
| 3 | #4 标题与内容不匹配 | 标题保持，内容已在 issues.md 正文明确拆分 |
| 4 | Reason 字段文档标注 | 已在 system-architecture §5 补充 Reason 字段说明 |
| 5 | nextAction.skill 透传验收点 | 已在 code-arch §3 dispatch 签名（skill 字段透传）覆盖 |
| 6 | pi 依赖移除验证脚本 | 已在 execution-plan W6 + scripts/verify-anti-patterns.sh 覆盖 |

## 溯源

- reviewer 报告：`changes/review-detail-issues.md`
