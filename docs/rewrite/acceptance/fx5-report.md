# fx-5 验收报告：成对 unit 资源回收（事后补录验收）

> verifier 独立验收报告（2026-08-18）。验收对象 = commit `187f7df`（fx-5 交付）+
> 补录验收基线 `docs/rewrite/acceptance/fx5-acceptance.md`。verifier 未修改任何
> 代码 / 测试 / 文档（唯一写入 = 本报告）；未执行任何 git 写操作。

## 0. 补录性质说明

fx-5 实现于 2026-08-18 committed（187f7df），当时未走「基线先行 + verifier 独立
验收」流程（plan 完成度审查 D1 流程缺口）。`fx5-acceptance.md` 为事后补录的验收
基线：常规「先行情基线 diff」防篡改核对不适用，本文的核对对象改为——

1. 补录验收文档自身相对 HEAD 的稳定性（工作区 + git 历史双向核对）；
2. 交付 commit `187f7df` 的内容与补录文档 §2 清单的一致性。

## 1. 防篡改核对（补录文档稳定性）

| 项 | 结果 |
|----|------|
| `fx5-acceptance.md` sha256 | `a16f42fabf16ad82e8522be077b58c21c6998d4b5bcf9927e413b5f6b255b9eb` |
| 工作区 vs HEAD | `git diff HEAD -- <file>` 为空（未被修改） |
| git 历史 | 进入 git 后仅 1 个 commit（`6705a71`，即补录入库点），`git diff 6705a71..HEAD -- <file>` 为空——补录后无任何改动 |
| 验收时 HEAD | `539371cce0ecbf032e4a06348bf1a04d40d2ae7c` |

## 2. 交付 commit 核对（§2 清单逐项）

`git show 187f7df --stat`：7 文件（+793 / −72）。§2 清单五项全部在列：

| §2 清单项 | commit 内 | 核对结论 |
|-----------|-----------|----------|
| `src/runner/worktree.ts` | 有（+148） | 新增 `listUnitBranchRefs` / `removeUnitBranch` / `reclaimUnit`。**成对谓词确认**：`removeUnitBranch` 中 ① `unitId === rootId` → root 成果分支守卫（直接 ok，不在自动回收范围）②分支不存在 → 幂等 ok ③root 分支缺失 → 保守保留 + error（含「不存在」原因 + 恢复动作 + 手动 `branch -D` 命令）④tip 经 `merge-base --is-ancestor` 判不可达 → 保守保留 + error（含「不在 root 分支可达」+ 恢复动作）⑤可达 → `branch -D`。`reclaimUnit` 先目录后分支（解除 worktree 占用才能删分支），两侧成败独立 |
| `src/runner/integrate.ts` | 有（±18） | **merge 成功路径确无 `branch -D`**：原 `gitStep(opts.cwd, ["branch", "-D", childBranch])` 整行删除，替换为注释「子分支保留（回收统一走 unit 终态成对回收）」；可达性跳过注释同步改为「与子分支存亡无关」 |
| `src/runner/loop.ts` | 有（+175） | **双扫并集确认**：`sweepOrphanWorktrees` = `listUnitWorktreeIds`（目录）∪ `listUnitBranchRefs`（ref）`[...new Set([...dirIds, ...rootIdByRef.keys()])]`；closed/无主 → `reclaimUnits`（成对）；两侧都拿不到 rootId 的 ghost 目录退回 `removeWorktree` 原语义（防误删分支外的资源）；延迟回收路 `reclaimPendingUnits` 统一走 `reclaimUnit`（rootId 账本上溯解析，链断裂跳过 + 出声） |
| `tests/fx5-unit-reclaim.test.ts` | 有（+481） | 5 场景齐全（见 §4） |
| 设计勘误 v3.2 | 有（design-worktree-isolation.md） | D5 回收段重写（成对谓词 / 双扫 / merge 点无副作用）+ 版本记录 v3.2 条目 |

commit 额外含 `docs/rewrite/ledger.md`（+1 状态行）与 `tests/wt4-integration-merge.test.ts`
（迁移断言，即验收动作 5 的对象）——与 §2 清单不冲突，属交付自洽范围。

## 3. 验收命令实跑（工作区口径说明）

并行 builder（rv-2/rv-4）正在本工作区改动 src/handlers、src/verify 等文件。
前置核对：`git diff HEAD --stat -- tests/fx5-unit-reclaim.test.ts src/runner/{worktree,integrate,loop}.ts tests/wt4-integration-merge.test.ts` 全部为空——**fx-5 验收对象文件在工作区未被修改**，直接在当前工作区实跑（未 stash，未触碰并行现场）。

### 3.1 fx5 测试（验收动作 2）

```
$ npx vitest run tests/fx5-unit-reclaim.test.ts

 ✓ tests/fx5-unit-reclaim.test.ts (5 tests) 4375ms
   ✓ fx5-3 孤儿分支回收：启动清扫的 ref 扫（M3 gate 残留现场复刻） > closed unit 目录已亡、分支残留且 tip 可达 → runLoop 启动清扫回收该分支；root 资源不动  647ms
   ✓ fx5-4 并行 root 不误删：另一 root 的 open unit > 清扫后另一 root 的 open unit 分支与目录、其 root 成果分支与 worktree 均保留  610ms
   ✓ fx5-5 M3 gate 全链：merge 冲突 → 人工解 → 集成重跑 pass → 清扫成对回收 > 两子同改 f.txt 冲突 → 集成 fail → 人工解（git 模拟处置者）→ 重跑集成 pass → 启动清扫后两子目录+分支成对消失  2668ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 3.2 wt4 迁移后回归（支撑动作 5）

```
$ npx vitest run tests/wt4-integration-merge.test.ts

 ✓ wt4 M2 / M3 / M4 / M5 / M6 / M7 …（M1、M8 在滚动输出上方）
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

## 4. 真实性抽查（验收动作 3：5 场景断言语义核验）

逐场景读 `tests/fx5-unit-reclaim.test.ts` 断言原文核验（全部真实环境零 mock：
直调 dist + 真实 git 子进程 + 真实账本 + 隔离 CW_HOME/CW_WORKTREE_HOME）：

| 场景 | 关键断言 | 语义核验 |
|------|----------|----------|
| fx5-1 成对回收 | `refMissing(cw/rt/unit-x)` = true（分支已亡）**且** `existsSync(child.dir)` = false（目录已亡）+ root 分支 `refMissing` = false（在）+ root worktree `existsSync` = true + 重复回收双 ok | 双侧消亡与 root 保留都有实体断言；幂等有二次调用断言。强度足 |
| fx5-2 不可达保留 | `res.branch.ok` = false + error 含「不在 root 分支」「恢复动作」「`git -C "<repo>" branch -D cw/rt/unit-y`」+ **`refMissing(unit-y)` = false（分支实体仍在）** + 目录 `existsSync` = false（目录照常回收） | 「保留」有分支实体断言（非只断言 error 字符串）；error 含可操作恢复命令。强度足。注：本场景直调 `reclaimUnit`，出声断言落在函数级 error 文本——loop 层 stderr 出声由本报告 §5 对抗抽查 ① 补验 |
| fx5-3 孤儿分支现场复刻 | 前提断言：目录已亡 + `refMissing` = false（分支残留）+ `listUnitBranchRefs` 恰好扫出该 ref；runLoop 后 `refMissing` = true（分支被回收）+ root 分支/worktree 保留 + stdout 含「启动孤儿清扫」「unit-x」 | 前提（bug 现场形态）与结果（ref 扫发现并回收）双向断言。强度足 |
| fx5-4 并行 root 不误删 | 另一 root（rootb）的 open 子分支 `refMissing` = false（在）+ 子 worktree 目录在 + **其 root 成果分支 `cw-root/rootb` `refMissing` = false（在）** + 其 root worktree 在 + 反向断言 stdout `not.toContain("unit-y")` / `not.toContain("rootb")` | 四个保留实体断言 + 清扫清单反向断言（防只断言不炸）。强度足 |
| fx5-5 冲突→人工解→重跑全链 | 冲突后两子分支 `refMissing` = false（**在**——正是「merge 点不删」的输入形态断言）；人工解 + 集成重跑 pass；清扫后两子目录 4 项 `existsSync`/`refMissing` 全部翻转（成对消失）+ root 侧保留 + stdout 含清扫输出 | 残留场景 by construction 消失的完整证明链。强度足 |

## 5. 行为对抗抽查（验收动作 4：真实 tmp git + worktree + CW_HOME 隔离）

独立脚本（/tmp，未入仓库）直调 dist 产物，与 tests/ 不共享代码。fixture 注意点：
acceptance 需与测试的 `unitAcceptance` 同款（e2e-real + unit 型双条目）才能过 spec
gate 五规则使 unit 到 closed——单条 e2e-real 的 fixture 会使 unit 停在 created
（清扫按「未 closed 保留」正确跳过，该行为本身与 fx5-4 语义一致）。

### ① tip 不可达 → runLoop 启动清扫 → 分支保守保留 + stderr 出声（18 项之 5）

现场：root worktree 停 base + 子 unit-z commit 领先未 merge（tip 不可达）+ 账本
unit-z 全链 closed。

- ①-1 清扫后 `cw/rt/unit-z` 分支仍在（保守保留，非误删）——PASS
- ①-2 子 worktree 目录已回收（成对谓词分支侧独立成败：目录消、分支留）——PASS
- ①-3/①-4 **stderr 出声**（loop 层 `emitErr`，非仅函数返回值）——PASS，原文：

  ```
  [runner] unit "unit-z" 的子分支回收失败（保守保留）——子分支 cw/rt/unit-z 保留：其 tip 不在 root 分支 cw-root/rt 可达（产出未确认回流，删除将丢失其唯一 ref 锚点）。恢复动作：在 root worktree merge 该分支使产出回流后重跑回收，或确认产出已失效后手动清理 git -C "<repo>" branch -D cw/rt/unit-z。
  ```

- ①-5 root 分支与 root worktree 不受牵连——PASS

### ② 「分支已删 + worktree 仍在」中间态（D5「在/亡」异常格）→ 成对回收收敛（5 项）

现场：`git update-ref -d refs/heads/cw/rt/unit-v` 旁路删 ref（`git branch -D` 会被
worktree 占用拒绝，update-ref 是「人动过分支」的真实旁路形态），目录与 worktree
注册仍在。

- ②-0 前提成立：分支亡而目录在——PASS
- ②-1 `reclaimUnit` worktree 侧 ok（目录消）——PASS
- ②-2 分支侧幂等 ok（分支不存在视为已回收，不炸、无 env error 阻塞）——PASS
- ②-3 root 资源不受牵连——PASS
- ②-4 收敛后再跑 runLoop：无该 unit 的回收失败噪声（中间态被回收通道收敛为
  「亡/亡」，不再堵「在该 unit 重提 build 证据」恢复路径）——PASS

### ③ cw-root/<id> 不存在 → 保守保留不误删（8 项）

现场：root 分支用 `git branch` 创建（无 worktree 占用）→ 子 unit-w worktree +
commit → `git branch -D cw-root/rt`（旁路删 root 分支）。

- ③-1 直调 `reclaimUnit`：`branch.ok` = false（保守保留）——PASS
- ③-2/③-3 error 指明「root 分支 … 不存在」+ 含「恢复动作」+ 手动清理命令
  `git -C "<repo>" branch -D cw/rt/unit-w`——PASS
- ③-4 分支实体仍在（未被误删）——PASS
- ③-5 目录侧仍正常回收（成对谓词分支侧独立成败）——PASS
- ③-6/③-7 同现场走 runLoop 启动清扫（ref 扫拿到 rootId，谓词发现 root 分支缺）：
  分支仍在 + stderr 出声（「保守保留」+「不存在」+「恢复动作」）——PASS，原文：

  ```
  [runner] unit "unit-w" 的子分支回收失败（保守保留）——子分支 cw/rt/unit-w 保留：root 分支 cw-root/rt 不存在，无法确认其 tip 的产出已回流（仓库 "<repo>"）。恢复动作：确认产出已回流（或已失效）后手动清理 git -C "<repo>" branch -D cw/rt/unit-w。
  ```

**对抗抽查汇总：18/18 PASS（exit 0）。**

## 6. wt4 迁移断言核对（验收动作 5）

`git show 187f7df -- tests/wt4-integration-merge.test.ts` 核对四处迁移，语义全部
正确（且当前工作区实跑 8/8 绿）：

| 用例 | 迁移前 | 迁移后 | 语义核验 |
|------|--------|--------|----------|
| M1 | `gitFails(rev-parse cw/rt/unit-a)` = true（两子分支已删） | = **false**（两子分支保留）+ 注释锚点「fx-5 行为变更回归锚点」 | 与 merge 点去副作用一致；fixture 注释同步（removeWorktree 模拟终态回收目录侧，分支留给回收谓词） |
| M8 幂等重跑 | 子分支仍不存在（跳过路径不撞分支不存在） | 子分支仍在（可达性判定不依赖分支存亡） | 与 integrate.ts 新可达性语义（与子分支存亡无关）一致 |
| M2 冲突 | unit-a 分支已删 / unit-b 保留 | 两分支均保留 | 冲突现场两分支均在正是 fx5-5 的输入形态断言，语义一致 |
| M7 汇总 | 「已回收 worktree × N；保留 × M」 | 「已回收 unit 资源（worktree 目录+子分支）× N；保留 worktree × M」 | 与 loop.ts `summaryText` 文案变更逐字一致 |

## 7. 观察与备注（非阻塞）

1. **fx5-2 出声断言层级**：测试断言的是 `reclaimUnit` 函数级 error 文本，「loop
   层 stderr 出声」在 fx5 套件内无直接覆盖（fx5-3/5 只断言 stdout 清扫输出）。
   loop 层 `emitErr` 出声已由本报告 §5 ①/③ 对抗抽查实证（非缺陷，供后续测试
   补强参考）。
2. **commit 范围**：187f7df 含 §2 清单外两文件（ledger.md 状态行、wt4 测试迁移），
   均为交付自洽内容，无越界改动。
3. 对抗抽查脚本位于 /tmp（会话级临时目录），未入仓库；如需固化建议后续以测试
   形式补入 tests/（本 verifier 无写入权限）。

## 8. 总结论

**PASS（补录闭环）。** §2 五文件齐全且关键 diff 逐项确认（成对谓词 / merge 点
无 branch -D / 双扫并集）；fx5 测试 5/5 绿、wt4 迁移后 8/8 绿；5 场景断言语义
核验强度足（保留均有实体断言）；对抗抽查 18/18 过（不可达保留 + loop 层 stderr
出声、在/亡异常格成对收敛、root 分支缺失保守保留）；wt4 四处迁移断言语义正确。
