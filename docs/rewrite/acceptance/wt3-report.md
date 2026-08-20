# wt-3 验收报告：reset 语义替换收尾（W3 纯删除波）

> verifier 独立对抗验收。基线：commit `e1a8b8f` 的 `docs/rewrite/acceptance/wt3-acceptance.md`。
> 验收日期：2026-08-16。verifier 不修改任何代码/测试/文档（本报告为唯一写入）。

## 总结论：PASS

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff e1a8b8f -- docs/rewrite/acceptance/wt3-acceptance.md` | 空输出（未篡改） |
| 验收基线 sha256 | `781430ae308055507ac4e06c7ef5008d2fd1c409f466f642072567e3d41fb869` |
| `git status` 改动 | 恰好 3 项：`M src/runner/loop.ts`、`M tests/u7b-loop-timeout-reset.test.ts`、`?? tests/wt3-reset-legacy-removal.test.ts`（与 §2 交付物一一对应） |
| 禁改清单（§3） | `src/` 其余文件、`tests/` 既有文件（除 u7b 注释）、`docs/`、配置文件零改动 |

## 2. 纯删除证明（loop.ts diff 逐行审）

`git diff --numstat`：`src/runner/loop.ts` +2/-87；`tests/u7b-loop-timeout-reset.test.ts` +5/-4（全注释行）。

loop.ts 的**全部** `+` 行（grep "^+" 枚举，仅 2 行，均为模块头注释）：

```
+ * 半成品清理由派发点 ensureUnitWorktree（reset --hard + clean -fd -e .cw-spawn）
+ * 承担；项目 cwd 属于用户，runner 不触碰。
```

删除的 4 件套（与基线 §2 逐条对应）：

1. `checkWorkspaceForDispatch` 函数（含 JSDoc 与分隔注释）
2. `trackedDirtyLines` 函数（含 JSDoc）
3. `PORCELAIN_STATUS_WIDTH` 常量（含注释）
4. 派发循环内 `let workspaceChecked = false;` 声明 + `if (!workspaceChecked)` 调用块

零逻辑新增/修改的旁证：

- `ensureUnitWorktree` 调用点（现 loop.ts:950）、`snapshotHeadCommit` 快照逻辑、SPAWN_ERROR/TIMEOUT 处理、派发/spawn/emit 逻辑全部在 diff hunk 之外，零触碰
- 删除后无孤儿符号：`GIT_STEP_TIMEOUT_MS` 仍被 loop.ts:788（快照）使用，`emitErr` 仍有 6 处调用者
- u7b diff 的 +5/-4 行全部为 ` * ` 前缀的块注释行（旧「tracked 脏改动清理」口径 → worktree 口径），测试逻辑零改动

## 3. 通过命令实跑（基线 §5）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（check + check:tests 均过） |
| `npm run build && npx vitest run tests/wt3-reset-legacy-removal.test.ts tests/u7b-loop-timeout-reset.test.ts` | `Test Files 2 passed (2)` / `Tests 7 passed (7)` |
| `npx eslint src/runner/loop.ts tests/wt3-reset-legacy-removal.test.ts` | 零输出，exit 0 |
| `npm test` | `Test Files 44 passed (44)` / `Tests 313 passed (313)`，Duration 75.84s |

313 = 310 基线 + 3 新增（wt3 A1/A2/A3），与基线「310 基线 + 新增，本波不留红」一致。builder 自报 313 绿属实。

## 4. 新增测试条款对照（基线 §4）

| 条款 | 断言强度核实 | 结论 |
|------|--------------|------|
| A1 项目 cwd 不再被 reset | `contentAtRedispatch).toBe(dirtyContent)`（tests/wt3-reset-legacy-removal.test.ts:267）真内容比对；porcelain 双断言（:268-270，恰 1 行且以 M 开头）；重派轮次 `toBeGreaterThan(1)`（:265）；maxIdle 收束 `code===1`（:264）；结束后 a.txt 再次 toBe（:272）——非「只查函数不存在」 | 达标 |
| A2 worktree 半成品清理仍生效 | porcelain 过滤只排除空行与含 `.cw-spawn` 的行（:316-318）→ `toEqual([])`；文件级断言兜底：`half-done.tmp` 不存在（:321）、`brief.md` 回滚 toBe（:322）、`-e .cw-spawn` 产物保留（:324）——porcelain 误放过不可能通过 | 达标 |
| A3 派发流程零回归 | 3 角色全链 `toEqual(["designer","builder","reviewer"])`（:356）；root closed（:350-351，status + 输出文案）；exit 0；无「派发前清理」stdout/stderr 双查（:353-354）——3 次 spawn 收敛 closed 真实 | 达标 |

fixture 真实性：真实 git 子进程 + tmp 仓库 + 隔离 `CW_HOME`/`CW_WORKTREE_HOME`；`AgentSpawnRequest.projectCwd`/`workdir` 字段真实存在（src/runner/spawn/types.ts:16-18）。零 mock 框架。

## 5. 行为对抗抽查（verifier 独立探针，真实子进程 + tmp + 隔离，20 项断言全 PASS）

探针直调 dist 的 runLoop（rebuild 后），fake adapter 注入失败/SPAWN_ERROR 副作用，不依赖 builder 的测试文件。

- **P1 项目 cwd tracked 脏 + untracked 双保留**：改 tracked a.txt 不 commit + 预置 untracked user-untracked.txt → 失败 builder 重派 24+ 轮至 maxIdle 收束（exit 1）→ a.txt 内容 toBe 原样、untracked 文件原样、porcelain 仍含 `M a.txt` 与 `?? user-untracked.txt` 双行、输出无「派发前清理」旧文案。7/7 PASS。
- **P2 极端双语义同 run 验证**：失败 builder 在 unit worktree 留 tracked 脏（brief.md）+ untracked（half.tmp），同时项目 cwd 预置 tracked 脏 → 重派现场：worktree porcelain 除 `?? .cw-spawn/` 外为空、half.tmp 已清、brief.md 回滚 toBe；同一现场项目 cwd 内容 toBe 保留 + porcelain 仍报脏；结束后项目 cwd 脏仍保留。8/8 PASS。
- **P3（自行扩展）SPAWN_ERROR 出口路径**：adapter 返回 SPAWN_ERROR → 秒回 exit 1（非 idle 兜底）、stderr 含 SPAWN_ERROR 文案、单次 spawn 不重试、项目 cwd 预置脏改动 toBe 保留。5/5 PASS。
- **残留 grep**：`checkWorkspaceForDispatch|trackedDirtyLines|PORCELAIN_STATUS_WIDTH` 在 `src/` 与 `tests/` 零匹配；全仓（排除 .git/node_modules/dist）仅 `docs/rewrite/` 历史文档（design v3 / handoff / ledger / wt2 基线与报告）含描述性引用——属禁改的历史记录，非代码残留。
- 探针过程注记：第一版探针 P3 因未透传 `process.stderr.write` 回调触发 `emitExitOutput` 退出屏障挂起（exit 13），系探针自身缺陷（wt3 测试 :172-176 注释恰好说明了该约束），修正透传后全过；非被测代码问题。

## 6. 结论

纯删除波验收通过：4 件套删除干净（含全仓残留 grep）、loop.ts 零逻辑新增（+2 行全为注释）、u7b 仅注释、新增 A1/A2/A3 断言强度达标、313 全绿、verifier 独立行为探针 20/20 证实「项目 cwd 不再被 runner 触碰 + worktree 精确清理仍生效」两个语义同时成立。无失败项。
