---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw CLI. 入口：bash 调 cw 命令（create → evidence submit →
  verify 等），按返回的 stdout 文本推进全流程。
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
| `cw review submit --unit <id> --verdict-kind spec-review\|exec-review --verdict pass\|fail [--comment <text>]` | 写 | 提交审查结论 |
| `cw verify --unit <id> [--timeout-ms <n>] [--red-phase]` | 写 | 干净重跑验证 |
| `cw run --root <id> [--spawn human\|pi] [--poll-ms] [--max-idle-ms] [--max-concurrency]` | 跑 | runner 调度循环 |
| `cw status [--unit <id>] [--json]` | 只读 | 状态视图 |
| `cw frontier [--json]` | 只读 | 就绪集合（可推进节点） |
| `cw tree` | 只读 | 分解树 |
| `cw report [--unit <id>]` | 只读 | 证据链汇总（逐验收覆盖标记） |

## 手动流程（逐步交证据）

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

验收类型：`e2e-real`（真实环境 e2e）/ `e2e-mock`（带 mock 的 e2e，须附 `mockFidelityNote`）/ `unit` / `integration` / `manual`。

提交：
```bash
cw evidence submit --kind spec --unit my-feature --file spec.json
```

#### spec gate 规则（提交时机器检查）

| 规则 | 含义 |
|------|------|
| ① | 验收非空 |
| ② | `core: true` 的用例 type 必须是 `e2e-real` 或 `e2e-mock` |
| ③ | e2e 用例必须有可执行 command（首 token 在 PATH 可解析） |
| ④ | `e2e-mock` 须附非空 `mockFidelityNote` |
| ⑤ | 至少一条 `unit` 级用例 |
| ⑥ | split 不得自引用 |

gate 不过不入账。错误信息含具体哪条规则未过 + 恢复动作。

#### spec-review（独立审查）

spec 入账后，提交审查结论：
```bash
cw review submit --unit my-feature --verdict-kind spec-review --verdict pass
```

spec-review pass 后 spec 冻结（后续 verify 按此验收执行）。

### 第 3 步：提交 build 证据

实现代码，git commit，然后：
```bash
cw evidence submit --kind build --unit my-feature --commit $(git rev-parse HEAD) --run-id build-v1 [--file <产物文件>]
```

- `--commit`：git commit hash（十六进制）
- `--run-id`：幂等键，同 unit 重跑须换新 runId
- `--file`：可选，产物文件路径（可多个）

### 第 4 步：verify（机器验证）

```bash
cw verify --unit my-feature
```

verify 执行三道 gate：
1. **红阶段**（`--red-phase`）：checkout 实现前的父 commit 树重跑验收，逐条期望 fail——证明验收在检测实现而非恒绿假命令
2. **名字级比对**：验收 id 必须以词边界出现在测试产物中（vitest 的 fullName / e2e-sh 的标记行），且全部 pass
3. **干净重跑**：checkout 账本记录的 commit，在隔离环境重跑，产物落盘

verify 输出：
- stdout：逐条 `<id> pass|fail|manual` + 总结行 + runId + 报告路径
- stderr：失败条目的 id + 原因 + 恢复动作

pass → exit 0；fail → exit 1；环境错误 → exit 2（不入账）。

### 第 5 步：exec-review + 关闭

```bash
cw review submit --unit my-feature --verdict-kind exec-review --verdict pass
```

exec-review pass 后 unit 进入 closed 终态。

## runner 模式（自动调度）

不想逐步手动时，用 runner 自动推进：
```bash
cw run --root my-feature --spawn human   # 人肉模式：打印指令，人执行后轮询推进
cw run --root my-feature --spawn pi      # 无头 agent：派 pi 进程自动执行
```

runner 循环：frontier → 批次派发 → 等退出 → 证据回收 → 重算 → 重复，直到根 unit closed。

- `--spawn human`：打印每步指令，人执行后 runner 轮询账本推进
- `--spawn pi`：起无头 pi 进程自动执行（需 `CW_AGENT_MODEL` 环境变量或默认模型）
- `--poll-ms`：轮询间隔（默认 5000ms）
- `--max-idle-ms`：无进展超时（默认 1800000ms = 30min）
- `--max-concurrency`：并行上限（默认 3）

## 验收适配器（TestRun 缝）

cw 2.0 有两个适配器，按验收 type 自动路由：

### e2e-sh 适配器（e2e-real / e2e-mock）

验收 command 是一个 bash 脚本。脚本**必须**输出标记行：

```
<验收id> PASS
<验收id> FAIL
```

标记行格式：验收 id + 空格 + PASS/FAIL，每条验收一行。脚本 exit code 须与标记行一致。

**反模式**：一次 vitest 全绿就给所有验收打 PASS 的 wrapper 脚本——这是「无区分力」证据，红阶段会拦截。

### vitest 适配器（unit / integration）

验收 command 是 vitest 命令。cw 会自动追加 `--reporter=json`（不要手动加）。

名字级比对规则：测试的 `fullName`（describe + it 拼接）必须以词边界包含验收 id。例如验收 id 为 `A0`：
```ts
describe("A0 SessionMetaCache", () => {   // ✅ fullName 包含 "A0"
  it("setLabel/getLabel", () => { ... });
});
```

词边界 = 前后不是 `[A-Za-z0-9-]`（防 A1 误命中 A10）。

## 只读查询

| 命令 | 用途 |
|------|------|
| `cw status [--unit <id>]` | 查看 unit 状态（默认当前 cwd 全部） |
| `cw frontier` | 查看可推进节点集合 |
| `cw tree` | 查看 unit 分解树 |
| `cw report [--unit <id>]` | 证据链汇总（逐验收覆盖标记 ✓/✗） |

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

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `CW_HOME` | 存储根目录（每个 cwd 一个独立账本） | `~/.cw` |
| `CW_AGENT_MODEL` | pi 后端派发 agent 用的模型 | `xiaomi-token-plan-cn/mimo-v2.5-pro` |

## Self-Check

[MANDATORY] 以下全部满足才算流程走完：
- [ ] spec gate 全部通过（`cw evidence submit --kind spec` 返回成功）
- [ ] spec-review pass（`cw review submit --verdict-kind spec-review --verdict pass`）
- [ ] build 证据已提交（`cw evidence submit --kind build` 返回成功）
- [ ] verify pass（`cw verify` exit 0，全部验收 pass）
- [ ] exec-review pass（`cw review submit --verdict-kind exec-review --verdict pass`）

## 标记说明

| 标记 | 含义 |
|------|------|
| [强制] | 流程不可逾越的边界（机器层强制） |
| [MANDATORY] | 流程强制要求 |
