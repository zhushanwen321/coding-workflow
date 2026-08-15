# u6b 验收报告：human 适配器（verifier 独立验收）

> 验收对象：`src/runner/spawn/human.ts` + `tests/u6b-human-adapter.test.ts`
> 基线：commit `9c6af01`（`docs/rewrite/acceptance/u6b-acceptance.md` 锁定版）

## 总结论：**PASS**

## 1. 防篡改核对

| 检查项 | 结果 |
|--------|------|
| `git diff 9c6af01 -- docs/rewrite/acceptance/u6b-acceptance.md` | 空（exit 0，无输出） |
| 验收文档 sha256（工作区） | `62fa55429fd0e0425c159c4f86916da4642b926fe2c96086e971c4ccd355ef10` |
| 验收文档 sha256（基线 `git show 9c6af01:...`） | `62fa55429fd0e0425c159c4f86916da4642b926fe2c96086e971c4ccd355ef10`（一致） |
| `git rev-parse HEAD`（验收时） | `9c6af01` |

`git diff 9c6af01 --stat` 全量归因：

| 变更 | 归因 |
|------|------|
| `M AGENTS.md`（1 行，e2e 测试基建描述改写） | 认知外（内容与 u6b 无关，非 builder 越界） |
| `?? src/runner/spawn/human.ts` | **u6b 领地新文件 1** |
| `?? tests/u6b-human-adapter.test.ts` | **u6b 领地新文件 2** |
| `?? src/runner/spawn/pi.ts`、`?? tests/u6c-pi-adapter.test.ts` | u6c 并行领地（豁免） |
| `?? src/runner/loop.ts` | u7 并行领地（豁免） |
| `?? wave-endstate-execution.drawio*`（4 个） | 认知外（非代码） |

结论：u6b 领地仅 2 新文件；tracked 文件零改动；禁改清单（契约层 / pi.ts / lifecycle.ts / loop.ts / run.ts / human-loop.ts / 既有 tests）全部未触碰。

## 2. 命令实跑

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u6b-human-adapter.test.ts`（第 1 遍） | 6/6 passed（4.06s） |
| 同上（第 2 遍） | 6/6 passed（4.11s） |
| `npx eslint src/runner/spawn/human.ts tests/u6b-human-adapter.test.ts` | 零输出（exit 0） |
| `npm run check:all`（tsc src + tests） | 通过（无失败，无需并行归因；pi.ts/loop.ts 同时在树亦编译通过） |

## 3. 规格锁定逐条对照

- `export const humanAdapter: AgentSpawnAdapter`（name: "human"）：`src/runner/spawn/human.ts:132-133` ✓
- spawn() 建 `.cw-spawn/` 目录、指令全文写 stdoutPath（`<unitId>.<role>.stdout`）并同步 `process.stdout.write` 打印（实跑可见控制台输出）：136-146 行 ✓
- 指令内容三要素（cd workdir → cat briefPath → role 分步指引 + 信任边界提示）：`renderInstructionLines` 85-93 行 + `roleStepLines` 58-82 行 + `trustBoundaryLine` 53-55 行 ✓
- 立即返回 SpawnHandle（轮询协程 `void (async ...)()` 火忘）：171-190 行 ✓
- wait() 轮询间隔 `min(1000, timeoutMs/10)`（`Math.max(1, Math.floor(...))` 防护 timeoutMs<10 的 0 间隔，合理护栏）：148-151 行 ✓
- cwd 推导账本路径（`ledgerPath(cwHome, req.workdir)`，CW_HOME 优先 req.env）：101-113 行 ✓
- role→事件映射（designer→SpecSubmitted / builder→EvidenceSubmitted / reviewer→VerdictSubmitted）：43-50 行 ✓
- 「晚于 spawn 起始时间戳」（`Date.parse(event.ts) > startedAt`，旧事件不触发）：116-124 行 ✓
- 超时 → `{exitCode: "TIMEOUT", ...}`：177-180 行 ✓
- kill() 置停止标志（settled）+ wait() 立即返回 CRASH：161-167、186-190 行 ✓
- stderrPath 空文件：144 行 ✓

### 单测验收 6 组真实性

1. **#1 三要素**：三 role 循环断言 cd/briefPath/role 关键词 + stderr 存在且空 + 信任边界——真实读盘断言（128-159 行）✓
2. **#2 真实子进程写事件**：`spawnSync(process.execPath, ["-e", ...])` 起 node 子进程向账本 append（66-74 行），**非测试进程内直写**——防自写自读假验证成立 ✓
3. **#3 双段构造真实**：spawn 前测试进程用真实 EventLedger 写旧 SpecSubmitted（177 行，ts 早 + 类型错双重不触发）；spawn 后子进程写新 SpecSubmitted（182 行，ts 晚 + 类型错）→ race 1.5s 验证 pending（183-189 行）→ 子进程写 EvidenceSubmitted（191 行）→ exitCode 0。时间戳过滤语义（旧事件不触发）与类型过滤语义均被覆盖 ✓
4. **#4 超时**：timeoutMs=800、elapsed 断言 [800, 3000) ✓
5. **#5 kill→CRASH**：kill() 两次（幂等）、wait() 两次（同引用）✓
6. **#6 类型契约**：`const adapter: AgentSpawnAdapter = humanAdapter`，tsc 即证 ✓

## 4. builder 披露裁量评判

### 裁量 1：指令生成不复用 human-loop 的 buildStepInstruction —— **成立**

比对 `src/runner/human-loop.ts`：

- `buildStepInstruction(projection, rootId)` 的输入域确是「root 子树状态导航」：按账本投影推导目标 unit 与步骤（create/spec/spec-review/build/exec-review，177-211 行），**不接受 role 参数、目标由账本现状决定**；u6b 是「unit+role 定点派发」（spawn 时该 unit 可能无任何进展事件），输入域确实不匹配。
- 三点差异核实：① 入参 `SequencedUnitProjection` → `AgentSpawnRequest`（属实）；② 去掉「当前 created，尚无 spec / spec-frozen / verified」状态注记（human-loop 94/111/123/136 行确有、human.ts 的 `roleStepLines` 确无，属实）；③ 头部补 `cd <workdir>`（human-loop 只 `cat ${unit.briefRef}` 相对路径、human.ts 88 行显式 cd，属实）。
- 文件头注释（human.ts 11-23 行）如实注明上述全部差异。指令行内容与 human-loop 私有蓝本（specInstruction/buildInstruction/execReviewInstruction）逐行同源（cd/cat 定位 + evidence submit + review submit + verify + 信任边界）。
- 佐证：human-loop 指令函数（specInstruction 等）均模块私有未导出，唯一导出的指令入口即 buildStepInstruction——「只读 import」为零 import 是结构性必然，非偷懒。验收文档「其函数不满足处在本文件内写变体，注明差异」条款满足。

### 裁量 2：测试进展事件由子进程直写 JSONL —— **成立**

比对 `EventLedger.append`（`src/store/events-log.ts:71-83,127-140`）与测试子进程脚本（tests 52-58 行）逐字段：

| 字段 | EventLedger.append | 子进程脚本 | 一致性 |
|------|--------------------|-----------|--------|
| seq | `events.length === 0 ? 1 : events[last].seq + 1` | `lines.length + 1` | 等价（账本由 append 写入保证 seq 从 1 连续，`lines.length === events[last].seq`） |
| ts | `new Date().toISOString()` | `new Date().toISOString()` | 一致 |
| type / payload | 原值透传 | 原值透传 | 一致 |
| 行格式 | `JSON.stringify(envelope) + "\n"` | `JSON.stringify(envelope) + "\n"` | 一致（字段序 seq,ts,type,payload 相同） |

理由核实：子进程 `node -e` 无法加载 TS 源、测试不依赖 dist——属实（测试文件零 dist import）。被测 wait() 只读账本文件、对写入方无感知。子进程直写不走文件锁/孤儿校验，但测试场景无并发写且 setup 已建 UnitCreated，不构成对验收文档#2（「另一真实子进程向账本 append 一条 SpecSubmitted」）的偏离。

### kill→CRASH（非 TIMEOUT）设计 —— 与验收文档一致

验收文档 25 行锁定「kill()：置停止标志，wait() 尽快返回 `{exitCode: "CRASH", ...}`」。实现 kill 即 `settle("CRASH")` 立即 resolve + settled 置位令轮询循环退出。builder 理由（不污染 runner 连续超时计数）与 u6a lifecycle 的同类归因注释（lifecycle.ts 166-174 行「手动 kill() 不置位……归 CRASH——不污染 runner 的『连续 2 次 TIMEOUT 转人工』计数」）语义同构，两 unit 冲突模式一致，无矛盾。

## 5. 行为对抗抽查（独立探针，真实调用，7 条全 PASS）

探针：esbuild bundle 后纯 node 真实调用 `humanAdapter`，隔离 CW_HOME，事件由真实 node 子进程 append（与交付测试同形状、代码独立）。

| # | 对抗点 | 结果 |
|---|--------|------|
| 1 | designer spawn 后子进程写 EvidenceSubmitted（同 unit、新 ts、错误类型）→ 不触发；SpecSubmitted 才触发 | PASS（错误类型阶段 pending，正确类型后 exitCode=0） |
| 2 | spawn 前旧 SpecSubmitted（类型对、unit 对、**ts 早**）单独不触发——时间戳过滤的独立语义 | PASS（旧事件阶段 pending，新事件后 exitCode=0） |
| 3 | kill() 即时性：timeoutMs=60000（interval=1000ms）轮询 sleep 中段 kill → wait() 立即 resolve | PASS（CRASH，kill→resolve=0ms，未等 sleep 结束） |
| 4 | 极小 timeoutMs=200 → TIMEOUT 且 elapsed 合理 | PASS（TIMEOUT，elapsed=214ms） |
| 5 | TIMEOUT 已 settle 后再 kill() 两次 → 结果不被改写（出口幂等） | PASS（两轮 TIMEOUT，同一 Promise 引用） |
| 6 | 同账本双实例并行 wait（unitA designer / unitB builder 同 workdir）互不干扰 | PASS（A=0 后 B 仍 pending，B 触发后=0，产物按 unit+role 分文件） |
| 7 | stderr 文件存在且为空（独立复核） | PASS（长度 0） |

与验收文档无任何矛盾。

## 6. 非阻塞观察项（不构成打回）

1. **minor**：`readLedgerEvents`（human.ts:101-113）的 `req.env.CW_HOME` 路径跳过了 `getCwHome` 的 isAbsolute 校验（getCwHome 对相对路径抛错）。注释声称「与 getCwHome 语义一致」仅就「空串视为未设置」成立，绝对路径校验强度弱于 getCwHome。生产影响极低（env 由 runner 传入），留待接线 unit（u7）或后续统一。
2. **可忽略**：`pollIntervalMs` 的 `Math.max(1, Math.floor(...))` 是对文档公式 `min(1000, timeoutMs/10)` 的防 0 护栏（timeoutMs<10 场景），实跑 timeoutMs=200/800 均符合原公式。

## 7. 结论

防篡改、命令实跑、规格对照、两处裁量、7 条行为对抗抽查全部通过。**u6b 验收 PASS**，建议流转 verified。
