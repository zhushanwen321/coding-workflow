# cw 每 unit 独立 worktree 升级设计（M2）

> **一句话结论**：把 runner 派发给 agent 的工作区从「项目共享 cwd」升级为「每 unit 一个 git worktree + 独立分支」，账本、证据、verify 语义钉在项目仓库不动，物理消除并行 commit 混卷、串行脏读、untracked 污染三类工作区污染。
>
> **层声明**：当前层 = 技术方案（worktree 机制如何接入 runner/spawn）；下一层 = 实现计划（波次拆分与文件改动地图，§5）。不跨到测试用例粒度。
> **输入依据**：canon 终态设计 `.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`（下称 canon）；差距清单 `docs/rewrite/handoff-worktree-isolation.md`。本文引用的全部代码锚点与 git 行为断言已于 2026-08-17 逐条实测核实（探针结果见 §3.4）。

## 1. 背景目标

**每个 unit 的 agent 在物理隔离的 git worktree 里干活，commit 可审计、半成品不外溢、成果经 root 分支汇聚回流——账本与 verify 机制零改动。**

- **S（情境）**：cw 是「Agent CI」——一个根任务递归拆成 unit 树（深度 ≤2），runner 循环按 `maxConcurrency`（默认 3）把就绪 unit 派发给 designer / builder / reviewer 三种角色 agent 并行推进，状态唯一来源是事件账本（`~/.cw/<encoded-cwd>/events.log`，append-only）。
- **C（冲突）**：当前所有 agent 共享项目 cwd 干活（M1 简化，`src/runner/loop.ts:48`）。并行意味着两个 builder 同时改同一目录的文件：commit 混卷、脏读、untracked 污染三类失败模式真实存在（§2.3），终验 PASS 含运气成分。
- **Q（问题）**：如何让每个 unit 的 agent 在物理隔离的工作区干活，同时账本定位、证据链、verify 重跑、投影语义全部不变？
- **A（答案）**：每 unit 一个 git worktree（`~/.cw-worktrees/<encoded-cwd>/<unitId>`）+ 每 unit 一个分支；账本与仓库操作锚定项目 cwd，agent 工作区与产物去 worktree；子 unit 成果经 merge 汇聚到 root 分支。本文展开这个答案。

### 1.1 关键术语（首次出现即锚定）

| 术语 | 定义 | 物理锚点 |
|------|------|---------|
| **unit** | 任务树节点，runner 派发的最小单位（slug 规则 `^[a-z][a-z0-9-]*$`，`src/handlers/create.ts:29-31`） | 账本 `UnitCreated` 事件 |
| **账本** | append-only 事件日志，cw 唯一状态源 | `~/.cw/<encoded-cwd>/events.log`，encoded 由 `encodeCwd`（`src/store/project.ts:52-57`）产出，形如 `__Users__x__proj-3f2a9c1d` |
| **worktree** | git 原生机制：同一仓库检出多个独立工作目录，各自有 HEAD，**共享 object store** | 本设计新增：`~/.cw-worktrees/<encoded-cwd>/<unitId>` |
| **cleanCheckout** | verify 重跑的干净工作区机制：mkdtemp 内 `git clone` 项目仓库 + checkout 目标 commit（detached）+ porcelain 自证 | `src/verify/checkout.ts`（M0 已实现，commit `df432b0`） |
| **证据链** | agent 产出（commit hash、stdout/stderr 路径）经 `EvidenceSubmitted` 事件入账，供 gate 审计 | 账本事件 + `~/.cw/<encoded-cwd>/evidence/` |

### 1.2 设计目标（从 runner 与人类接手者体验倒推）

- **G1 并行隔离**：两个 builder 同时改同一文件，各自 commit 只含各自产出（`git show --stat <hash>` 可审计「这个 commit 是谁的」）。
- **G2 串行洁净**：失败 agent 的半成品（tracked 脏 + untracked 产物）不进入任何后续派发——重派时工作区全净。
- **G3 verify 真值不回归**：重跑只信账本 commit、不信工作区现状（现有 cleanCheckout 已保证，升级后必须仍成立）。
- **G4 人可接手**：unit 转人工后，人按指引 cd 到该 unit 的 worktree 能接着干，且人执行的 cw 命令正常入账本。
- **G5 成果可回流**：run 结束（root closed）后，全部已集成产出承载在 root 分支上，用户一条 `git merge` 即可回流主分支。

### 1.3 scope

- **in scope**：runner/spawn 层的 workdir 拆分（项目 cwd vs worktree）、worktree 生命周期（创建/复用/回收）、reset 语义回归 canon、集成 verify 的 commit 汇聚、转人工指引路径、测试断言迁移。
- **out of scope**：账本 schema 与事件类型（零变更，baseCommit 复用既有 `SpecSubmitted.commit`）；frontier/投影逻辑（frontier = 由账本事件 fold 出的「哪些 unit 就绪」确定性视图，纯函数读账本，与 workdir 无关，零改动）；cleanCheckout 机制本身（M0 已落地）；`CW_HOME` 与 evidence 目录布局（不变）。

## 2. 现状与问题分析

**根因一句话：agent 的「工作间」与「项目仓库」是同一个目录——workdir 从 CLI 入口到子进程全链路纯透传项目 cwd，无任何隔离层。**

### 2.1 现状：workdir 纯透传链路（真实代码）

`workdir` 从 `process.cwd()` 出发直达 agent 子进程，中间零改写：

```
src/cli.ts:38        dispatch(argv, process.cwd())          ← src/ 全目录唯一 process.cwd()
  → dispatch.ts      ctx.cwd
  → handlers/run.ts:153  RunLoopOptions.cwd = ctx.cwd
  → loop.ts:982      AgentSpawnRequest.workdir = opts.cwd
  → pi.ts:103        spawn(..., { cwd: req.workdir })        ← agent 子进程的工作目录
  → human.ts:106     [human] cd ${req.workdir}               ← 人接手时的工作目录
```

workdir 同时承担四种角色，全部绑死在项目 cwd 上：

1. **agent 工作区**（pi.ts:103 子进程 cwd）——agent 在此改文件、commit；
2. **产物落盘根**：`<workdir>/.cw-spawn/<unitId>.<role>.stdout/.stderr/.brief.md`（`loop.ts:625`、`pi.ts:84-85`）；
3. **账本定位入参**：`loop.ts:853/880` 用 `opts.cwd` 推导账本路径；`human.ts:122` 更直接用 `req.workdir` 调 `ledgerPath(cwHome, req.workdir)`；
4. **派发前清理对象**：`checkWorkspaceForDispatch`（`loop.ts:799-826`）对 `opts.cwd` 的 tracked 脏改动 `git reset --hard HEAD`。

### 2.2 物理数据流（现状）

```
项目 cwd（= 仓库 = 所有 agent 的工作间）
  ├── src/…                      ← builder A、builder B 同时改这里的文件
  ├── .cw-spawn/                 ← 所有 unit 的 brief/stdout/stderr 混落在此
  └── .git（HEAD 被各 agent 的 commit 轮流推动）

~/.cw/<encoded-cwd>/events.log   ← 账本：loadLedger(opts.cwd) 定位，与工作区同 key
~/.cw/<encoded-cwd>/evidence/    ← 证据产物（不进工作区，此布局升级后不变）
```

### 2.3 真实失败模式（三类，MECE）

**A. 并行 commit 混卷（不可审计）**。`maxConcurrency=3` 时最多 3 个 agent 同写项目 cwd。场景：builder A（unit-login）和 builder B（unit-logout）都改了 `src/app.ts`；A 先执行 `git add -A && git commit`——B 的半成品被一起卷进 A 的 commit。该 commit hash 经 `EvidenceSubmitted` 进证据链后，「A 的产出 = commit X」的审计声明不再成立：commit X 里混着 B 的东西。近似清理（`checkWorkspaceForDispatch`）对此**完全无效**——它只在无 in-flight 时触发（`loop.ts:960`），并行窗口期是它的盲区。

**B. 串行脏读（近似缓解的残留盲区）**。builder A 失败退出，留下改了一半的 tracked 文件。无 in-flight 时下一轮派发前近似 reset 会清掉（8a1f846 的保护垫）；但**有 in-flight 时只提示不清理**——窗口期内派发的 agent 读到 A 的尸体，把它当当前代码状态。

**C. untracked 污染（近似实现刻意不保）**。近似 reset 刻意不动 untracked（防误删用户文件），代价是 builder 的构建产物、临时脚本（untracked）永远残留，污染后续所有派发。共享 cwd 下这是无法两全的权衡：清，可能误删用户文件；不清，污染必然。

### 2.4 根因

三类失败模式同一个根：**工作区复用**。canon 的数据流图（326 行）本就把「派发出去的工作间」设计为 `~/.cw-worktrees/<unitId>` 独立 worktree，M1 为跑通闭环简化成共享 cwd（canon 336 行实现现状注记）。workdir 的四种角色（§2.1）里，只有「agent 工作区」和「产物落盘根」应该去 worktree；「账本定位」和「仓库操作」必须钉在项目 cwd——升级的本质是把这两组角色拆开（§3.3 D3），而不是整体换路径。

### 2.5 已具备机制（不重复设计）

- **cleanCheckout（G3 的载体）**：M0 已实现（commit `df432b0`），mkdtemp + `git clone --quiet <repoDir>` + detached checkout + `git status --porcelain` 干净性自证；`handlers/verify.ts:117` 与集成入口 `integrate.ts:130` 均在用。canon P7 探针状态列仍为 ⛔（canon 352 行）——是**探针验证未勾**，不是机制缺失。本设计不重建它，只在 §4 场景 3 防回归、§5 勾验探针。
- **近似 reset**（`loop.ts:799-826`）：升级后被精确语义替换（§3.3 D4），届时整体删除。

## 3. 解决方案

**终态一句话：runner 派发前为 unit 创建专属 worktree 与分支，agent 的一切文件操作与 commit 发生在其中；账本、证据目录、cleanCheckout 的 clone 源始终锚定项目仓库；子成果经 merge 汇聚到 root 分支供用户回流。**

### 3.1 终态（使用者视角）

**runner 一次成功 run 的完整输出（成功路径）**：

```
$ cw run
[runner] root design 冻结 @ commit a1b2c3d（分支 cw/<rootId>）
[runner] spawn builder(unit-login)  → worktree ~/.cw-worktrees/__Users__x__proj-3f2a9c1d/unit-login（分支 cw/unit-login）
[runner] spawn builder(unit-logout) → worktree ~/.cw-worktrees/__Users__x__proj-3f2a9c1d/unit-logout（分支 cw/unit-logout）
   …两个 builder 各自在自己 worktree 改 src/app.ts、各自 commit、cw evidence submit（账本经注入的锚点写回项目账本）…
[runner] unit-login  gate PASS → merge cw/unit-login → cw/<rootId>
[runner] unit-logout gate PASS → merge cw/unit-logout → cw/<rootId>
[runner] root closed。已回收 worktree × 2；保留 × 0。
         成果分支：cw/<rootId>（含全部已集成子产出）
         👉 回流主分支：git merge cw/<rootId>
```

**转人工路径（人接手视角）**：

```
[human] builder 指令：unit "unit-export"（转人工——由人执行）
[human]   cd ~/.cw-worktrees/__Users__x__proj-3f2a9c1d/unit-export
[human]   cat .cw-spawn/unit-export.builder.brief.md
[human]   完成后提交：cw evidence submit --unit unit-export --commit <hash>（cw 命令经 CW_PROJECT_DIR 锚定项目账本，人在 worktree 里直接执行即可）
```

**失败路径与恢复指引**：

| 失败场景 | 表现 | 恢复指引 |
|---|---|---|
| worktree 创建失败：分支已存在（上次 run 异常退出的残留） | `fatal: a branch named 'cw/unit-login' already exists`（探针 P-wt1b 实测 exit 255）→ runner 报 env error | 👉 `git worktree list` 查残留；确认无未保存产出后 `git worktree remove --force <path> && git branch -D cw/<unitId>`，重跑 `cw run` |
| worktree 创建失败：磁盘满 | mkdtemp/add 返回 ENOSPC → runner 报 env error | 👉 清理 `~/.cw-worktrees/` 下历史目录后重跑 |
| 集成 merge 冲突（两个子改了同一文件的同一区域） | runner 在 root worktree merge 时冲突 → 该集成步骤转人工 | 👉 指引打印 root worktree 路径，人 cd 过去解决冲突、commit，再 `cw evidence submit` 推进 |
| worktree 回收时含脏残留 | `git worktree remove` 拒绝（探针 P-wt4 实测 exit 128） | 设计内行为：closed unit 的回收用 `--force`（产出已进证据链与 root 分支，残留可弃）；非 closed 的一律保留不回收 |

**终态物理数据流（对照 §2.2 现状）**：

```
项目 cwd（仓库本体）
  └── .git ← object store 共享：worktree 内 commit 此处立即可见（探针 P-wt2）

~/.cw-worktrees/<encoded-cwd>/
  ├── unit-login/    ← builder(unit-login) 的独立工作区，分支 cw/unit-login
  │     └── .cw-spawn/unit-login.builder.{brief.md,stdout,stderr}
  └── unit-logout/   ← builder(unit-logout) 的独立工作区，分支 cw/unit-logout
        └── .cw-spawn/unit-logout.builder.{brief.md,stdout,stderr}

~/.cw/<encoded-cwd>/events.log   ← 账本位置不变；agent/人的 cw 命令经 CW_PROJECT_DIR 锚定到这里
~/.cw/<encoded-cwd>/evidence/    ← 证据目录不变

gate/verify：cleanCheckout（clone 项目仓库 → checkout 账本 commit）——机制不变，
            clone 携带 cw/* 分支 refs（探针 P-wt3），集成 verify checkout root 分支 HEAD
```

### 3.2 多方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：每 unit git worktree + 独立分支**（推荐） | ✅ 工作间/仓库分离归位；object store 共享使 commit 天然回流（探针 P-wt2），证据链可审计 by construction | 中：新增 worktree 生命周期模块 + spawn 链路拆双路径 + 39 处测试断言迁移 | 低：git 原生机制，6 条核心断言全部实测通过（§3.4） | ✅ |
| B：每 unit mktemp + `git clone`（复用 cleanCheckout 模式） | ❌ clone 是单向拷贝——agent commit 留在一次性目录里，需额外补丁回传/push 机制才能进项目仓库；commit hash 指向将被删除的 clone，审计悬空 | 中（机制可复用）但回传机制是新增复杂度 | 高：回传机制 = 新断言源；临时目录生命周期与证据链脱节 | ❌ |
| C：维持共享 cwd + 强化清理（加 `git clean -fd` + 文件锁） | ❌ 不治根：并行窗口内两个 builder 仍同写一个目录，失败模式 A（commit 混卷）物理上无法消除 | 低（改动最小） | 高：`clean -fd` 在共享 cwd 下会误删用户文件（§2.3 C 的权衡依旧）；锁机制引入新复杂度 | ❌ |

**被否方案若采用，§2.3 的例子会变成什么样**：

- **若用 B**：builder A 在 `/tmp/cw-clone-xxx` 里 commit 了 `a1b2c3`，evidence 入账；runner 回收临时目录后，任何人 `git show a1b2c3` 得到 `fatal: bad object`——证据链的 commit 审计声明永久失效，除非再设计一套补丁回传机制（新机制 = 新断言源，准则 8 减法原则否掉）。
- **若用 C**：§2.3 例子里 A、B 同时改 `src/app.ts` 的场景不变——`git clean -fd` 只在派发间隙跑，并行窗口内 B 的半成品照样被 A 的 `git add -A` 卷走。清理再强也只治串行（失败模式 B/C），治不了并行（失败模式 A）——而 A 正是 maxConcurrency 存在的意义。

**推荐理由（方案 A）**：git worktree 是本问题的原生机制——独立工作目录 + 共享 object store，前者物理消除三类污染（G1/G2），后者让 agent 的 commit 在主仓库立即可见（探针 P-wt2 实测），证据链审计与 cleanCheckout（clone 带全部 refs，P-wt3 实测）零适配成本。canon 终态设计（326 行数据流图）承诺的正是此方案。

### 3.3 关键决策与权衡

**D1 布局：`~/.cw-worktrees/<encoded-cwd>/<unitId>`，env 可覆盖。** worktree 根目录由 `getCwWorktreeHome()` 产出（默认 `~/.cw-worktrees`，测试用 `CW_WORKTREE_HOME` 指到 tmp——与 `getCwHome`/`CW_HOME` 同构）；下一层 `<encoded-cwd>` 复用 `encodeCwd` 产出，与账本目录同 key，归属排查时一眼对应。被否备选「放项目仓库内子目录」：agent 的 `git add -A` 会把 worktree 目录吞进 commit，物理上不可行。

**D2 分支策略：每 unit 一分支，base = root spec 冻结 commit。** 分支名由 unitId 派生（slug 规则 `^[a-z][a-z0-9-]*$` 是 git 分支名的严格子集，by construction 合法，无需转义）。base 取 root unit 的 `SpecSubmitted.commit`（`src/events/types.ts:90-91`，既有事件字段，**零账本 schema 变更**）——语义是「全部子的设计基于同一份冻结 spec + 代码快照」，兄弟并行、集成兜底一致性。被否备选「base = 派发时刻 HEAD」：root 分支 HEAD 会被已集成兄弟的 merge 推动，后派发的子隐式包含先行兄弟的产出——spec 与代码错位（spec 未含兄弟产出），且引入派发时序依赖，不可复现。**本决策是 handoff 指定的用户拍板项，本文按推荐方案设计；若拍板改为派发时刻 HEAD，§3.1 输出样例与 §4 场景 1 的 base 描述需同步调整，其余不变。**

**D3 workdir 角色拆分：账本/仓库锚定项目 cwd，工作区/产物去 worktree。** `AgentSpawnRequest` 新增 `projectCwd` 字段；`workdir` 字段语义不变（agent 工作区，`types.ts:15-16` 注释已按终态口径书写），值从项目 cwd 变为 worktree 路径。具体拆分：

| 消费点 | 现状入参 | 升级后入参 |
|---|---|---|
| pi.ts:103 子进程 cwd / 产物拼接（84-85） | `req.workdir` | `req.workdir`（= worktree 路径，自动跟随，零改动） |
| human.ts:106 `cd` 指引 | `req.workdir` | `req.workdir`（自动跟随） |
| human.ts:122 账本定位 | `req.workdir` ❌ 会分裂 | `req.projectCwd`（必改，否则 human 轮询读错账本，永远等不到完成信号 → TIMEOUT） |
| loop.ts:853/880 `loadLedger` | `opts.cwd` | 不变（本就走 `opts.cwd`） |
| brief 指示 agent 执行的 cw 命令（loop.ts:613「账本命令：在 workdir 下执行 cw …」） | workdir = 项目 cwd，天然正确 | worktree 下 `process.cwd()` 推导会定位到 `<encoded-worktree>` 的**空账本**——spawn env 注入 `CW_PROJECT_DIR=<项目cwd>`，cli.ts:38 优先取该 env 作为 cwd（必改，否则 agent 的 evidence submit 写进分裂账本） |
| integrate.ts:130 cleanCheckout 源 | `opts.cwd` | 不变（项目仓库）；checkout 目标从 cwd HEAD 变为 root 分支 HEAD（D6） |

**D4 reset 语义回归 canon：删近似实现，对 unit worktree `reset --hard` + `clean -fd`。** 每次派发前（重派或换角色）对该 unit 的 worktree 执行 `git reset --hard HEAD && git clean -fd`：清掉未提交半成品（含 untracked），保留已 commit 产出。此时 `clean -fd` 是安全的——worktree 由 cw 创建管理，目录内不存在认知外文件（§2.3 失败模式 C 的权衡消失）。`checkWorkspaceForDispatch`（`loop.ts:799-826`）及其调用点（960）整体删除；「reviewer 在跑时不动 builder 产出」由「同 unit 同时只有一个 agent」的派发不变量天然保证，无需 in-flight 分支逻辑。

**D5 生命周期：closed 延迟回收，失败/转人工保留。** 创建：首个角色派发前 `git worktree add <path> -b cw/<unitId> <baseCommit>`；复用：同 unit 后续角色复用同一 worktree（先 reset）；回收：unit closed 后不立即删（debug 常需翻看现场），下一轮 runner 循环统一回收上一轮 closed 的 worktree（`git worktree remove --force`——探针 P-wt4：脏残留需 force；closed = 产出已进证据链 + merge 进 root 分支，残留可弃）；失败/转人工的一律保留并在指引中打印路径。子分支在 merge 进 root 分支后可删（commit 经 root 分支可达，探针 P-wt5：GC 安全）；root 分支 run 结束后保留供回流（G5）。root closed 汇总输出打印回收清单（§3.1 样例末段）。

**D6 集成汇聚：子 closed 即 merge 进 root 分支，集成 verify checkout root 分支 HEAD。** 子 gate PASS 后，runner 在 root worktree 执行 `git merge cw/<unitId>`——冲突早发现（子级别暴露，而非集成时集中爆发）；base 相同、改动文件不同时自动合并，真冲突 = 真实集成冲突，按 §3.1 失败路径转人工。集成 verify 复用既有 cleanCheckout：本地 clone 携带全部 refs（探针 P-wt3），checkout root 分支 HEAD 即得「子的 commit 集合」汇聚态，防「工作区现状冒充证据状态」的 Goodhart 纪律不变。

### 3.4 探针清单（运行时断言，全部实测 ✅）

| ID | 断言 | 探针方法 | 状态 |
|---|---|---|---|
| P-wt1 | `git worktree add -b cw/<unitId> <base>` 正常创建独立工作区 | /tmp 实测：创建 → 独立 HEAD → commit 互不影响 | ✅ |
| P-wt1b | 重复分支名 add 报 fatal 而非静默复用 | 实测：`fatal: a branch named 'cw/unit-1' already exists`，exit 255 | ✅（→ §3.1 失败路径恢复指引） |
| P-wt2 | worktree 内 commit 的对象在主仓库 object store 立即可见（object store 共享） | 实测：wt1 内 commit 后主仓库 `git cat-file -t <hash>` → `commit` | ✅（D3 证据链免回传的基石） |
| P-wt3 | 本地 `git clone` 携带全部分支 refs（含 cw/*），clone 内可 checkout unit commit | 实测：clone 后 `origin/cw/unit-1` 存在，`git cat-file -t` → `commit` | ✅（D6 cleanCheckout 兼容的基石） |
| P-wt4 | 含 untracked/脏文件的 worktree，`remove` 拒绝（exit 128）、`remove --force` 成功 | 实测：两种行为均符合 | ✅（D5 回收用 --force 的依据） |
| P-wt5 | 子分支 merge 进 root 后删分支，commit 仍可达（不被 GC） | 实测：`merge` → `branch -D` → `git log` 可见该 commit | ✅（D5 分支清理的依据） |
| P-wt6 | unitId slug（`^[a-z][a-z0-9-]*$`）是 git 分支名严格子集；`SpecSubmitted.commit` 可作 baseCommit 源 | 读码核实：`create.ts:29-31` slug 校验；`events/types.ts:90-91` commit 字段 | ✅（零转义逻辑、零账本变更） |

## 4. 验收（真实场景，非单测非 mock）

**改动规模：大（新机制接入 + 行为变更 + 接口字段新增）——必须多场景真实验证。单测只作回归辅助，不计入验收。**

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| 1 | **并发污染对抗**（G1） | 在真实 git 项目里构造两个并行 builder（unit-a / unit-b），验收目标互相冲突（同改 `src/app.ts` 不同改法），`maxConcurrency=2` 跑 `cw run` 至两 unit 均 closed | `git show --stat <unit-a 的 evidence commit>` 只含 unit-a 的产出文件，unit-b 同理；两 worktree 物理分离（`git worktree list` 曾出现两条记录）；项目 cwd 全程无 `.cw-spawn/` 新增 |
| 2 | **半成品清理回归**（G2） | builder 被人为注入失败（exit≠0），在其 worktree 留 tracked 脏改 + untracked 构建产物；触发重派 | 重派的 agent 开工前该 worktree `git status --porcelain` 为空（tracked 与 untracked 全净）；既有 u7b 系测试改造后转绿 |
| 3 | **cwd 改脏不影响 verify**（G3，防回归） | verify 触发前人为把项目 cwd 改脏（tracked 修改 + 新增 untracked），再触发 verify | verify 仍按账本 commit 干净重跑，结果与 cwd 状态无关；canon P7 探针从 ⛔ 勾为 ✅ |
| 4 | **human 接管全链路**（G4） | 构造 unit 转人工；人按指引 `cd <worktree>` 读 brief、改代码、commit、执行 `cw evidence submit` | 事件写入**项目账本**（`~/.cw/<encoded-项目cwd>/events.log`）而非分裂账本；human adapter 轮询到完成信号正常返回，无 TIMEOUT |
| 5 | **终验靶子全链路**（G1-G5 综合） | 在 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（真实前端项目）跑 `cw run --spawn pi`（模型 mimo-v2.5-pro，brief 存档 `.xyz-harness/cw-endstate-architecture/test-brief.md`），无人干预 | 跑到 root closed；汇总输出含 worktree 回收清单；`git merge cw/<rootId>` 在项目主分支可干净合并；全量测试绿（282 + 新增） |

## 5. 下一层拆分（实现计划层入口）

**按依赖序分 5 波，每波独立可验收、可回滚；实施沿用 cw-orchestrator 机制（builder/verifier 派发 + 验收基线防篡改）。**

| 波次 | 内容 | justification | 独立验收 |
|---|---|---|---|
| **W1 worktree 基建** | 新增 `src/runner/worktree.ts`（add/reset/remove 封装）；`store/project.ts` 加 `getCwWorktreeHome()` + worktreePath 拼接；cli.ts 支持 `CW_PROJECT_DIR` | 纯增量、不接调用方，零行为变更，可先行 | 单元层验证封装函数对真实 tmp 仓库的 add/reset/remove |
| **W2 spawn 链路拆分** | `types.ts` 加 `projectCwd`；loop.ts:982 派发点接 worktree 创建 + workdir/projectCwd 双传；pi.ts env 注入；human.ts:122 改锚；brief 文案（612-613）更新；escalationMessage（730-731）路径跟随 | D3 的完整落地，是行为切换点；依赖 W1 的封装 | 场景 4（human 接管）先在此波验收 |
| **W3 reset 语义替换** | 删 `checkWorkspaceForDispatch`（loop.ts:799-826 + 960 调用点），派发前改调 worktree reset+clean | D4；必须在 W2 之后（worktree 存在才有 reset 对象） | 场景 2（半成品清理） |
| **W4 集成汇聚与回流** | 子 closed → root worktree merge；集成 verify checkout root 分支 HEAD；root closed 汇总输出（回收清单 + `git merge cw/<rootId>` 指引） | D5 回收 + D6；依赖 W2 的 worktree 存在性 | 场景 1（并发对抗）+ 场景 3（cwd 防脏回归） |
| **W5 测试迁移与终验** | tests/ 10 文件 39 处 `.cw-spawn` 断言迁到 worktree 路径（`CW_WORKTREE_HOME` 隔离）；新增并发污染对抗测试；canon P7 探针勾验；终验靶子重跑 | 收口波；39 处分布已清点（u7-loop 8、fx3 7、u6c 5、fx1 4、u7b/u6a/fx2 各 3、u8/u7/u6b 各 2） | 场景 5（终验靶子）+ 全量绿 |

**文件改动地图**：新增 `src/runner/worktree.ts`；改 `src/runner/spawn/types.ts`（+projectCwd）、`src/runner/loop.ts`（派发点 / 删近似 / brief 文案 / escalation / 汇总输出）、`src/runner/spawn/pi.ts`（env 注入）、`src/runner/spawn/human.ts`（账本锚定）、`src/cli.ts`（CW_PROJECT_DIR）、`src/store/project.ts`（getCwWorktreeHome）、`src/runner/integrate.ts`（checkout 目标改 root 分支）、`src/runner/spawn/lifecycle.ts` 与 `types.ts:15` 注释口径统一；tests/ 10 文件断言迁移 + 新增对抗测试。

**待验证检查点（实施期）**：① W2 联调时实测「spawn env 注入 `CW_PROJECT_DIR` 后，agent 在 worktree 里执行 cw 命令确实写项目账本」（设计依据是读码 + 链路推演，未实跑）；② W4 联调时实测 merge 冲突转人工路径的指引文案可用性；③ 嵌套场景（内部节点的子在独立分支模型下的 base 取值）若 cw 后续开放深度 >2，需单独设计——当前深度 ≤2 不在本次范围。
