---
verdict: APPROVED
slug: code-arch
topic: cw-cli-extract
phase: mid-detail-plan
review_round: 1
route_count: 1
must_fix_status: all_resolved
---

# review-code-arch.md — CW detail gate 面向文件

> 合并 code 契约 + test-matrix 禁读重建路的 review 结论。初始 CHANGES_REQUESTED（2 must_fix），已全部修复。

## must_fix（已全部解决）

| # | 问题 | 修复 |
|---|------|------|
| M-1 | §6 MISSING: git ENOENT 用例完全遗漏 | ✅ 新增 T3.6（异常/integration/git 可执行文件缺失/throw ENOENT） |
| M-2 | §9 骨架覆盖表遗漏 3 个方法 | ✅ 新增 mapExitCode + dispatch + readJsonInput 三行 |

## should_fix（已采纳）

| # | 问题 | 处理 |
|---|------|------|
| S-1 | readJsonInput 签名不一致（2参 vs 3参） | ✅ §3 签名改为 3 参数（+isStdinTTY） |
| S-2 | §4.2 时序图 readJsonInput 调用缺 isStdinTTY | ✅ 已补充第三参数 |
| S-3 | T1.4/T1.7 来源标注为时序图推导 | 来源标注差异不影响验收 |
| S-4 | T3.x 全标 mock 无法覆盖 git infra error | ✅ T3.6 标 integration |

## 骨架覆盖核验

§3 签名表 33 个方法全部在骨架有对应定义，接线状态标注准确。

## 溯源

- reviewer 报告：`changes/review-detail-code-arch.md`
