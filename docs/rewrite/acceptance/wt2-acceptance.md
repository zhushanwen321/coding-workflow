# wt-2 验收标准：spawn 链路 worktree 拆分（W2）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-worktree-isolation.md` §3.3 D1/D2/D3/D5（含 D2 勘误）、§5 W2 行（含实施注记）。
> 波次定位：W2 = **行为切换点**——spawn 的 workdir 从项目 cwd 切换为 unit 专属 worktree，账本/仓库操作锚定项目 cwd（D3 双路径拆分）。受影响的既有测试断言**随本波迁移**（理由见设计文档 §5 W2 实施注记：行为切换即迁，保证本波可独立验收、不留回归防护真空）。

## 1. 目标

runner 派发前为 unit 确保 worktree 就绪；agent 子进程在 worktree 里干活，其 cw 命令经 `CW_PROJECT_DIR` 锚定项目账本；human 转人工路径全链路可用（设计 §4 场景 4 在本波验收）。

## 2. 交付物（文件级）

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/spawn/types.ts` | 追加字段 | `AgentSpawnRequest.projectCwd`（§4 契约） |
| `src/runner/worktree.ts` | 追加函数 | `ensureUnitWorktree`（§4 契约） |
| `src/runner/loop.ts` | 修改 | 启动 HEAD 快照、派发点接 worktree、brief 落盘迁 worktree、文案更新（§5 逐点） |
| `src/runner/spawn/pi.ts` | 修改 | spawn env 注入 `CW_PROJECT_DIR` |
| `src/runner/spawn/human.ts` | 修改 | 账本定位锚 `projectCwd`、指令清单加 export 行 |
| `tests/wt2-dispatch-worktree.test.ts` | 新建 | §7 新增条款 |
| `tests/` 既有文件 | **断言迁移** | 仅限 §6 列出的迁移性质改动 |

## 3. 关键裁决（builder 必读，口径已锁定不得另选）

**R1 baseCommit**（设计 D2 勘误后口径）：`runLoop` 启动时执行 `git -C <opts.cwd> rev-parse HEAD` 一次性快照；全部 unit 的 worktree 同 base。失败（非 git 仓库 / 无 HEAD）→ throw 可操作错误（git 是证据链硬依赖，fail-fast 优于空转到 idle 超时）。

**R2 worktree 就绪三步**（ensureUnitWorktree 内聚）：
1. `worktreeDir` 目录已存在 → `resetWorktree(worktreeDir)` 复用（D5：同 unit 后续角色/重派先 reset——清未提交半成品，保留已 commit 产出）；
2. 目录不存在 → `addUnitWorktree(repoDir, worktreeDir, unitId, baseCommit)`（新建分支）；
3. 步骤 2 失败且 git 原文含 `already exists`（分支残留——上次 run 异常退出）→ `git -C <repoDir> worktree add <worktreeDir> cw/<unitId>`（不带 -b，checkout 既有分支——中断重跑复用分支上已 commit 的产出）；仍失败 → `{ok:false, error 含恢复指引}`。

**R3 派发失败不炸循环**：ensure 失败 → `emitErr`（error 原文，含恢复指引）+ **跳过该 unit 本轮派发**（不 push inFlight，其余 unit 继续；下轮重算重试，无人处理时由 maxIdle 兜底退出）。

**R4 旧近似保留**：`checkWorkspaceForDispatch` 及其调用点（loop.ts 约 956-961 的 workspaceChecked 块）**本波不动**（W3 删）。本波后它对项目 cwd 基本恒空转（agent 不再在项目 cwd 干活），无害。

## 4. 接口契约（签名锁定）

```ts
// src/runner/spawn/types.ts —— AgentSpawnRequest 追加（必填）：
/** 项目仓库目录：账本定位与仓库操作的锚点（agent 的 cw 命令经 CW_PROJECT_DIR 锚定此处；与 workdir 分离见设计 D3） */
projectCwd: string;

// src/runner/worktree.ts —— 追加（R2 三步的封装；WorktreeOutcome 复用既有类型）：
export function ensureUnitWorktree(
  repoDir: string,
  worktreeDir: string,
  unitId: string,
  baseCommit: string,
): WorktreeOutcome;
```

## 5. loop.ts 改动点（逐点锁定）

1. **启动快照**（R1）：`rev-parse HEAD` 失败 throw，message 含「恢复动作：cw 依赖 git 仓库（evidence/verify 均需），在项目仓库内运行 cw run，或先 git init + commit」。
2. **派发点**（现 978-985）：按 §4 契约接 `ensureUnitWorktree`；成功 → `writeBriefFile(wtDir, …)` + `adapter.spawn({ …, workdir: wtDir, projectCwd: opts.cwd })`；失败 → R3。派发日志行追加 worktree 路径。
3. **writeBriefFile**：落盘根从 `opts.cwd` 改为 worktreeDir（briefPath = `<wtDir>/.cw-spawn/<unitId>.<role>.brief.md`）；renderBrief 的「环境约定」段改为：
   ```
   ## 环境约定
   - workdir: <wtDir>（unit 专属 git worktree，分支 cw/<unitId>）
   - 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 <opts.cwd>）
   ```
4. **escalationMessage**：stdoutPath 改为 `join(worktreePath(getCwWorktreeHome(), cwd, unitId), ".cw-spawn", …)`。
5. **idleFailureMessage**：「查看 <workdir>/.cw-spawn/」改为「查看各 unit 的 worktree（~/.cw-worktrees/<encoded-cwd>/<unitId>/.cw-spawn/）下 agent 的 stdout / stderr」。
6. **模块头注释**：删「M1 简化：workdir = cwd 本身」段，替换为 worktree 语义一句话 + 指向设计文档。
7. **集成直跑（runIntegrationDispatch）本波不动**（cwd 语义照旧，W4 改）。

## 6. pi.ts / human.ts / 既有测试迁移

**pi.ts**：`spawnProcess` 的 env 改为 `{ ...req.env, CW_PROJECT_DIR: req.projectCwd }`（注入在适配器层，lifecycle 合并逻辑不变）。

**human.ts**：
- `readLedgerEvents`：`ledgerPath(cwHome, req.projectCwd)` 替代 `req.workdir`（**必改**——否则 human 轮询读 worktree 编码下的空账本，永远等不到完成信号）；
- `renderInstructionLines` 在 `cd <workdir>` 行后追加一行：`[human]   export CW_PROJECT_DIR=${req.projectCwd}（cw 命令锚定项目账本——在 worktree 里执行 cw 前必须设置）`。

**既有测试迁移**（仅允许下列两类改动，语义弱化 = FAIL）：
- 直接构造 `AgentSpawnRequest` 的测试（u6a/u6b/u6c 系）补 `projectCwd` 字段（值 = 测试的项目 tmp 目录）；
- 断言 `.cw-spawn` 路径 / brief 位置 / 派发 workdir / stderr 文案路径的测试（u7-loop、u7-e2e、u7b、fx1 系、fx2、fx3 系、u8 系、e2e 系）迁移断言目标到 worktree 路径，测试 env 设 `CW_WORKTREE_HOME=<tmp>` 隔离（与 CW_HOME 同款）；确需 git 仓库前提的 tmp fixture 补 `git init + commit`（R1 行为前提）。
- 迁移后受影响测试的**行为语义必须等价**（同一场景仍验证同一行为，只是路径/env 前提变化）。

## 7. 新增测试条款（tests/wt2-dispatch-worktree.test.ts，真实子进程 + tmp，零 mock）

- T1 派发双传：fake adapter 捕获 req——`workdir === worktreePath(home, cwd, unitId)` 且 `projectCwd === cwd`（`CW_WORKTREE_HOME` 指 tmp）。
- T2 worktree 物理创建：派发后目录存在、`git -C <repo> rev-parse cw/<unitId>` = run 启动 HEAD 快照。
- T3 重派复用与 reset：同 unit 二次派发（fake adapter 两次 exit≠0 触发重派，或直接二次 runLoop）→ worktree 目录不变；在 worktree 预置 tracked 脏改 + untracked 文件后重派 → 两者被清（porcelain 为空）。
- T4 中断重跑复用分支（R2 步骤 3）：首轮派发后终止循环（kill/短 maxIdle）；worktree 内 commit 一个新文件；分支残留但删除 worktree 目录（模拟异常退出）；重跑 runLoop → 复用既有分支，commit 的新文件仍存在。
- T5 ensure 失败跳过（R3）：构造 add 必败态（repoDir 为非 git 目录的 unit 派发——或 worktree.ts 单元级直测 ensure 三步全败路径）→ 该 unit 不 spawn、循环不炸、stderr 含恢复指引。
- T6 brief 落盘与内容：briefPath 在 `<wtDir>/.cw-spawn/` 下；内容含 worktree 路径行与 CW_PROJECT_DIR 说明行；项目 cwd 下**不再**新增 `.cw-spawn/`。
- T7 pi env 注入：捕获 spawnProcess 入参（或子进程 env 探针——跟随 u6c 既有模式），断言 `CW_PROJECT_DIR === req.projectCwd`。
- T8 human 指令与账本锚定（场景 4 前半）：human adapter 派发 → 指令清单含 `export CW_PROJECT_DIR=<项目cwd>` 行；`wait()` 轮询期间在**项目账本**追加该 unit 的完成信号事件（测试进程模拟人在 worktree 里跑 cw）→ wait 正常返回 exit 0，无 TIMEOUT。
- T9 e2e human 全链路（场景 4 完整）：tmp git 项目 + CW_HOME/CW_WORKTREE_HOME 隔离；runLoop（human adapter）派发 builder 后，测试进程按指引在 worktree 里（env 已设 CW_PROJECT_DIR）真实执行 `cw evidence submit`（子进程跑 dist/cli.js 或等效 node 直调——跟随既有 e2e 模式）→ 事件写入项目账本（`~/.cw-home-tmp/<encoded-cwd>/events.log`）而非 worktree 编码账本；循环推进到下一状态。
- T10 非 git cwd：runLoop 启动即抛可操作错误（R1）。

## 8. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                                   # exit 0
npx vitest run tests/wt2-dispatch-worktree.test.ts  # 全绿
npx eslint src/runner/ src/store/ src/cli.ts        # 零输出（本波领地）
npm test                                            # 全量绿（297 基线 + 新增；既有测试迁移后全绿——本波不留红）
```

## 9. 禁改清单（违反 = FAIL）

- `src/runner/integrate.ts`、`src/runner/human-loop.ts`（W4/只读域）
- `checkWorkspaceForDispatch` 函数体及其调用点（W3 领地，本波保留）
- `src/verify/`、`src/handlers/`、`src/core/`、`src/store/`（除 wt-1 已交付内容外零改动）、`src/cli.ts`
- `docs/`、`archive/`、`package.json`、eslint/tsconfig
- 既有测试文件的改动仅限 §6 列出的两类迁移性质（追加 projectCwd 字段 / 路径与 env 断言迁移）；禁止改测试逻辑、删测试、放宽断言

## 10. status 字段

- 全部通过 → 汇报文件清单 + 各命令输出尾部 + §7 条款对照表 + **§6 迁移清单**（文件 × 改动性质 × 处数）。
- 任一未达成 → 如实列出；实现与本文档冲突时披露冲突点与处理理由，不静默偏离。

## 11. 返工规格（v2 基线，2026-08-16 设计 v2 对抗审查后追加；与 §1-10 冲突处以本节为准）

背景：设计文档 v2（分支双空间 / clean 排除产物 / human 内联前缀 / D5 四格矩阵 / 文件解析锚定分离）经对抗审查定案。首版 wt-2 交付（工作区未验收）按旧口径实现，按本节返工。审查报告：/tmp/design-review-worktree-v2.md（must-fix 6 条中 4 条落在 wt-2 交付面）。

**R-1 分支命名双空间**（worktree.ts）：`unitBranchName` 签名改 `(rootId: string, unitId: string): string`——`unitId === rootId` 返回 `cw-root/${rootId}`，否则 `cw/${rootId}/${unitId}`。loop.ts 调用点传 `opts.rootId`；涉及测试断言（wt1 B1/B3、wt2 T2/T4）同步。

**R-2 reset 排除产物**（worktree.ts）：`resetWorktree` 的 clean 改 `clean -fd -e .cw-spawn`（探针 P-wt8）。测试补断言：换角色重派后上一角色 stdout/stderr/brief 仍在（wt1 B5 补 untracked 目录排除断言——预置 `.cw-spawn/x` 与普通 untracked，前者留后者删）。

**R-3 ensureUnitWorktree 四格矩阵**（worktree.ts，替换首版两态近似——禁 `error.includes("already exists")` 字符串匹配）：签名 `(repoDir, worktreeDir, rootId, unitId, baseCommit)`。分支检测用 `git -C repoDir rev-parse --verify --quiet <branch>`，目录检测用 `existsSync`：
- 目录在 + 分支在 → `resetWorktree` 复用；
- 目录亡 + 分支在 → `git -C repoDir worktree add <path> <branch>`（无 `-b`）；若因 stale worktree 注册失败，先 `git -C repoDir worktree prune` 重试一次，仍败 → error；
- 目录在 + 分支亡 → `{ok:false}`，error 指引 `git worktree remove --force <path>` 后重跑（env error 语义，loop 跳过该 unit 本轮派发，沿用 R3 首版跳过行为）；
- 目录亡 + 分支亡 → `add -b` 新建。
测试四格逐格构造（wt2 T4 改造为「亡/在」格的正测 + 新增「在/亡」格 error 测）。

**R-4 human 指令内联前缀 + 引号规则**（human.ts）：删首版的 `export CW_PROJECT_DIR=…` 行；`roleStepLines` 每条 cw 命令渲染为 `CW_PROJECT_DIR="<projectCwd>" cw …`；`cd "<workdir>"` 加双引号。路径渲染规则：一律双引号包裹（POSIX/macOS 路径含 `"` 非法，不另设转义）。wt2 T8 断言从 export 行改为：指令中每条 cw 命令含内联前缀、cd 含引号。

**R-5 文件路径解析锚定分离**（src/handlers/common.ts + 调用点）：`resolveAgainstCwd` 的锚从 `ctx.cwd` 改为 `process.cwd()`——`CW_PROJECT_DIR` 只锚账本定位与 git 仓库操作，文件路径参数（`--file`/`--brief`）相对执行者所在目录解析。先 grep 全部调用点统一改。新增测试：设 `CW_PROJECT_DIR=<项目A>`、进程 cwd 在目录 B、B 下有 spec.json 而 A 下无 → `cw evidence submit --kind spec --file spec.json` 读到 B/spec.json（解析跟随进程 cwd）；账本事件仍写 A 的账本（锚定不跟随）。既有非 worktree 测试行为不变（两锚同值）。

**R-6 测试迁移同步**：R-1/R-3/R-4 引起的既有断言（wt1/wt2 及首版迁移的 11 文件中涉分支名/矩阵行为/指令形态处）同步更新；语义等价，不放宽。

**通过命令**：同 §8（check:all / 本 unit vitest / eslint 领地 + src/handlers / npm test 全量绿）。汇报要求同 §10 + R-1~R-6 逐项对照。
