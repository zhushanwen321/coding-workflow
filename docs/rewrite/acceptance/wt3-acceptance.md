# wt-3 验收标准：reset 语义替换收尾（W3）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-worktree-isolation.md`（v3）§3.3 D4、§5 W3 行。
> 波次定位：W3 = 纯删除波——精确 reset 语义（`ensureUnitWorktree` 在/在格：reset --hard + clean -fd -e .cw-spawn）已随 wt-2 落地，本波删除共享 cwd 时代的近似实现及其全部残留。**行为变化**：项目 cwd 的 tracked 脏改动不再被 runner 触碰（worktree 模式下项目 cwd 属于用户）。

## 1. 目标

删除 `checkWorkspaceForDispatch` 近似链，项目 cwd 与 agent 工作区彻底解耦。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/loop.ts` | 删除 | `checkWorkspaceForDispatch` 函数（约 826-849）、`trackedDirtyLines`（约 792-825）、`PORCELAIN_STATUS_WIDTH` 常量（约 120）、派发循环内 `workspaceChecked` 块（约 994、1009-1013）；模块头注释「重派前工作区清理（共享 cwd 时代的近似，W3 将整体删除）」段改为一句 worktree 精确清理语义（指向 ensureUnitWorktree） |
| `tests/u7b-loop-timeout-reset.test.ts` | 注释同步 | 模块头注释第 12 行附近的旧语义描述改为 worktree 口径（半成品清理由派发点 ensureUnitWorktree 承担）；测试逻辑零改动 |
| `tests/wt3-reset-legacy-removal.test.ts` | 新建 | §4 条款 |

## 3. 禁改清单（违反 = FAIL）

- `src/` 除 `src/runner/loop.ts` 外全部禁改（尤其 worktree.ts / spawn/* / handlers/* / integrate.ts——ensureUnitWorktree 已验收，不动）
- `tests/` 既有文件除 u7b 注释行外零改动；`docs/`、`archive/`、配置文件禁改

## 4. 新增测试条款（真实子进程 + tmp，零 mock）

- A1 **项目 cwd 不再被 reset**：tmp git 项目 + 项目 cwd 预置 tracked 脏改动（改一个 tracked 文件不 commit）→ runLoop 派发（fake adapter）至重派轮次 → 项目 cwd 的脏改动**原样保留**（旧近似会 reset 它——此断言锁死行为变化，防近似复活）。
- A2 **worktree 半成品清理仍生效**（防删过头）：builder 失败（fake exit≠0）在 worktree 留 tracked 脏 + untracked → 重派 → worktree porcelain 除 `?? .cw-spawn/` 外为空（与 wt2 T3 同语义，此处从「近似已删」视角再锁一次）。
- A3 **派发流程零回归**：runLoop 完整推进（fake adapter 收敛 root closed），输出无「派发前清理」字样（旧文案已不存在）。

## 5. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                                   # exit 0
npx vitest run tests/wt3-reset-legacy-removal.test.ts tests/u7b-loop-timeout-reset.test.ts  # 全绿
npx eslint src/runner/loop.ts tests/wt3-reset-legacy-removal.test.ts  # 零输出
npm test                                            # 全量绿（310 基线 + 新增，本波不留红）
```

## 6. status 字段

全部通过 → 汇报删除清单（函数 × 行数）+ 各命令输出尾部 + §4 条款对照；未达成如实说明。
