# Issues.md 独立审查报告

## Verdict: APPROVED

issues.md 覆盖充分，无阻断性遗漏/幻象/错配。有几处可优化但不阻断审批。

## 重建结果摘要

按 4 轴独立重建可拆 issue 元素（共 20 项）：

### 状态§5 轴（4 项）
| # | 重建元素 | P 级 | 对应 issues.md |
|---|---------|------|---------------|
| S1 | 状态机零改动搬迁（TRANSITIONS 表原样） | P0 | #1 已覆盖 |
| S2 | Reason 字段正交维度（closed normal/abandoned） | P2 | 上游核验声称已覆盖，实际无独立 issue |
| S3 | 三重 guard 行为不变（checkLinear/PhaseCascade/CacheConsistency） | P0 | #1 已覆盖 |
| S4 | 渐进式 action 支持（dev/test/retrospect progressive=true） | P1 | #7 已覆盖 |

### 模块§7 轴（8 项）
| # | 重建元素 | P 级 | 对应 issues.md |
|---|---------|------|---------------|
| M1 | cli.ts 新建（argv + 路由 + ActionDeps） | P0 | #2 已覆盖 |
| M2 | protocol.ts 新建（参数校验 + 序列化 + exit code） | P0 | #2 已覆盖 |
| M3 | CwParamsSchema 信封下沉到 protocol.ts | P1 | #6 已覆盖 |
| M4 | resolveDbPath 改写（~/.cw/ + CW_HOME） | P0 | #4 已覆盖（标题误导见下方） |
| M5 | StringEnum → typebox Type.Union | P1 | #5 已覆盖 |
| M6 | dispatch + actions/* 搬迁 | P0 | #1 已覆盖 |
| M7 | state-machine + checks + gates 搬迁 | P0 | #1 已覆盖 |
| M8 | store + plan-parser + types 搬迁 | P0 | #1 已覆盖 |

### 边界§8 轴（5 项）
| # | 重建元素 | P 级 | 对应 issues.md |
|---|---------|------|---------------|
| B1 | git 客户-供应商关系（GitValidator 封装） | P1 | #1 已覆盖 |
| B2 | 文件系统客户-供应商关系（node:fs 原子读写） | P1 | #1 已覆盖 |
| B3 | 调用方 agent CLI 协议定义（子进程+JSON stdio） | P0 | #2 已覆盖 |
| B4 | pi 扩展关系解除（数据不迁移） | P0 | #1 已覆盖 |
| B5 | MCP 留后续（D-A 决策） | P3 | #11/#12 迷雾已覆盖 |

### 挑战§10 轴（6 项）
| # | 重建元素 | P 级 | 对应 issues.md |
|---|---------|------|---------------|
| C1 | D-A: 适配层不抽象多 runtime port（D-不可逆） | P3 | #11/#12 已覆盖 |
| C2 | D-002: 存储路径 ~/.cw/ + CW_HOME（D-不可逆） | P0 | #4 已覆盖 |
| C3 | D-001: CLI 协议子命令 + stdin/file（D-不可逆） | P0 | #2/#4 已覆盖 |
| C4 | D-D: 大 JSON 传递机制（stdin 优先 + file fallback） | P0 | #4 已覆盖 |
| C5 | D-005: nextAction.skill 原样透传（D-可逆） | P1 | #2 隐含 |
| C6 | D-F: ADR-029 worktree cwd 防护（D-可逆） | P0 | #4 已覆盖 |

## must_fix（MISSING/PHANTOM/MISMATCH 阻断项）

**无。** issues.md 上游覆盖核验表与重建结果无阻断性差异。

## should_fix

### 1. [K] MISSING: replan action CLI 命令无独立 issue

**类型**: K（可合并到 #1 或 #7）

requirements UC-6 明确定义 `cw replan` 命令（append-only 守卫、status ∈ {planned, developed}）。issues.md 在上游覆盖核验表提到「#1, #7 已覆盖」，但 #1 是 engine 源码搬迁（不涉及 CLI 命令），#7 是渐进式退出语义（不涉及 replan 的 append-only 校验）。建议在 #2 或新增独立 issue 明确 replan CLI 命令的实现边界。

### 2. [K] MISSING: exit code 分层契约独立实现点

**类型**: K（可合并到 #7）

requirements C-1 明确定义 exit code 分层契约（exit 0 = 程序正常，exit ≥1 = 程序错误）。issues.md #7 在方案 A 里提到，但没有作为独立的实现验收点。建议在 #7 的验收标准里明确 exit code 映射表。

### 3. [K] MISMATCH: #4 标题与内容不匹配

**类型**: K（标题误导，内容正确）

issues.md #4 标题是「大 JSON 参数传递机制」，但内容里混合了 worktree 防护和存储路径的讨论。建议拆分或改标题为「存储路径、worktree 防护与大 JSON 传递机制」。

### 4. [K] MISSING: Reason 字段文档标注

**类型**: K（文档级，非代码）

system-architecture §5 明确提到 Reason 字段（closed 终态 normal/abandoned），但 issues.md 上游覆盖核验表写「已覆盖」时没有对应 issue。建议在 #1 的「后置状态」或「验收标准」里标注 Reason 字段维度的存在（文档标注，非实现）。

### 5. [K] MISSING: nextAction.skill 透传作为独立验收点

**类型**: K（可合并到 #2）

D-005 确认 nextAction.skill 原样透传，CLI 不处理。issues.md #2 方案里隐含提及，但没有作为独立验收点。建议在 #2 的验收标准里明确「skill 字段原样透传，不做映射/剥离」。

### 6. [K] MISSING: pi 依赖移除验证脚本

**类型**: K（可合并到 #10 反模式验收清单）

system-architecture §11 第一条反模式是「engine 运行时 import 图无 pi 包」，issues.md #10 讨论反模式验收但没有明确验证脚本的具体实现。建议在 #10 或 #1 的验收标准里明确 `grep -r "@mariozechner\|@earendil-works" src/` 的自动化检查。

## nit

1. **issues.md #4 的方案 C「可配置 worktree-prefix」**：§10 D-F 已确认「泛化留后续」，但 issues.md 把方案 C 列为「不推荐」而非「延后」。建议与 §10 D-F 的「留后续」措辞对齐。

2. **issues.md 上游覆盖核验表的 N/A 列**：§5 Reason 字段行写「已覆盖」但没有对应 issue，N/A 列留空。建议改为「文档标注，非独立 issue」或补充对应 issue 编号。

---

*审查完成时间: 2026-07-10*
*审查依据: system-architecture.md §5/§7/§8/§10 + requirements.md + CONTEXT.md*
