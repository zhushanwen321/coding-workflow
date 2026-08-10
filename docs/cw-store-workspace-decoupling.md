# cw store 归属与 workspace 解耦设计

> **一句话结论**：cw-cli 把「store 归属」（任务元数据属于哪个 repo）和「workspace」（git/测试在哪个工作树跑）耦合在同一个值上，bare repo + worktree 模式下系统性崩溃。根治 = store 归一化下沉到 cw-cli 内部（`getCwJsonPath` 用 `git-common-dir` 探测），workspace 改用 `show-toplevel`，testCwd **保持相对仓库根的相对路径契约**（不改绝对路径），迁移**冲突即停、人工裁决**（不自动仲裁状态机）。

> **层性质声明**（设计准则 10）：
> - **当前层**：cw-cli 架构方案设计——为什么解耦、归一化放哪一层、怎么迁移
> - **下一层**：cw-cli 的接口/数据模型/代码改动（`getCwJsonPath` 签名、`constructCwDeps` 拆分、迁移逻辑）+ cw-tool（pi extension 封装层）的协调需求
> - **不跨层**：本文不写函数级实现（不逐行写 `getCwJsonPath` 内部），深度止于接口设计与拆分计划

---

## §1 背景目标

### SCQA 开篇

- **S（情境）**：cw-cli（npm 包 `@zhushanwen/coding-workflow`）是编码流程状态机，存储任务树（epic/feature/slice/wave）、方案文档、审查判断、开发 commitHash 等元数据。它自己不持有代码——代码在 git 里，cw 只记录「这个方案设计成什么样、开发了哪个 commit、测试过没」。
- **C（冲突）**：cw-cli 用单一 `workspacePath` 同时承担「store 存哪个文件」和「git/测试在哪个目录跑」两件事。这两件事的答案在 bare repo + worktree 模式下是**不同的目录**：store 要 repo 级标识（所有 worktree 共享），git/测试要当前 worktree 根。耦合让 cw-cli 在 bare repo worktree 里要么 store 命中失败、要么 git/测试跑错地方。
- **Q（问题）**：一个「存储方案/设计/commit 元数据」的工具，凭什么和「你站在哪个目录操作它」强耦合？这个耦合从哪来，怎么根治？
- **A（答案）**：把 store 归属与 workspace 解耦——store 用 `git rev-parse --git-common-dir`（repo 级标识，所有 worktree 相同），workspace 用 `git rev-parse --show-toplevel`（当前 worktree 根）；归一化下沉到 cw-cli 内部，让 bash 直接调 cw 和 cw-tool 调 cw 走同一条路径。

### cw-cli 是什么——先建立基本认知

cw-cli 是一个命令行工具，把编码任务拆成层级单元（epic → feature → slice → wave），用状态机驱动每个单元走 `design → review → execute → test → retrospect → closeout`。它管理四类元数据：

| 数据 | 例子 | 本质属性 |
|---|---|---|
| **任务树** | `slice:provider` 下挂 5 个 `wave:*`（`parentUnitId` 外键） | 任务的结构关系，与文件位置无关 |
| **方案文档** | design 阶段产出的 plan（文件清单、测试命令、验收标准） | 任务的方案描述，与文件位置无关 |
| **审查判断** | designReviewJudgment（pass/fail + 问题清单） | 对方案的判断，与文件位置无关 |
| **开发证据** | execute 记录的 commitHash、test 结果 | commitHash 是 git 全局对象引用（repo 级共享），非文件路径 |

**关键认知**：这四类数据都是「某个任务的元数据」，归属维度是**任务**（或任务所在的 repo），不是「你站在哪个目录操作它」。同一个任务的 design 文档，不管从哪个 worktree 看，都应是同一份。commitHash 更是跨 worktree 的——git object store 在 repo 级共享（见 §3.3 探针 P-object-store），任何 worktree 都能 `git cat-file` 同一个 commit。

cw-tool（npm 包 `@zhushanwen/pi-cw-tool`）是 cw-cli 的 pi extension 封装，把 `cw` 包成 4 个 role-restricted 工具（cw_planning / cw_wave / cw_dev / cw_review），供递归编排 agent 调用。

### 设计目标

从使用者体验倒推（使用者 = 在 bare repo + worktree 模式下用 cw 的开发者 / 递归编排 agent）：

1. **G1 — bare repo worktree 下 cw 全线可用**：cw 任意命令在 bare repo worktree 里能正常 design/execute/review，不出现 unit not found 或 git/测试崩。
2. **G2 — bash 与 cw-tool 路径统一**：bash 直接调 cw 和 cw-tool 调 cw 访问同一个 store，不再「bash 能用、cw-tool 路径失效」。
3. **G3 — 递归编排跨 worktree 任务树共享**：planning 层（父 worktree）design 出的 wave，wave-agent（子 worktree）能 execute 到。
4. **G4 — 普通 repo 迁移后单 store 语义一致**：普通 repo（单 worktree 或 `git worktree add` 的 linked worktree）迁移到 repo 级单 store 后行为一致。**显式行为变化**：普通 repo 从子目录调用的存量 per-cwd 隔离会随迁移合并消失（子目录任务并入 repo 级 store），迁移保证数据不丢，但 per-cwd 隔离语义不再保留。
5. **G5 — 职责归位**：store 归一化是 cw-cli 的内部决策，cw-tool 退回纯封装。

### In / Out scope

- **In**：cw-cli 的 store 归一化层选型、workspace 语义解耦、store 路径迁移策略、向后兼容、与 cw-tool 的协调接口
- **Out**：cw 的状态机逻辑、审查 gate 规则、guidance 生成——这些不涉及 workspace 耦合，不动；cw-tool 的具体实现代码（在另一个项目，本文只列协调需求）

---

## §2 现状与问题分析

### §2.1 cw-cli 的本质职责——位置无关的元数据存储

**cw-cli 是任务的元数据存储，不是代码的执行环境。** 它的输入是方案 JSON / 审查判断 / commitHash，输出是状态推进 + 持久化。cw-cli 自己不编译、不运行代码——它只在 execute/test 阶段**委托** git（校验 commit 存在）和测试命令（跑 vitest）。这种「委托」需要知道「在哪个目录跑」，但这与「任务元数据存在哪」是两回事。

### §2.2 当前实现——4 个关注点耦合在单一 workspacePath

**cw-cli 的 `constructCwDeps(workspacePath)` 把 4 个本应分开的关注点绑在同一个值上。** 取证（`src/cli.ts:645-700`）：

| 关注点 | 代码（cli.ts） | 用 workspacePath 做什么 | 正确归属 |
|---|---|---|---|
| **store 键控** | `new CwStore(workspacePath)` → `getCwJsonPath(workspacePath)` | 决定任务树存哪个 `store.json` | **repo 标识**（"这是哪个 repo 的元数据"） |
| **gitValidator** | `git cat-file -e <hash>^{commit}` cwd=`workspacePath`（cli.ts:654） | 校验 commitHash 真实存在 | **任意能访问该 git 对象的工作树** |
| **testRunner** | 缺省 cwd=`workspacePath`，相对 testCwd 用 `resolve(workspacePath, testCwd)`（cli.ts:669） | 跑测试子进程 | **被测代码所在的工作树** |
| **fileExists** | `resolve(workspacePath, ref)`（cli.ts:696） | 检查 artifact 文件存在 | **代码工作目录** |

`getCwJsonPath` 的实现（`src/store/schema.ts:130-132`）证实 store 键控就是路径编码：

```ts
export function getCwJsonPath(cwd: string): string {
  return join(getCwHome(), encodeCwd(cwd), "store.json");
}
```

`workspacePath` 的解析入口（`src/cli.ts:1060-1061`）证实它要么是命令行 `--workspace`，要么是 `process.cwd()`：

```ts
const workspacePath =
  typeof parsed.workspace === "string" ? parsed.workspace : process.cwd();
```

**这 4 个关注点的「正确归属」实际是 2 类**：store 键控要 repo 标识，gitValidator/testRunner/fileExists 要工作树目录。当前用一个 `workspacePath` 全覆盖——在「cwd = repo 根 = 工作树」的原始假设下无害，演进后崩溃（§2.3）。

### §2.3 单 cwd 假设在三种演进下崩溃

**耦合在三种场景下逐个失效，每种都让前面的「修复」变成下一种的病灶。**

#### 演进 1：子目录调用（cwd ≠ repo 根）

开发者在 repo 内 `cd` 到子目录跑 cw。cwd = `/repo/packages/renderer`，但任务属于 `/repo`。store 键控到子目录级 → 换个子目录就丢任务树。

cw-cli 的应对：**没应对**。per-cwd 是 cw-cli 的设计，它接受这个分叉，靠 `cw list --all`（`src/readonly/cross-cwd.ts` 聚合 `CW_HOME` 下所有 store）+ RepoMeta（`src/store/schema.ts:36`，记录 remoteUrl/branch/worktreePath/headCommit）做只读聚合显示。

#### 演进 2：bare repo + worktree（repo 标识 ≠ 工作树）—— 当前 bug

bare repo + worktree workspace 模式（如本项目 `coding-workflow-workspace/.bare` + `fix-cw-cwd-worktree/` 等独立 worktree 目录）下，4 关注点全崩。**本项目实测（当前 worktree `fix-cw-cwd-worktree`）**：

```bash
$ git rev-parse --git-common-dir        # repo 标识（所有 worktree 相同）
/Users/.../coding-workflow-workspace/.bare
$ git rev-parse --show-toplevel         # 当前工作树根
/Users/.../coding-workflow-workspace/fix-cw-cwd-worktree
$ dirname $(git rev-parse --git-common-dir)   # ADR-0045 现状的「修复」算法
/Users/.../coding-workflow-workspace          # ← workspace 容器，不是任何 worktree！
```

cw-tool（pi extension 封装层，ADR-0045 的修复所在）探测 `git-common-dir` 后取 `dirname`，把这个 workspace 容器当 `--workspace` 传给 cw-cli → `constructCwDeps` 的 4 个关注点全走这个**非 git 目录**：

| 关注点 | 后果 |
|---|---|
| store 键控 | store 路径 = `~/.cw/__...__coding-workflow-workspace/store.json`（容器级，空）→ unit not found |
| gitValidator | `git cat-file` 在非 git 目录跑 → 校验失败 |
| testRunner | 测试在非 git 目录跑 → 跑错地方 |
| fileExists | 文件 resolve 基准是容器 → 找不到代码文件 |

**这解释了为什么是「所有 cw 操作失效」而不只是「unit not found」**——`--workspace` 绑了 4 个 cwd，bare repo 下这 4 个全坏。

> **ADR-0045**（在 cw-tool 项目，记录这个修复）的方向半对、实现错位：它识别到「store 应 repo 级共享」（归属维度正确）、用 `git-common-dir` 做 repo 标识（标识选型正确）。错误是：① 多余的 `dirname`（common-dir 本身就是标识，dirname 只为凑「可工作目录」，bare repo 下反而到容器）；② 单一 `--workspace` 兼任 repo 标识 + 工作树两角色（bare repo 结构性不可能）；③ 归一化放 cw-tool 调用层而非 cw-cli 引擎层（见 §2.4 隐藏病灶）。本设计修正这三点。

#### 演进的隐藏病灶：bash 与 cw-tool 结构性割裂

**只要 store 归一化在 cw-tool（调用层），bash（不经过 cw-tool）就永远是 per-cwd，两者必然分叉。** 数据流：

```
bash 调 cw（不经过 cw-tool）
  → workspace = process.cwd()（per-cwd）
  → store = encodeCwd(cwd)                         ← per-cwd store

cw-tool 调 cw（探测 common-dir 后传 --workspace）
  → workspace = dirname(common-dir)（repo 级，但 bare repo 下 = 容器）
  → store = encodeCwd(dirname(common-dir))         ← 另一个 store 文件
```

**实测证据**：`~/.cw/` 下本项目目前已有 store `__...__coding-workflow-workspace__fix-cw-config-json`（另一个 worktree 建的），当前 worktree `fix-cw-cwd-worktree` 还没建 store。这就是 per-worktree 分裂——每个 worktree 一个 store，递归编排跨 worktree 必然 unit not found。

普通 repo 里若开发者只用 cw-tool 不用 bash，store 一直在 repo 根，不暴露；bare repo 里开发者大量用 bash 推进 + 想用 cw-tool（递归编排），两条路径同时用 → store 割裂暴露 → 「bash 能用、cw-tool 路径失效」。

### §2.4 物理数据流图——当前（割裂）vs 理想（统一）

**当前（割裂）**：store 归一化在 cw-tool，bash 与 cw-tool 走不同 store。

```
  bash 调 cw                          cw-tool 调 cw
  (不经过 cw-tool)                    探测 common-dir → dirname → --workspace
        │                                          │
  workspace = cwd                          --workspace <dirname(common-dir)>
        │                                          │
        ▼                                          ▼
  store = encodeCwd(cwd)                  store = encodeCwd(dirname(common-dir))
  (per-cwd)                               (bare repo 下 = 容器 → 4 关注点全坏)
        │                                          │
        └────────────── 两个不同的 store.json ──────────────────┘
                        ★ bash 能用、cw-tool 路径失效的根源 ★
```

**理想（统一）**：store 归一化下沉到 cw-cli 内部，bash 与 cw-tool 走同一条路径。

```
  bash 调 cw                          cw-tool 调 cw（纯封装，不再探测）
        │                                          │
        └────────── workspace（cwd 或 --workspace）──────────────┘
                          │
                    cw-cli 内部（getCwJsonPath + constructCwDeps）
            store-key = git rev-parse --git-common-dir (.bare/.git，所有 worktree 相同)
            workspace = git rev-parse --show-toplevel  (当前 worktree 根，有效工作树)
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
     store 键控                    gitValidator / testRunner / fileExists
  getCwJsonPath(common-dir)         cwd = show-toplevel（当前 worktree）
          │                               │
  普通 repo: .git → 同一 store          workspace=worktree根 → git/test 有效
  bare repo: .bare → 同一 store         workspace=worktree根 → git/test 有效
          │
  ★ bash 和 cw-tool 走同一条 cw-cli 归一化，无割裂；bare/普通 repo 统一无特殊分支 ★
```

### §2.5 根因——归属与执行位置混淆

**根因是概念混淆：cw-cli 把「归属」和「执行位置」混为一谈。**

| 维度 | 问题 | 答案应该是 | 当前实现 |
|---|---|---|---|
| 归属 | store 存哪个文件？ | repo 标识（任务属于哪个 repo） | cwd（执行位置） |
| 执行位置 | git/测试在哪跑？ | 被测代码的工作树 | cwd（执行位置） |

这两个问题是正交的，cw-cli 用单一 `workspacePath` 回答两者，是单 cwd 时代（§2.3 演进前）的简化。根治 = 把它们拆开，并在 cw-cli 内部完成 repo 标识的探测（不让调用方传，否则 bash/cw-tool 割裂无法消除）。

---

## §3 解决方案

### §3.1 终态——使用者视角

**改造后，bash 与 cw-tool 走同一条 cw-cli 内部归一化，bare repo worktree 下行为完全一致，递归编排跨 worktree 任务树共享。**

```
[场景 A：bare repo worktree 内推进任务，已拆 5 wave]

# bash 线性模式
$ cw status --unitId slice:provider
  status: executing, 5 waves (wave1 designing, wave2-5 blocked)

# cw-tool（修复后，之前 unit not found）—— 与 bash 访问同一个 store
> cw_wave design --unitId wave::provider-kind-type
  ✅ status: designing（store 命中，git/test 在当前 worktree 有效）

[场景 B：递归编排，planning 在父 worktree，wave 派到子 worktree]

# planning-agent（父 worktree）
> cw_planning execute --unitId slice:...   # cw 自动建 wave unit，写入 repo 级 store
> subagent start wave-agent (worktree:true)  # 派 wave 到独立 worktree

# wave-agent（子 worktree）
> cw_wave design --unitId wave::...        # cw-cli 内部 common-dir 归一化 → 同一 store
  ✅ 命中父层建的 wave unit（之前 unit not found）
> cw_dev execute --commitHash <sha>        # commitHash 校验：当前 worktree cat-file 成功
  ✅ execute 成功
```

**失败路径 + 恢复指引**（设计准则 6）：

| 失败场景 | 现象 | 恢复动作 |
|---|---|---|
| 非 git 目录调 cw | common-dir 探测失败 | cw 降级 per-cwd（保持现状），stderr 提示「cwd 非 git 目录，store 按 cwd 隔离；若需 repo 级共享，请在 git 工作树内调用」 |
| 旧 per-cwd store 弃用 | 升级后找不到历史任务 | store-key 改 repo 级（common-dir），旧 `~/.cw/<旧cwd>/store.json` 不再被认；启动一次性 stderr warning 提示弃用 + 旧数据位置；**不迁移**，存量任务需重建或手动从旧 store 捞（决策 9） |
| wave commit 未进 object store | gitValidator 校验失败 | 错误文案指向「commit `<sha>` 不在当前 repo object store，确认 wave worktree 已 commit 且 worktree 共享同一 bare repo」 |

### §3.2 多方案对比（设计准则 9，强制 ≥2）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. store 归一化下沉 cw-cli 内部（不迁旧 store）** | ✅ 最干净：归一化回归引擎层（职责归位），bash/cw-tool 自动统一，cw-tool 退回纯封装，bare/普通 repo 统一无分支 | 低：cw-cli 改 `getCwJsonPath` + `constructCwDeps` + 弃用 warning；**无迁移**（旧 per-cwd store 弃用，决策 7/9） | 低-中：改默认 store 路径是 breaking（minor + 醒目 warning），但不做迁移所以无迁移 bug 面 | ✅ 推荐 |
| **B. cw-cli 加 `--store-key` 参数** | ⚠️ 半解耦：归一化仍在调用方，**bash 不传则 per-cwd，bash/cw-tool 割裂结构性存在**（G2 不达成） | 低-中：cw-cli 加参数 + cw-tool 改探测 | 低：bash 行为不变 | ❌ 不彻底 |
| **C. remoteUrl 做 store-key** | ✅ 语义最贴近「属于哪个项目」，跨 clone 也统一，人可读 | 中：无 remote/改 remote/格式归一化（https vs ssh vs .git 后缀）的 edge case 处理 | 中：纯本地 repo 无 remoteUrl → fallback；remote 改名分裂 | ❌ edge case 更麻烦 |
| **D. 短期止血（仅改 cw-tool）** | ❌ 治标：cw-tool 把 `dirname(common-dir)` 改 `common-dir` 原值、workspace 改 `show-toplevel`，归一化仍在 cw-tool，bash 割裂仍在 | 最低：零 cw-cli 改动、零迁移 | 最低 | ❌ 仅作过渡 |

#### 推荐与理由

**推荐方案 A**。理由：

1. **职责归位（by construction）**：store 归一化是 cw-cli 的内部决策，放 cw-cli 最自然，结构性消除「调用方传错值」类 bug（dirname bug 不可能再发生）和「bash/cw-tool 割裂」（两者走同一 cw-cli 路径）。不是 clever mechanism，是结构正确。
2. **bash/cw-tool 统一（G2）**：方案 B 的 `--store-key` 仍是调用方传参，bash 不传就 per-cwd，割裂结构性存在。只有 cw-cli 内部归一化才能让两条路径统一。
3. **减法优先，不迁旧 store（准则 8）**：方案 C 的 remoteUrl 是全新的 edge case 集合；方案 D 不彻底。方案 A **不做迁移**——store-key 改 repo 级（common-dir），旧 per-cwd store 弃用（决策 7），配套弃用 warning（决策 9）。这砍掉了迁移（归属算法/并发互斥/冲突仲裁）的全部复杂度，代价是存量任务需重建（本项目单人使用，可接受）。

**关于不迁的代价（已确认接受）**：方案 A 不迁旧 store，意味着升级后存量 cw 任务（旧 per-cwd store 里）在新版不可写、写操作不可见，需重建或手动从 `~/.cw/<旧cwd>/store.json` 捞。本项目当前单人使用、bare repo worktree 刚采用、存量任务可弃，此代价可接受（决策 7）。若未来用户量增长需兼容，可再补迁移（届时按决策 7 历史版本的归属算法实现）。

**若用方案 B，§3.1 终态会变成什么样**：cw-tool 路径能用了（store-key 修复），但 bash 和 cw-tool 仍访问不同 store——开发者在 bash 建的任务，cw-tool 看不到；反之亦然。G2 不达成，本次 bug 本质未根治，只是从「cw-tool 全坏」降级为「bash 和 cw-tool 各看各的」。

### §3.3 关键决策与权衡

**决策 1：store 归一化放 cw-cli 内部（`getCwJsonPath`），不放 cw-tool。**
- 选择：cw-cli 内部 `detectCommonDir(workspacePath)` → `getCwJsonPath(commonDir)`
- 被否：cw-tool 探测后传 `--store-key`（方案 B）——bash 不经过 cw-tool 仍 per-cwd，割裂不消除
- 证据：§2.3 隐藏病灶 + §2.5 根因

**决策 2：store-key 用 `--path-format=absolute --git-common-dir` 绝对路径原值，不加 dirname。**
- 选择：`store-key = git rev-parse --path-format=absolute --git-common-dir`（`.git` / `.bare` 绝对路径原值）
- **`--path-format=absolute` 是硬约束，不可省**：裸 `git rev-parse --git-common-dir` 在普通 repo（`git init`，.git 是目录）返回**相对 `.git`** → `encodeCwd('.git')='.git'`（无 `/` 不变）→ 所有普通 repo store 全局撞名 `~/.cw/.git/`；子目录返回 `../../.git` → 同 repo 不同深度目录 store 分叉。bare repo worktree 裸命令恰好返回绝对（.bare 的 gitdir 指针所致），但普通 repo 不行——必须 absolute 统一（探针 P-absolute ✅）
- 被否：`dirname(common-dir)`（ADR-0045 现状）——bare repo 下 dirname 到 workspace 容器（本项目实测 `dirname(.bare)` = `coding-workflow-workspace`，非任何 worktree）；separate-git-dir 下 dirname = external.git 父目录（非 repo 根）
- 证据：探针 P-dirname-harmful ✅（本项目实测）

**决策 3：workspace 用 `show-toplevel`（当前 worktree 根），不用裸 cwd。**
- 选择：`workspace = git rev-parse --show-toplevel`
- 被否：`process.cwd()`——agent 常在 worktree 子目录调 cw（如 `src/`），cwd ≠ worktree 根，git/test 漂移到子目录
- 证据：探针 P-toplevel ✅（本项目 worktree 根与 `git -C src` 输出一致）

**决策 4：testCwd 收紧为「相对仓库根的相对路径」，禁止绝对路径。**（对常见错误方向的纠正）

这是与「直觉修复」相反的关键决策。直觉会认为：workspace 从 cwd 改成 show-toplevel 后，相对 testCwd 的解析基准变了（从 agent cwd 变 repo 根），为避免漂移应要求 testCwd 改绝对路径。**这是错的**：

- 绝对路径（如 `/Users/x/coding-workflow-workspace/main/packages/auth`）存进 **repo 级共享 store** 后，`fix-xxx` worktree 读到它——**路径不存在**，解析错位。绝对路径与「跨 worktree 共享 store」直接矛盾。
- 正解：testCwd 用相对仓库根的相对路径（如 `packages/auth`），运行时 `resolve(show-toplevel, "packages/auth")` 在每个 worktree 都解析到**该 worktree 的** `packages/auth`——跨 worktree 自动正确。
- **现状契约并非已是「相对仓库根」，需收紧**：`src/core/plan.ts:73-74` 字段注释为「相对 workspacePath **或绝对路径**」，`src/cli.ts:669` 实现有 `isAbsolute` 分支**放行**绝对路径。即现状允许绝对路径 testCwd 合法存入 store——这些旧契约下存入的绝对 testCwd 在 repo 级共享 store 时代跨 worktree 必炸（正是本决策要防的 bug）。因此**不能只改 guidance 文案**，必须在 design/replan 入参校验层加机器检查拒绝绝对 testCwd（S1 改动清单见 §4.1）。
- 选择：① 运行时 `resolve(show-toplevel, testCwd)` 解析基准换 show-toplevel；② design/replan 校验层拒绝绝对路径 testCwd（机器检查，非仅文案）；③ guidance 补「testCwd 必须相对仓库根，禁止绝对路径」
- 被否：testCwd 改绝对路径——破坏跨 worktree 共享的前提
- 证据：`src/core/plan.ts:73-74` 注释 + `src/cli.ts:669` isAbsolute 分支 + `src/guidance/templates/wave.ts:58` guidance 示例 + 探针 P-toplevel ✅

**决策 5：gitValidator/testRunner/fileExists 统一用 workspace（worktree 根），store-key 只服务 store 键控。**
- 选择：3 个执行类关注点 cwd = workspace（show-toplevel）
- 被否：gitValidator 用 common-dir 直接 cat-file——虽探针证明可行，但 worktree 是「正经 git 工作树」，cat-file / 后续 git 操作（diff/log）更自然；common-dir 在普通 repo 是 `.git` 内部目录，不宜当工作 cwd
- 权衡：workspace 服务 3 个执行类关注点，store-key 只服务 store 键控——职责清晰，2 类而非 4 类

**决策 6：探测失败降级，不引入跨进程 clever 机制（设计准则 8）。**
- common-dir 探测失败（非 git 目录）→ store-key fallback workspacePath（per-cwd，现状行为）
- 不加「猜测 repo」「跨进程持久缓存 common-dir」「自动迁移」等机制——每个跨进程 clever 机制都是新的运行时断言（准则 7）。by construction：探测到就归一化，探测不到就降级，结构上不可能错。
- **进程内 memoize（非跨进程）允许**：单次 cw 写 action 至少 2 次 `new CwStore`（`src/cli.ts:647` constructCwDeps + `:791` getUnitScope）+ 1 次 show-toplevel probe = ≥3 次 git spawnSync（每次数 ms-数十 ms）。进程内一次性 memoize common-dir/show-toplevel 结果**不引入运行时断言**（同进程 cwd 不变，结果稳定），可消除重复 spawn 代价。这与「跨进程持久缓存」（有失效/一致性断言）性质不同，允许。

**决策 7：不迁移——旧 per-cwd store 弃用，新任务直接走 repo 级 store。**

**减法优先（准则 8）**：迁移（per-cwd → per-common-dir 的 N→1 合并 + 归属算法 + 并发互斥 + 冲突仲裁 + 存量 testCwd rebase）是为「兼容历史任务」而设计的复杂度。本项目当前单人使用、bare repo worktree 刚采用、存量任务可弃，**不做迁移**。

- **新任务**：升级后所有 cw 调用走新 repo 级 store（common-dir 键控），bare repo 多 worktree 天然共享（G3 达成）。
- **旧任务**：`~/.cw/<旧cwd>/store.json` 物理保留（cw 不删），但 cw 写操作不认（store-key 变了）。`cw list --all`（cross-cwd.ts 目录扫描）仍能扫到旧 store（只读可见，最后一道可见性，零额外代码），但 create/design/execute 等写操作只走新 store。
- **不做的事**：无归属算法、无 N→1 合并、无并发互斥锁、无 statusHistory 冲突仲裁、无存量 testCwd rebase、无 `cw migrate-store` 命令。
- **代价（已确认接受，决策 9 配套 warning）**：升级后进行中的 cw 任务在新版不可写、写操作不可见；需手动从旧 store JSON 重建。

**决策 8：`--workspace` flag 的后向语义显式定义。** S1 后 bash 用户仍可传 `--workspace`，需明确其角色：
- `--workspace` 值（缺省 `process.cwd()`）是 **probe 基准 + 执行位置基准**，**不是 store-key**。store-key 恒为「从该基准 probe 出的 common-dir」，非 git 目录时才 fallback 回该基准值（per-cwd 降级）。
- 降级链：`--workspace`(或 cwd) → probe common-dir 成功 → store-key=common-dir，workspace=show-toplevel；probe 失败 → store-key=workspace 原值（per-cwd），workspace=原值。store-key 与 workspace 在降级时才合流，正常态分离——原「单一 --workspace 兼任两角色」的耦合 bug 以此显式拆解，不残留。
- 被否：`--workspace` 继续兼任 store-key（旧语义）——正是本次要消除的耦合。

**决策 9：弃用 warning + minor 版本（不迁旧 store 的配套）。**

决策 7 不迁旧 store，需配套让用户感知这个 breaking change：
- **启动弃用 warning**：cw-cli 启动时检测当前 repo 是否存在旧 per-cwd store（旧路径 `~/.cw/<encodeCwd(旧cwd)>/store.json` 仍存在），存在则**一次性** stderr warning：「v2 起 store 改 repo 级（git-common-dir 键控），旧 per-cwd store 已弃用；存量任务需重建或手动从 `~/.cw/<old>/store.json` 捞」。**不引导迁移命令**（无迁移功能）。用 marker 文件（`~/.cw/.deprecation-warned-<encoded>`）去重，避免每次启动刷屏。
- **版本号 minor + 醒目 warning**：虽是 breaking（store 路径变 + testCwd 契约收紧），但不跳 major——靠启动 warning + CHANGELOG 集中传递。理由：单人/小众项目，major 跳号成本 > 收益；warning 已覆盖感知。
- **list --all 不改**：cross-cwd.ts 目录扫描照常，旧 store 只读仍可见（决策 7）。

**附带收益：只读 action 跨 worktree 自动统一。** 现状只读 action（status/list/tree/handoff，`src/cli.ts:747` runReadonly）也 `new CwStore(workspacePath)` → 走 cw-cli `process.cwd()` per-cwd store。方案 A 下沉后 cw-cli 内部 `getCwJsonPath` 统一归一化，只读 action 自动也走 common-dir store，跨 worktree 查询不再分叉——这是下沉带来的结构性收益，无需额外机制。

---

## §4 下一层拆分

### §4.1 实施路径

| 步骤 | 改动项目 | 内容 | 验证 |
|---|---|---|---|
| **S1** | coding-workflow（cw-cli） | ① `getCwJsonPath` 内部 `detectCommonDir` 归一化（common-dir 优先，fallback workspace）；② `constructCwDeps` 解耦（store 用归一化值，git/test/file 用 workspace=show-toplevel）；③ **design/replan 入参校验拒绝绝对路径 testCwd**（决策 4 机器检查）+ guidance 补「相对仓库根、禁止绝对路径」；④ 探测失败降级；⑤ 进程内 memoize common-dir/show-toplevel（决策 6）；⑥ **启动弃用 warning**（决策 9：检测旧 per-cwd store + 一次性 stderr + marker 去重） | 单测：common-dir 归一化、4 关注点分别用对的值、降级路径、testCwd 绝对路径被拒、相对根跨 worktree 解析、弃用 warning 触发与去重 |
| **S2** | cw-tool（pi extension，跨项目协调） | 删除 `detectRepoWorkspace` + `--workspace` 透传逻辑；cw-tool 退回纯封装（只透传 action/unitId/input，workspace 由 cw-cli 自己探测） | 单测：cw-tool 不再传 --workspace，cw-cli 内部归一化生效 |

> **S1/S2 原子上线 + 版本契约（关键约束）**：「同一批次发布」是流程愿望不是机制——cw-tool（`@zhushanwen/pi-cw-tool`）与 cw-cli（`@zhushanwen/coding-workflow`）是两个独立 npm 包，用户可独立升级。**错配组合分析**：
> - **旧 cw-tool（传 dirname(common-dir)）+ 新 cw-cli（S1）**：cw-cli 在容器探测 common-dir 失败 → fallback 容器 per-cwd → cw-tool 路径和现状一样坏（已论证）；
> - **新 cw-tool（S2，不传 --workspace）+ 旧 cw-cli（无 S1）**：cw-cli 用 `process.cwd()` per-cwd → **回退到 bash/cw-tool 割裂**（G2 倒退）。
>
> 机制保障（二选一）：① cw-tool 声明对 cw-cli 的 **peerDependencies 最低版本**（含 S1 的 cw-cli 版本号），安装期约束；② cw-tool 运行时探测 cw-cli 归一化能力（如 `cw version` 或特性 flag 门控），不满足则保留旧 `--workspace` 行为兜底。二选一，不可仅靠「约定同时发布」。

### §4.2 文件改动地图

**coding-workflow（本项目 `src/`）**：
- `src/store/schema.ts` — `getCwJsonPath` 内部增加 common-dir 归一化（探测 `git rev-parse --path-format=absolute --git-common-dir`，失败 fallback 原 cwd）
- `src/cli.ts` — `constructCwDeps` 解耦（store 用归一化 common-dir，git/test/file 用 workspace=show-toplevel）；workspace 解析加 `show-toplevel`；新增 `detectCommonDir` + `detectWorktreeRoot` 辅助函数
- `src/store/cw-store.ts` — `CwStore` 构造配合归一化后的 dbPath（迁移须尊重现有文件锁 `lockPath` + 原子写 `renameSync` 机制，`src/store/cw-store.ts:88,143,166`）
- `src/guidance/templates/wave.ts` — testCwd guidance 补「相对仓库根、禁止绝对路径」
- `src/handlers/validate-input.ts` — design/replan 入参校验加「拒绝绝对路径 testCwd」（决策 4 机器检查，非仅文案）
- `src/cli.ts`（启动入口）— 新增弃用 warning：启动检测旧 per-cwd store 路径存在 + marker 去重（决策 9）；无 migrate.ts（不迁）
- `tests/` — 新增 common-dir 归一化测试（bare repo `.bare` + 普通 repo `.git` + linked worktree + 非 git 目录 + 普通 repo 从子目录调用）+ migrate 测试（含冲突即停）

**cw-tool（跨项目，`extensions/cw-tool/`，仅列协调需求）**：
- `src/cw-runner.ts` — 删除 `detectRepoWorkspace`；`executeCwAction` 移除 workspace 探测 + `--workspace` 透传
- `src/__tests__/` — detect-repo-workspace 相关测试删除或改为「不传 --workspace」契约

**ADR（本项目 `docs/adr/`）**：
- 新增 ADR 记录「cw-cli 内部 common-dir 归一化」决策（对应 cw-tool 项目的 ADR-0045 Superseded）

### §4.3 待验证检查点（实施期门槛 ⛔）

| ID | 待验证 | 验证方式 | 阶段 |
|---|---|---|---|
| V-normalize | cw-cli common-dir 归一化在 bare/普通 repo 都返回稳定**绝对** repo 标识；edge case（separate-git-dir / submodule）行为明确 | 构造 bare repo + 普通 repo + linked worktree + 普通 repo 从子目录调用 + separate-git-dir + submodule，对比 `getCwJsonPath` 输出（子目录与 repo 根一致验证 absolute；separate-git-dir 用 common-dir 原值稳定；submodule 按 `.git/modules/<name>` 独立 store） | S1 前 |
| V-testcwd-relative | testCwd 相对仓库根 + workspace=show-toplevel 后，跨 worktree 解析到正确子包；含相对 testCwd 的 unit 测试在各 worktree 跑对地方 | 构造含相对 testCwd（如 `packages/auth`）的 unit，在 2 个 worktree 各跑 cw test，断言 cwd = 各自 worktree 的 `packages/auth` | S1 |
| V-bash-unified | bash 调 cw 与 cw-tool 调 cw 访问同一 store（G2 达成） | bash `cw create` + cw-tool `cw status`，确认命中同一 store 的 unit | S2 后 |
| V-bare-e2e | bare repo worktree 端到端：cw-tool 全 4 工具 + 递归编排 wave 跨 worktree | 本项目两 worktree（如 `fix-cw-config-json` + `fix-cw-cwd-worktree`）实跑 cw_planning create + cw_wave design | S2 后 |

---

## 探针清单（运行时断言验证，设计准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-object-store | bare repo 所有 worktree 共享 git object store，任意 worktree 能 cat-file 其他 worktree commit | 当前 worktree `git cat-file -e main^{commit}` | ✅ 已测（本项目） |
| P-toplevel | `show-toplevel` 从 worktree 根和子目录都稳定返回 worktree 根 | 本项目 worktree 根 vs `git -C src show-toplevel` 输出对比 | ✅ 已测（本项目） |
| P-common-dir-bare | 同一 bare repo 所有 worktree 的 git-common-dir（absolute）相同（store-key 统一性） | 本项目 worktree `git rev-parse --path-format=absolute --git-common-dir` = `.bare` | ✅ 已测（本项目） |
| P-dirname-harmful | dirname(common-dir) 对 bare repo 有害 | 本项目实测 `dirname(.bare)` = `coding-workflow-workspace`（容器，非任何 worktree） | ✅ 已测（本项目） |
| P-absolute | 裸 vs `--path-format=absolute` 差异（撞名风险） | 本项目 bare repo worktree 裸命令恰好返回绝对；普通 repo（`git init`）裸命令根返回相对 `.git`、子目录返回 `../../.git`、`--path-format=absolute` 全场景稳定绝对 | ✅ 已测（本项目 bare repo + 审查轮 mktemp 构造普通 repo/linked worktree 独立复测） |
| V-normalize | cw-cli 内部归一化 bare/普通 repo 稳定 | 见 §4.3 | ⛔ S1 前 |
| V-testcwd-relative | testCwd 相对根跨 worktree 正确 | 见 §4.3 | ⛔ S1 |
| V-bash-unified | bash 与 cw-tool store 统一 | 见 §4.3 | ⛔ S2 后 |

---

## 附录：与现有决策的关系

- **ADR-0008（本项目，v1 schema + RepoMeta）**：ADR-0008 只加 schemaVersion + repoMeta 字段（读侧不做版本校验），**不含迁移逻辑**。本设计**不迁旧 store**（决策 7），故不复用 RepoMeta 做归属；store-key 用 common-dir 而非 remoteUrl（决策 2 + 方案 C 否决理由）。历史两次 1:1 路径 rename 迁移（代码已移除）与本案无关。
- **ADR-0045（cw-tool 项目，cw-tool 附加 --workspace）**：本设计将其状态标记为 Superseded——核心洞察（store 应 repo 级共享、用 common-dir 做标识）完全成立并被继承，修正其实现错误（多余 dirname + 单一 --workspace 兼任两角色 + 归一化放错层）。cw-tool 项目需同步修订该 ADR。
