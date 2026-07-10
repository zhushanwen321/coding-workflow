---
verdict: pass
phase: closeout
---

# ARCHIVED — cw-cli-extract

## 沉淀去向清单

本 topic 的设计沉淀已归档到以下长期文档：

| 沉淀文档 | 去向 | 说明 |
----------|------|------|
| CONTEXT.md | `CONTEXT.md`（项目根） | 统一语言 + 项目背景，已含 [from: cw-cli-extract] |
| ARCHITECTURE.md | `.xyz-harness/cw-cli-extract/system-architecture.md` | 系统架构（3 层 + 数据流 + 状态机），待合并到项目 ARCHITECTURE.md |
| NFR.md | `.xyz-harness/cw-cli-extract/non-functional-design.md` | 7 维度 NFR 分析 |
| TEST-STRATEGY.md | `.xyz-harness/cw-cli-extract/code-architecture.md` §6 | 测试矩阵 39 用例（来源 A + 来源 B） |

### 其他设计交付物（topic 内归档）

| 交付物 | 去向 | 说明 |
|--------|------|------|
| requirements.md | `.xyz-harness/cw-cli-extract/requirements.md` | 需求文档（6 UC + 11 NFR 维度） |
| system-architecture.md | `.xyz-harness/cw-cli-extract/system-architecture.md` | 系统架构（3 层 + 数据流 + 状态机） |
| issues.md | `.xyz-harness/cw-cli-extract/issues.md` | 13 个 issue（P0×4 / P1×4 / P2×2 / P3×3） |
| code-architecture.md | `.xyz-harness/cw-cli-extract/code-architecture.md` | API 契约 + 时序图 + 测试矩阵（39 用例） |
| non-functional-design.md | `.xyz-harness/cw-cli-extract/non-functional-design.md` | 7 维度 NFR 分析 |
| execution-plan.md | `.xyz-harness/cw-cli-extract/execution-plan.md` | 7 Wave 编排 + 39 测试验收清单 |
| decisions.md | `.xyz-harness/cw-cli-extract/decisions.md` | D-001~D-006 决策记录 |
| retrospect.md | `.xyz-harness/cw-cli-extract/changes/retrospect.md` | 执行复盘 |
| src/ | `src/cli/` + `src/engine/` | CLI 入口 + engine 核心（28 源文件） |
| tests/ | `tests/cli-e2e/` + `tests/engine/` | 13 测试文件，184 tests |
