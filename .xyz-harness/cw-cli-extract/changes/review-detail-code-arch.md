# Review Detail: code-architecture.md — 测试矩阵独立重建 + 骨架覆盖核验

> Reviewer: independent（禁读 §6，从 §4 时序图 alt/else + NFR 回灌表独立重建）
> 决策账本：D-001~D-006 已确认，不得当 gap 重报

## Verdict: CHANGES_REQUESTED

---

## 重建测试用例摘要

从 §4 时序图 5 个 UC 的 alt/else 分支 + NFR 回灌表独立推导，共重建 **15 条功能用例 + 11 条 NFR 用例 = 26 条**。

### 来源 A：功能用例（时序图 alt/else 推导）

| 重建 ID | UC | 类型 | 测试层 | 场景 | 推导自 |
|---------|-----|------|--------|------|--------|
| R-1.1 | UC-1 | 正常 | unit | create lite → topicId + status=created + nextAction=plan | §4.1 主路径 |
| R-1.2 | UC-1 | 正常 | unit | create mid → nextAction=clarify | §4.1 主路径 |
| R-1.3 | UC-1 | 边界 | unit | slug 含特殊字符 a-b_1 → 成功 | §4.1 边界条件 |
| R-1.4 | UC-1 | 异常 | unit | slug 重复 → throw PRIMARY KEY | §4.1 alt slug 重复 |
| R-1.5 | UC-1 | 异常 | unit | 无效 tier → typebox 校验失败 | §4.1 方法签名表边界条件 |
| R-2.1 | UC-2 | 正常 | unit | plan gate 通过 → status=planned | §4.2 主路径 |
| R-2.2 | UC-2 | 异常 | unit | plan gate fail → exit 0 + gatePassed=false | §4.2 alt gate fail |
| R-2.3 | UC-2 | 异常 | unit | 非法状态转换 → exit ≥1 | §4.2 else 非法状态转换 |
| R-2.4 | UC-2 | 异常 | unit | closed topic 调 plan → illegal_transition | §4.2 guard 校验 |
| R-3.1 | UC-3 | 正常 | unit | 单 wave commit → committed 更新 | §4.3 主路径 |
| R-3.2 | UC-3 | 异常 | unit | 无效 commitHash → valid=false | §4.3 else commit 无效 |
| R-3.3 | UC-3 | 异常 | integration | git 可执行文件缺失 → throw ENOENT | §4.3 alt git ENOENT |
| R-6.1 | UC-6 | 正常 | unit | 追加新 wave → 成功 | §4.4 else 仅追加 |
| R-6.2 | UC-6 | 异常 | unit | 破坏性变更 → throw append-only violation | §4.4 alt 破坏性变更 |
| R-4.1 | UC-4 | 正常 | unit | 查询已存在 topic → JSON | §4.5 alt topic 存在 |
| R-4.2 | UC-4 | 异常 | unit | 查询不存在 topic → exit 1 | §4.5 else topic 不存在 |

### 来源 B：NFR 用例（回灌表推导）

| 重建 ID | NFR 维度 | 测试层 | 场景 | 推导自 |
|---------|---------|--------|------|--------|
| R-NFR-1 | 安全 | integration | 无效 slug/tier/objective → exit ≠0 | 回灌表 typebox 参数校验 |
| R-NFR-2 | 安全 | integration | CW_HOME 含 .. 或非绝对路径 → throw | 回灌表路径穿越防护 |
| R-NFR-3 | 安全 | integration | --plan-json-file 不存在/非 JSON/超 10MB → exit ≠0 | 回灌表文件读取边界 |
| R-NFR-4 | 稳定性 | integration | gate fail → exit 0 + gatePassed=false | 回灌表 exit code 分层 |
| R-NFR-5 | 稳定性 | integration | illegal_transition → exit ≥1 | 回灌表 exit code 分层 |
| R-NFR-6 | 可观测性 | integration | 程序错误 stderr 非空且人类可读 | 回灌表 stderr 错误输出 |

---

## test-matrix diff

### MISSING（重建有但 §6 没有）

| 重建 ID | 场景 | 严重度 | 说明 |
|---------|------|--------|------|
| R-3.3 | git 可执行文件缺失 → throw ENOENT | **must_fix** | §4.3 时序图明确有 `alt git 可执行文件缺失` 分支，§6 完全遗漏。此为 infra error，与 commit 无效不同：commit 无效 → valid=false（正常返回），git 缺失 → throw（程序错误）。调用方需要区分这两种失败模式 |

### PHANTOM（§6 有但重建不支持）

| §6 用例 ID | 场景 | 严重度 | 说明 |
|-----------|------|--------|------|
| T1.4 | 空 objective → 成功创建 | **should_fix** | §4.1 时序图无对应 alt/else 分支。从 requirements AC-1.1 推导的边界条件，非时序图推导。归类为 PHANTOM（来源标注错误），但用例本身合理——建议保留但修正来源标注为 requirements 边界条件 |
| T1.7 | create 在已存在 topicId 上 → throw | **nit** | topicId 由 slug 派生（`cw-YYYY-MM-DD-<slug>`），T1.5 已覆盖 slug 重复场景。T1.7 是 T1.5 的等价表述，非独立用例。建议合并到 T1.5 或标注为 T1.5 别名 |

### MISMATCH（测试层/断言不一致）

| §6 用例 ID | 字段 | §6 值 | 重建值 | 严重度 | 说明 |
|-----------|------|-------|--------|--------|------|
| T3.1~T3.5 | 测试层 | mock | mock（R-3.1/3.2）+ integration（R-3.3） | **should_fix** | §4.3 时序图 GitValidator 真调 `execFileSync("git", ...)`，mock 层无法覆盖 git 基础设施错误（ENOENT）。至少 R-3.3 需 integration 层。§6 全标 mock 遗漏了此维度 |
| T6.2 | 场景描述 | "修改已 committed wave 的 changes" | "破坏性变更" | **nit** | §4.4 原文为"alt 破坏性变更"，含义更广（含删除 committed wave、修改 changes、修改 dependsOn 等）。§6 描述缩窄了范围，建议对齐 §4.4 用语 |

---

## 骨架覆盖核验结果

### §9 骨架覆盖表缺失项

| §3 方法 | 骨架文件 | §9 状态 | 严重度 | 说明 |
|---------|---------|---------|--------|------|
| `cli.cli.mapExitCode` | src/cli/cli.ts（L22-L34） | **未列出** | **must_fix** | §3 签名表 §4.1 方法签名表明确列出 mapExitCode，骨架已实现（GuardError → exit 1，ActionResult → exit 0），但 §9 遗漏 |
| `engine.dispatch.dispatch` | src/engine/dispatch.ts | **未列出** | **must_fix** | §5 Deep Module 设计决策明确描述 dispatch 为 engine 入口，骨架有完整接线（guard → switch → handler），但 §9 遗漏。dispatch 是新增模块，§3 §4.1 数据流链已引用 |
| `cli.protocol.readJsonInput` | src/cli/protocol.ts | **未列出** | **must_fix** | §3 签名表列出 readJsonInput，骨架已实现（3 参数版），但 §9 遗漏 |

### §3 签名 vs 骨架签名不一致

| §3 方法 | §3 签名 | 骨架签名 | 严重度 | 说明 |
|---------|---------|---------|--------|------|
| `cli.protocol.readJsonInput` | `(flagValue?: string, stdinData: string) → unknown` (2 参) | `(flagValue: string \| undefined, stdinData: string, isStdinTTY: boolean) → unknown` (3 参) | **should_fix** | 骨架新增 `isStdinTTY` 参数用于 TTY 检测（stdin 优先 vs 文件 fallback 的判定依据）。§4.2 时序图调用处也只显示 2 参数。§3 签名表需补充第三参数，时序图需标注 isStdinTTY 来源 |

### §3 签名 vs 骨架签名一致项（✅ 通过）

| §3 方法 | 骨架文件 | 签名一致 | 接线层级 |
|---------|---------|---------|---------|
| cli.cli.main | src/cli/cli.ts | ✅ | 接线完整 |
| cli.protocol.parseParams | src/cli/protocol.ts | ✅ | 接线完整 |
| cli.protocol.validateParams | src/cli/protocol.ts | ✅ | 接线完整 |
| cli.protocol.resolveDbPath | src/cli/protocol.ts | ✅ | 接线完整 |
| cli.protocol.CwParamsSchema | src/cli/protocol.ts | ✅ | 签名(叶子) |
| engine.types.judgeByExpected | src/engine/types.ts | ✅ | 签名(叶子) |
| engine.types.resolveTopicDir | src/engine/types.ts | ✅ | 签名(叶子) |
| engine.store.CwStore.* | src/engine/store.ts | ✅ | 签名(叶子) |
| engine.state-machine.* | src/engine/state-machine.ts | ✅ | 接线完整 |
| engine.gates.* | src/engine/gates.ts | ✅ | 接线完整 / adapter 真引SDK |
| engine.plan-parser.* | src/engine/plan-parser.ts | ✅ | 签名(叶子) |
| engine.actions.create.handleCreate | src/engine/actions/create.ts | ✅ | 接线完整 |
| engine.actions.*（其余 8 个） | src/engine/dispatch.ts（handler stub） | ✅ | 签名级 stub |

### Import 关系核验

| 规则 | 骨架实际 | 状态 |
|------|---------|------|
| cli → engine 单向 | cli.ts import dispatch/store/gates/protocol | ✅ |
| engine → 不得 import cli | 无 cli import | ✅ |
| engine actions → state-machine/types/store/gates/plan-parser | create.ts import state-machine + types | ✅ |
| 零 pi 依赖 | 无 @mariozechner/pi-coding-agent 或 @earendil-works/pi-ai | ✅ |

### GateRunner.runCheck dispatch 表

骨架中 `CHECK_DISPATCH` 为空（`{}`），所有 check 函数返回 infraError。这是骨架 stub 的预期行为（Wave 实现时填充），不阻塞 review。但 §9 标注为"✅ 接线完整：dispatch 到 check 函数"有误导性——实际是"接线框架完整，dispatch 表待填充"。

---

## must_fix

| # | 文件 | 问题 | 修复建议 |
|---|------|------|---------|
| M-1 | code-architecture.md §6 | **MISSING: git 可执行文件缺失用例** — §4.3 时序图有 `alt git 可执行文件缺失 → throw ENOENT` 分支，§6 完全遗漏 | 新增 T3.6: 类型=异常, 测试层=integration, 场景="git 可执行文件缺失", 输入="无 git 环境", 预期="throw ENOENT (infra error)", 关联 AC-3.2 |
| M-2 | code-architecture.md §9 | **骨架覆盖表遗漏 3 个方法** — mapExitCode、dispatch、readJsonInput 已在骨架实现但未列入 §9 | §9 补充三行：`cli.cli.mapExitCode → src/cli/cli.ts → ✅ 接线完整`，`engine.dispatch.dispatch → src/engine/dispatch.ts → ✅ 接线完整`，`cli.protocol.readJsonInput → src/cli/protocol.ts → ✅ 接线完整` |

## should_fix

| # | 文件 | 问题 | 修复建议 |
|---|------|------|---------|
| S-1 | code-architecture.md §3 | **readJsonInput 签名不一致** — §3 写 2 参数，骨架实际 3 参数（+isStdinTTY） | §3 readJsonInput 签名改为 `(flagValue?: string, stdinData: string, isStdinTTY: boolean) → unknown` |
| S-2 | code-architecture.md §4.2 | **时序图 readJsonInput 调用缺 isStdinTTY** — §4.2 时序图显示 `readJsonInput("--plan-json-file", stdin)` 但实际需 3 参数 | §4.2 时序图调用改为 `readJsonInput("--plan-json-file", stdin, isStdinTTY)` |
| S-3 | code-architecture.md §6 | **T1.4/T1.7 来源标注** — 标为时序图推导但实际来自 requirements 边界条件 | T1.4 来源改为"requirements AC-1.1 边界条件"；T1.7 合并到 T1.5 或标注为"T1.5 别名" |
| S-4 | code-architecture.md §6 | **T3.x 测试层全标 mock** — §4.3 时序图 GitValidator 真调 git，mock 无法覆盖 infra error | T3.3（无效 commitHash）可保持 mock；新增 T3.6（git ENOENT）标 integration |

## nit

| # | 文件 | 问题 | 修复建议 |
|---|------|------|---------|
| N-1 | code-architecture.md §6 | **T6.2 描述缩窄** — §4.4 原文"破坏性变更"，§6 写"修改已 committed wave 的 changes" | T6.2 场景改为"破坏性变更（修改/删除已 committed wave）" |
| N-2 | code-architecture.md §9 | **GateRunner.runCheck 标注误导** — 标"✅ 接线完整：dispatch 到 check 函数"但 CHECK_DISPATCH 为空 | 改为"✅ 接线框架完整，dispatch 表待 Wave 填充" |
