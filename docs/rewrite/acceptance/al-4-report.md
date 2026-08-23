# al-4 验收报告（verifier 独立验收）

> 落盘说明（主 agent 记）：本报告全文由 verifier 交付（其回复原文原样落盘——verifier 因 subagent 运行约束未直接写本文件，已如实声明；内容零改动）。

**总结论：PASS**

- 基线 commit：`141347b`（HEAD，docs(rewrite): add al-4 acceptance baseline）
- 验收文档 sha256：`486637079f2d4548547113c71f9d699b162341fdfad2ac1761b2f15351695d6`
- 测试文件 sha256：`ad54d1f58e02af70f026ac68cfdc04287ee912c843e07f5d66906d0ea30a50d7`
- 防篡改：`git diff 141347b -- docs/rewrite/acceptance/al-4-acceptance.md` 为空；`git diff 141347b --name-only` 为空
- 越界扫描：工作区仅 `tests/al-4-e2e-layer.test.ts` untracked，node_modules 外零越界在场；探针 tmp 全部清理（最终复查零残留）

## 1. 命令实跑（全过）

| 命令 | 结果 |
|---|---|
| `npm run build && npm run check:all` | 通过（无错误输出） |
| `npx vitest run tests/al-4-e2e-layer.test.ts` 两连跑 | 10/10 绿 ×2（13.19s / 12.94s） |
| `npx eslint tests/al-4-e2e-layer.test.ts` | 零输出 exit 0 |
| 全量 `npm test` | **79 文件 618 用例一次全绿**（166.47s），本次未复现 rv5 T3/T8 竞态，无需单跑复核 |

## 2. 代笔保真度深查（重点节）——判定：足以支撑断言强度，且已做真实 loop 双向对照

**静态逐字段对照**（`src/runner/loop.ts` L445-533 `runIntegrationDispatch` vs 测试 `integrateLikeLoop` L506-556）：

| 字段/步骤 | 生产（loop.ts） | 代笔（测试） | 一致性 |
|---|---|---|---|
| spec 取法 | `unit.specs[last]` | 同 | 一致 |
| children | split 逐 entry 取子最后 build 证据 commit | 同 | 一致 |
| contracts | `[root,...子]` 各最后 spec 契约 → `{contract, ownerUnitId}` | 同构 flatMap | 一致 |
| pass acceptanceIds | `[...new Set([...childIds, ...rootIds])]` | 同 | 逐字符一致 |
| fail acceptanceIds | root spec `type==="manual"` 过滤 | 同 | 逐字符一致 |
| reportHash | `sha256(报告文件字节)` | 同算法同实现 | 一致 |
| runId 前缀 | `integrate-`（integrate.ts L114 生成，runIntegrationVerify 真实产物） | 透传 result.runId | 一致 |
| 入账 | `new EventLedger(ledgerPath(getCwHome(), cwd))` | `ledgerForCwd` = 完全等价（common.ts） | 一致 |
| timeoutMs | 省略（逐条分档 10min/30min） | 显式 120s | **唯一偏差**，已披露；场景命令秒级完成，两档位均不触发，行为等价（u8-integrate 先例同样显式传 timeoutMs） |

**「自说自话」风险评估 + 真实 loop 对照（已执行）**：用 `cw run --spawn human --poll-ms 50` 在独立 tmp 副本驱动真实 loop 至 integrationReady（probe2），loop 自身写入的 VerifyRan 与代笔口径逐字段吻合：runId `integrate-` 前缀、result=pass、**acceptanceIds=["FA1","FB1","R1","RU1"]（子∪root 全部）**、reportHash=报告文件 sha256、root verified 收敛、集成批次 R1.stdout 含 `R1 PASS`。fail 侧（probe3）：真实 loop fail VerifyRan 的 acceptanceIds=[]（root 无 manual 条目→空集），与代笔 fail 口径一致。结论：A1-2/A1-3/A6-1 消费的账本事件字段语义经真实 loop pass/fail 双向复验无偏差，无遗留复验缺口。

## 3. 真实性抽查

- **A6-2 断言真实形态**（非存在性检查）：`frontier --json` 真实 CLI 投影断言 integrationDrift 含 root；对照组 `Math.max(leafVerifySeqs) < integrateFailSeq` 时序断言（全部叶子 verify 早于集成 fail）+ 每叶 `evidences`/`verifyRuns` 各 `toHaveLength(1)`（恰 1 build + 1 verify）。
- **A6-3**：`verifyRunsOf(dir, ROOT_ID).map(result)` `toEqual(["fail","pass"])` + root verified + drift 维度 `not.toContain` + 修复后 R1.stdout 含 `R1 PASS`。
- **fixture 真实性**：`lint.sh` 真实 `grep -rn 'console\.log' packages/*/src`；wrapper 真实 `node <vitest.mjs> run packages/app|lib`（非 echo 假标记）；`broken.test.ts` 真实 vitest 恒挂（`expect(1).toBe(2)`）且与本功能无关。
- **事件序**：16 事件 `[type, unitId]` 精确 `toEqual` + JSONL 原文行含 `"layer":"topic"` 序列化形态。
- **耗时对照（S1② 人工数据）**：本 verifier 实跑叶 verify 1175-1207ms、集成 1942-2023ms——与 builder 自报（1.3-1.6s / 2.3-2.6s）同量级。

## 4. 行为对抗抽查（4 条，全过）

1. **R1 反向注入**（probe1，tmp 副本真实 CLI）：叶子 spec 含 `layer:"topic"` R1 条目 → `evidence submit` **exit 1**、stderr 规则⑩文案点名 R1 + 上收 root 指引、账本（正确编码路径）无 SpecSubmitted；对照组同 spec 去 layer 字段 → exit 0 入账。防线在端到端链路真实工作，非仅 al-3 单测层。
2. **红阶段零回归**（probe2）：每叶恰 1 `red-phase-*` + 1 `verify-*` 目录，逐文件零 R1 产物、report.json 用例集无 R1，且红阶段产物含本叶 FA1/FB1 执行痕迹（红阶段真实跑）。
3. **集成 fail 处置任务书渲染**（probe3）：真实 loop fail 后 `topic.designer.brief.md` 渲染在场——含「失败验收：R1（unit topic）」、契约比对事实清单、二选一处置指引、worktree 环境约定。loop stderr 同步输出首败即转语义（MAX=1）。
4. **真实 loop 对照**（probe2/3，见第 2 节）。

## 5. 波后三项

- **S4（真实 pi reviewer）**：`cw run --spawn pi` 生产链路（spec 提交层规则⑪ warning 先出声：「无文件参数的全量 vitest run…上收 root spec 并标 layer: topic」）。pi verdict=**fail**，comment 第六维原文精确命中：
  > ⑥ 验收成本与层级归属：A1 为全量回归形态，出现在叶子 spec 的 unit 层，需上收 root spec 并标 layer: "topic"。

  人工核验：同时命中「成本/层级问题」与「上收 root 指引」两个要素；另一 must-fix（vitest 未声明 devDependencies，维度⑤）系 fixture 仓真实缺陷，审查正确，不影响第六维判定。产物归档 `/tmp/al4-s4-archive/`（events.log / spec-leaf-full.json / topic 目录 brief+stdout）。
- **G6 文档核对**：`.tmp/design-acceptance-layering.md` §2.5 F1-F7 处置栏全部非空且无「待定」——F1 治理（D7 落点二 + D9 容量记档）、F2/F3/F4 记档+触发条件、F5/F6/F7 记档附理由/锚点；D9 F1-F4 触发条件均有明确信号与升级路径（例：F4「loop 空转 CPU 可感知或单 topic 事件数达万级 → mtime/size 短路」）。核对通过。
- **场景重放抽查**：A1（probe2，独立 tmp 等价重建：集成 pass + verified + 红阶段零 R1）、A6（probe3，**全真实 loop** 重放：fail 入账 → drift → designer brief → root worktree 修复 → pass → verified + drift 消失，序列 [fail, pass]）。均不依赖 builder tmp 残留。

## 6. §5 条款对照

A1-1 / A1-2 / A1-3 / A1-4 / A6-1 / A6-2 / A6-3 / 通用事件序与耗时条款：全部实测通过（断言形态见第 3 节，强度不低于验收文档要求；A1-1 扫描含 red-phase-* 强于文档）。

## 7. builder 5 项披露偏差核验

①evidenceDir import 自 src——已披露，纯路径函数无行为分叉风险，可接受；②timeoutMs 120s——已披露，行为等价（u8 先例同形态）；③构造器内联——文档 §2 明确授权；④A1-1 含 red-phase-*——强化而非弱化；⑤波后归 verifier——本报告完成。全部核验无隐瞒。

**builder 自报逐项证实**：10 用例覆盖、两连跑绿、全量 618 绿（本次一次过）、耗时量级、5 项偏差——全部与实测相符，无虚报。

## 相关文件

- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split/tests/al-4-e2e-layer.test.ts`（交付物，814 行）
- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split/docs/rewrite/acceptance/al-4-acceptance.md`（防篡改基线，未改动）
- 代笔对照锚点：`/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split/src/runner/loop.ts` L445-533；`/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split/src/runner/integrate.ts` L114
- S4 产物留档：`/tmp/al4-s4-archive/`（探针其余 tmp 已清理，git 状态复核零污染）

> 主 agent 补记（2026-08-22）：S4 证据已从 /tmp 复制至仓库 gitignore 目录 `.xyz-harness/al4-s4-evidence/` 长期保留（M4 三跑 /tmp 清证据事故后立的纪律）。
