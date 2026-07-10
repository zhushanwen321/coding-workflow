---
verdict: CONSISTENT
---

# 一致性终检报告 — cw-cli-extract

> 检查时间：2026-07-10
> 检查范围：6 份 deliverable（requirements / system-architecture / issues / non-functional-design / code-architecture / execution-plan）+ decisions.md + CONTEXT.md

## 1. 跨文档矛盾检查

### 1.1 requirements ↔ system-architecture

**结果: PASS**

| 核对项 | requirements | architecture | 一致性 |
|--------|-------------|-------------|--------|
| Aggregate 边界 | CwTopic 含 waves/testCases/gateHistory（§2 UC 定义） | §4 CwTopic 为 aggregate 根，Wave/TestCase 为内部实体 | 一致 |
| 状态机 | 8 态：created→planned/clarified→detailed→developed→tested→retrospected→closed（UC 前置条件隐含） | §5 TRANSITIONS 表完整列出 9 action 的 expectedStatuses/nextStatus | 一致，architecture 补充了 replan 回退语义 |
| 模块划分 | §6 数据流图分 CLI 适配层 / Engine / 基础设施三层 | §6 层级图同样的三层（CLI 适配层 / Engine 核心层 / 基础设施适配） | 一致 |
| Port/Seam | §5 未显式使用 Port 术语 | §6 定义 ActionDeps（真 seam）、CLI 协议（假设 seam）、存储路径解析（真 seam） | 一致，architecture 补充了 seam 判断 |
| exit code 契约 | C-1：exit 0=程序正常（gate pass/fail 均为正常返回），exit ≥1=程序错误 | §10 D-C 确认同契约 | 一致 |
| 存储路径 | D-002：~/.cw/，CW_HOME 覆盖，不迁移 pi 数据 | §10 D-B 完全一致 | 一致 |

### 1.2 system-architecture ↔ issues

**结果: PASS**

| 核对项 | architecture | issues | 一致性 |
|--------|-------------|--------|--------|
| Port 列表 | §6 ActionDeps + CLI 协议边界 + 存储路径解析 | #2 CLI 适配层、#3 存储路径、#8 status/list 边界 | 一致 |
| Seam 判断 | ActionDeps=真 seam；CLI 协议=假设 seam（单实现）；存储路径=纯函数 | #8 方案A 明确 CLI 只读查询不入 engine（保持 engine 边界）；#12 迷雾（MCP 落地时再升格） | 一致 |
| 分层 | 三层：CLI 适配 / Engine 核心 / 基础设施 | #2 方案A 两层结构（cli.ts + protocol.ts）对应 CLI 适配层；#1 方案A 物理拷贝对应 Engine 核心层 | 一致 |
| 反模式清单 | §11 列 8 条反模式验收项 | #10 反模式验收策略（方案A grep 脚本自动化） | 一致 |
| 上游覆盖核验 | — | issues 开头「上游覆盖核验」表逐条映射 architecture §5/§7/§8/§10/§11 | 完整覆盖，无遗漏 |

### 1.3 issues ↔ non-functional-design

**结果: PASS**

| Issue | 已决策方案 | NFR 分析 | 一致性 |
|-------|----------|---------|--------|
| #1 物理拷贝 | 方案A | 安全⚠️（进程沙箱消失）、可观测⚠️（renderSummary 移除）；数据/性能/并发/稳定性/兼容性✅ | 一致 |
| #2 两层结构 | 方案A | 安全⚠️（参数注入）、稳定性⚠️（异常映射）、可观测⚠️（stdout JSON 纯化） | 一致 |
| #3 完整路径+双覆盖 | 方案A | 安全⚠️（路径穿越）、数据⚠️（并发写+迁移策略） | 一致 |
| #4 stdin 优先 | 方案A | 安全⚠️（文件读取）、性能⚠️（JSON 大小限制）、稳定性⚠️（stdin/文件冲突） | 一致 |
| #5 Type.Union | 方案A | 全✅ | 一致 |
| #6 protocol.ts | 方案A | 全✅ | 一致 |
| #7 严格分层 | 方案A | 稳定性⚠️（exit code 语义混淆） | 一致 |
| #8 CLI 只读 | 方案A | 全✅ | 一致 |

所有 P0/P1 issue 的已决策方案均在 NFR 有对应副作用分析，无遗漏。

### 1.4 issues ↔ code-architecture

**结果: PASS**

| Issue | 已决策方案 | code-arch 实现设计 | 一致性 |
|-------|----------|-------------------|--------|
| #1 物理拷贝 | 方案A | §7 现有代码映射表：engine 全部 move，CwParamsSchema 信封拆到 protocol.ts | 一致 |
| #2 两层结构 | 方案A | §1 工程目录：`src/cli/cli.ts` + `src/cli/protocol.ts`；§3 API 契约：parseParams/readJsonInput/validateParams | 一致 |
| #3 存储路径 | 方案A | §3 protocol.ts.resolveDbPath：`~/.cw/<encoded-cwd>/_cw.json`，.cw-wt/ 检测 | 一致 |
| #4 stdin 优先 | 方案A | §3 protocol.ts.readJsonInput：stdin 优先 + 文件 fallback + 冲突报错 | 一致 |
| #5 Type.Union | 方案A | §3 protocol.ts.CwParamsSchema：typebox Type.Object | 一致 |
| #6 信封下沉 | 方案A | §1 `src/cli/protocol.ts` 定义 CwParamsSchema；§7 映射表：从 index.ts move+refactor | 一致 |
| #7 严格分层 | 方案A | §3 cli.ts.mapExitCode：gate fail→0，illegal_transition→1，内部异常→2 | 一致 |
| #8 CLI 只读 | 方案A | §4.5 时序图：cli.ts handleStatus/handleList 直调 store，不经 dispatch | 一致 |

### 1.5 non-functional-design ↔ code-architecture

**结果: PASS**

| NFR 缓解项 | 来源 Issue | code-arch §6 来源 B 对应用例 | 一致性 |
|-----------|----------|---------------------------|--------|
| typebox 参数校验 | #2 安全 | T7.1, T7.2, T7.3 | 一致 |
| 路径穿越防护 | #3 安全 | T7.4, T7.5 | 一致 |
| 文件读取边界 | #4 安全 | T7.6, T7.7, T7.8 | 一致 |
| 数据隔离（per-cwd） | #3 数据 | 由 T7.4 覆盖（encodeCwd 路径校验） | 一致 |
| JSON 大小限制 | #4 性能 | T7.8（超大文件测试） | 一致 |
| exit code 分层契约 | #7 稳定性 | T7.9, T7.10 | 一致 |
| 未捕获异常处理 | #2 稳定性 | 由 T7.9/T7.10 覆盖（exit code 映射） | 一致 |
| stderr 错误输出 | #2 可观测性 | T7.11 | 一致 |
| stdout JSON 纯化 | #2 可观测性 | 由 T7.9 覆盖（gate fail 时 stdout 仍为 JSON） | 一致 |

NFR 缓解项回灌登记表 9 项均有对应用例，无遗漏。

### 1.6 code-architecture ↔ execution-plan

**结果: PASS**

**Wave 依赖与 §4 时序图一致性：**

| 时序图（code-arch §4） | 对应 Wave | dependsOn | 一致性 |
|----------------------|---------|-----------|--------|
| §4.1 UC-1 create | W1 | 无 | 一致 |
| §4.2 UC-2 plan | W2 | W1 | 一致 |
| §4.3 UC-3 dev | W3 | W1 | 一致 |
| §4.4 UC-6 replan | W4 | W2 | 一致（replan 需 plan 先工作） |
| §4.5 UC-4 status/list | W5 | W1 | 一致 |
| NFR 测试 | W6 | W1-W5 | 一致（验收 Wave blocked by 全部功能 Wave） |
| 等价验证 | W7 | W1-W5 | 一致 |

**test-matrix 用例 ID 集合一致性：**

code-arch §6 来源 A 功能用例（27 条）：
T1.1~T1.8, T2.1~T2.6, T3.1~T3.5, T6.1~T6.4, T4.1~T4.4

code-arch §6 来源 B NFR 用例（11 条）：
T7.1, T7.2, T7.3, T7.4, T7.5, T7.6, T7.7, T7.8, T7.9, T7.10, T7.11

**合计：38 条**

execution-plan 测试验收清单（38 条）：
T1.1~T1.8(8), T2.1~T2.6(6), T3.1~T3.5(5), T6.1~T6.4(4), T4.1~T4.4(4), T7.1/1b/1c/2/2b/3/3b/3c/4/4b/5(11)

**ID 集合完全一致，38 = 38，无遗漏无多余。**

## 2. decisions.md 一致性

| ID | 决策 | status | requirements 溯源 | architecture 溯源 | issues 溯源 | NFR 溯源 | code-arch 溯源 | execution 溯源 |
|----|------|--------|------------------|-------------------|-----------|---------|---------------|---------------|
| D-001 | CLI 协议子命令 + stdin/--xxx-file | confirmed | C-1, F2, F3 | §10 D-C/D | #2 方案A, #4 方案A | #2 安全/可观测, #4 性能/稳定性 | §3 readJsonInput | W2 test-matrix |
| D-002 | 存储路径 ~/.cw/ | confirmed | F5 | §10 D-B | #3 方案A | #3 安全/数据 | §3 resolveDbPath | W1 test-matrix |
| D-003 | 独立 npm 包 bin=cw | confirmed | §7 决策记录 | §7 模块划分 | #1 方案A（隐含） | — | §1 package.json | W1 文件影响 |
| D-004 | engine 单测原样 + CLI e2e | confirmed | UC-5, G3 | — | #9 方案A | — | §6 test-matrix | W7 |
| D-005 | nextAction.skill 透传 | confirmed | — | §10 D-E | — | — | — | — |
| D-006 | ADR-029 worktree 防护 | confirmed | C-3 | §10 D-F | #3 方案A（隐含 .cw-wt/） | #3 安全 | §3 resolveDbPath .cw-wt/ 检测 | W1 T7.5 |

**6 条 confirmed 决策均在对应 .md 中有真实章节，无孤立决策。**

注：D-005（skill 透传）属 D-可逆类决策，影响范围仅限协议层透传行为，在 code-arch/execution 中无需专门章节（CLI 不额外处理 skill，无代码变更），一致。

## 3. 测试闭环

**验收清单用例 ID 集合比对：**

```
code-arch §6 来源 A (功能): T1.1 T1.2 T1.3 T1.4 T1.5 T1.6 T1.7 T1.8
                             T2.1 T2.2 T2.3 T2.4 T2.5 T2.6
                             T3.1 T3.2 T3.3 T3.4 T3.5
                             T6.1 T6.2 T6.3 T6.4
                             T4.1 T4.2 T4.3 T4.4
                             = 27 条

code-arch §6 来源 B (NFR):  T7.1 T7.2 T7.3
                             T7.4 T7.5
                             T7.6 T7.7 T7.8
                             T7.9 T7.10
                             T7.11
                             = 11 条

来源 A + 来源 B 合计: 38 条

execution-plan 测试验收清单: 38 条

差集: ∅（空集）
```

**结论：用例 ID 集合完全一致，测试闭环成立。**

## 4. 反哺处理

各 deliverable frontmatter `backfed_from` 字段均为空数组 `[]`。文档正文中无 `[BACKFED]` 标记残留。

**结论：无待修订的反哺项。**

## 结论

**CONSISTENT**

6 份 deliverable + decisions.md 之间无跨文档矛盾：
- 12 对核对项全部 PASS
- 6 条 confirmed 决策均可溯源到对应 .md 章节
- 测试闭环成立（38 条用例 ID 集合 = 来源 A + B 全量）
- 无待修订的反哺项
