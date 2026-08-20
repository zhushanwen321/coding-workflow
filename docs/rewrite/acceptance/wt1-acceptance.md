# wt-1 验收标准：worktree 基建（W1）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-worktree-isolation.md` §3.3 D1/D4/D5、§3.4 探针表、§5 W1 行。
> 波次定位：W1 = 纯增量基建，**不接任何调用方**（loop.ts / spawn/* 是 W2 领地，本 unit 禁碰），零行为变更。

## 1. 目标

交付 worktree 生命周期封装（add / reset / remove）与路径布局函数，供 W2-W4 接线使用。全部函数对真实 git 仓库（tmp 内 init）验证，零 mock。

## 2. 交付物（文件级）

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/worktree.ts` | 新建 | worktree 生命周期封装（§3 契约） |
| `src/store/project.ts` | 追加 | `getCwWorktreeHome` / `worktreePath` / `resolveProjectDir`（§4 契约；既有函数零改动） |
| `src/cli.ts` | 最小改动 | `dispatch(argv, process.cwd())` 改为 `dispatch(argv, resolveProjectDir(process.cwd()))` + import；其余零改动 |
| `tests/wt1-worktree.test.ts` | 新建 | §6 全部单测条款 |

## 3. 接口契约：`src/runner/worktree.ts`（签名锁定）

风格对齐 `src/verify/checkout.ts`：spawnSync 跑 git（单步 timeout 120s）；不抛裸异常，统一 Outcome 模式；错误文案可操作（含 git 原始 stderr + 恢复动作指引）。

```ts
/** worktree 操作结果：成功无返回值；失败 error 含原始失败原因与恢复指引 */
export type WorktreeOutcome = { ok: true } | { ok: false; error: string };

/** unit 分支名：<unitId> 已过 slug 校验，cw/ 前缀拼接无转义需求（P-wt6） */
export function unitBranchName(unitId: string): string; // 返回 `cw/${unitId}`

/**
 * 为 unit 创建独立 worktree（P-wt1）。
 * 1. unitId 必须匹配 ^[a-z][a-z0-9-]*$（src/handlers/create.ts:29-31 同规则）——不匹配返回
 *    error（防路径逃逸/分支名注入），且不产生任何文件系统副作用；
 * 2. mkdirSync(dirname(worktreeDir), { recursive: true })（git worktree add 不建多级父目录）；
 * 3. git -C <repoDir> worktree add <worktreeDir> -b cw/<unitId> <baseCommit>；
 * 4. 失败 error 形如：`git worktree add 失败（worktree "<dir>" 分支 cw/<unitId> base <baseCommit>）：<exit/stderr 原文>。恢复动作：git worktree list 查残留；确认无未保存产出后 git worktree remove --force <path> && git branch -D cw/<unitId>，重跑。`
 *    （P-wt1b：分支已存在时 git 原文即 `fatal: a branch named 'cw/<unitId>' already exists`）
 */
export function addUnitWorktree(
  repoDir: string,
  worktreeDir: string,
  unitId: string,
  baseCommit: string,
): WorktreeOutcome;

/**
 * 派发前重置 unit worktree（D4 精确语义）：清未提交半成品（含 untracked），保留已 commit 产出。
 * git -C <worktreeDir> reset --hard HEAD && git -C <worktreeDir> clean -fd，任一失败返回 error。
 */
export function resetWorktree(worktreeDir: string): WorktreeOutcome;

/**
 * 回收 unit worktree（D5：closed 延迟回收用 --force——脏残留可弃，P-wt4）。
 * git -C <repoDir> worktree remove --force <worktreeDir>；失败返回 error。
 */
export function removeWorktree(repoDir: string, worktreeDir: string): WorktreeOutcome;
```

## 4. 接口契约：`src/store/project.ts` 追加（与 getCwHome 同构）

```ts
/** worktree 根目录。默认 ~/.cw-worktrees，CW_WORKTREE_HOME 可覆盖；覆盖值必须绝对路径，否则抛错（错误消息含恢复动作，文案风格对齐 getCwHome）。 */
export function getCwWorktreeHome(): string;

/** unit worktree 路径：<cwWorktreeHome>/<encodeCwd(projectCwd)>/<unitId>——与账本目录同 encoded key（D1） */
export function worktreePath(cwWorktreeHome: string, projectCwd: string, unitId: string): string;

/** CLI 入口的项目目录解析：CW_PROJECT_DIR 非空时优先（必须绝对路径，否则抛错含恢复动作）；否则返回 fallback（D3 表第 5 行）。 */
export function resolveProjectDir(fallback: string): string;
```

`cli.ts` 接线后语义：无 `CW_PROJECT_DIR` 时与现状逐字节一致（`process.cwd()`）；有且合法时 dispatch 的 cwd 取 env 值（W2 起 spawn 注入，本波无注入方，零行为变更）。

## 5. 禁改清单（违反 = FAIL）

- `src/` 既有文件除 `src/store/project.ts`（仅追加）与 `src/cli.ts`（仅上述一行调用 + import）外全部禁改——尤其 `src/runner/loop.ts`、`src/runner/spawn/*`、`src/runner/integrate.ts`、`src/runner/human-loop.ts`（W2-W4 领地）。
- `tests/` 既有文件禁改（新增 `tests/wt1-worktree.test.ts` 是唯一可写测试文件）。
- `docs/`、`archive/`、`package.json`、eslint/tsconfig 配置禁改。

## 6. 单测验收（逐条可查，测试名可对应；全部真实子进程 + tmp 仓库，零 mock）

tmp 仓库初始化跟随 `tests/u2-evidence.test.ts` 的 `initRepo` 内联模式（mkdtemp 根 + `git init` + config user + 初始 commit 作为 baseCommit）。

**A 组：路径与 env 解析（store/project.ts）**
- A1 `getCwWorktreeHome()` 无 env 时 = `join(homedir(), ".cw-worktrees")`。
- A2 `CW_WORKTREE_HOME` 为绝对路径时生效；相对路径抛错且 message 含恢复动作（指向改绝对路径或取消变量）。
- A3 `worktreePath(h, cwd, u)` === `join(h, encodeCwd(cwd), u)`——与 `ledgerPath` 共享 encoded key（同 cwd 时两路径的第二段相同）。
- A4 `resolveProjectDir`：无 env 返回 fallback；绝对路径 env 返回 env 值；相对路径抛错（message 可操作）；env 为空串视为未设置（对齐 getCwHome 的空串语义）。

**B 组：worktree 生命周期（runner/worktree.ts）**
- B1 add 成功：worktree 目录存在；`git -C <wt> rev-parse --abbrev-ref HEAD` = `cw/<unitId>`；主仓库 `rev-parse cw/<unitId>` = baseCommit。
- B2 父目录多级缺失时 add 仍成功（recursive mkdir 生效）。
- B3 分支已存在时 add 失败（P-wt1b）：`{ok:false}`，error 含 `already exists` 原文与恢复动作文案。
- B4 非法 unitId（`../escape`、`UPPER`、空串至少三种）add 返回 error 且文件系统无新目录。
- B5 reset：worktree 内改 tracked + 新增 untracked 文件与目录 → reset 后 `git -C <wt> status --porcelain` 为空。
- B6 reset 保留已 commit 产出：worktree 内 commit 新文件 → reset → 文件仍在且 status 干净。
- B7 remove --force（P-wt4）：worktree 含脏文件时 remove 成功；目录消失；`git -C <repo> worktree list` 不再列出该路径。
- B8 object store 共享（P-wt2）：worktree 内 commit → 主仓库 `git -C <repo> cat-file -t <hash>` = `commit`。
- B9 clone 携带 refs（P-wt3）：worktree 内 commit 后，`git clone <repo> <tmp>` 内 `git cat-file -t <hash>` = `commit`。

**C 组：CLI 层 CW_PROJECT_DIR 接线（e2e，子进程跑真实 CLI）**
- C1 设 `CW_PROJECT_DIR=<项目A>` 且进程 cwd 在另一 tmp 目录：只读命令（如 `status`）读 A 的账本（A 预置含 unit 的账本时输出反映 A 的状态；具体断言跟随既有 e2e 基建的输出解析模式）。
- C2 不设 env 时行为与现状一致（读 cwd 账本；空账本正常退出不报错）。

## 7. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                    # exit 0
npx vitest run tests/wt1-worktree.test.ts   # 全绿
npx eslint src/runner/worktree.ts src/store/project.ts src/cli.ts tests/wt1-worktree.test.ts  # 零输出
npm test                             # 全量绿（282 既有 + 本 unit 新增）——零行为变更的直接证明
```

## 8. status 字段

- 全部通过 → 汇报文件清单 + 各命令输出尾部 + §6 条款对照表（测试名 ↔ 条款号）。
- 任一未达成 → 如实列出，不得谎报；实现与本文档冲突时在汇报中披露冲突点与你的处理理由（验收方笔误先例已发生 2 次，不默认文档对）。
