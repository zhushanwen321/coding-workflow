---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw v1 CLI. 唯一入口：bash 调 `cw v1 create <layer>`，
  之后按返回的 nextAction.guidance 驱动全流程。guidance 是唯一导航——每步只给
  当前决策需要的最小信息（渐进式），agent 不需要记忆 action 列表。
  Not for pure analysis/research/design. 不适合纯分析/调研任务——
  只有要写代码+测试的编码任务才用 CW。
---

# cw v1 CLI（编码流程编排器）

> **唯一入口**：`cw v1 create <layer>`。不需要记忆任何 action 列表。
> create 之后，CLI 返回的 `nextAction.guidance` 携带当前步骤需要的最小信息，
> agent 按 guidance 一步步推进，直到 `nextAction.action` 为空（流程结束）。

## 什么时候该用 / 不该用

| 场景 | 判断 | 原因 |
|------|------|------|
| 新功能 / 复杂 bug / 重构模块 | 用 CW | 有明确目标，需要 plan→execute→test 完整链路 |
| 改 typo / 改配置值 / 加注释 | 不用 CW | 流程开销 >> 收益 |
| 纯调研 / 可行性分析 / 架构评估 | 不用 CW | 无代码产出 |
| 加简单工具函数（无外部依赖）| 不用 CW | 单文件单函数，无 plan 必要 |

**判断标准**：如果不会走完至少 plan → execute → test → closeout，就不要 create。

## 核心理念

[强制] **只暴露 create 入口**：只需调 `cw v1 create <layer>`，后续全靠 `nextAction` 驱动。

[强制] **guidance 是唯一导航**：每次 `cw v1` 返回的 `nextAction.guidance` 含当前步骤需要的最小信息（位置 + 下一步命令 + input schema + 关键约束）。按 guidance 走，不自决下一阶段。**guidance 是渐进式的**——正常走时只给当前步骤信息，gate fail 时才聚焦问题。

[强制] **通过 bash 调 `cw v1` 命令**：agent 用 bash 工具执行 `cw v1 <action> [flags]`，读 stdout 的 JSON。

[强制] **create 即承诺走完全流程**：`cw v1 create` 后，所有编码工作必须通过 cw 命令推进。发现任务不适合走 CW 时，和用户确认后放弃（`cw v1 abort`），不要静默跳过。

## 唯一入口：选层 + create

### 第 0 步：该不该用 CW（见上方表格）

### 第 1 步：选层（按工作性质，不按规模）

4 层 WorkUnit，两种类型。**任何一层都能独立起步**（parent 全可选）：

| 层 | 类型 | 工作性质 | 什么时候选 |
|----|------|---------|-----------|
| **wave** | ExecutionUnit（9步） | 施工执行——能直接写 testCases + files + contracts | 技术方案已清晰，直接施工 |
| **slice** | PlanningUnit（7步） | 技术方案化——需要定义接口契约/数据模型/技术选型 | 知道做什么，需要设计怎么做 |
| **feature** | PlanningUnit（7步） | 需求规格化——需要把模糊需求变成可验收规格（FR/AC/UC）| 需求模糊，需要规格化 |
| **epic** | PlanningUnit（7步） | 战略翻译——需要拆成多个独立功能方向 | 多功能协作的大型目标 |

判别核心：问自己「我下一步要写的第一份产物是什么」——能直接写 testCases→wave，需要写技术契约→slice，需要写 FR/AC/UC→feature，需要拆功能方向→epic。

### 第 2 步：create

```bash
# wave（最常用，唯一产生代码的层）
cw v1 create wave --slug <kebab-case-slug> --objective "<一句话目标>" [--parent <parentId>]

# slice / feature / epic（PlanningUnit，当前暂未实现 handler，仅 wave 可用）
cw v1 create slice  --slug <slug> --objective "..." [--parent <featureId>]
cw v1 create feature --slug <slug> --objective "..." [--parent <epicId>]
cw v1 create epic   --slug <slug> --objective "..."
```

`--parent` 可选——任何一层都能无 parent 独立起步。有 parent 时挂到已有树上。

返回 JSON 含 `unitId` + `nextAction`。**记下 unitId**，后续所有调用都要传。

## 推进流程（按 nextAction 驱动）

每次 `cw v1` 调用返回 JSON：

```json
{
  "unitId": "wave:auth-w1",
  "status": "created",
  "ok": true,
  "nextAction": {
    "action": "clarify",
    "guidance": "## 位置\n[wave:auth-w1] 状态：created\n\n## 下一步\n澄清需求...\n命令：cw v1 clarify --unitId wave:auth-w1 --input @clarify.json\n\n## input schema\n...",
    "unitPath": { "layer": "wave", "unitId": "wave:auth-w1", "rootUnitId": "wave:auth-w1" }
  }
}
```

**ALWAYS 按 `nextAction.action` 调下一次 `cw v1`**。

- `action` 非空 → 同层下一步，调 `cw v1 <action> --unitId <id>`
- `action` 为空（undefined）→ 读 `crossLayer` 字段：
  - `crossLayer` 非空 → 跨层（下一个 unitId = `crossLayer.targetUnitId`）
  - `crossLayer` 为空 + status 终态（closed/aborted）→ 流程结束

### wave 的 9 步流程

```
create → clarify → plan → design-review → execute → test → exec-review → retrospect → closeout
```

每个阶段的 **input schema、关键约束、异常处理** 全部内嵌在 guidance 里，按 nextAction 走即可获得。

### 命令速查

| action | 命令 | input 方式 |
|--------|------|-----------|
| `clarify` | `cw v1 clarify --unitId <id> --input @clarify.json` | JSON 文件或 stdin |
| `plan` | `cw v1 plan --unitId <id> --input @plan.json` | JSON 文件或 stdin |
| `design-review` | `cw v1 design-review --unitId <id> --input @review.json` | JSON 文件或 stdin |
| `execute` | `cw v1 execute --unitId <id> --commitHash <sha>` | flags |
| `test` | `cw v1 test --unitId <id> --input @test.json` | JSON 文件或 stdin |
| `exec-review` | `cw v1 exec-review --unitId <id> --input @review.json` | JSON 文件或 stdin |
| `retrospect` | `cw v1 retrospect --unitId <id> --input @retrospect.json` | JSON 文件或 stdin |
| `closeout` | `cw v1 closeout --unitId <id> --input @closeout.json` | JSON 文件或 stdin |
| `replan` | `cw v1 replan --unitId <id> --abandonedIds '["T2"]' --note "原因"` | flags |
| `abort` | `cw v1 abort --unitId <id> [--reason "原因"]` | flags |

`--input` 支持 `@file.json`（读文件）、`-`（stdin）、或直接传 JSON 字符串。

## guidance 的渐进式特性

guidance 是**渐进式**的——每个 action 返回的 guidance 只包含「当前决策需要的最小信息」：

- **正常走（ok=true）**：三段式（位置 / 下一步+命令 / input schema+关键约束）
- **gate fail（ok=false）**：四段式（位置 / 问题 / 怎么修 / 递进提示）
  - 第 1 次 fail：只说问题
  - 第 3 次 fail：加三出口（回到 clarify / replan / abort）
  - 第 5 次 fail：强烈建议先 abort 跳出重审

**replan 的三层渐进**（解决「agent 不知道 replan 存在就调不了」的悖论）：
1. plan 阶段的 guidance 关键约束段提及「条目 execute 后冻结，修改走 replan」
2. gate fail 递进提示里提到 replan 出口
3. replan action 触发后才给完整操作细节（影响面 + append-only 机制 + 重走 design-review）

## 跨层导航（closeout 后）

wave closeout 后，`nextAction.action = undefined`，读 `crossLayer`：
- 有 parent + 有未终态兄弟 wave → 指向下一个兄弟（横向）
- 有 parent + 所有兄弟终态 → 指向父单元 retrospect（回溯）
- 无 parent → 流程结束（孤立终点）

## 数据存储

- v1 状态库：`~/.cw/<encoded-cwd>/_v1.json`（per-cwd 隔离）
- 0.x 状态库：`~/.cw/<encoded-cwd>/_cw.json`（0.x 命令用，与 v1 隔离）
- unitId 格式：`{scope}:{slug}`（如 `wave:auth-w1`）
- 跨 session 接续：`cw v1 status --unitId <id>` 看当前进度，再按 nextAction 继续

## 前置检查

[MANDATORY] 启动前：
- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow` 或用 dev-link skill 切本地开发版
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（execute 需要真实 commit）
- **workspace 可写**：交付物落在 `<cwd>/.xyz-harness/<slug>/`

## 失败模式

### illegal_transition（跳阶段）
调了状态机不允许的 action → V1Error（exit 1）。看 `cw v1 status --unitId <id>` 确认当前 status，按 nextAction 重来。

### gate fail
返回 `ok: false` + `gateResults` + 异常 guidance（四段式）。**不要慌**——guidance 的「问题」段会告诉你具体哪里错了，「怎么修」段告诉你修正后重提什么命令。

### unit not found
unitId 不对（跨 worktree/子目录/session）。`node -p "process.cwd()"` 确认实际路径，回到创建 unit 时的目录。

### 任务不适合走 CW（abort）
发现任务走偏、不适用时，和用户确认后调 `cw v1 abort --unitId <id>`。status 流到 aborted 终态。

## Self-Check

[MANDATORY] 以下全部满足才算流程走完：
- [ ] 从 `cw v1 create` 开始，没有绕过状态机
- [ ] 每次 `cw v1` 调用后读 `nextAction`，按它的 `action` 调下一次
- [ ] closeout 后 `nextAction.action` 为空（终态）
- [ ] `nextAction.guidance` 每步都非空

## 0.x 兼容

`cw create`（不带 v1）仍走 0.x 流程（单层 topic 模型）。0.x 代码在 `src/legacy/`，功能不变。旧版 skill 见 `cw-cli-archive`。新任务推荐用 `cw v1`。

## 标记说明

| 标记 | 含义 |
|------|------|
| [强制] | 流程不可逾越的边界（机器层强制） |
| [MANDATORY] | 流程强制要求 |
