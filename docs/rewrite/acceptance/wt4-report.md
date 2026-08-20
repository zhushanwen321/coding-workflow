# wt-4 验收报告：集成汇聚与回流（W4）

> **总结论：PASS**。防篡改、四条通过命令、M1-M8 对照、4 处披露裁决、8 条行为对抗抽查全部通过。
> verifier 独立验收于 commit 917ac1e 基线（docs/rewrite/acceptance/wt4-acceptance.md），builder 自报一律经实测证实。

## 1. 防篡改核验

| 检查项 | 结果 |
|--------|------|
| `git diff 917ac1e -- docs/rewrite/acceptance/wt4-acceptance.md` | 空输出（未被修改） |
| 基线 sha256 | `7bc77414d3ae3bef1a33a84bcf99a5466a597d6e60254a50c96ab82cd670f63f` |
| `git status` 改动文件 | 恰好 7 个：`src/runner/integrate.ts`、`src/runner/loop.ts`、`src/runner/worktree.ts`、`tests/u8-integrate.test.ts`、`tests/u8-e2e.test.ts`、`tests/u5b-e2e.test.ts`（修改）+ `tests/wt4-integration-merge.test.ts`（新建） |
| `src/runner/worktree.ts` diff | 仅 import 扩展（`readdirSync`/`join`/`encodeCwd`）+ 追加 `listUnitWorktreeIds`；wt-1/wt-2 已验收的既有函数逐字不变 |
| 禁改清单（`src/verify/` `src/handlers/` `src/core/` `src/events/` `src/store/` `src/cli.ts` `src/runner/spawn/*` `src/runner/human-loop.ts` wt1-wt3 测试） | 零触碰（`git diff 917ac1e --stat` 对上述路径输出为空） |
| 既有测试改动性质 | 仅断言适配（§7 边界内，无删测试/放宽断言，详见 §4） |

## 2. 通过命令实跑

| 命令 | 结果 | 输出尾部 |
|------|------|---------|
| `npm run check:all` | exit 0 | `tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json` 零错误 |
| `npx vitest run tests/wt4-integration-merge.test.ts` | 8/8 绿 | `Test Files 1 passed (1) / Tests 8 passed (8)`，Duration 6.22s |
| `npx eslint src/runner/ tests/wt4-integration-merge.test.ts` | exit 0 | 零输出 |
| `npm test` | 321/321 绿 | `Test Files 45 passed (45) / Tests 321 passed (321)`，Duration 76.93s（313 基线 + 8 新增，无红） |

真实 home 零污染：全量测试前后 `~/.cw-worktrees`（空）与 `~/.cw`（52 项历史存量）`find -maxdepth 2` 快照 diff 均为 IDENTICAL。

## 3. M1-M8 条款对照核验

逐条读 `tests/wt4-integration-merge.test.ts` 测试代码 + verbose 单跑（8 条全绿，含 M6 单行确认）。重点核验的 5 个「最易空洞」点：

- **M2 merge 冲突（真构造）**：`seedSplitFixture("m2")` 两子都改 `f.txt` 同区域（写不同内容，非改动不同文件）→ 真冲突。abort 后断言 `git -C <rootWorktree> status --porcelain` stdout trim 为空字符串（真断言，直调场景 root worktree 无 `.cw-spawn`，断言口径严格于条款）。failures 断言含 `unit-b`、`merge 冲突`、root worktree 路径、`CW_PROJECT_DIR="<cwd>"` 内联前缀形态。附加断言：先 merge 的 `unit-a` 分支已删、`unit-b` 分支保留（修复后重试现场）。
- **M3 锚定解耦（对照面成立）**：测试 L371-374 项目 cwd 独立 commit 使 HEAD 领先 base；L377-379 **在集成之前**断言两子 commit 对项目 HEAD `merge-base --is-ancestor` 均不可达（旧锚定下会全灭的对照面真成立）→ L381-387 集成 pass + 报告 head = root 分支 HEAD ≠ 项目 HEAD。
- **M5 孤儿清扫（三类真构造）**：`unit-closed` 走全链（spec 过审 + evidence + VerifyRan + exec-review）真 closed；`unit-live` 仅 UnitCreated；`unit-ghost` 只建 worktree 目录不进账本。hold adapter（spawn 挂住不结算）驱动 runLoop → 逐目录断言：closed 消失、ghost 消失、live 保留 + 启动段输出含「启动孤儿清扫」与两个被回收 id。
- **M6 延迟回收（时序断言）**：非只断最终态——adapter 在 spawn 时点采样：`builderSawUnitA === true`（unit-a closed 的当轮派发时 worktree 仍在，debug 留一轮窗口）、`reviewerSawUnitA === false`（下轮 J4 回收后不再见到）、`rootWorktreeEverMissing === false`（root 全程保留）+ run 结束后目录级复核。
- **M8 幂等（真跳过 merge）**：二次集成断言 root 分支 HEAD hash 逐字不变（误 merge 会产生新 commit）+ 子分支已不存在的现场不撞「分支不存在」失败 + 报告落盘且 children 全 reachable。

其余三条经同样口径核验成立：M1（isAncestor × 2 + 报告 head = root 分支 HEAD ≠ 项目 HEAD + 子分支已删 + `git log` 含子 commit）；M4（rm root worktree 目录保留分支 → 集成内「亡/在」格重建 → HEAD 不动 + worktree 检出分支 = `cw-root/root`）；M7（输出含 `已回收 worktree × 1（unit-a）`、`保留 × 1（root）`、`成果分支：cw-root/root`、`回流主分支：git merge cw-root/root`）。

## 4. 既有测试适配清单（§7 边界内核验）

| 文件 | 适配内容 | 裁定 |
|------|---------|------|
| `tests/u8-integrate.test.ts` | 仅追加 `CW_WORKTREE_HOME` 隔离（步骤 0 建 root worktree 落 tmp）；4 条用例断言零改动 | 等价成立：其 fixture 子 commit 即项目 HEAD（单 commit 仓库），root 分支 base = 该 commit → merge 幂等跳过，可达性/验收/契约语义与旧 HEAD 锚定同构 |
| `tests/u8-e2e.test.ts` | 受控修复（heal）从项目 cwd 直 commit 改为定位 `cw-root/feat` 检出的 worktree 内 commit；heal 计数断言从 `rev-list --count HEAD` 改锚 `cw-root/feat` | W4 必要适配：三处 HEAD 锚 root 分支后修项目 cwd 不再影响集成；断言语义（修复真发生 + 最终集成在修复树上通过）不变 |
| `tests/u5b-e2e.test.ts` | 人 build 从项目 cwd 直 commit 改为轮询等待后在 impl unit worktree（分支 `cw/demo/impl`）内 commit，evidence/verify 调用锚项目 cwd 不变 | 语义等价（human 全链收敛不变，321 全绿含本文件）+ 确属必要前提（见 §5 披露 4 实验） |
| `tests/fx2-*` / `tests/u7-loop.test.ts` | 未改动 | 现有断言与新行为兼容（均在 321 绿内）；§7 为「允许适配」非「必须」，无缺漏 |

## 5. builder 4 处披露裁决（逐条实测）

1. **退出清尾回收（root closed 时一并回收 pendingReclaim 剩余）——接受**。验收文档 J4 只定义「下轮开头」语义（该语义保留：主循环开头先回收上轮 pending），退出清尾是 root closed 退出路径上的补充；设计 D5 与 §3.1 样例「已回收 worktree × 2」佐证退出输出应含全部实际回收。实测（对抗 A3，见 §6）：同轮双 closed 构造下退出输出含「已回收 worktree × 1（unit-a）」、目录消失、root worktree 保留——行为如声称，与验收文档不冲突。
2. **J3 排除本 run 的 rootId（root 永不回收）+ 全账本口径回收他 root 的 closed unit——接受**。实测（对抗 A2）：另一 root 的未 closed unit worktree 首轮保留；补全链 closed 后跨 run 再启动被回收（清扫输出含该 id）。「查全账本」真实现（`loadLedger(cwd).projection` + `treeStatuses`，非本 root 子树投影）。
3. **branch -D 被子 worktree 检出占用时 best-effort 静默——接受，附一条观察**。实测（对抗 A6）：子 worktree 仍在时集成仍 pass、子分支残留（占用导致 -D 失败、静默不炸）；删子 worktree 后重跑集成 pass（可达性成立跳过 merge）。M1「子分支已删」断言落在 fixture 显式回收子 worktree 的现场——断言本身真实（branch -D 在可删时确实删除），非空洞；真实链路首次集成分支残留是设计 J1 明文接受的形态（静默 + P-wt5 可达保证）。**观察（非缺陷，记录待后续波次裁量）**：残留分支在后续幂等重跑中不会被清理（已达跳过 merge 即跳过 -D），长期运行子分支会堆积；J3 只回收目录不删分支。当前无害（可达、命名空间隔离），超出本波验收文档范围。
4. **u5b-e2e 作业形态适配（§7「等」字范围）——接受**。语义等价：human 全链收敛不变（root demo → 子 impl → 集成 → root closed 全链在 321 绿中真跑通）。必要性实验（对抗 A7）：模拟旧形态（root/impl worktree 分支停在启动快照、人在项目 cwd 直 commit）→ 集成 fail，failures 含「build commit 在 root 分支 cw-root/demo 不可达」——旧形态产出不在汇聚路径上，适配是 W4 行为变更的必要前提而非可选。

## 6. 行为对抗抽查（真实子进程 + tmp + 隔离 CW_HOME/CW_WORKTREE_HOME，直调 dist 产物）

| # | 对抗点 | 结果 | 关键证据 |
|---|--------|------|---------|
| A1 | merge 冲突后可恢复性（转人工路径闭环）：双子同文件冲突 → 集成 fail → 人在 root worktree merge 解决 + commit → 重跑集成 | **PASS** | 首次 fail=true；二次 pass=true；unit-b commit 对 root 分支 isAncestor=true |
| A2 | 孤儿清扫跨 root：他 root 的未 closed unit worktree → 启动保留；其 closed 后跨 run 再启动 → 回收 | **PASS** | 首轮 exit=1（maxIdle）保留=true；第二轮回收=true、输出含 unit-x |
| A3 | 退出清尾：root closed 时 pendingReclaim 非空（同轮双 exec-review 构造）→ 退出输出含其回收 + 目录消失 | **PASS** | exit=0；unit-a 目录消失=true；root 保留=true；输出含「已回收 worktree × 1（unit-a）」「保留 × 1（root）」 |
| A4 | 项目 cwd 脏 + 孤儿清扫并存：清扫不触碰项目 cwd（wt-3 行为不回归） | **PASS** | unit-y 被清扫=true；`status --porcelain` 前后逐字一致（`M app.js; ?? dirty-new.txt`） |
| A5 | root worktree 目录在 + 分支亡（「在/亡」异常格）→ 集成收 failures 且报告落盘 | **PASS** | ok=false；failures 含「root worktree 就绪失败」+ 恢复指引；reportPath 存在 |
| A6 | branch -D 被占用（披露 3 真实链路） | **PASS** | 占用时集成 pass=true、子分支残留=true；回收后重跑 pass=true 不炸 |
| A7 | u5b 旧形态必要性（披露 4） | **PASS** | 旧形态集成 fail=true、failures 含「不可达」+ root worktree 恢复指引 |
| A8 | `listUnitWorktreeIds` 容错（自选扩展） | **PASS** | worktree 根不存在返回 `[]`；根下普通文件项忽略、仅目录计入且排序确定（`["u1","u2"]`） |

补充核验：`loadLedger` 对账本文件不存在返回空投影不抛错（`src/readonly/load.ts` existsSync 前置探测）——J3 清扫在无账本现场（全量为「旁路残留」）安全，不会炸 runLoop 启动。

## 7. 附注

- 真实链路首次集成的子分支残留（披露 3 观察项）与 root 分支以集成时刻项目 HEAD 为 base 的语义（`revParseHead(opts.cwd)`）均为设计口径内行为，本波不构成 FAIL 项；前者建议后续波次在孤儿清扫或回流指引中一并清理分支引用。
- 验收过程零代码/测试/文档修改；对抗脚本用后即清（tmp 已删除）。
