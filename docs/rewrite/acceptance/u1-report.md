# u1 验收报告：事件模型 + 账本 + 投影（verifier 独立验收）

> 验收对象：`docs/rewrite/acceptance/u1-acceptance.md`（锁定文件）
> verifier 角色：对抗式独立验收，builder 自报一律实测证实。本报告不修改任何代码/测试/验收文档。

## 总结论：PASS

| 项 | 结果 |
|----|------|
| 防篡改检查 | 通过（验收文档 diff 为空；types.ts 纯追加 33 行 0 删改；工作区仅 u1 领地文件） |
| 通过命令（check:all / test / lint） | 全部 exit 0；测试 5 文件 41 用例全绿 |
| 单测验收 8 条 | 8/8 真实覆盖 |
| E2E real 验收 | 通过（含任务要求的真实交错断言） |
| builder 披露 4 点设计决策 | 全部证实为真且合理（见 §5） |
| 对抗抽查 | 17 条全 PASS（含锁 10s 超时路径实测） |
| 观察项（非 fail） | 3 条，见 §7 |

## 1. 防篡改检查

| 检查 | 结果 | 证据 |
|------|------|------|
| 验收文档未被改动 | 通过 | `git diff 01fd577 -- docs/rewrite/acceptance/u1-acceptance.md` 输出为空；`git status --short` 中该文件无条目 |
| 验收文档 sha256 | 记录 | `117681da2507e0ad162fadb83ff995dfc39fba6658ebb7f34f0c306ddedf668c` |
| 验收时 HEAD | 记录 | `71f60a9954a1f8d9ccdb29bf24b046f54fb61a77`（u3 已 committed） |
| types.ts 只追加 | 通过 | `git diff 01fd577 --stat -- src/events/types.ts` = `33 insertions(+)`，0 删除 0 修改；逐行核验 diff 仅一个 hunk `@@ -162,3 +162,36 @@`，全部为 `+` 行。既有定义（1-164 行：五类 payload、EventEnvelope、Projection 等）零改动，u3 的并行契约未破坏（u3 的 13 个测试在全量运行中通过） |
| git status 全量 | 通过 | 仅：`M AGENTS.md`（会话前认知外，任务说明豁免）、`M src/events/types.ts`（u1 领地，纯追加）、untracked `src/core/`、`src/store/`、`tests/fixtures/`、`tests/u1-{fold,ledger,e2e}.test.ts`（u1 领地）、drawio 系列 5 个（认知外，豁免）。无其他文件 |
| 禁改清单 | 通过 | `docs/rewrite/`、`archive/`、`tests/smoke.test.ts`、`src/cli.ts`、`src/index.ts` 工作区零改动 |
| builder 未执行 git 写操作 | 通过 | u1 交付物均为 untracked/未提交状态 |
| 零 mock | 通过 | `grep "vi\.|jest\.|\.mock|sinon"` 对三个 u1 测试与 fixture 无匹配 |

## 2. 通过命令实跑（仓库根，2026-08-15）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（tsc src + tests 零错误） |
| `npm test` | exit 0；Test Files 5 passed (5)，Tests 41 passed (41)：u1-ledger 12 / smoke 3 / u3-spec-rules 13 / u1-e2e 1 / u1-fold 12。验收文档要求「含既有 smoke 3 条」满足；派发说明中「预期 6 个测试文件」与实际 5 个不符，以验收文档原文为准（无文件数要求），不构成偏差 |
| `npm run lint` | exit 0，零输出 |

## 3. 单测验收 8 条对照（读测试源码逐条判定断言真实性）

| # | 条款 | 判定 | 证据（tests/u1-fold.test.ts / u1-ledger.test.ts） |
|---|------|------|------|
| 1 | 完整生命周期 → closed | 真实覆盖 | 验收1：6 事件序列，`deriveStatus === "closed"` |
| 2 | spec 提交两次只认最后一条 | 真实覆盖且更强 | 验收2：specs 长度 2；`gateOnlyHash("spec-v1")` 放行旧 spec 仍停 created（证明生效的是 v2）；v2 过 gate 但 v1 时代的 pass verdict 在 v2 之前不计数（`verdictSeqs[i] > lastSpecSeq` 语义被锁定）；v2 后新增 pass verdict 才冻结 |
| 3 | verify 覆盖缺 A2 → spec-frozen | 真实覆盖 | 验收3：`acceptanceIds=["A1"]` → spec-frozen |
| 4 | replay 幂等 deep-equal | 真实覆盖 | 验收4：`expect(fold(x)).toEqual(fold(x))`——vitest `toEqual` 对 Map 递归深度比较，比较的是完整投影（units Map + 全部数组字段），非个别字段 |
| 5 | gate 注入纯函数性 | 真实覆盖 | 验收5：同一 fold 产出的同一 unit 投影，`gateFail → "created"`、`gatePass → "spec-frozen"`，状态差异唯一归因于 gate |
| 6 | seq 连续 + JSONL 可解析 + evidence 幂等拒绝且账本不变 | 真实覆盖 | 验收6：seq `[1,2,3]`；原始文件逐行 `JSON.parse` + 信封字段断言；重复提交抛错后**字节级**比对账本内容不变 |
| 7 | 孤儿 SpecSubmitted 被拒 | 真实覆盖 | 验收7：错误含 unitId 与 UnitCreated 指引；账本保持空 |
| 8 | stale 锁（未来时间戳 + 死 pid）夺取 | 真实覆盖，死 pid 真实 | 验收8：`spawnSync(process.execPath, ["-e","process.exit(0)"])` 真实 spawn 后退出（pid 已 reap，非写死的 99999 类撞活值）；时间戳写 `Date.now()+60s` 迫使 stale 判定只能走 pid 死亡路径；随后 append 成功且 lockfile 被正常释放 |

## 4. E2E real 验收对照（tests/u1-e2e.test.ts + tests/fixtures/append-worker.js）

| 条款 | 判定 | 证据 |
|------|------|------|
| 两真实子进程并发对同一账本各 20 条 | 真实 | `spawn(process.execPath, [WORKER_PATH, ...])`；起跑门文件保证两 worker 同时放行形成真实并发窗口 |
| 40 条无交错损坏（每行 JSON 可解析） | 真实 | 原始文件 split 后逐行 `JSON.parse` + seq/ts/type 字段断言 + 末行换行收尾断言 |
| seq 全局 1..40 连续不重复 | 真实 | 排序后与 `Array.from({length:40}, (_,i)=>i+1)` 全等比较 |
| 两 unit 事件各自完整 | 真实 | 每 unit 1×UnitCreated + 19×EvidenceSubmitted，runId 全套逐一比对；worker 自身也自检数量否则 exit 1 |
| 子进程走 dist 编译产物（非 ts 直跑） | 真实 | append-worker.js `import { EventLedger } from "../../dist/store/events-log.js"`；`pretest` 钩子先 build 保证 dist 最新 |
| 交错断言（任务追加要求：两 unit 事件至少真实交错一次） | 真实存在 | line 112-114：`owners` 序列相邻切换计数 `switches`，断言 `toBeGreaterThanOrEqual(1)`，注释明示「非先后整块」；worker append 间隔 10ms（> 锁重试间隔 100ms 的间隙），设计上保证输家有真实杀入临界区的机会。非仅查总数与连续性 |

## 5. builder 披露 4 点设计决策核实

1. **encodeCwd 同时编码 `/` 与 `.`**：证实为真。`src/store/project.ts:46` `cwd.replace(/[\\/.]/g, "__")`（`\` 一并编码）。合理性成立：验收文档交付物表明文要求「`/` 与 `.` → `__`」，实现忠于文档；相比旧实现（只编码分隔符）多出的 `.` 编码防护了 `.`/`..` 特殊目录名与 `.bare` 类隐藏目录。行为实测：`/Users/x/.bare → __Users__x____bare`、`. → __`、`.. → ____`。
2. **types.ts 追加顺序锚点类型**：证实为真，但披露不完整——实际追加 **4** 个类型（SequencedUnitProjection、SequencedProjection、SpecGate、DiscriminatedEvent），披露只点名前 2 个。均属纯追加，验收文档明文允许 owner 追加，不构成违规。必要性论证成立：UnitProjection 的 specs/verdicts 是平行数组，丢失跨数组账本顺序，「最后一条 spec 之后的 spec-review pass」（重新提交 spec = 打回重审）无法从平行数组判定，必须有 seq 锚点；DiscriminatedEvent 是纯类型层判别联合视图（运行时零开销），解决泛型信封无法窄化 payload 的问题。
3. **fold 对孤儿事件与重复 UnitCreated 抛错**：证实为真（src/core/fold.ts:36-61，单测锁定）。合理性成立：append 侧已拒绝这两类，fold 再见到即事件流被外部改动，静默跳过会把损坏伪装成正常投影；不违反「纯函数」契约（同输入恒同异常）。
4. **锁超时路径（持锁 >10s）无单测**：证实为真（u1-ledger.test.ts 无该用例；验收文档 8 条单测亦无此要求，仅接口契约要求行为存在——无单测不构成条款 fail）。verifier 实测补证该路径行为正确：活 pid + 未来时间戳（永不触发 stale）下，append 于 **10043ms** 抛「10s 内未获得账本锁」，错误含 lockfile 处置恢复动作。

## 6. 行为对抗抽查（/tmp 脚本 import dist 真实代码，17 条全 PASS）

脚本 1（`/tmp/u1-adv-probe.mjs`，14 条）：
- encodeCwd 实际输出形状：`/Users/x/.bare → __Users__x____bare`、`. → __`、`.. → ____`、反斜杠同步编码 — 4 PASS
- 同一事件流（真实账本 readAll）gate fail → created / gate pass → spec-frozen — 2 PASS
- append 拒绝路径错误可操作性：孤儿事件错误含 unitId + 「先…UnitCreated/create」指引；重复 evidence 错误含 runId + 「新 runId/readUnit」指引；重复 UnitCreated 错误含恢复动作；拒绝后账本字节不变（长度仍 2）— 4 PASS
- readUnit 隔离：多 unit 交错账本中 `readUnit("u-a")` 全部事件 `payload.unitId === "u-a"` 且 seq 严格递增 — 2 PASS
- 账本损坏行时 append 抛可操作错误（含行号/截断指引），不写半行 — 1 PASS

脚本 2（`/tmp/u1-adv-lock-timeout.mjs`，3 条）：锁 10s 超时抛错 / 超时有界实测 10043ms / 错误含恢复动作 — 3 PASS

## 7. 观察项（不构成验收 fail，供主 agent 决策）

1. **lockfile 空窗口竞态（沿用旧实现的既有机能缺口）**：`src/store/events-log.ts:209-231`——进程 A `openSync(wx)` 创建 lockfile 与 `writeSync` 写入内容之间存在微秒级窗口；进程 B 在此窗口 openSync 得 EEXIST 后 `readLockFingerprint()` 读到空文件返回 null，随即 unlink A 刚创建的锁并自己持锁 → 双持锁、并发写。40 条并发 E2E 未触发（窗口极小）。**对比确认**：旧实现 `archive/src/store/cw-store.ts:180-186` 在 fingerprint null 时同样直接 unlink（注释断言「一定不是 fresh valid lock」在该窗口不成立），u1 是按验收文档「锁语义沿用旧实现（附录 B.3）」忠实沿用，非新引入回归。修法方向：fingerprint null 时改为等待下一轮而非立即 unlink。
2. **E2E 交错断言存在低概率 flake**：switches ≥ 1 依赖调度（10ms append 间隔 vs 100ms 锁重试间隔，输家首次重试约 80% 概率杀入），极端调度下可能先后整块执行导致偶发红。实测通过；如未来出现 flake，优先调大 APPEND_PAUSE_MS。
3. **verified 判定不校验 VerifyRan 在最后一条 spec 之后**：`deriveStatus` 取全局最后一条 pass 的 VerifyRan，重新提交 spec 后旧的 pass verify 仍计数。与验收文档条款字面一致（条款未要求顺序），非偏差；记录以免后续 unit 误解语义。

## 8. 结论

u1 交付满足 `u1-acceptance.md` 全部条款（单测 8/8、E2E、接口契约、禁改清单、通过命令），builder 披露 4 点决策全部证实，对抗抽查 17 条全 PASS。**PASS**，建议流转 verified → committed。
