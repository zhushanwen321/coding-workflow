# wt-4 验收标准：集成汇聚与回流（W4）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-worktree-isolation.md`（v3）§3.3 D5/D6（含 S2 裁决：merge 内聚进 runIntegrationVerify、失败也落报告）、§5 W4 行。
> 波次定位：W4 = 集成从「隐式共享 HEAD」升级为「显式 merge 汇聚到 root 分支」；集成 verify 三处 HEAD 消费点全部锚 root 分支引用；worktree 生命周期闭环（孤儿清扫 + 延迟回收 + 回流指引）。

## 1. 目标

子产出经 merge 显式汇聚到 `cw-root/<rootId>`；集成 verify 只信 root 分支（与项目 cwd HEAD 解耦）；closed worktree 有界回收（延迟一轮 + 启动孤儿清扫）；root closed 汇总给出回流指引（G5）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/integrate.ts` | 修改 | 步骤 0（merge 汇聚，内聚）+ 三处 HEAD 改锚 root 分支（§4 契约） |
| `src/runner/worktree.ts` | 追加 | `listUnitWorktreeIds`（§4 契约） |
| `src/runner/loop.ts` | 修改 | 启动孤儿清扫、每轮延迟回收（pendingReclaim）、summaryText 回收清单 + 回流指引 |
| `tests/wt4-integration-merge.test.ts` | 新建 | §6 条款 M1-M8 |
| `tests/` 既有文件 | 断言适配 | u8-integrate / u8-e2e / fx2 / u7-loop 等（§7 边界） |

## 3. 关键裁决（口径锁定）

**J1 merge 内聚与幂等**：`runIntegrationVerify` 新增步骤 0（在可达性检查之前）——ensure root worktree（`ensureUnitWorktree(cwd, worktreePath(getCwWorktreeHome(), cwd, rootId), rootId, rootId, revParseHead(cwd))`，四格复用；失败收 failures + report fail）→ 逐子：若子 commit **已**在 root 分支可达（`isAncestor` 对 root 分支）→ 跳过 merge（幂等重跑天然成立）；否则在 root worktree 执行 `git merge --no-edit cw/<rootId>/<unitId>`，成功后 best-effort `git -C <repoDir> branch -D <子分支>`（静默，P-wt5 保证可达）。merge 冲突 → `git merge --abort` 清理现场 → failures 收 `子 <unitId> merge 冲突` + 恢复指引（root worktree 路径 + `CW_PROJECT_DIR="<cwd>"` 内联前缀形态）。

**J2 三处锚定**：`revParseHead(cwd)` 改解析 root 分支（`git -C cwd rev-parse cw-root/<rootId>`，失败 = 集成锚点缺失 failures）；`isAncestor(cwd, commit)` 改对 root 分支 ref；`cleanCheckout(cwd, head)` 传 root 分支 hash（解析后传 hash——分支名在 clone 内不存在）。`IntegrateReport.head` = root 分支 HEAD。

**J3 孤儿清扫**：runLoop 启动时（HEAD 快照之后、首次派发之前）——`listUnitWorktreeIds(home, cwd)` 扫描目录名，对每个 id 查**全账本**投影：unit 已 closed（树感知口径）或账本内不存在 → `removeWorktree`（best-effort，失败 stderr 指引继续）；未 closed（含其他 root 的 unit）→ 保留。扫描与回收不阻塞主循环（同步执行，量级小）。

**J4 延迟回收**：每轮循环开头回收「上一轮循环结束时已 closed 且尚未回收」的 unit worktree（pendingReclaim 集合：本轮发现的 closed 加入，下轮开头执行回收后清出）；root 自身 worktree 不回收（回流载体，run 结束保留）。J3 是跨 run 兜底，J4 是 run 内语义（debug 翻看现场留一轮窗口）。

## 4. 接口契约（签名锁定）

```ts
// src/runner/worktree.ts 追加：
/** 扫描项目 worktree 根 <cwWorktreeHome>/<encodeCwd(projectCwd)>/ 下的全部 unit 目录名（非目录项忽略；不判定状态，closed 判定由调用方查账本） */
export function listUnitWorktreeIds(cwWorktreeHome: string, projectCwd: string): string[];

// src/runner/integrate.ts —— runIntegrationVerify 签名不变（opts 字段不动），内部新增步骤 0 与锚定改法见 §3；报告 head 字段 = root 分支 HEAD
```

loop.ts 的 `runIntegrationDispatch` 调用点签名不变（merge 已内聚）。

## 5. 禁改清单（违反 = FAIL）

- `src/verify/`（checkout.ts 的 cleanCheckout 接口不变）、`src/handlers/`、`src/core/`、`src/events/`、`src/store/`、`src/cli.ts`、`src/runner/spawn/*`、`src/runner/human-loop.ts`
- `src/runner/worktree.ts` 既有函数（wt-1/wt-2 已验收）零改动，仅追加 `listUnitWorktreeIds`
- `docs/`、`archive/`、配置文件
- 既有测试改动仅限断言适配（§7），禁止改测试逻辑/删测试/放宽断言

## 6. 新增测试条款（tests/wt4-integration-merge.test.ts，真实子进程 + tmp git 仓库 + CW_HOME/CW_WORKTREE_HOME 隔离，零 mock）

- M1 汇聚：双子各自 worktree 分支 commit → 集成 pass → root 分支 HEAD 对两子 commit 均 isAncestor；报告 head = root 分支 HEAD（≠ 项目 cwd HEAD）；两子分支已删；`git log cw-root/<rootId>` 含子 commit。
- M2 merge 冲突：双子改同文件同区域 → 集成 fail、failures 含冲突 unitId 与恢复指引（root worktree 路径 + 内联前缀）；root worktree 冲突现场已 abort（porcelain 除 `.cw-spawn/` 外干净）；经 loop 断言 fail VerifyRan 入账（或直调断 IntegrateResult.failures 非空 + report 落盘含冲突事实）。
- M3 锚定解耦：项目 cwd 在集成前有独立新 commit（HEAD 领先 root 分支 base，且不含子 commit）→ 集成可达性检查仍 pass（旧锚定下会全灭）。
- M4 root worktree 重建：集成前删 root worktree 目录（保留分支）→ 集成时自动重建（亡/在格）→ merge/verify 正常完成。
- M5 孤儿清扫：预置三类 worktree——已 closed unit、未 closed unit、账本不存在的 unitId → runLoop 启动 → 第一、三类被回收（目录消失），第二类保留。
- M6 延迟回收：fake adapter 推进至某 unit closed → 当轮其 worktree 仍在；下一轮循环后 → 已回收；root worktree 全程保留。
- M7 汇总输出：root closed 的 summary 含「已回收 worktree × N；保留 × M」清单与 `git merge cw-root/<rootId>` 回流指引行。
- M8 幂等重跑：集成 pass 后再次 runIntegrationVerify（子 commit 已达）→ 跳过 merge（无 merge 调用或 up-to-date）、ok=true、报告落盘。

## 7. 既有测试适配边界

- `tests/u8-integrate.test.ts` / `u8-e2e.test.ts`：直调 runIntegrationVerify 的用例——现在会建 root worktree + merge（需 root worktree 前提与子分支现场）；断言「HEAD 可达」语义改 root 分支口径。适配为构造子分支 + root worktree 现场（或经 loop 驱动），行为语义等价。
- `tests/fx2-integration-recovery.test.ts`：失败注入路径适配（失败事实入口不变——failures 语义与 recovery guidance 原样）。
- `tests/u7-loop.test.ts` 等 summaryText / 循环输出断言：新增回收清单行后适配。
- 适配原则：同一场景仍验证同一行为；新增行为（merge/回收）由 M1-M8 覆盖，不在旧测试里重复展开。

## 8. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                                        # exit 0
npx vitest run tests/wt4-integration-merge.test.ts       # 全绿
npx eslint src/runner/ tests/wt4-integration-merge.test.ts  # 零输出
npm test                                                 # 全量绿（313 基线 + 新增，本波不留红）
```

## 9. status 字段

全部通过 → 汇报文件清单 + 各命令输出尾部 + §6 条款对照 + §7 适配清单（文件 × 性质）；未达成如实说明；实现与本文档冲突时披露冲突点与处理理由。
