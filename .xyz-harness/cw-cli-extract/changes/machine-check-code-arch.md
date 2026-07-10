---
phase: code-arch
machine_check: PASS
---

# 机器检查报告 — code-arch

**Verdict:** PASS

| 检查项 | 结果 | 详情 |
|--------|------|------|
| code-architecture.md 存在 | ✅ PASS | /Users/zhushanwen/Code/coding-workflow-workspace/main/.xyz-harness/cw-cli-extract/code-architecture.md |
| frontmatter verdict | ✅ PASS | verdict: pass |
| 关键章节 | ✅ PASS | 全部 4 个必须章节存在 |
| 无占位符 | ✅ PASS | 无未替换占位符 |
| review-code-arch verdict | ✅ PASS | verdict: APPROVED |
| test-matrix 来源 B | ✅ PASS | 含 NFR 风险→用例映射表 |
| 来源 B 用例 ID 映射 | ✅ PASS | 来源 B 行均映射到用例 ID |
| 来源 A 测试层 | ✅ PASS | 来源 A 表含「测试层」列（mock/real） |
| 骨架源文件存在 | ✅ PASS | 10 个源文件 |
| 骨架无占位符/类型逃逸（③） | ✅ PASS | 无 TODO/eslint-disable/any/type:ignore/nolint 等逃逸 |
| god object（>600 行） | ✅ PASS | 最大文件 400 行 |
| 类型检查（tsc） | ✅ PASS | tsc 通过 |
| ②§11 grep pattern | ⏭️ SKIP | ②§11 未提取到带路径作用域的 grep pattern |
| 调用链接线密度（③e） | ✅ PASS | Level 1 接线：1 处注入依赖调用（this./self./receiver. 等，调用链在代码里真实接上） |
| orphan 方法（③f） | ✅ PASS | §3 全部 31 个方法在骨架有定义（无 orphan） |

> ✅ 机器检查全过。可进入 6 维 LLM 审查。