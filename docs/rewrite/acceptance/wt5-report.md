# wt-5 验收报告（W5 收口：并发污染对抗测试 + P7 勾验 + 残余复核）

> verifier 独立对抗式验收，2026-08-16。基线 commit `2a975d7` 的
> `docs/rewrite/acceptance/wt5-acceptance.md`（防篡改对象）。
> **总结论：PASS**。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff 2a975d7 -- docs/rewrite/acceptance/wt5-acceptance.md` | 空（无篡改） |
| 基线文件 sha256 | `3f6ed0931575e2ccca45ddcd88a011b14a68fa7241adac353e8b9d3467945496` |
| `git status --porcelain` | 仅 `?? tests/wt5-parallel-contamination.test.ts`（src/ 与既有 tests 零改动；HEAD = 2a975d7） |
| canon 文件（`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md`，gitignore 排除，525 行） | 第 352 行 P7 已 `⛔ → ✅ M0（勾验依据：wt5 C2 场景测试 + u4a cleanCheckout 单测）`，格式与相邻 P8 行（`✅ M1`）一致；全文 `wt5` 字样仅此一处，章节结构（开篇/§1-§5/附录/变更注记）完整——与「仅改 P7 一行」声明相符。注：该文件无 git 历史（目录非 repo、无其他副本），「其余未动」以内容侧写核验 |

## 2. 通过命令实跑（基线 §5）

```
npm run check:all    exit 0（check + check:tests 均过）
npx vitest run tests/wt5-parallel-contamination.test.ts   2 passed (2)
  [wt5] builder 文件操作窗口重叠 430ms（a:[...8965,...9396] b:[...8955,...9395]，派发间隔 32ms）
npx eslint tests/wt5-parallel-contamination.test.ts       exit 0，零输出
npm test             Test Files 46 passed (46) / Tests 323 passed (323)（= 321 基线 + 2 新增，Duration 82s）
```

## 3. 真实性抽查（读 tests/wt5-parallel-contamination.test.ts 代码）

1. **C1 混卷断言为真**：`evidenceCommitOf`（L132-140）从账本 `EvidenceSubmitted` 事件读 commit——数据源是真实账本，非固定 hash；L460-467 用该 commit 真实跑 `git show`，`expect(diffA).not.toContain(MARK_B)` 是真实负向断言（commit message 不含对方标记常量，无误伤面），并以 `git diff-tree --name-only` 加断言改动文件集仅 `src/app.ts`。
2. **C1 重叠窗口为真**：worker 脚本（L273-282）ready-rendezvous 屏障——两 builder 各写 `ready-<id>` 文件并 20ms 轮询互等对方（30s 超时），重叠由屏障保证而非 sleep 概率；屏障后 `sleep(400)` 仅拉宽窗口提升 overlap 断言稳健性。cwd 监视器（L366-390）为 25ms `setInterval` 真轮询项目 cwd 的 `.cw-spawn/` 存在性与 `src/app.ts === BASE_APP_TS` 基线逐字比对。
3. **C2 三断言为真**：C2A/C2B/C2C 验收命令以相对路径在检出树内执行（读 `tracked.txt`/`feature.txt`/`git status --porcelain`）；主断言（L588-591）读 VerifyRan runId 对应 evidence 产物 `${id}.stdout` 含 `${id} PASS`，非仅 exit 0；cwd 脏保留（L594-596）为内容逐字比对（`DIRTY-EDIT\n` / `untracked residue\n` / porcelain 前后串相等）。
4. **全链终态为真**：root 集成 pass（L451-454）取账本投影 `verifyRuns.at(-1)` 断言 `runId` 匹配 `^integrate-` 且 `result === "pass"`——账本数据源，非输出文本匹配（文本 `root "feat" 已 closed` 仅辅助断言）。

## 4. 行为对抗抽查（真实子进程 + tmp + 隔离，探针在 /tmp，已清理）

| # | 探针 | 预期 | 实测 | 结论 |
|---|------|------|------|------|
| 1 | 混卷红性：/tmp 共享 cwd 场景，模拟两 worker 在同一目录重叠窗口内先后写标记行后 `git add+commit` | 单 commit 的 diff 同时含 `MARK_UNIT_A` 与 `MARK_UNIT_B`（若 worktree 隔离失效，C1 的 `not.toContain` 断言必红） | unit-a 的 commit diff 确实同时含双标记行 | C1 断言逻辑有真实抓混卷能力，非空洞 |
| 2 | C2 反向：/tmp 副本 fixture 同 C2，验收命令改为断言 `tracked.txt === 'DIRTY-EDIT'`（读 cwd 现状），cwd 改脏后子进程跑 `cw verify` | fail（验收在干净检出树执行，读到 `committed-v1` 而非 cwd 的 `DIRTY-EDIT`） | verify exit 1、result=fail、`C2R.stdout` = `C2R FAIL got=committed-v1` | 检出树与 cwd 真隔离，C2 正向 pass 非碰巧 |
| 3 | 真实 home 零污染：`npm test` 全量前后对 `~/.cw` 与 `~/.cw-worktrees` 逐文件 sha256 对比 | 完全一致 | 25 个文件 sha256 前后逐一致，`~/.cw-worktrees` 条目数 0→0 | 真实 home 零污染 |
| 4 | C1 flake 检查：单文件连跑 3 次 | 全绿且重叠窗口稳定 | 3 次全绿，重叠 424/448/431ms，派发间隔 27/45/30ms | 无 flake |

## 5. C4 残余复核（独立 grep）

verifier 独立 `grep -rn ".cw-spawn" tests/`（含 fixtures）：**15 文件 / 89 处原始引用**，逐类判定——

- 正向断言/读写全部位于 unit worktree：`join(worktreePath(WT_HOME, repoDir, id), ".cw-spawn", …)`、`join(wtDir, ".cw-spawn", …)`、`join(req.workdir, ".cw-spawn", …)`（wt1/wt2/wt3/fx1/fx2/fx3/u6/u7/u7b/u8/wt5）
- 项目 cwd 相关仅负向断言：`expect(existsSync(join(repoDir, ".cw-spawn"))).toBe(false)`（wt2 L432、wt5 L441）
- u6a-lifecycle 的 `join(tmpRoot, name, ".cw-spawn")` 是 spawnProcess 直传 tmp 路径，非项目 cwd

**语义残留：zero**，与 builder 结论一致。注：builder 自报「17 文件 46 处」与实测原始引用数（15 文件 89 处）口径不符（疑为判定清单条目数而非原始 grep 数），实质结论无差异。

## 6. 结论

- 交付物齐全：`tests/wt5-parallel-contamination.test.ts`（新建，598 行，C1+C2 两条 it）、canon P7 行 ✅、C4 zero 残留。
- 禁改清单全部遵守：src/ 零改动、既有 tests 零改动、canon 除 P7 行外未动（内容侧写）、基线文件 sha256 一致。
- 4 条通过命令全过；4 项真实性抽查全真；4 条行为对抗探针全部按预期方向成立。

**PASS**
