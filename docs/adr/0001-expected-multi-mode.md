# ADR 0001：expected 字段多模式判定

## 状态

Accepted（2026-07-17，topic cw-2026-07-17-expected-multi-mode）

## 背景

CW 的 `expected` 字段自始至终只有 `{ url?, text? }` + 精确字符串相等（`===`）一条判定路径（`src/types.ts:74-77`、`judgeByExpected` L94-125）。这个机制建立在一个隐含假设上：

> 每个测试断言都能产出一个可观测的、确定的、非布尔结论的字符串值，能在 tdd_plan 时预测、在 test 时复现。

该假设对数值/字符串断言成立（`.toBe(2)` → `"2"`），但对**布尔/状态类断言不成立**：

- `expect(existsSync(sidecarPath)).toBe(true)` 没有天然的字符串值
- `FUZZY_EXPECTED_RE`（`src/gate.ts:345-348`）在 planCheck 阶段把 `"true"/"false"/"passed"/"ok"` 等结论词全拦了
- tdd_plan 阶段没有合法填法 → agent 填描述性文本（如 `"sidecar written"`）→ test 跑出 `"5 passed"` 填入 actual → `!==` 不匹配 → failed
- failed 后 append-only 机制（`validateAppendOnly`，`src/actions.ts:2256-2270`）专门锁死 expected（防"fail → 改 expected 匹配 actual → pass"作弊）→ replan 改不了、test_fix 不碰 → 流程死锁 → abort

这是设计张力，不是 bug：append-only 锁死是故意的，问题在**上游**没有合法填法。

## 决策

给 `Expected` 改为**判别联合**，支持三种判定模式（`type` 字段必填）：

```ts
type Expected =
  | { type: "exact"; url?: string; text?: string }   // 精确字符串 ===（现状）；url 和 text 都可选，至少一个
  | { type: "exit_zero" }                            // 测试命令 exit 0 即 pass
  | { type: "script"; path: string }                 // 跑判定脚本，exit 0 即 pass
```

> **exact 模式约束修正（SR2）**：`text` 不再必填。`url` 与 `text` **都可选，至少一个**——与现状 `judgeByExpected` 的"无判据判 failed"兜底一致（`src/gate.ts` judgeByExpected：url/text 都缺 → 直接 failed）。原 ADR 写 `text: string` 必填会 break 现有 url-only fixture（`tests/gate.test.ts:368`、`tests/plan-parser.test.ts:72`）。`url` 仍是独立的 `===` 判据（非 fetch），命中即 pass。`text` 仍受 `FUZZY_EXPECTED_RE` 约束。

### 五个子决策

**1. 执行边界：testCheck 保持纯函数**

- `judgeByExpected` / `testCheck` 不执行外部命令（保持纯函数，可单测）
- `exit_zero` / `script` 的命令执行（`child_process.execFileSync`）在 `handleTest` 里预处理：先把外部命令的 exit code 归一化为一个判定值，再传给纯函数的 `judgeByExpected`
- 纯函数性是 RB-1 机器重算语义的基石，不能破

**2. script 协议：自包含（无 stdin/argv 传 actual）**

- 判定脚本**不接收** agent 提交的 actual 作为输入
- 脚本自行读取被测系统状态（文件、DB、进程）做判定，exit 0 即 pass
- 理由：CW 核心哲学是"不信 agent 声明"（`gate.ts:732` 注释："lite 单轨不信 agent 声明"）。如果 script 接收 agent 提交的 actual，就等于让 agent 自己裁判自己，防线作废
- 代价：脚本要自己拉取状态，不能复用 agent 的上下文。但这是安全边界，不可妥协

**3. 安全：execFile 不经 shell + 路径限制**

- 用 `execFileSync`（非 `exec`），不经 shell，防 shell 注入
- `script.path` 路径校验用 **resolve 沙箱**（标准做法）：`path.resolve(workspace, scriptPath)` 的结果必须 `startsWith(path.resolve(workspace))`，否则拒绝
- resolve 沙箱天然覆盖：绝对路径（`/etc/passwd` → resolve 后脱离 workspace）、非顶层 `..` 绕过（`foo/../../../etc/passwd` → resolve 后脱离 workspace）。比原"字符串 substring 检查/拒 `..`"更稳健，不会被 `a/../../../` 这类多级回溯绕过

**4. exit_zero 执行模型（SR1）**

- `testRunner` 是**项目级单命令**（`src/types.ts:756-767` 的 `TestRunner` 类型，整个 topic 共享一条），不是 per-case 粒度；原 `runTestRunner`（`src/gate.ts:576`）是无人调用的 dead code
- 修正后的执行/归因模型：`exit_zero` 模式下，`handleTest` 内把 `testRunner` 命令**执行一次**，所有 `type=exit_zero` 的 case **共享这一次执行结果**——exit 0 → 全部 pass，非 0 → 全部 failed
- 这是唯一语义自洽的方案：`testRunner` 表达"信这条命令的退出码作为整批判定"。若需要 per-case 粒度的命令判定，用 `script` 模式（每个 case 独立 path，各自执行）
- `actual` 在 exit_zero 模式可省略（解决布尔/命令行断言无值可填的根因）

**5. script 解释器与可执行位（SR3）**

- `script.path` 指向的脚本文件依赖其 **shebang + 可执行权限**，由 `execFileSync(path)` 直接执行，**不经 shell、不显式指定解释器**（显式 `execFileSync('sh', ['-c', ...])` 等于经 shell，方向错）
- 即标准的 Unix 执行语义：脚本首行 `#!/usr/bin/env node`（或 `#!/bin/sh` 等）决定解释器，文件须 `chmod +x`
- **CW 不为 Windows 兜底**（项目本身就是 darwin/linux 工具链，无跨平台需求）。无 shebang/无执行位 → `execFileSync` 抛错 → 该 case failed（错误信息透传给 agent 排查）
- 脚本自包含，不接收 agent 提交的 `actual`（见子决策 2）

## 替代方案

- **A. 约定"契约串" + custom executor（零代码改动）**：要求 executor 脚本在断言成立时 `echo "SIDECAR_OK:/path"`，expected 填该串。短期可用，但每个布尔断言都要编一个契约串，治标不治本，agent 学习成本高
- **B. 放宽到 contains/regex**：方向错。问题是"布尔断言没值可填"，不是"值不够灵活"。contains 反而让 `"5 passed" contains "passed"` 合法化，与 FUZZY_EXPECTED_RE 直接冲突
- **C. 解锁 failed 的 expected**：破坏 append-only 核心防作弊设计。允许改 expected = 破坏机器重算基准

选 D（本 ADR）而非 A/B/C 的理由：A 是短期 workaround，B/C 破坏核心防线。只有 D 在架构上正确归位（把"如何判定"作为 expected 的一等公民），不引入新的技术债。

## 后果

**正面**：
- 布尔/状态/命令行测试断言有合法填法，根除 tdd_plan → test 死锁
- "如何判定"成为 expected 的一等公民，架构归位
- exit_zero/script 仍是确定性机器重算（exit code 确定），不破坏 RB-1 的"机器重算不信任声明"精神

**负面**：
- 30+ 处存量测试 fixture 全要加 `type: "exact"`（`dispatch`/`store`/`state-machine`/`e2e-*`/`pure-functions`）
- RB-1 回归基线（`pure-functions.test.ts` judgeByExpected 测试组）的现有断言结构要改，需同步更新 `TEST-STRATEGY.md` RB-1 措辞
- `testCheck` 调用链增加 child_process 依赖，handleTest 不再是纯调度（但在 testCheck 外）
- script 模式引入外部命令执行风险（由子决策 3 的 resolve 沙箱 + execFile 缓解）

**已知风险（SR7，explicit accepted）**：

- **script 防作弊张力**：`script.path` 指向的脚本文件由 agent 写，理论上可写"恒 exit 0"的脚本来作弊（与自己 exit 0 无异）。这与 CW"不信 agent 声明"的核心哲学（`gate.ts:732` 注释"lite 单轨不信 agent 声明"）有张力
- **mitigation（三重）**：
  1. **dev git commit 锚定**：`script.path` 指向的脚本文件必须经 dev 阶段 git commit（dev gate 已校验 commit），脚本内容进入版本历史可追溯
  2. **append-only 锁 path 值**：`expected` 含 `script.path` 值本身受 `validateAppendOnly` 锁定，事后改 path 触发 `case_expected_tampered_failed`
  3. **reviewer 人工审脚本内容**：script 模式的判定逻辑由 reviewer 在 review 阶段人工审，是最后防线
- **accepted**：此风险被显式接受。script 模式用于复杂判定场景（需读系统状态做断言），使用频率应低于 exit_zero/exact。exit_zero 模式天然无此风险（跑的是项目共享 testRunner，非 agent 写的脚本）

## 关联

- RB-1 基线（`TEST-STRATEGY.md:220-225`）措辞需从"精确 === 绝对规则"降级为"exact 模式规则"，补 exit_zero/script 的判定语义说明
- `FUZZY_EXPECTED_RE`（`src/gate.ts:345-348`）只在 `exact` 模式触发，exit_zero/script 跳过
- append-only 锁定（`validateAppendOnly`，`src/actions.ts:2256-2270`）逻辑不变——`JSON.stringify` 深比较对新结构天然生效（改 type 即判 differ）
