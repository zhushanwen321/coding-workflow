---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw CLI. 两种模式：多 unit 任务（≥2 unit 或需并行）默认用
  runner 自动调度——cw run --root <id> --spawn pi 后台运行，runner 循环派发
  designer/developer/reviewer 直到根 unit closed；单 unit 调试 / runner 不可用时
  走手动逐步交证据（create → evidence submit → verify → review submit）。
  Not for pure analysis/research/系统设计（无代码产出的任务）。
  只有要写代码+测试的编码任务才用 CW。
---

# cw CLI（agent 工作的 CI）

> cw 2.0 是对 1.x 的完全重写：四层 WorkUnit + 状态机 + 声明推进 → 事件账本 + 证据 gate + 机器验证。
> **1.x 的 `cw create <layer>` / `cw abort` / `cw handoff` / `cw design` / `cw execute` / `nextAction.guidance` 等全部不存在。**本文件描述的是 2.0 命令面。

## 什么时候该用 / 不该用

| 场景 | 判断 | 原因 |
|------|------|------|
| 新功能 / 复杂 bug / 重构模块 | 用 CW | 有明确目标，需要 spec → verify 完整证据链 |
| 改 typo / 改配置值 / 加注释 | 不用 CW | 流程开销 >> 收益 |
| 纯调研 / 可行性分析 / 架构评估 | 不用 CW | 无代码产出 |
| 加简单工具函数（无外部依赖）| 不用 CW | 单文件单函数，无 spec 必要 |

**判断标准**：如果不需要 spec（验收用例）+ verify（机器重跑）的证据链，就不要用 CW。

## 模式分流：runner 还是手动

[MANDATORY] 建 unit 树**之前**先定模式——这是流程的第一个决策点，不得跳过：

| 判据（建树前可数） | 模式 | 入口 |
|------|------|------|
| unit 数 ≥2，或需要并行推进 | **runner（默认）** | `cw run --root <id> --spawn pi` |
| 单 unit；调试验收命令 / gate 规则 / 适配器；学习流程；runner 不可用 | 手动（降级路径） | 逐步 `cw create → evidence → verify → review` |

[MANDATORY] 多 unit 任务**禁止主 agent 手动逐 unit 派 subagent 编排替代 runner**：角色分工（designer / developer / 独立 reviewer）、每 unit worktree 隔离、集成 merge、死锁转人工全部是 runner 内建机制，手动编排等于放弃全部——实测代价（2026-08-20 session）：29 次手动 subagent、15 小时 session、root spec 迭代 7 次。

树深度上限 2 层（根 + 叶）。需要更深的任务拆成多个 root 分别 run，或先人工降层再走 CW。

## 核心理念

[强制] **交证据不声明**：没有「声明状态推进」的命令，只有「交证据」——补录结构性不可能。

[强制] **通过 bash 调 `cw` 命令**：agent 用 bash 工具执行 `cw <command> [flags]`，读 stdout/stderr。

[强制] **机器验证判定完成**：pass/fail 由 verify（干净重跑 + 名字级比对 + 红阶段）裁决，人与 agent 同权。

[强制] **账本 append-only**：事件不可撤销、不可篡改。closed 是最终结论。

## 命令一览（10 个）

| 命令 | 类别 | 用途 |
|---|---|---|
| `cw create --id <slug> --brief <路径> [--parent <id>]` | 写 | 创建 unit |
| `cw evidence submit --unit <id> --kind spec --file spec.json` | 写 | 提交 spec（入账冻结） |
| `cw evidence submit --unit <id> --kind build --commit <hash> --run-id <id> [--file <产物>]...` | 写 | 提交构建证据 |
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail [--role <role>] [--comment <text>] [--evidence-refs <runId,...>]` | 写 | 提交审查结论 |
| `cw verify --unit <id> [--timeout-ms <n>] [--no-red-phase]` | 写 | 干净重跑验证（红阶段默认执行） |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms] [--max-idle-ms] [--max-concurrency] [--reviewer-model <m>] [--max-spec-rejects <n>]` | 跑 | runner 调度循环 |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图 |
| `cw frontier [--json]` | 只读 | 就绪集合（可推进节点） |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>] [--root <id>]` | 只读 | 证据链汇总（逐验收覆盖标记） |

## runner 模式（多 unit 默认路径）

多 unit 任务不需要 agent 逐步操作账本——runner 一条命令调度到根 unit closed：

```bash
cw run --root my-feature --spawn pi
```

### 启动前准备

最小启动 = 一个 root unit + 任务书：

```bash
cw create --id my-feature --brief brief.md
cw run --root my-feature --spawn pi
```

designer 任务书含根节点拆分指引：brief 里有拆分建议时 designer 会先建子 unit 再提交 spec（预先手动建好子 unit 也可以，两种都合法）。

### 循环语义

每轮对投影重算 frontier 就绪维度 → 批次派发（并行上限 `--max-concurrency`，默认 3）→ 等 spawn 退出 → 回收证据 → 重算，直到根 unit closed 或仅剩转人工 unit（`src/runner/loop.ts`）。

### 角色分工（review 独立）

- **designer**：写 spec、修被打回的 spec、处置契约漂移。任务书内置已知契约坑的提醒——e2e-sh 标记行从哪产出、verify 在一次性干净 checkout 重跑（无提交者本机全局依赖）等——spec 一次写对的概率显著高于无提示手写
- **developer**：实现 + 提交 build 证据 + 触发 verify
- **reviewer**：spec-review 与 exec-review 由 runner 单独 spawn 的独立 reviewer 提交（developer 不自审）；模型可异源（见「模型配置」）

### worktree 隔离与集成

每 unit 独立 git worktree + 独立分支，互不踩踏。叶子 unit verified 后由确定性集成代码（不派 agent）merge 子树回 root 分支并干净重跑受影响验收；集成连续 fail 转派 designer 处置契约漂移。根 unit closed 时 runner 输出 worktree 回收清单与 merge 回流指引——收尾时按清单回流。

### 转人工出口（escalation）

以下死锁形态 runner 不自动重试，stderr 打印处置指引；无可派发且无 in-flight 时 exit 1 收束并汇总转人工清单：

| 出口 | 触发阈值（默认） | 处置 |
|------|------|------|
| specReviewDeadlock | spec 打回 ≥10 代（`--max-spec-rejects` 可调紧） | 人工介入 spec 方向 |
| specContractDeadlock | 验收命令契约回炉 ≥2 代 | 人工修 spec 的验收命令 |
| flakeReview | 同一验收连挂 ≥2 | 人工判定 flake 或真 bug |
| spawn 连续超时 | 同 unit 连续 2 次 TIMEOUT | 人工查环境 |

转人工处置完成后**重跑 `cw run` 从投影续接**，已完成进展不丢失。Ctrl-C 同理——中断后重跑即续接。

### 后台运行与监控

`cw run` 前台阻塞直至收束（多 unit 任务常以小时计）。实操：后台运行该命令，期间定期 `cw status` / `cw frontier` 观察推进；escalation 走 stderr——后台形态下把 stderr 落盘并定期检查。

### 模型配置

- developer / designer：`CW_AGENT_MODEL` 环境变量，缺省 `xiaomi-token-plan-cn/mimo-v2.5-pro`
- reviewer：`--reviewer-model <m>` > `CW_REVIEWER_MODEL` 环境变量 > 回落 developer 同款

### manual 型验收在 runner 下的语义

manual 型免机器验证：verify 跳过执行、自动并入覆盖（进 acceptanceIds）。runner 全自动推进下**没有任何环节强制人工确认**——需要强制人工验收点（如 GUI 检查）时，不要声明为 manual 型；声明为 e2e 级、command 用「检查人工勾选文件」的 gate 脚本（未勾选则 FAIL），把人工动作变成机器可判的验收前置。

## 手动流程（单 unit 调试与降级路径）

**何时用手动**：单 unit 任务；调试单条验收命令 / gate 规则 / 适配器行为；学习流程理解证据链；runner 不可用（如 spawn 后端故障）时的降级。多 unit 任务用 runner（见上），禁止手动逐 unit 编排。

### 第 1 步：创建 unit

```bash
cw create --id my-feature --brief brief.md
```

- `--id`：小写字母开头，仅小写字母/数字/连字符（`^[a-z][a-z0-9-]*$`）
- `--brief`：任务书文件路径（内容原样不解析，空文件亦可）
- `--parent`：可选，挂到已有 unit 下（深度上限 2 层：根 + 叶）

返回 unit 的创建确认。**记下 unit id**，后续所有命令都要传。

### 第 2 步：提交 spec（验收用例）

写一个 `spec.json`，结构：

```json
{
  "acceptance": [
    {
      "id": "A1",
      "title": "验收标题",
      "type": "e2e-real",
      "core": true,
      "command": "bash run-tests.sh",
      "scenario": "场景描述"
    },
    {
      "id": "A2",
      "title": "单元测试",
      "type": "unit",
      "core": false,
      "command": "npx vitest run tests/foo.test.ts"
    }
  ],
  "contracts": [],
  "split": []
}
```

验收类型：`e2e-real`（真实环境 e2e）/ `e2e-mock`（带 mock 的 e2e，须附 `mockFidelityNote`）/ `unit` / `integration` / `manual`。需要 pytest / playwright 适配器时验收条目加 `"runner": "pytest"` 显式声明（缺省按 type 路由，见「验收适配器」）。

提交：
```bash
cw evidence submit --kind spec --unit my-feature --file spec.json
```

#### spec gate 规则（提交时机器检查，多缺口全列不短路）

| 规则 | 含义 |
|------|------|
| ① | 验收非空 |
| ② | `core: true` 的用例 type 必须是 `e2e-real` 或 `e2e-mock` |
| ③ | e2e 用例必须有可执行 command（首 token 在 PATH 可解析） |
| ④ | `e2e-mock` 须附非空 `mockFidelityNote` |
| ⑤ | 至少一条 `unit` 级用例 |
| ⑥ | split 不得自引用 |
| ⑦ | 验收 id 字符集：字母数字开头，后续可含 `.` `_` `-`（禁空格中文） |
| ⑧ | 显式 `runner` 声明必须在合法值集合内：`vitest` / `e2e-sh` / `pytest` / `playwright`（大小写敏感） |
| ⑨ | 验收命令契约（按最终适配器路由）：vitest / playwright 命令禁自带非 json 的 `--reporter`（等号形态值须恰为 `json`）与任何 `--outputFile`；pytest 禁 `-q` / `--quiet`（含 `-qq` 等短选项合写、`--q` 等前缀缩写）；e2e-sh / manual 无静态规则 |

gate 不过不入账。错误信息含具体哪条规则未过 + 恢复动作。

#### spec-review（独立审查）

spec 入账后，以独立 reviewer 身份提交审查结论——`--role` 必填且必须 `reviewer`（缺/错 exit 1 纯拒绝，防 developer 自审）：

```bash
cw review submit --unit my-feature --verdict-kind spec-review --verdict pass --role reviewer
```

spec-review pass 后 spec 冻结（后续 verify 按此验收执行）。

### 第 3 步：提交 build 证据

实现代码，git commit，然后：
```bash
cw evidence submit --kind build --unit my-feature --commit $(git rev-parse HEAD) --run-id build-v1 [--file <产物文件>]
```

- `--commit`：git commit hash（十六进制）
- `--run-id`：幂等键，同 unit 重跑须换新 runId。**记下它——第 5 步 exec-review 的 `--evidence-refs` 要引用**
- `--file`：可选，产物文件路径（可多个）

### 第 4 步：verify（机器验证）

```bash
cw verify --unit my-feature [--timeout-ms <n>] [--no-red-phase]
```

verify 执行三道 gate：
1. **红阶段**（默认执行，`--no-red-phase` 仅调试用逃生口）：checkout 实现前的父 commit 树重跑验收，逐条期望 fail——证明验收在检测实现而非恒绿假命令
2. **名字级比对**：验收 id 必须以词边界出现在测试产物中（vitest 的 fullName / e2e-sh 的标记行），且全部 pass
3. **干净重跑**：checkout 账本记录的 commit，在隔离的一次性工作区重跑（无提交者本机全局依赖），产物落盘

verify 输出：
- stdout：逐条 `<id> pass|fail|manual` + 总结行 + runId + 报告路径
- stderr：失败条目的 id + 原因 + 恢复动作

pass → exit 0；fail → exit 1；环境错误 → exit 2（不入账）。

### 第 5 步：exec-review + 关闭

```bash
cw review submit --unit my-feature --verdict-kind exec-review --verdict pass --evidence-refs build-v1
```

- `--evidence-refs`（必填）：至少 1 个该 unit 已入账的 runId——build 的 `--run-id` 或 verify 输出的 runId。exec-review pass 是 closed 的前置，结论必须锚定已入账证据
- `--role` 可选自报（`reviewer | designer | developer | human`；审计载体，非信任边界）

exec-review pass 后 unit 进入 closed 终态。

## 验收适配器（四适配器）

按验收 type 自动路由（`AcceptanceItem.runner` 显式声明优先）：

| 适配器 | 路由 | 产物契约 |
|---|---|---|
| vitest | unit / integration（缺省） | cw 自动追加 `--reporter=json`；测试 fullName 须以词边界包含验收 id |
| e2e-sh | e2e-real / e2e-mock（缺省） | 脚本须输出 `<验收id> PASS\|FAIL` 标记行 |
| pytest | 需显式 `runner: "pytest"` | cw 自动追加 `-v` 等 verbosity；命令禁带 `-q` / `--quiet`（gate 规则⑨） |
| playwright | 需显式 `runner: "playwright"` | cw 自动追加 `--reporter=json`；命令禁自带其他 reporter / `--outputFile` |

### vitest 名字级比对

验收 command 是 vitest 命令。cw 会自动追加 `--reporter=json`（不要手动加）。

名字级比对规则：测试的 `fullName`（describe + it 拼接）必须以词边界包含验收 id。例如验收 id 为 `A0`：
```ts
describe("A0 SessionMetaCache", () => {   // ✅ fullName 包含 "A0"
  it("setLabel/getLabel", () => { ... });
});
```

词边界 = 前后不是 `[A-Za-z0-9-]`（防 A1 误命中 A10）。

### e2e-sh 标记行

验收 command 是一个 bash 脚本。脚本**必须**输出标记行：

```
<验收id> PASS
<验收id> FAIL
```

标记行格式：验收 id + 空格 + PASS/FAIL，每条验收一行。脚本 exit code 须与标记行一致。

**反模式**：一次 vitest 全绿就给所有验收打 PASS 的 wrapper 脚本——这是「无区分力」证据，红阶段会拦截。

## 只读查询

| 命令 | 用途 |
|------|------|
| `cw status [--unit <id>]` | 查看 unit 状态（默认当前 cwd 全部） |
| `cw frontier` | 查看可推进节点集合 |
| `cw tree` | 查看 unit 分解树 |
| `cw report [--unit <id>] [--root <id>]` | 证据链汇总（逐验收覆盖标记 ✓/✗；`--root` 为子树汇总） |

## 失败模式与恢复

### spec gate 失败
返回具体哪条规则未过 + 恢复动作。修 spec.json 后重新 `cw evidence submit --kind spec`。

### verify 失败
stderr 列出失败验收 id + 原因。**恢复动作：修复代码并 git commit 后，仅重新 `cw evidence submit --kind build` + `cw verify`；spec 冻结不动。**

### 名字级比对失败（"验收 X 未出现在产物"）
vitest：测试 fullName 须以词边界包含验收 id。e2e-sh：脚本须输出 `<id> PASS|FAIL` 标记行。

### 红阶段失败（"无区分力"）
验收在旧代码树上也通过 = 恒绿假命令。加强断言（assert 实现产物的具体特征），或改 type 为 e2e-real/e2e-mock。

### 超时
用 `--timeout-ms <毫秒>` 增大超时（默认 unit 600000ms / e2e 1800000ms）。

### unit 不存在
`cw status` 查看全部 unit 确认 id。确认 cwd 是创建 unit 时的目录。

### 已 closed
closed 是 append-only 账本的最终结论，不可逆。需变更请新建 unit。

## 前置检查

[MANDATORY] 启动前：
- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow`
- **`cw --version` ≥ 2.0**：本文件描述的是 2.0 命令面，1.x 命令（`cw create <layer>` / `cw abort` / `cw handoff` / `cw design` / `cw execute`）全部不存在
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（verify 需要真实 commit）
- **`--spawn pi` 前置**：PATH 上有 `pi` 可执行（无头 agent spawn 用）

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `CW_HOME` | 存储根目录（每个 cwd 一个独立账本） | `~/.cw` |
| `CW_AGENT_MODEL` | developer / designer 用的模型 | `xiaomi-token-plan-cn/mimo-v2.5-pro` |
| `CW_REVIEWER_MODEL` | reviewer 模型（未设则回落 developer 同款） | 未设 |

## Self-Check

[MANDATORY] 按实际所走模式核对，以下全部满足才算流程走完：

**runner 路径（多 unit 任务）**：
- [ ] `cw run --root <id> --spawn pi` 运行至根 unit closed（exit 0）
- [ ] 无未处置的转人工清单（若 exit 1 收束：逐个处置 escalation 后重跑 `cw run` 续接）
- [ ] `cw report --root <id>` 验收覆盖全部 ✓（无 ✗）
- [ ] root 分支 merge 回流完成（按 runner 收束输出的回收清单）

**手动路径（单 unit 调试 / 降级）**：
- [ ] spec gate 全部通过（`cw evidence submit --kind spec` 返回成功）
- [ ] spec-review pass（`cw review submit --verdict-kind spec-review --verdict pass --role reviewer`）
- [ ] build 证据已提交（`cw evidence submit --kind build` 返回成功）
- [ ] verify pass（`cw verify` exit 0，全部验收 pass）
- [ ] exec-review pass（`cw review submit --verdict-kind exec-review --verdict pass --evidence-refs <runId>`）

## 标记说明

| 标记 | 含义 |
|------|------|
| [强制] | 流程不可逾越的边界（机器层强制） |
| [MANDATORY] | 流程强制要求 |
