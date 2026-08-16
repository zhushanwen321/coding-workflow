# wt-5 验收标准：对抗测试与探针勾验（W5 收口）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-worktree-isolation.md`（v3）§4 场景 1/3、§5 W5 行。
> 波次定位：W5 = 收口波——G1 的并发污染对抗固化为永久测试；canon P7 探针勾验（⛔→✅）；残余断言清理。**§4 场景 5（终验靶子，真实 pi 全流程 45min 级）按历史终验模式拆为 M3 gate 单独执行，不在本 unit。**

## 1. 目标

把「worktree 隔离消除三类污染」的核心声明固化为可回归的机器测试：并行 commit 不混卷（G1）、verify 真值不受 cwd 状态影响（G3/P7）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `tests/wt5-parallel-contamination.test.ts` | 新建 | §4 条款 C1（并发污染对抗）、C2（P7 场景勾验） |
| `.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md` | 一行更新 | 探针表 P7 行 ⛔ → ✅（注明勾验依据：wt5 C2 场景测试 + u4a cleanCheckout 单测） |
| `tests/` 残余清理 | 按需 | C4 复核（预期 zero，发现即迁） |

## 3. 禁改清单（违反 = FAIL）

- `src/` 全部禁改（本波纯测试 + canon 一行；发现 src 缺陷上报不擅改）
- `tests/` 既有文件零改动（C4 若发现语义残留，单独列出发汇报，由主 agent 裁决是否迁——本波不擅自改）
- canon 文档除 P7 一行外零改动；`docs/`、`archive/`、配置禁改

## 4. 新增测试条款（真实子进程 + tmp git 仓库 + CW_HOME/CW_WORKTREE_HOME 隔离，零 mock）

**C1 并发污染对抗（场景 1，G1）**：tmp git 项目，root spec 声明两子（unit-a/unit-b，验收 command 真实可执行的轻量命令），两子验收目标同改 `src/app.ts` 的**不同区域**（保证集成 merge 干净）；fake adapter（u7-e2e/fx3 模式）以 maxConcurrency=2 驱动全链——两 builder 在各自 spawn 回调里并行真实执行：在自己 worktree 改 `src/app.ts`（写入各自的标记行）、`git add + commit`、以 `CW_PROJECT_DIR` 内联前缀真实跑 `cw evidence submit`。同步屏障确保两 builder 的文件操作时间窗重叠。断言：
  - `git show <unit-a 的 evidence commit>` 的 diff 体只含 unit-a 的标记行、不含 unit-b 的标记行（互不混卷——commit 审计声明成立），unit-b 对称；
  - 两个 worktree 物理分离（派发期间两目录并存）；
  - 项目 cwd 全程无 `.cw-spawn/` 新增、无标记行写入；
  - 全链推进到两 unit closed 且 root 集成 pass（merge 汇聚后 root 分支含两子标记行）。

**C2 verify 真值与 cwd 状态无关（场景 3，G3/P7 勾验）**：tmp git 项目 + 某 unit 的账本 commit 与冻结验收；把项目 cwd 改脏（tracked 文件修改 + 新增 untracked）→ 子进程跑 `cw verify`（exit 0 pass）→ 断言：verify 的检出树与账本 commit 一致（干净重跑）；项目 cwd 的脏改动 verify 后原样保留（不被触碰）。

**C4 残余断言复核**：grep tests/ 中 `.cw-spawn` 全部引用，逐处判定是否仍有「断言位于项目 cwd」的语义残留；输出判定清单（预期 zero——wt-2 已迁移），发现残留仅汇报不擅改。

## 5. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                                       # exit 0
npx vitest run tests/wt5-parallel-contamination.test.ts # 全绿
npx eslint tests/wt5-parallel-contamination.test.ts     # 零输出
npm test                                                # 全量绿（321 基线 + 新增）
```

## 6. status 字段

全部通过 → 汇报各命令输出尾部 + C1/C2 条款对照 + C4 判定清单 + canon P7 行的 diff；未达成如实说明。
