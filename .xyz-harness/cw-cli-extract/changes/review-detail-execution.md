# Execution Plan Review Detail

**审查对象**: execution-plan.md  
**参照文件**: code-architecture.md (§4 时序图 + §6 测试矩阵), issues.md (P级 + blocked_by)  
**审查日期**: 2026-07-10

---

## Verdict: CHANGES_REQUESTED

---

## Wave 依赖核对结果

### DAG 图 vs §4 时序图依赖

| Wave | DAG blocked_by | §8 下游衔接依赖 | 一致性 |
|------|---------------|----------------|--------|
| W1 (create) | 无 | 无 | ✅ |
| W2 (plan) | W1 | Wave 1 | ✅ |
| W3 (dev) | W1 | Wave 1 | ✅ |
| W4 (replan) | W2 | Wave 2 | ✅ |
| W5 (status/list) | W1 | Wave 1 | ✅ |
| W6 (NFR验收) | W1-W5 | Wave 1-5 | ✅ |
| W7 (单测迁移) | W1-W5 | Wave 1-5 | ✅ |

**结论**: DAG 图与 §4 时序图、§8 下游衔接表完全一致。

---

## 测试闭环核对结果（用例 ID 集合比对）

### 来源 A (功能用例)

| UC | code-arch §6 用例 ID | execution-plan 清单用例 ID | 一致性 |
|----|---------------------|---------------------------|--------|
| UC-1 | T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8 | T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8 | ✅ |
| UC-2 | T2.1, T2.2, T2.3, T2.4, T2.5, T2.6 | T2.1, T2.2, T2.3, T2.4, T2.5, T2.6 | ✅ |
| UC-3 | T3.1, T3.2, T3.3, T3.4, T3.5 | T3.1, T3.2, T3.3, T3.4, T3.5 | ✅ |
| UC-6 | T6.1, T6.2, T6.3, T6.4 | T6.1, T6.2, T6.3, T6.4 | ✅ |
| UC-4 | T4.1, T4.2, T4.3, T4.4 | T4.1, T4.2, T4.3, T4.4 | ✅ |

**来源 A 小计**: 27 条，完全一致。

### 来源 B (NFR 用例)

| 缓解项 | code-arch §6 用例 ID | execution-plan 清单用例 ID | 一致性 |
|--------|---------------------|---------------------------|--------|
| typebox 参数校验 | T7.1, T7.2, T7.3 | T7.1, T7.2, T7.3 | ✅ |
| 路径穿越防护 | T7.4, T7.5 | T7.4, T7.5 | ✅ |
| 文件读取边界 | T7.6, T7.7, T7.8 | T7.6, T7.7, T7.8 | ✅ |
| exit code 分层 | T7.9, T7.10 | T7.9, T7.10 | ✅ |
| stderr 输出 | T7.11 | T7.11 | ✅ |

**来源 B 小计**: 11 条，完全一致。

### 总量核验

- code-arch §6 来源 A + 来源 B = 27 + 11 = **38 条**
- execution-plan 清单实际列出 = **38 条**
- execution-plan 文档声称 = **36 条** ← **错误**

**结论**: 用例 ID 集合完全匹配（无遗漏无多余），但文档声称的"36 条"与实际不符。

---

## 测试执行层一致性

### 功能用例测试层

| 用例 | code-arch §6 层 | execution-plan 层 | 一致性 |
|------|----------------|------------------|--------|
| T1.1~T1.7 | mock | unit | ✅ (mock≈unit) |
| T1.8 | mock | e2e | ✅ |
| T2.1~T2.5 | mock | unit | ✅ |
| T2.6 | mock | e2e | ✅ |
| T3.1~T3.4 | mock | unit | ✅ |
| T3.5 | mock | e2e | ✅ |
| T6.1~T6.4 | mock | unit | ✅ |
| T4.1~T4.4 | mock | unit | ✅ |

### NFR 用例测试层

| 用例 | code-arch §6 层 | execution-plan 层 | 一致性 |
|------|----------------|------------------|--------|
| T7.1 | integration | integration | ✅ |
| T7.2 | integration | integration | ✅ |
| T7.3 | integration | integration | ✅ |
| T7.4 | integration | integration | ✅ |
| T7.5 | integration | integration | ✅ |
| T7.6 | integration | integration | ✅ |
| T7.7 | integration | integration | ✅ |
| T7.8 | integration | integration | ✅ |
| T7.9 | integration | integration | ✅ |
| T7.10 | integration | integration | ✅ |
| T7.11 | integration | integration | ✅ |

**结论**: 测试执行层完全一致。

---

## dependsOn 一致性

code-arch §6 未定义 dependsOn 字段，execution-plan 独立定义。审查 execution-plan 的 dependsOn 设置：

| 用例 | dependsOn | 合理性 |
|------|-----------|--------|
| T1.1~T1.7 | — | ✅ 无依赖 |
| T1.8 | T1.1 | ✅ e2e 依赖前置 |
| T2.1~T2.3 | T1.1 | ⚠️ 可疑（见下） |
| T2.4 | T2.1 | ✅ 状态依赖 |
| T2.5 | T2.1 | ✅ 状态依赖 |
| T2.6 | T2.1 | ✅ 功能依赖 |
| T3.1 | T2.1 | ✅ dev 需 plan 完成 |
| T3.2~T3.5 | T3.1 | ✅ 渐进式依赖 |
| T6.1~T6.4 | T3.1 或 T6.1 | ✅ replan 需 dev 完成 |
| T4.1 | T1.1 | ✅ 查询需 topic 存在 |
| T4.2 | — | ✅ 查询不存在 topic |
| T4.3 | T1.1 | ✅ list 需有 topic |
| T4.4 | — | ✅ 空库测试 |
| T7.1 | T1.1 | ⚠️ 可疑（见下） |
| T7.2 | — | ✅ |
| T7.3 | T2.1 | ⚠️ 可疑（见下） |
| T7.4 | — | ✅ |
| T7.5 | — | ✅ |
| T7.6, 3b, 3c | T2.1 | ⚠️ 可疑（见下） |
| T7.9 | T2.2 | ✅ |
| T7.10 | T2.4 | ✅ |
| T7.11 | T2.4 | ✅ |

**可疑依赖分析**:
- T7.1 (无效CLI参数) 依赖 T1.1: 这是参数校验测试，应可独立运行，不依赖 create 成功
- T7.3 (非法JSON) 依赖 T2.1: 这是 JSON 解析测试，应可独立运行
- T7.6/3b/3c (文件读取边界) 依赖 T2.1: 这是文件系统测试，应可独立运行

---

## 并行约束核对

### 并行组统计

| 组 | Waves | 数量 | ≤3 约束 |
|----|-------|------|---------|
| G1 | W2, W3, W5 | 3 | ✅ |
| G2 | W6, W7 | 2 | ✅ |

### 文件冲突检测

**G1 组 (W2, W3, W5 并行)**:

| 文件 | W2 | W3 | W5 | 冲突 |
|------|----|----|----|----|
| `src/engine/dispatch.ts` | ✏️ 修改 | ✏️ 修改 | — | **❌ 冲突** |
| `src/engine/actions/plan.ts` | ✏️ 修改 | — | — | ✅ |
| `src/engine/gates.ts` | ✏️ 修改 | — | — | ✅ |
| `src/engine/plan-parser.ts` | ✏️ 修改 | — | — | ✅ |
| `src/engine/actions/dev.ts` | — | ✏️ 修改 | — | ✅ |
| `src/cli/cli.ts` | — | — | ✏️ 修改 | ✅ |
| `src/engine/store.ts` | — | — | ✏️ 修改 | ✅ |
| `tests/cli-e2e/skeleton.test.ts` | ✏️ 修改 | ✏️ 修改 | ✏️ 修改 | ⚠️ 测试文件 |

**关键发现**: `src/engine/dispatch.ts` 被 W2 和 W3 同时修改，违反"同文件不允许多 Wave 同时修改"约束。

---

## must_fix

### M1: dispatch.ts 文件冲突（阻塞级）

**问题**: W2 (plan子命令) 和 W3 (dev子命令) 都声明修改 `src/engine/dispatch.ts`（W2 填充 handlePlan，W3 填充 handleDev）。两 Wave 在 G1 组并行，违反 execution-plan 自身定义的"同文件不允许多 Wave 同时修改"约束。

**影响**: 并行执行时会产生文件写入冲突，导致其中一个 Wave 的修改丢失或文件损坏。

**建议方案**:
- **方案 A（推荐）**: 将 dispatch.ts 的修改全部移入 W1，W1 负责创建完整的 dispatch 骨架（含所有 action 路由桩），W2/W3/W4 只修改各自 actions/ 文件，不碰 dispatch.ts
- **方案 B**: 将 W3 的 blocked_by 改为 [W1, W2]，使 W3 在 W2 完成后再执行（但降低并行度）

### M2: 测试用例数量声明错误

**问题**: execution-plan 文档声称"闭环要求：清单用例 ID 集合 = ... 36 条"，但实际列出 38 条（27 功能 + 11 NFR）。

**影响**: 文档准确性问题，可能导致验收时遗漏 2 条用例。

**建议**: 将"36 条"修正为"38 条"。

---

## should_fix

### S1: skeleton.test.ts 多 Wave 并行修改

**问题**: W2、W3、W5 都修改 `tests/cli-e2e/skeleton.test.ts`（填充各自测试断言体）。虽然测试文件并行修改风险低于核心源码，但仍存在合并冲突风险。

**建议**: 考虑将 skeleton.test.ts 拆分为多个测试文件（如 `plan.test.ts`, `dev.test.ts`, `status.test.ts`），或明确各 Wave 负责的测试文件行范围。

### S2: NFR 用例过度依赖前置功能用例

**问题**: T7.1, T7.3, T7.6/3b/3c 的 dependsOn 设置可疑。这些是独立的 NFR 测试（参数校验、JSON 解析、文件读取边界），理论上应可独立运行，不需要依赖 T1.1 或 T2.1。

**影响**: 增加测试执行的耦合度，前置用例失败会导致 NFR 测试无法执行，降低测试反馈的独立性。

**建议**: 
- T7.1 (无效CLI参数) dependsOn → —
- T7.3 (非法JSON) dependsOn → —
- T7.6/3b/3c (文件读取边界) dependsOn → —

---

## nit

### N1: Wave 切片类型标注不一致

W6 和 W7 在调度表中标注切片类型为"验收"，但 Wave 详情中未明确标注切片类型。建议统一。

### N2: issues.md 中 #3 和 #4 的编号冲突

issues.md 中 #3 是"存储路径与worktree防护"，#4 是"大JSON传递机制"。但 execution-plan 的 Wave 1 P级覆盖标注为"#1, #2, #3, #5, #6"，Wave 2 标注为"#2, #4, #7"。需要确认 #3 和 #4 的对应关系是否正确（#3→存储路径，#4→JSON传递）。

---

## 审查总结

| 维度 | 结果 |
|------|------|
| Wave 依赖正确性 | ✅ 通过 |
| 测试闭环 | ✅ 通过（数量声明需修正） |
| 测试执行层一致性 | ✅ 通过 |
| dependsOn 一致性 | ⚠️ 有可疑依赖（should_fix） |
| 并行约束 | ❌ 不通过（dispatch.ts 冲突） |

**判定**: **CHANGES_REQUESTED** — 必须先修复 M1 (dispatch.ts 文件冲突)，否则并行执行会失败。
