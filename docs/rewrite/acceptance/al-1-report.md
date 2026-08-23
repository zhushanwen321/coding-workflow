# al-1 验收报告：nice 减震双落点（D7）——verifier 独立验收

> verifier 对抗式独立验收，2026-08-22。机制依据 docs/rewrite/orchestration.md。
> 总结论：**PASS**（全部条款证实；附 1 项存量竞态观察——rv5 T3/T8 间歇挂，已实证与 al-1 无因果，非本 unit 引入，不阻塞）。

## 1. 防篡改核对

| 项 | 结果 |
|----|------|
| 基线 commit | `a8b5ed7`（docs(rewrite): add M5 acceptance baselines for al-1 (nice) and al-2 (layer)） |
| 验收文档 sha256（工作区） | `5c26c7eb459b68ad87fc78abd061744ba19069043750e4a5bfbd5d7c21691ce4` |
| 验收文档 sha256（基线 `git show a8b5ed7:...`） | `5c26c7eb459b68ad87fc78abd061744ba19069043750e4a5bfbd5d7c21691ce4`（一致） |
| `git diff a8b5ed7 -- docs/rewrite/acceptance/al-1-acceptance.md` | **空**（零篡改） |

## 2. 越界扫描

`git status`（工作区未提交）：`M src/runner/spawn/lifecycle.ts`、`M src/verify/run.ts`、`?? tests/al-1-nice.test.ts`（al-1 三交付文件）、`?? docs/rewrite/acceptance/al-3-acceptance.md`（豁免——主 agent 预写草稿）。

`git diff a8b5ed7 --stat` 共 9 文件，逐项归属：

- al-1 工作区改动：`src/verify/run.ts`（+47/-6）、`src/runner/spawn/lifecycle.ts`（+49/-3）、`tests/al-1-nice.test.ts`（新增 225 行）——恰为 §2 交付物三文件
- al-2 已 commit（0902c53）交付：`CONTEXT.md`、`src/events/types.ts`、`src/handlers/spec-schema.ts`、`tests/al-2-layer-model.test.ts`、`docs/rewrite/acceptance/al-2-report.md`——豁免
- al-2 流转区（主 agent 行为，非 builder 越界）：`docs/rewrite/acceptance/al-2-acceptance.md`（§7 勘误 + §8 流转，0902c53 内 committed）、`docs/rewrite/ledger.md`（al-2 verified 流转 + 事件流水）——逐行读过，均为 al-2 流转/勘误备案文案，无 al-1 相关改动

**禁改清单核对**：两源文件 diff 逐行读毕——`src/verify/run.ts` 改动仅：头注释补 nice 说明、import 增 `type SpawnOptions`、`NICE_ADJUSTMENT = 10` 具名私有常量、`niceResolvable(env)`（与 `bashResolvable` 同型：PATH undefined 放行 / delimiter 逐段 / 复用 `isExecutableFile`）、spawnOptions 抽取 + nice 预检分流（§4.A 全部列明项）。`reclaimGroup` / `readSentinel` / `bashResolvable` / `isExecutableFile` / 等待辅助 `spawnSync("bash", ["-c", "while ..."])` 函数体零触及（不在 diff 任何 hunk 中）。`src/runner/spawn/lifecycle.ts` 同型：`assertExecutableResolvable` 函数体零变更且调用仍在 spawn 之前（源码第 129 行，nice 分流第 158-165 行）。spawn 选项对象抽为两分支共用常量，字段值（cwd / env / stdio / detached:true）与原内联对象逐字段一致。`tests/` 既有文件零改动（git status 无其他 tests 条目）；`dist/` 已被 .gitignore 覆盖。**结论：改动集 ⊆ al-1 三文件 + al-2 已 commit 交付 + 豁免清单，零越界。**

## 3. 通过命令实跑

| 命令 | 结果 |
|------|------|
| `npm run build` | 通过（tsc 零错误） |
| `npm run check:all`（check + check:tests） | 通过 |
| `npx vitest run tests/al-1-nice.test.ts`（第 1 次） | 1 file / **7 tests passed**（924ms） |
| `npx vitest run tests/al-1-nice.test.ts`（第 2 次，连跑防 flaky） | 1 file / **7 tests passed**（890ms） |
| `npx eslint src/verify/run.ts src/runner/spawn/lifecycle.ts tests/al-1-nice.test.ts` | 零输出通过 |
| 全量 `npm test`（第 1 次） | 76 文件：**589/590 用例绿**，`tests/rv5-flake-escalation.test.ts` T8 挂（既有竞态，归因复核见 §6，与 nice 无因果实证） |
| 全量 `npm test`（第 2 次） | **76 文件 590 用例全绿**（215s，exit 0）——builder 自报复现 |

注：全量两次实跑——第 1 次 589/590（rv5 T8 间歇挂，§6 归因与 nice 无因果），第 2 次 **590/590 全绿**，builder 自报「76 文件 590 用例绿」得到复现；rv5 挂为存量竞态间歇性（verifier 另行单跑统计 5 挂 1 绿等，见 §6），不构成 al-1 条款失败。

## 4. §5 条款对照表

| 条款 | 判定 | 证据 |
|------|------|------|
| N1 验收命令落点（execBashTree 直测，ps 自报 → done 0，stdout trim 恰 10） | **证实** | tests/al-1-nice.test.ts:76-91；两连跑绿；verifier 波后场景在真实 CLI 干净 checkout 内再次独立证实（§7） |
| N2 agent spawn 落点（spawnProcess 直测，stdout 落盘 trim 恰 10） | **证实** | tests/al-1-nice.test.ts:95-109；两连跑绿 |
| N3 两落点值一致（同一常量值 10 锁定两文件实现） | **证实** | 共享 `EXPECTED_NI = "10"`（test:40）分别锚定两用例；两文件各自 `NICE_ADJUSTMENT = 10`（run.ts:491 / lifecycle.ts:108）；任一处漂移即红、测试不代偿 |
| D1 execBashTree 降级（仅 bash 的 PATH → done 0 / hello\n / stderr 空；bashResolvable 仍放行） | **证实** | tests:62-71 夹具（`symlinkSync(bashPath, bin/"bash")`，bin 内无其他可执行）+ :114-132 断言（stderr `""` 恰为空、降级静默）；kind=done 本身证 bash 预检放行；verifier 抽查1 以同构造独立复现降级路径（§5 抽查1） |
| D2 spawnProcess 降级（req.env 覆盖 PATH → hi\n / stderr 无 nice 报错） | **证实** | tests:135-152；断言 stderr 文件恰 `""` |
| D3 降级不影响预检抛错契约（同步抛带可执行名） | **证实** | tests:155-169 `toThrow(/definitely-not-on-path/)`；verifier 抽查3 独立复现（错误消息含可执行名与 SPAWN_ERROR 恢复动作文案） |
| R1 超时整树 kill（victim pid + ESRCH 轮询 ≤2s） | **证实** | tests:174-207：victim-pid 文件落盘 + `process.kill(pid, 0)` ESRCH 轮询（真实检查进程死亡，非仅断言 outcome kind）；实跑 667ms 绿；verifier 抽查3 在 spawnProcess 侧独立复现并扩展到孙进程（§5 抽查3） |
| R2 退出码透传（exit 42 → done 42） | **证实** | tests:210-223；抽查1 c2 以 exit 3 双形态对照独立复现 |
| R3 哨兵与产物完整（归全量回归） | **证实** | 全量 75/76 文件绿（rv5 挂为竞态观察项）；抽查1 三组命令哨兵文件逐字节对照一致；波后场景 fd 直写 / report.json / sha256 产物链完整（§7） |
| R4 agent 链路既有行为（归全量回归） | **证实** | u6a/u6b/u6c/u7 系套件全量绿；抽查3 四态归因（EXITOK / 非零 / SPAWN_ERROR 同步抛 / TIMEOUT）直测全过（§5 抽查3） |

## 5. 真实性抽查 + 行为对抗抽查

### 真实性（防空洞断言）

- **N1/N2 手法**：断言读**产物文件**（`readFileSync(stdoutPath).trim() === "10"`，test:90/108）而非进程内存值；`ps -o ni= -p $$` 在被测命令字符串内部执行（`$$` = 被 nice 的 bash 主进程）。**非空洞。**
- **D1/D2 构造**：tmp bin 真只含一个指向系统 bash 的 symlink（夹具代码 62-71 行，无 nice/ps）；PATH 替换为 `env: { PATH: bashOnlyBin }`（整体替换非拼接）；降级静默断言检查 stderr 产物**恰为空串**。**非空洞。**
- **R1 形态**：victim pid 从文件读出、`process.kill(pid, 0)` 抛 ESRCH 才通过，2s 轮询窗口耗尽则显式 throw（进程确实死亡，非只看 outcome）。**非空洞。**

### 对抗抽查（真实子进程 + tmp + 环境隔离，直调 dist）

1. **nice 语义零变化（产物逐字节对照）**：三组命令（带标记行+stderr 事实 / 非零退出 exit 3 / 空命令 true）在 nice 在场与「仅 bash」降级两形态下，outcome / stdout / stderr / 哨兵文件**逐字节全等**（12/12 断言过）。c1 sanity：stdout `E9 PASS\n`、stderr `err-line\n`、哨兵 `0\n` 与既有语义一致。
2. **超时路径产物完整性（CLI 层，真实 verify）**：`--timeout-ms 2000` 下 E2 条目超时——`E2.timeout` 标记文件内容 `command timed out after 2000 ms, killed\n`、`E2.stderr` 含同款超时注记、`E2.stdout` 含进程死前部分输出 `E2 started`（fd 直写与进程存活解耦）；整体 exit 1；同轮 E1/U1 正常 pass（快命令不受影响）。与验收文档锁定的既有超时语义一致。
3. **lifecycle 四态归因回归（nice 分流后）**：EXITOK（exit 0）✓；非零透传（exit 7 → 7）✓；不存在的可执行同步抛带可执行名（SPAWN_ERROR 契约，消息含恢复动作文案）✓；TIMEOUT（timeoutMs 800 + sleep 30 → `"TIMEOUT"`）✓ 且 **detached 组 kill 覆盖孙进程**：组长 bash pid 与后台孙进程 sleep pid 在 kill 后均 ESRCH（2s 轮询窗口内），nice 组长下 `kill(-pgid)` 整树回收不变式实测。
4. **嵌套累加实测（POSIX 增量语义，D7 接受行为）**：父 ni=0 控制组 → execBashTree 内自报 10；`nice -n 10 node` 起 execBashTree → 自报 **20**（增量累加实证）；`nice -n 25` → 子 20（macOS ni 上限 clamp，`nice -n 25` 直接跑同为 20、双层 nice -n 10 为 20——增量语义 + 上限封顶均与 POSIX/macOS 文档一致）。代码注释声明的「嵌套累加接受、不去重」与实测吻合。

## 6. rv5 T3/T8 间歇挂归因复核（存量竞态观察项）

**现象**：全量第 1 次 T8 挂；verifier 单跑 1 挂（用例未及记录）1 绿 4 挂（T3/T8 皆中）——失败全部同位置：`driveToFlake`（tests/rv5-flake-escalation.test.ts:413）`waitText` 等待「派发 developer → unit "fdemo"」超时 10s，runner stdout 末尾停在 human 模式「派发 reviewer / designer」之后。

**builder 归因逐点核实**：

1. 失败点在 T8/T3 首次验收执行之前 ✓——driveToFlake 第 413 行等待第一次 developer 派发，先于任何 `runCli verify`（第一次 verify 在其后的 419-423 行）。
2. human spawn 无子进程 ✓——src/runner/spawn/human.ts 全文无 `spawn` 调用：spawn() 只写指令清单文件 + 轮询账本（`hasProgressSince`），不经 lifecycle.ts spawnProcess。
3. 卡点路径与 al-1 两落点零交集 ✓——runner 进程与 `runCli` 均由测试直接 `spawn`/`spawnSync`（不经 execBashTree / spawnProcess）；失败时 runner 侧尚未执行任何 verify（不进 execBashTree）。
4. **无 nice 基线独立复现**：基线 a8b5ed7 源码导出 tmp（dist 中 `grep -c NICE_ADJUSTMENT` = 0，确证无 nice）连跑 10 次：**5 挂 5 绿**，失败位置/形态与 nice dist 完全同构（T3/T8 皆中、同停「派发 reviewer/designer」后）。
5. **ABAB 交替对照**（排除负载时段干扰）：A（nice）1 挂 1 绿 / B（无 nice）2 挂 1 绿——无 nice 挂率不低于 nice。
6. **机制定位（代码级）**：runner 轮询投影（读账本快照，`--poll-ms 200`）与 `humanAdapter.spawn` 内 `baselineSeq` 读取（human.ts:200 再次读账本）之间存在时间窗口——进展事件（SpecSubmitted / VerdictSubmitted）恰在窗口内入账时，投影按旧快照决定派发（specReviewPending → reviewer / specReady → designer），而 baselineSeq 已包含该事件 → `hasProgressSince` 恒 false → 该 human spawn 轮询到 timeoutMs 永不结算 → 循环卡住 → 测试 waitText 超时。与 mx-1 修复的同毫秒窗口问题（human.ts:160-165 注释自认）同族、窗口位置不同（投影快照 ↔ baselineSeq 读取之间）。

**结论**：builder 归因成立——既有竞态，与 nice 无因果（4/5/6 三线独立证实）。按任务口径记**存量竞态观察项**报告，不要求 al-1 修复。

## 7. 波后场景（§7，真实 CLI 全链路）

隔离 CW_HOME + tmp git 仓（git init + fixture commit），真实 `node dist/cli.js` 走完整链路：`create` → spec（E1 e2e-real `bash wrapper.sh`：wrapper 内 `grep impl.js` 保证红阶段区分力 + `ps -o ni= -p $$` 自报 + 尾部 `E1 PASS` 标记行；E2 e2e-real sleep 5；U1 unit）→ `evidence submit spec` → `review submit pass` → 实现树 commit → `evidence submit build` → `verify`。

| 断言 | 结果 |
|------|------|
| verify（默认档）整体 pass、exit 0；红阶段 E1/E2/U1 全有区分力 | **PASS** |
| `E1.stdout`（干净 checkout 一次性工作区内执行）首行自报 ni **恰 `10`** | **PASS**（`["10","E1 PASS"]`） |
| 标记行 `E1 PASS` 契约不因 nice 破坏（e2e-sh 适配器折叠 `E1.report.json` cases: `[{id:"E1",name:"E1 PASS",status:"pass"}]`） | **PASS** |
| run 级 `report.json`（含 redPhase 节）+ 每条 `<id>.stdout/.stderr` + `<id>.report.json` 产物链完整 | **PASS** |
| 账本 `VerifyRan` 两轮入账、build 证据 sha256 数组字段在位 | **PASS** |
| 超时轮（`--timeout-ms 2000`）exit 1 + E2 超时产物三件（.timeout / stderr 注记 / 部分 stdout） | **PASS**（对抗抽查 2 同场） |

## 8. 总结论

**PASS**。§1 目标（双落点包 nice -n 10 + 预检降级静默 + 全部语义零变化）逐条证实；§4.A/§4.B 实现形状（niceResolvable 同型 / NICE_ADJUSTMENT 具名常量 / spawn 选项逐字段不变 / 进程组不变式注释 / 嵌套累加接受声明 / 等待辅助与 reclaimGroup 不包 / assertExecutableResolvable 保持在前）全部落实；§5 N1-N3 / D1-D3 / R1-R4 十条全证实；§6 通过命令实跑（唯一例外 rv5 竞态已三线归因为存量问题）；§7 波后场景全链路 PASS。防篡改与越界扫描零违规。

**观察项移交（非 al-1 失败项）**：rv5 T3/T8 human spawn 完成信号吞没竞态（§6 机制定位），建议后续 unit 处置（候选方向：humanAdapter.spawn 的 baselineSeq 读取与 runner 投影快照取同一账本读快照，或完成信号判定回退到「事件 ts/seq 晚于派发决策快照」）。
