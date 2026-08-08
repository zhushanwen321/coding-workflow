---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw CLI. 唯一入口：bash 调 `cw create <layer>`，
  之后按返回的 nextAction.guidance 驱动全流程。guidance 是唯一导航——每步只给
  当前决策需要的最小信息（渐进式），agent 不需要记忆 action 列表。
  Not for pure analysis/research/系统设计（无代码产出的任务）。
  只有要写代码+测试的编码任务才用 CW。
---

# cw CLI（编码流程编排器）

> **唯一入口**：`cw create <layer>`。不需要记忆任何 action 列表。
> create 之后，CLI 返回的 `nextAction.guidance` 携带当前步骤需要的最小信息，
> agent 按 guidance 一步步推进，直到 `nextAction.action` 为空（流程结束）。

## 什么时候该用 / 不该用

| 场景 | 判断 | 原因 |
|------|------|------|
| 新功能 / 复杂 bug / 重构模块 | 用 CW | 有明确目标，需要 design→execute→test 完整链路 |
| 改 typo / 改配置值 / 加注释 | 不用 CW | 流程开销 >> 收益 |
| 纯调研 / 可行性分析 / 架构评估 | 不用 CW | 无代码产出 |
| 加简单工具函数（无外部依赖）| 不用 CW | 单文件单函数，无 design 必要 |

**判断标准**：如果不会走完至少 design → execute → test → closeout，就不要 create。

## 核心理念

[强制] **只暴露 create 入口**：只需调 `cw create <layer>`，后续全靠 `nextAction` 驱动。

[强制] **guidance 是唯一导航**：每次 `cw` 返回的 `nextAction.guidance` 含当前步骤需要的最小信息（位置 + 下一步命令 + input schema + 关键约束）。按 guidance 走，不自决下一阶段。**guidance 是渐进式的**——正常走时只给当前步骤信息，gate fail 时才聚焦问题。

[强制] **通过 bash 调 `cw` 命令**：agent 用 bash 工具执行 `cw <action> [flags]`，读 stdout 的 JSON。

[强制] **create 即承诺走完全流程**：`cw create` 后，所有编码工作必须通过 cw 命令推进。发现任务不适合走 CW 时，和用户确认后放弃（`cw abort`），不要静默跳过。

## 唯一入口：选层 + create

### 第 0 步：该不该用 CW（见上方表格）

### 第 1 步：选层

#### 层级关系与自动拆解

4 层 WorkUnit 构成树状拆解链，**上层 execute 时按 plan.split 自动创建下层子 unit**，guidance 随后引导 `crossLayer.descend` 下沉到第一个 child：

```
epic    （战略目标）       execute → 拆出多个 feature
  └─ feature （需求规格）    execute → 拆出多个 slice
       └─ slice  （技术方案）  execute → 拆出多个 wave
            └─ wave   （施工执行） 唯一产生代码的层（写 testCases/tasks/files/contracts）
```

> 注：`plan.split` 是 WorkUnit 的拆分清单字段（`unit.plan.split`）。

**关键认知**：选 1 个上层 unit 即可，下层会自动拆解。例如一个 feature 的需求可能拆出 3 个 slice、每个 slice 拆出 2 个 wave——你只需建那 1 个 feature，execute 时 cw 自动建 6 个 wave 孙单元，guidance 引导逐个推进。**不要手动建多个同级 unit 去凑覆盖面**。

任何一层都能无 parent 独立起步（`--parent` 可选）。

#### 怎么选：规模 × 性质

选层由 **规模（工作量）× 性质（下一步产物）** 共同决定。**先看规模，再看性质**——规模不够上高层级是常见错误：

| 规模（预估工作量） | 推荐起步层 | 理由 |
|-------------------|-----------|------|
| **1 个 wave 能搞定**（单文件 / 几个函数 / 明确的小 bug） | 直接 `wave` | 无需 design，直接施工 |
| **多个 wave，但共享一套技术方案** | 直接 `slice` | slice 的 design 写接口/数据模型，execute 自动拆出多个 wave |
| **需求模糊，需要规格化后才能拆技术方案** | `feature` | feature 先出 FR/AC/UC，execute 拆多个 slice |
| **多个独立功能方向、需战略级拆解** | `epic` | execute 拆多个 feature |

性质判据（规模介于两档之间时用）：问「下一步要写的第一份产物是什么」——能直接写 testCases→wave，需要写接口契约→slice，需要写 FR/AC/UC→feature，需要拆功能方向→epic。

#### 反模式（必读）

- ❌ **单个 slice 维度的任务，为每个 wave 手动建一个 slice** → 产出多个碎 slice。正解：建 **1 个 slice**，execute 时 cw 自动按 plan.split 拆出多个 wave，guidance 引导 descend。
- ❌ **能 1 个 wave 搞定却上 slice** → 多走 design/design-review 的开销，无收益。
- ❌ **手动建多个 wave 挂同一个 parent** → 没有 slice 层的技术方案聚合，接口/数据模型割裂。正解：建 1 个 slice 让它拆。

核心原则：**选能覆盖全貌的最小层，宁低勿高；上层会自动拆解下层，不要手动凑**。

### 第 2 步：create

```bash
# 任一层都可起步（--parent 可选，挂到已有树上）
cw create wave    --slug <kebab-case-slug> --objective "<一句话目标>" [--parent <parentId>]
cw create slice   --slug <slug> --objective "..." [--parent <featureId>]
cw create feature --slug <slug> --objective "..." [--parent <epicId>]
cw create epic    --slug <slug> --objective "..."
```

`--parent` 可选——任何一层都能无 parent 独立起步。有 parent 时挂到已有树上。

返回 JSON 含 `unitId` + `nextAction`。**记下 unitId**，后续所有调用都要传。

## 推进流程（按 nextAction 驱动）

每次 `cw` 调用返回 JSON：

```json
{
  "unitId": "wave:auth-w1",
  "status": "created",
  "ok": true,
  "nextAction": {
    "action": "design",
    "guidance": "## 位置\n[wave:auth-w1] 状态：created\n\n## 下一步\n写 design（testCases/tasks/files/contracts）...\n命令：cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json\n\n## input schema\n...",
    "unitPath": { "layer": "wave", "unitId": "wave:auth-w1", "rootUnitId": "wave:auth-w1" }
  }
}
```

**ALWAYS 按 `nextAction.action` 调下一次 `cw`**。

- `action` 非空 → 同层下一步，调 `cw <action> --unitId <id>`
- `action` 为空（undefined）→ 读 `crossLayer` 字段：
  - `crossLayer` 非空 → 跨层（下一个 unitId = `crossLayer.targetUnitId`）
  - `crossLayer` 为空 + status 终态（closed/aborted）→ 流程结束

### 两套主流程（因层而异）

**wave（ExecutionUnit）8 步**——唯一产生代码的层：

```
create → design → design-review → execute → test → exec-review → retrospect → closeout
```

**planning 层（epic/feature/slice，PlanningUnit）6 步**——无 test / exec-review（不跑代码测试、不做代码品味审查）：

```
create → design → design-review → execute → retrospect → closeout
```

> planning 层的 `execute` 不接收 input、不记录 commit，而是按 plan.split 自动创建下层 unit。wave 的 `execute` 才记录 commitHash。

每个阶段的 **input schema、关键约束、异常处理** 全部内嵌在 guidance 里，按 nextAction 走即可获得。

### 命令速查

| action | 命令 | input 方式 |
|--------|------|-----------|
| `design` | `cw design --unitId <id> --input .cw/<slug>/design.json` | JSON 文件或 stdin（**四层 input 不同，见下表**） |
| `design-review` | `cw design-review --unitId <id> --input .cw/<slug>/review.json` | JSON 文件或 stdin |
| `execute` | `cw execute --unitId <id> --commitHash <sha>` | flags（wave 记 commit；planning 层忽略 commitHash，按 split 下沉） |
| `test` | `cw test --unitId <id> --input .cw/<slug>/test.json` | JSON 文件或 stdin（**wave 专属**） |
| `exec-review` | `cw exec-review --unitId <id> --input .cw/<slug>/review.json` | JSON 文件或 stdin（**wave 专属**） |
| `retrospect` | `cw retrospect --unitId <id> --input .cw/<slug>/retrospect.json` | JSON 文件或 stdin |
| `closeout` | `cw closeout --unitId <id> --input .cw/<slug>/closeout.json` | JSON 文件或 stdin |
| `replan` | `cw replan --unitId <id> --abandonedIds '["T2"]' --note "原因"` | flags |
| `abort` | `cw abort --unitId <id> [--reason "原因"]` | flags |

`--input` 支持**文件路径**（如 `.cw/<slug>/design.json`，相对项目根）或 `-`（stdin 读管道）。

[MANDATORY] **不要直接传 JSON 字符串**——CLI 会把整段 JSON 当文件路径解析，报 `--input 文件不存在: .../{"clarifications":...}`。正确写法二选一：
- 写文件：`echo '{...}' > .cw/<slug>/<action>.json && cw <action> --input .cw/<slug>/<action>.json`
- 用 stdin：`echo '{...}' | cw <action> --input -`

guidance 给的命令已自带 `.cw/<slug>/<action>.json` 路径，中间产物按此路径写入即可（`.cw/` 已在 .gitignore，不进 git）。

### design 的 input（四层各异，最易出错）

design 是写设计方案 + 追加需求澄清问答的 action（progressive，可多次调用追加 clarifications）。四层 input 顶层都是裸对象（无包裹），但字段差异大：

| 层 | 必填字段 | 可选字段 |
|----|---------|---------|
| **wave**（DesignInput） | `testCases, tasks, files, contracts, testCommand`（无 split，wave 是叶子） | `clarifications?, abandonParentItems?` |
| **slice**（DesignSliceInput） | `split, techChoices, interfaces, dataModels, errorSpecs` | `decisions?, clarifications?, abandonParentItems?` |
| **feature**（DesignFeatureInput） | `split` | `clarifications?, spec?（覆盖本层需求规格）, abandonParentItems?` |
| **epic**（DesignEpicInput） | `split` | `clarifications?, spec?, abandonParentItems?`（epic 不消费 spec，字段仅为与 feature 同步保留） |

> `split` 是 plan.split 数据字段（拆出下层 unit 的清单）；`abandonParentItems` 声明脱离 parent 的哪些条目（append-only）；`clarifications` 是 progressive append 的澄清问答。
>
> guidance 的 schema block 会从 Input 接口自动提取并内联展开完整字段结构（**design 的 schema 源于 `src/core/plan.ts`**，其余 action 源于 `src/handlers/types.ts`），**直接照 schema block 写即可**，上表是快速参考。

### design 的 progressive 语义

`design` / `design-review` / `replan` 都是 **progressive action**——可在当前 status 原地多次调用：
- `design` 在 `created/designing/design-reviewed` 都能调。其中 `clarifications` 是 append-only（多次调用累加澄清问答）；但 `plan` 本体（testCases/split/tasks/files/contracts）是**整体替换**——每次调用都用本次 input 覆盖之前的 plan。所以补充澄清时直接再调一次 `cw design` 没问题（不必开新 unit），但**必须带上完整的 plan 字段**，只补 clarifications 会把之前的 plan 清空。
- `design-review` 在 `designing/design-reviewed` 都能调，多次审查 OK。
- `replan` 是旁路（不改 status），在 `design-reviewed` 之后的多个 status 都能调。

## guidance 的渐进式特性

guidance 是**渐进式**的——每个 action 返回的 guidance 只包含「当前决策需要的最小信息」：

- **正常走（ok=true）**：三段式（位置 / 下一步+命令 / input schema+关键约束）
- **gate fail（ok=false）**：四段式（位置 / 问题 / 怎么修 / 递进提示）
  - 第 1 次 fail：只说问题
  - 第 2 次 fail 起：加三出口（回到 design 当前阶段 / replan / abort）
  - 第 5 次 fail：强烈建议先 abort 跳出重审（**cw 永不阻断**，熔断只换文案，不阻止重试）

**replan 的三层渐进**（解决「agent 不知道 replan 存在就调不了」的悖论）：
1. design 阶段的 guidance 关键约束段提及「条目 execute 后冻结，修改走 replan」
2. gate fail 递进提示里提到 replan 出口
3. replan action 触发后才给完整操作细节（影响面 + append-only 机制 + 重走 design-review）

## 跨层导航（closeout 后）

子单元 closeout 后，`nextAction.action = undefined`，读 `crossLayer`：
- 有 parent + 有未终态兄弟 → 指向下一个兄弟（横向 sibling）
- 有 parent + 所有兄弟终态 → 指向父单元 retrospect（回溯 ascend）
- 无 parent → 流程结束（孤立终点）

> 递归编排模式下 crossLayer 路由会被抑制（改由调度器派发），见末尾「进阶：递归编排模式」。

## 数据存储

- 状态库：`~/.cw/<encodedCwd>/store.json`（per-cwd 隔离，`CW_HOME` 环境变量可覆盖默认 `~/.cw`）
- unitId 格式：`{scope}:{slug}`（如 `wave:auth-w1`、`slice:auth::token-exchange`，child slug = `${parentSlug}::${splitSlug}`）
- 跨 session 接续 / 交接：`cw handoff --unitId <id>`（首选，见下方只读查询）

## 只读查询命令（不经 dispatch、不写 store）

| 命令 | 用途 |
|------|------|
| `cw list [flags]` | unit 表格定位（见下方「list 定位 topic」），扫当前/跨 cwd 用 |
| `cw tree [--unitId <id>]` | 以某 unit 为根的父子树（缩进），看拆解结构用 |
| `cw status --unitId <id>` | 单 unit 的完整 JSON dump，程序化消费用（含全部字段原样透传，`--full` 不截断） |
| `cw handoff --unitId <id> [--scope self\|upstream\|full]` | **交接首选**——单 unit 的五段式叙述性摘要（目标/已定决策/当前位置与下一步/涉及文件与契约/历史），给 agent 或人读 |
| `cw frontier --root <id>` | 以某 unit 为根，列出所有非终态节点 + 各自可推进性（`blocked`/`blockedReason`/`dependsOn`）。**递归调度器（BFS）的主循环驱动**——每轮调取可推进节点（见「进阶：递归编排模式」） |

### list 定位 topic（新 agent 接手的第一步）

`cw list` 是定位 topic 的命令。零参数默认 = 当前 cwd 最近 10 个 unit（updatedAt DESC）。

**flags**：
- 无参数 → 当前 cwd 最近 10 个（**90% 接手场景用这个**）
- `--limit N` / `--offset N` → 分页（默认 limit=10）
- `--grep <keyword>` → slug + objective 大小写不敏感 substring 过滤
- `--all` → 跨所有 cwd 遍历（扫 CW_HOME 全部 store，按 repo/branch 分组带 group header；**与 `--cwd` 互斥**）
- `--cwd <path>` → 指定查别的 cwd（**必须绝对路径**，不 cd）
- `--long` → 追加 children/created 列
- `--layer epic|feature|slice|wave` → 按 scope 过滤

**防误用四条（必须遵守）**：

1. **一般不加参数即可**。默认就是最近 10 个当前 cwd topic，覆盖 90% 接手场景。
2. **看到 `Showing X–Y of Z` 时**，如果 Z 远大于当前页，**优先用 `--grep` 收窄**，不要无脑 `--offset` 翻页（浪费 token）。
3. **当前 cwd 没命中时才用 `--all`**——它会扫整个 CW_HOME，开销大。
4. **拿 unitId 后必须 handoff**——list 只给定位（unitId + status + objective），不给上下文。`cw handoff --unitId <id>` 才是真正接手（五段式 markdown 重建认知）。

**接手标准流程（≤ 3 次 cw 调用）**：

```
cw list                          # 当前 cwd 最近 10 个，肉眼认
  ↓ 没命中
cw list --grep "关键词"           # 或 --all 跨 cwd
  ↓ 拿到 unitId（+ --all 的正确 cwd）
[若提示需切 cwd] cd <正确 worktree>
cw handoff --unitId <id>         # 五段式 markdown，开干
```

**交接场景**（开发到一半换 agent 接手）：接手 agent 跑 `cw handoff --unitId <id>` 即可重建认知——输出含目标、之前的设计决策（design 含 clarifications + design-review 取舍/风险）、当前停在哪、下一步该跑什么命令 + 阶段 guidance（input schema + 关键约束）、涉及的文件与接口契约、完整变更历史。handoff 复用 buildNextAction 生成 guidance，与实际跑 action 返回的 guidance 逐字一致。

- wave / slice / feature / epic 四层均完整支持（handoff 按 scope 调对应的 build{Scope}NextAction 生成 guidance）
- handoff 不落盘文件（守「store 是唯一真相」不变量），需保存输出自己 redirect
- 缺 `--unitId` 或 unitId 不存在 → exit 1

## 前置检查

[MANDATORY] 启动前：
- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow` 或用 dev-link skill 切本地开发版
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（execute 需要真实 commit）
- **workspace 可写**：中间产物（input JSON）落在 `<cwd>/.cw/<slug>/`（已 gitignore）；报告类文档视情况存 docs/

## 失败模式

### illegal_transition（跳阶段）
调了状态机不允许的 action → CwEngineError（exit 1）。看 `cw status --unitId <id>` 确认当前 status，按 nextAction 重来。

### design input 写错的两类失败
design 阶段没有自己的 gate，但 input 仍会过 **strict schema 校验**（`additionalProperties: false`），按错误性质分两类：

- **结构错（立即失败）**：顶层多了/少了 key、字段名拼错（如误用 `{design:{...}}` 多包一层、`testCases` 拼成 `testcase`）→ cw **立即抛 CwError（exit 1）**，不会写入 store。这是机器层硬约束。
- **语义不充分（延迟到 design-review gate 失败）**：结构合法但内容空洞（如 `testCases` 为空数组、`contracts` 缺关键接口）→ 写入 store 成功，到 `design-review` 的 gate 才报错。

所以「立即失败 vs 延迟失败」取决于错误性质。写完后用 `cw status --unitId <id>` 确认字段正确存储（尤其排查语义层问题）。

> 顶部包裹规则：design 是裸对象（无包裹，直接 `{testCases,...}` 或 `{split,...}`）；design-review/test/exec-review/retrospect 是 `{xxxJudgment:{...}}` / `{retrospectData:{...}}` 包裹；closeout 是 `{summary?, artifacts?}`；replan 是扁平 `{abandonedIds, note}`。guidance 的 schema block 会显示完整结构，照写即可。

### gate fail
返回 `ok: false` + `gateResults` + 异常 guidance（四段式）。**不要慌**——guidance 的「问题」段会告诉你具体哪里错了，「怎么修」段告诉你修正后重提什么命令。

### unit not found
unitId 不对（跨 worktree/子目录/session）。`node -p "process.cwd()"` 确认实际路径，回到创建 unit 时的目录。

### 任务不适合走 CW（abort）
发现任务走偏、不适用时，和用户确认后调 `cw abort --unitId <id>`。status 流到 aborted 终态。

## 进阶：递归编排模式（条件触发）

> ⚠️ 本节是**可选的进阶模式**，依赖外部生态。默认线性模式（agent 直接 bash 调 cw，按上文流程走）已能满足所有场景。**仅当下面三个前提同时满足时**才考虑切换到递归编排。缺任一前提，请忽略本节，继续用线性模式。

### 三前提（缺一不可）

递归编排模式 = 一个主 agent 当调度器，用 `cw frontier` BFS 驱动多个 cw 适配 subagent 并行推进整棵 WorkUnit 树（而非单 agent 线性逐层 descend）。它依赖以下生态，**三者必须同时满足**：

1. **处于 pi coding-agent 环境**（或基于 pi 的 coding-agent）：
   ```bash
   [ "$PI_CODING_AGENT" = "true" ] && echo "PI_ENV=yes" || echo "PI_ENV=no"
   ```
2. **cw 适配 subagent 已被 pi 发现并加载到系统提示词**——当前 `<available_subagents>` 段应含：`planning-agent` / `wave-agent` / `dev-agent` / `review-agent` / `merge-agent`（注意 `planner` ≠ `planning-agent`，必须全名精确匹配）。
3. **cw-tool 已安装**（提供 cw_planning / cw_wave / cw_dev / cw_review 四个 role-restricted 工具）：
   ```bash
   ls -d "$HOME/.pi/agent/npm/node_modules/@zhushanwen/pi-cw-tool" 2>/dev/null \
     && echo "CW_TOOL=npm-installed" || echo "CW_TOOL=not-installed"
   # 或 xyz-agent dev-link 环境：echo "${XYZ_EXTENSION_PATHS:-}" | tr ':' '\n' | grep -i cw-tool
   ```

任一为假 → 留在默认线性模式。

### 生态归属（重要）

递归编排生态**不属于 coding-workflow**，属于 **xyz-agent 项目**：

| 组件 | 归属 | 作用 |
|------|------|------|
| recursive-split skill | xyz-agent | 教主 agent 如何当调度器 |
| cw-tool（@zhushanwen/pi-cw-tool） | xyz-agent | 把 cw 命令包成 pi 工具，按 role 限制可调 action |
| cw 适配 agent（planning/wave/dev/review/merge-agent） | xyz-agent（project-agent） | 各层执行/审查/合并的专用角色 |

> cw 适配 agent 是 xyz-agent 的 **project-agent**（定义在 `.agents/agents/`），仅当 workspaceRoot 指向 xyz-agent worktree 时才被 pi 的 `project-agents` 发现源自动发现。在别的项目里默认发现不了——需要 link 到全局发现源（`~/.pi/agent/agents/` 或 `~/.agents/agents/`）或打成 npm pi-package 安装。

### 调用链变化（条件满足时）

- **默认线性模式**：agent 直接 bash 调 `cw`（本 skill 上文所有内容）。
- **递归编排模式**：主 agent 只 `cw create <顶层>` + 派发第一个 planning-agent；cw 适配 agent **不直接 bash 调 cw**，而是通过 cw-tool 的 4 个 role 工具调（工具白名单硬约束「层主不写码 / review 不改被审物」）；主 agent 用 `cw frontier --root <顶层>` 每轮取可推进节点决定派谁，子 agent 完成后 steer 唤醒主 agent（事件驱动，无轮询）。

### frontier 作为调度主循环

`cw frontier --root <rootUnitId>` 返回整棵树的非终态节点 + 各自 `blocked`/`dependsOn`。调度器每轮：
1. 调 frontier 取 `advanceableCount`（非 blocked 节点）
2. 对每个可推进节点，按 scope 派对应 cw 适配 agent（planning 层 → planning-agent，wave 层 → wave-agent）
3. 各 subagent 线性走 cw 流程（design → design-review → execute → ...）
4. 子完成唤醒父，父汇总后继续 frontier 下一轮，直到全树 closed

> 失败恢复分 L0-L3（gate fail 原地改 / replan / 父级 replan 级联 / 人工介入），细节见 xyz-agent 的 recursive-split skill `design-v4.md`。

### 不满足前提时怎么办

如果想用递归编排但环境不满足：
- 条件①假（非 pi 环境）：递归编排依赖 pi 的 subagent 派发机制，无法用，坚持线性模式。
- 条件②假（subagent 未发现）：把 cw 适配 agent 的 `.md` link 到 `~/.pi/agent/agents/` 或 `~/.agents/agents/`，重启 session。
- 条件③假（cw-tool 未装）：`pi install npm:@zhushanwen/pi-cw-tool`（纯 pi 环境）或在 xyz-agent worktree 用 dev-link skill 的 `link-local.sh cw-tool`。

具体安装/配置步骤以 xyz-agent 项目的 recursive-split skill 和 cw-tool README 为准（本 skill 不负责该生态的安装）。

## Self-Check

[MANDATORY] 以下全部满足才算流程走完：
- [ ] 从 `cw create` 开始，没有绕过状态机
- [ ] 每次 `cw` 调用后读 `nextAction`，按它的 `action` 调下一次
- [ ] closeout 后 `nextAction.action` 为空（终态）
- [ ] `nextAction.guidance` 每步都非空

## 标记说明

| 标记 | 含义 |
|------|------|
| [强制] | 流程不可逾越的边界（机器层强制） |
| [MANDATORY] | 流程强制要求 |
