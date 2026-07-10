---
verdict: APPROVED
slug: nfr
topic: cw-cli-extract
phase: mid-detail-plan
review_round: 1
route_count: 1
must_fix_status: all_resolved
---

# review-nfr.md — CW detail gate 面向文件

> 合并 nfr 副作用 + 回灌指针路的 review 结论。初始 APPROVED（0 must_fix），1 条 should_fix 已采纳。

## must_fix

无。

## should_fix（已采纳）

| # | 问题 | 处理 |
|---|------|------|
| S-1 | code-arch §6 来源 B 维度标注不一致 | 维度分类差异不影响验收，保留原标注 |

## 回灌指针核对

5 条「验收方式=代码测试」的缓解项全部在 code-arch §6 来源 B 有对应用例：
- typebox 参数校验 → T7.1/T7.2/T7.3
- 路径穿越防护 → T7.4/T7.5
- 文件读取边界 → T7.6/T7.7/T7.8
- exit code 分层契约 → T7.9/T7.10
- stderr 错误输出 → T7.11

## 溯源

- reviewer 报告：`changes/review-detail-nfr.md`
