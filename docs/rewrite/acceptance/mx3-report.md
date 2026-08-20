# mx-3 验收报告：spec-review 身份强校验 + deadlock 代数计数 + spawn session 保留

- 判定：**PASS**（附 2 项 minor 发现 + 2 项裁决附注，见 §7）
- 日期：2026-08-18（verifier 独立验收，对抗式——builder 自报全部经实测证实或证伪）
- 验收基线：commit `cde8d6d`（mx-3 唯一基线；被测工作区 = 该 commit 之上的未提交改动）
- 基线文档 sha256：`e12a7ac05a5fc6727041480704571938669e8bdf4f4c77704b6931d95ebf373e`（docs/rewrite/acceptance/mx3-acceptance.md）
- 缺陷现场依据：docs/rewrite/acceptance/m4-gate-report.md §5.1 / §5.3 / §5.5
- 验收时 git HEAD：`cde8d6d`；工作区改动 = src 5 文件 + tests 34 改 2 新增（与领地一致，见 §1）

## 1. 防篡改核查

| 检查 | 结果 |
|------|------|
| `git diff cde8d6d -- docs/rewrite/acceptance/mx3-acceptance.md` | **空**（基线未被篡改） |
| `git status` 越界扫描 | 全部 41 项改动落在领地：src 恰好 5 文件（review-submit / fold / frontier / loop / pi）、tests 34 改 + 2 新增（mx3-role-gate / mx3-generation-count）、docs 与 archive 零改动、无表外文件 |
| §3 禁改清单 | `git diff cde8d6d --name-only` 对 src/verify/、src/gates/、src/testrun/、src/store/、src/runner/{integrate,worktree,human-loop,brief}.ts、src/runner/spawn/{types,lifecycle}.ts、src/handlers/{create,evidence-submit,run,verify}.ts、src/cli.ts、src/dispatch.ts、docs/、archive/ **零命中**；events schema（types.ts）零变更；派发 gate 语义零变更（loop.ts diff 无 gate 段改动） |
| pi.ts diff 逐行核查 | 仅 4 处：①头注释 session 实测增补 ②buildPiCommand JSDoc ③args 数组 `--no-session` → `--session-dir <req.artifactDir>` + `--name <unitId>-<role>` ④mx-3 边界注记注释。`resolvePiModel` / `DEFAULT_PI_MODEL` / 模型注入链（CW_AGENT_MODEL → --model）零触碰 |
| u1-ledger.test.ts | 存在且零改动（builder 自报「孤儿防护未动」属实） |

**迁移完整性归因**（34 个修改的测试文件逐一过 diff）：16 个具名迁移（mx1 T2① 反转/T3 语义迁移/T5 fixture/T6 载体换 exec-review、u5b-loop/u7-loop/fx3 注释+role、u6c 命令断言 ×2、mx1-model-chain T8 锚改写、rv1 role human→reviewer、rv2/rv5/u2-review/u2-e2e/u4a/u4b/u5b-e2e/u7-e2e/wt2 CLI 补 `--role reviewer`）+ 18 个纯 fixture 补 role 文件（closed-irreversible/fx1×2/fx2/fx4/fx5/p1-fold-perf/rv4/u1-fold/u1b-e2e/u1b-status-frontier/u1b-tree-report/u6b/u7b/u8/wt3/wt4/wt5）——与 builder 自报表一一对应，**未发现表外无声改动**；自报「19 文件约 45 处」与实测 18+1 文件量级吻合（fx3 兼具注释与 role 两类）。

## 2. 通过命令实跑（§6，全部在仓库根执行）

| 命令 | 结果 |
|------|------|
| `npm run check` | exit 0 |
| `npm run check:tests` | exit 0 |
| `npx vitest run tests/mx3-role-gate.test.ts tests/mx3-generation-count.test.ts tests/mx1-independent-review.test.ts tests/u5b-loop.test.ts tests/u7-loop.test.ts tests/fx3-loop-split-dispatch.test.ts tests/u6c-pi-adapter.test.ts` | **Test Files 7 passed (7) / Tests 63 passed (63)**，Duration 43.60s |
| `npx eslint src/handlers/review-submit.ts src/core/fold.ts src/readonly/frontier.ts src/runner/loop.ts src/runner/spawn/pi.ts tests/mx3-*.test.ts` | exit 0，零输出 |
| 全量 `npx vitest run` | **Test Files 63 passed (63) / Tests 466 passed (466)**，Duration 130.56s——与 builder 自报 63 文件 466 用例一致 |

mx3-generation-count 单独 verbose 复跑确认 S1（6385ms 真实 pi）/ S2 / S3（14760ms 两次真实 spawn）**真实执行非 skip**（7/7）。

## 3. 四个裁决点

### 裁决 1：抢答豁免时序窗口（账本事件 ts ∈ [spawnedAt, settledAt]，替代「查 inFlight 表」）——**采纳，语义等价成立**

- builder 理由成立：verdict 写于 spawn 内（ts 早于进程退出），loop 于结算后才观察到——此刻 flight 已移出 inFlight，查表必然漏掉全部正常 reviewer 流。实测佐证：probe w1 中 verdict 在 reviewer flight 存活期入账、loop 在其结算后观察到，窗口法正确豁免（零误报）。
- 正常流不误报：w1（真实 runner + human adapter reviewer flight）——窗口内提交 `--role reviewer` pass → 无「疑似非独立 reviewer 提交」警告，unit 正常 spec-frozen。
- 晚到提交告警：w2——reviewer flight 结算（stdout 出现退出行）后提交 pass → 警告恰好出现 1 次，循环不死锁（runner 存活）。
- builder in-flight 自审告警：r3——无任何 reviewer flight 的 unit 上谎报 `--role reviewer` → 警告出现，循环继续。
- 窗口起点前 verdict：入账 ts 早于任一 reviewer spawn → 无匹配窗口 → 告警（mx1 T3 迁移用例断言 designer 自审 pass 告警，语义保留）。
- 跨 run 泄漏：窗口表为进程内存态，重跑清零；水位初始化（seenSpecVerdictSeq 取启动时账本现状）使历史 verdict 不追警告——w3 实测重启后 0 条重放。
- settledAt 精度：结算时刻晚于 spawn 实际退出（进程退出 → wait 结算之间有间隙），窗口尾端偏宽（亚秒级），该间隙内的提交被豁免——偏「不告警」侧的误差，与「可见性增强不阻断」定位一致，可接受。
- 判定细节核可：`!newSpecVerdictSeqs.every(inReviewerWindow)`（任一新 verdict 出窗即告警一次，非逐条告警）；ts 不可解析的 verdict 保守告警（`inReviewerWindow` 返回 false）——实现与注释声明一致。

### 裁决 2：escalation 文案「已打回 N 代 + 每代首条意见」+ 指引 `--role human` → `--role reviewer`——**采纳，自洽**

- 文案：escalation 列出的意见数必须与计数口径同构——同代双 fail 下旧文案（列 fail 总数）会列 2 条意见而代数=1，自相矛盾；新文案（每代首条）是 §4「打回代数定义」的自然呈现。G2/G3 实测 escalation 含「已打回 2 代/3 代」与各代意见。
- 指引 role 改动是 §2 入账强制的**逻辑必然**：若保留 `--role human`，人工按指引提交会被新入账层拒绝（exit 1），deadlock 无法人工解除，机制自我锁死。§4「u5b『人扮演 reviewer』既有用例迁移补 role」即「人处置也以 reviewer 身份提交」的口径；human-loop.ts 指令模板（mx-1 已带 `--role reviewer`，禁改清单内未动）与新指引一致。改动不在文档显式条款但为条款交集的必然而非越界，判合规。

### 裁决 3：mx1 T3 断言语义迁移（自审 pass → 警告 + 派独立 reviewer + status 停 created）——**采纳，断言真实非空洞**

- 与 R2/G 系自洽：fold 只认 reviewer 的直接后果——designer 自审 pass 不驱动冻结，unit 回 specReviewPending。
- 断言非空洞：三个具体行为锚（`派发 reviewer` 在场 / `派发 builder` 不在场 / status 匹配 `created`）。probe f1 独立实测同一形态（直写无 role pass 历史账本 → 真实 runner 重派独立 reviewer），迁移后的断言与真实行为一致。

### 裁决 4：T6 载体换 exec-review + T8 锚改写——**采纳（附注）**

- T6：「缺省 → payload 无 role 键」的实质断言（--role 缺省不入 payload）原样保留，载体从 spec-review（现已强制拒绝，无法测「缺省入账」）迁到 exec-review（范围外不收紧）——语义等价；且为 exec-review 补造 verified 前置（evidence-refs 校验需要），断言真实。
- T8：锚从「pi.ts diff 为空」（字节级）改为「diff 为空或含 `--session-dir` 且 +/- 行不触及 resolvePiModel/DEFAULT_PI_MODEL」（特征级）。锚严格性客观下降（理论上任何含 --session-dir 的 diff 都能过），但 §3 已显式解除「零改动」锁定（唯一合法放开面 = session 参数行），字节级锚在解锁后无法保持；新锚守住模型注入链，且覆盖交付时点（diff 非空）与提交后时点（diff 为空）两形态。verifier 独立 diff 核查证实实际改动仅 session 参数行 + 相关注释。判「可接受的锚迁移，强度下降如实披露」（见 §7-2）。

## 4. 条款对照表

### §2 交付物

| 条款 | 结论 | 证据 |
|------|------|------|
| review-submit.ts 入账层强制（缺/错 role → exit 1 + 可操作文案；exec-review 可选） | 达成 | probe r3：no-role exit 1（文案含 `--role reviewer` 与「恢复动作」）、designer exit 1、exec-review 无 role exit 0 且 payload 无 role 键；R1 三态绿 |
| fold.ts 投影层只消费 role=reviewer（spec-frozen / specFixPending 输入 / deadlock 计数输入） | 达成 | deriveStatus、latestSpecReviewAfterLastSpec、specReviewFailCounts 三处消费点均加 `role === "reviewer"`；probe f1/f3 + R2 绿 |
| frontier.ts 打回代数（同代多条 fail 计 1；deadlock = 代数 ≥2；specFixPending 谓词同步） | 达成 | probe g1/g2/g3；G1-G3 绿 |
| loop.ts ① 抢答豁免收紧（窗口判定替代永久豁免） | 达成 | 裁决 1 全组实测；`specReviewerDispatched` Set 已删除 |
| loop.ts ② escalation 按签名去重（消息文本 + unitId） | 达成（附 §7-1 发现） | probe g3/e：同签名零重印、跨 unit 各一次 |
| pi.ts session 落盘（--session-dir + --name；模型链零变更） | 达成 | S1/S2/S3 绿 + 独立 probe-s1；diff 逐行核查 |
| tests/mx3-*.test.ts 新建 R/G/S 条款 | 达成 | 16 用例全绿，S 系真实 pi 执行 |
| 既有迁移（补 role / T2① 反转 + 注记） | 达成 | §1 归因表；迁移处均带「mx3 迁移/语义变化」注记 |

### §5 新增测试条款

| 条款 | 结论 |
|------|------|
| R1 入账强制三态 + exec-review 不收紧 | 绿（4 用例）+ probe r3 独立复证 |
| R2 fold 只认 reviewer（designer pass 直写不冻结 / 补 reviewer 冻结 / 无 role 历史形态） | 绿（3 用例）+ probe f 独立复证 |
| R3 §5.1 场景重演（被拒 exit 1 + 谎报入账 + 警告 + 循环继续） | 绿 + probe r3 独立复证（runner 最终 exit 143 优雅退出） |
| R4 历史兼容锚（reviewer 事件三态推进） | 绿 |
| G1 同代双 fail 不 deadlock | 绿 + probe g1 |
| G2 跨代双 fail deadlock（重提不清零） | 绿 + probe g2（escalation 含两代意见） |
| G3 三代计入 + 去重 | 绿 + probe g3（「已打回 3 代」恰 1 次） |
| G4 同 unit 一次 / 跨 unit 各一次 | 绿 + probe e（e1=1 e2=1 total=2） |
| S1 session 落盘含 toolCall + 命令原文 | 绿（真实 pi）+ 独立 probe-s1（自定义 marker `MX3VERIFY-77c9-echo` 逐字命中 JSONL；session 文件与 brief/stdout/stderr 同目录共存） |
| S2 命令行含 --session-dir/--name、不含 --no-session | 绿（buildPiCommand 锚 + u6c 迁移锚）；独立 probe 实际 spawn 的 session 落 artifactDir（session-dir 生效实证） |
| S3 多 spawn 不冲突 | 绿（两次真实 spawn，两文件并存） |

## 5. 行为对抗抽查记录（真实子进程 + tmp CW_HOME/worktree 隔离，零 mock）

| # | 场景 | 结果 |
|---|------|------|
| 1 | §5.1 重演：builder in-flight 期间无 role 提交 → exit 1（文案含恢复动作）；谎报 reviewer → 入账 + 警告 + 循环存活 | 全部符合（r3） |
| 2 | G1/G2 边界：同代双 fail（试探+正式）无 deadlock、specFixPending 派 designer；fail→重提→fail = deadlock「已打回 2 代」；第三代计入 | 全部符合（g） |
| 3 | 豁免窗口边界：在场提交零误报 / 结算后晚到提交告警恰 1 次 / 重启零重放 | 全部符合（w） |
| 4 | S1 深度：真实 pi 后 session JSONL 含 toolCall + 自定义命令原文逐字可查 | 符合（probe-s1） |
| 5 | fold 收紧回归：无 role pass 历史账本 → created + specReviewPending + 真实 runner 重派 reviewer；CLI 补 role=reviewer → frozen；designer role 同样不冻结 | 全部符合（f） |
| 6 | 入账拒绝纯拒绝：两次被拒提交账本行数零增长；正常 reviewer 按 brief 模板提交零影响 | 符合（r3 + w1） |
| 7 | escalation 去重 + 跨 unit：同 unit 同文案 1 次、两 unit 各 1 次 | 符合（e） |
| 8 | exec-review 不收紧（无 role 入账合法、payload 无 role 键） | 符合（r3） |
| 9 | specReviewPending 对非 reviewer verdict 的重派（f1）与 §5.5 flake 重印边界（见 §7-1） | 前者符合；后者记发现项 |

## 6. 红性验证（注入 → 红 → 字节级还原 → 复绿；只动 src/，未触碰 tests/）

| 组 | 注入 | 指定测试 | 红 | 还原 |
|----|------|---------|----|------|
| 1 | review-submit.ts 入账强制改 `false &&`（无 role 放行） | tests/mx3-role-gate.test.ts | **3 failed**（R1 两态 + R3） | cp 还原 + cmp 字节一致 |
| 2 | frontier.ts 代数计数还原为 fail 总数计数（删代内去重） | tests/mx3-generation-count.test.ts | **1 failed**（G1：同代双 fail 又 deadlock） | 同上 |
| 3 | fold.ts deriveStatus 去除 `verdict.role === "reviewer"` | tests/mx3-role-gate.test.ts | **2 failed**（R2 designer/无 role 两形态） | 同上 |
| 4 | pi.ts buildPiCommand 还原 `--no-session`（去 session-dir/name） | tests/mx3-generation-count.test.ts | **3 failed**（S2 参数 + S1/S3 真实 pi——session 文件确实不再落盘） | 同上 |

还原后四文件 sha256 与注入前逐一相同（`diff red-fingerprints-before/after` 为空）；`grep -rn RED-INJECT src/ tests/` 零残留；git status 足迹不变（41 项）；重 build 后 `npx vitest run tests/mx3-*.test.ts` 复绿 16/16。四组测试均具备真实抓缺陷能力（非恒真）。

## 7. 发现项（不构成 FAIL）

1. **[minor] §5.5 动机现象部分残留**：`src/runner/loop.ts:1226-1228` 注释声称「修复 M4 gate §5.5 消息重复打印」，但 flake escalation 消息文本内嵌 runId 列表与连挂数（loop.ts:861-863）——连挂 2→3 增长时文本必然变化，按 §4 锁定的「消息文本签名」语义会再次出声。verifier 实测（probe-flake）：2 连挂出声 1 次、第 3 次 fail 后累计 2 次——M4 gate §5.5 观察到的「按连挂数变化各打一次」双印形态在交付代码下**仍可复现**。与基线不冲突：§2 ②「同签名同轮不重复打印」与 §4 签名定义均被满足（同事实多轮零重印，G3/G4 锚定的 deadlock 路径完全去重）；但「修复 §5.5」表述过强，flake 增长形态的重印未消除。建议后续 unit：flake 出声改对齐 fx-2 one-shot 模式（escalated map），或消息不含增长事实。
2. **[minor] loop.ts:1262-1265 注释重复**：抢答检查段同一句「verdict 的入账 ts 取自原始事件流……同机同钟可比」连续出现两遍（纯注释冗余，无行为影响；eslint 不查注释冗余）。可随下次触碰该文件清理。
3. **[附注] T8 锚强度下降**：从「pi.ts diff 为空」（字节级）降为特征级（含 --session-dir 即过）——与 §3 显式解锁一致，模型链锚保留；实际改动经独立 diff 核查仅 session 参数行（详见 §3 裁决 4）。
4. **[附注] 指引 role 改动无显式条款**：`--role human` → `--role reviewer` 属 §2 入账强制 + §4「人扮演 reviewer」口径的逻辑必然（否则人工处置被入账层拒绝、死锁无出口），判合规（详见 §3 裁决 2）。

## 8. 总结论

**PASS。** 防篡改三查全过（基线文档 diff 空、领地零越界、迁移逐文件可归因）；§6 四组命令全绿（63 文件 466 用例，与自报一致；S 系真实 pi 执行非 skip）；§2/§5 条款逐条达成；四个披露/口径裁决点全部实测通过（豁免窗口语义等价、指引 role 自洽、T3 断言真实、T6/T8 迁移合理）；9 条对抗抽查全部符合；红性验证四组全红且字节级还原（测试无恒真）。2 项 minor（§5.5 flake 增长重印残留 + 注释冗余）不构成基线违约，建议列入后续 unit 候选。
