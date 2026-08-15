# fx-3 验收报告（verifier 原文落盘：verifier 线程受运行约束禁写 .md，报告全文由主 agent 原样归档）

**总结论：PASS**（对抗抽查 22/22 全过）

## 1. 防篡改

- `git diff 528e9ff -- docs/rewrite/acceptance/fx-3-acceptance.md` 为空（无篡改）
- 验收文档 sha256: `478762a7f8acfa849c1badf0ea3ab34b8fb66b75dad2092b6e7caff30eb99c87`
- 改动文件核对（`git diff 528e9ff --stat` + 未跟踪）：
  - 清单内 6 tracked：`src/handlers/evidence-submit.ts`（R5.1）、`src/runner/loop.ts`（R5.2/R5.3）、`tests/u5b-e2e.test.ts` + `tests/fx1-r1-split-selfref.test.ts`（越界适配，见 §4）、`tests/u2-evidence.test.ts` + `tests/u7-e2e.test.ts`（授权内适配）；2 新文件：`tests/fx3-spec-split-gate.test.ts`、`tests/fx3-loop-split-dispatch.test.ts`。**无第七个代码/测试文件**
  - 认知外披露（非 builder 清单，未触碰）：`AGENTS.md` 2 行改动（文档性质、非代码/测试，字面落在禁改清单内，来源不明需主 agent 裁决）；未跟踪 `wave-endstate-execution.drawio*` 等 5 个绘图文件

## 2. 命令实跑（全过）

| 命令 | 结果 |
|---|---|
| `npm run check:all` | exit 0 |
| `npm test` | 38 文件 / 230 全绿（222 + 8，与验收「222 + 新增」一致），37s |
| `npm run lint` | 零输出，exit 0 |
| fx3 两文件连跑 2 遍 | 8/8、8/8 均绿，无 flake |

## 3. 修复点真实性对照（源码核读）

- **R5.1**（`src/handlers/evidence-submit.ts` L150-179）：位于叶子 split 拒（fx-1 R1，L136）之后、`tryAppend`（L181）之前，校验不过不入账。逐条目二分类（missing/mismatched），错误含两类清单 + 恢复动作全文（unitId 真实内插）。阴性对照：split 原样入账且 files/dependsOn 保留。
- **R5.2**（`src/runner/loop.ts` `designerFirstTasks`）：第 0 步条件 = parentId === null 且账本无任何 parentId === unitId 子；文案含 cw create 模板 + 占位 brief 许可 + 「否则提交会被拒」预警；既有三步原样保留。renderBrief/writeBriefFile 签名加 projection，四类 designer 任务书按入口状态正确分流。
- **R5.3**（`computeDispatchTargets` L295-313）：`splitChildrenNotCreated`（以最后一条冻结 spec 的 split 为权威集合）判定在 `splitChildrenAllVerified` 集成等待**之前**拦截——子不齐绝不进集成等待（R5 死锁根因正面封堵）；missing 分支在外层，fx-2 R4a 上限判定在内层，**missing 优先于 R4a**。emit 区分两文案（补建 vs 上限）。
- **回归 #5 全链**（`tests/fx3-loop-split-dispatch.test.ts` L392-445）：断言两子 UnitCreated seq < root SpecSubmitted seq（R5.1 真实链路）、root 最后 VerifyRan.runId 匹配 `^integrate-` 且 pass、root 无 builder spawn、root designer 仅 1 次、全树 closed、exit 0。worker 为真实 node 子进程走真实 dist dispatch，零 mock。

## 4. 越界适配裁决（2 文件，均裁定：语义等价，无弱化）

- `tests/u5b-e2e.test.ts`：原「先提 root spec 后建子」与 R5.1 直接冲突，不改则用例必红——时序对调正是 fx-3 设计本意。所有 runCli 断言保留，后续 build/verify/exec-review/root closed/exit 0 断言未动，仍覆盖原「全链收敛」场景语义。属验收允许清单的文档遗漏而非 builder 越权。
- `tests/fx1-r1-split-selfref.test.ts`：放行用例仅前置 `create sub-unit --parent root`（+5 行），原有断言全部保留，放言语义不变。
- 授权内适配 u2（预建子 + 事件数 2→3、payload 断言保留）、u7（root spec 前先建子）合理。

## 5. 行为对抗抽查（独立探针，隔离 CW_HOME + tmp + 真实 dist，22/22 PASS）

- **场景 A（R5.1 混合清单分类精确性）**：split 声明 3 子（1 正确 + 1 未建 + 1 挂别家）→ exit 1；「未创建」行只含 child-miss、「parent 错配」行只含 child-wrong、正确子零出现；恢复模板 `--parent adv-root`；账本不入账。
- **场景 B（不回退/不误伤）**：叶子声明 split 仍被 fx-1 R1 拒（原文案）；叶子空 split spec 照常过审 exit 0。
- **场景 C（R5.3 部分缺失）**：root spec-frozen 声明 [pa, pb] 只建 pa → 派 designer 兜底，brief 补建清单只列 pb、emit「1 个未创建」、非 R4a 契约漂移任务书；pa 走正常首派轨道，pb 零派发。
- **场景 D（R5.3 不吞 fx-2 R4a）**：子全建全 verified + 契约漂移致集成 fail——恰好 fail 2 次后停自动重派、转派 designer，brief = 契约漂移任务书（非补建）、emit 上限文案、noop 应答后 idle 兜底 exit 1（不无限循环）。

## 6. 移交主 agent 事项

1. `AGENTS.md` 认知外 2 行改动 + 5 个未跟踪 drawio 文件的去留裁决。
2. 本报告落盘（已完成——主 agent 归档）。
