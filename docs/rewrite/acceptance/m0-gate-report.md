# M0 Gate 验收报告：A1 人肉全流程 + A3 补录攻击自证

> 执行日期：2026-08-15。执行方式：真实 CLI 子进程 + 真实 git 仓库 + 真实文件写入，
> 全程在 /tmp 临时项目与隔离 CW_HOME 下进行，未 mock 任何环节。
> 验收定义：`.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md` §4（A1/A3 行）。

## 总结论

**M0 gate PASS。**

- A1 人肉全流程通过：root unit 从 create 走到 closed，human runner 全程以指令驱动人工操作，
  自然退出（exit 0）并输出汇总行；账本事件链完整可读；`cw status` / `cw tree` / `cw report`
  均显示 closed 且证据链完整。
- A3 六条补录攻击路径全部被拒或留痕，无一条静默突破。

两条如实记录的语义边界（非突破，见 A3 各节「边界记录」）：

1. 改弱验收被重新审查放行后，旧的 pass VerifyRan 可覆盖弱 spec 的验收集合（集合包含判定），
   不强制重跑 verify——「非静默」防线本身生效（状态回退 + 强制新 verdict + 双 SpecSubmitted 留痕）。
2. 历史证据产物文件在绝对路径已知时可被 OS 层面改写（无文件系统沙箱），但无法影响任何一轮
   verify 的判定输入（时序隔离），且账本 reportHash 与产物现算 hash 不一致可审计发现篡改。

## 环境

| 项 | 值 |
|---|---|
| cw 构建 | 本仓库 `0061b26`（M0 complete）`npm run build` 产物 `dist/cli.js` |
| A1 场地 | `/tmp/cw-m0-gate-a1/proj`（git 仓库）+ `/tmp/cw-m0-gate-a1/cw-home`（CW_HOME） |
| A3 场地 | `/tmp/cw-m0-gate-a3/proj`（git 仓库）+ `/tmp/cw-m0-gate-a3/cw-home`（CW_HOME） |
| 隔离 | 所有 cw 调用经 `CW_HOME=<tmp>` 环境变量注入；结束后核查真实 `~/.cw` 无新增目录 |
| 清理 | 报告落盘后两个 tmp 目录已删除（本文所有路径引用为执行时快照） |

## A1 人肉全流程

### 设置

tmp git 项目（初始 commit：package.json + `src/index.js` 的 `greet()`）。任务：给项目加
`capitalize(str)` 纯函数。操作者（人）全程按 runner 打印的指令执行真实命令：写文件、调 CLI、
git commit。

### 时间线（UTC，账本 ts 与 runner 快照行交叉核对）

准备（runner 未起）：

| 时刻 | 动作 | 结果 |
|---|---|---|
| 11:20:17.695 | 写 `brief.md` + `cw create --id add-capitalize --brief brief.md` | `unit "add-capitalize" 已创建（根），seq 1` |
| 11:20:20 | 后台启动 `cw run --root add-capitalize --spawn human --poll-ms 500`（stdio 落盘 runner.log） | 循环启动行 + 每 500ms 一轮快照 |

循环内逐轮（runner 共 145 轮快照，总时长约 73s；五个状态段落的快照序列）：

| runner 指令（快照状态→待人工步骤） | 人动作 | 账本事件 / 结果 |
|---|---|---|
| created → spec（11:20:20.673 起，38 轮）指令组：读 brief → 写 spec.json（含字段骨架与规则提示）→ evidence submit --kind spec → review submit spec-review | 读 brief；写 spec.json：A1 core e2e-real（`node test/e2e-core.js`，脚本自写 `A1 PASS` 标记行）+ A2 unit（`node test/unit-capitalize.js`，脚本输出 vitest JSON 形状、用例名含 A2）；提交 spec | 11:20:38.997 `SpecSubmitted` seq 2，specHash `02a546b4…`（exit 0） |
| created → spec-review（11:20:39.244 起，8 轮）指令组：补 `cw review submit … spec-review --verdict pass` | 提交 spec-review pass（附 comment） | 11:20:43.254 `VerdictSubmitted` seq 3；runner 下一轮快照即 spec-frozen |
| spec-frozen → build（11:20:43.258 起，71 轮）指令组：实现并 git commit → evidence submit --kind build --commit <hash> --run-id <自拟> → cw verify | 写 `capitalize()` 实现 + `test/e2e-core.js` + `test/unit-capitalize.js`，git commit（`dc5568f`）；提交 build 证据；跑 verify | 11:21:13.435 `EvidenceSubmitted` seq 4（runId r1, commit dc5568f）；11:21:18.709 `VerifyRan` seq 5，result=pass（`A1 pass` / `A2 pass`，verify exit 0） |
| verified → exec-review（11:21:19.141 起，28 轮）指令组：`cw review submit … exec-review --verdict pass` | 提交 exec-review pass（--evidence-refs r1） | 11:21:33.198 `VerdictSubmitted` seq 6 |
| closed → 无（11:21:33.205，1 轮） | （无） | runner 打印汇总行后进程自然退出 |

### 断言结果（任务定义四项全过）

1. **runner 自然退出 exit 0、输出含汇总行**：后台进程于 11:21:33 退出；汇总行原文
   `[human] root "add-capitalize" 已 closed——human 循环结束（exit 0）。汇总（root 子树 1 个 unit）：` / `[human]   add-capitalize  closed  lastVerify:pass`。
   后台进程 exit code 无法直接回收，补前台重跑同一命令：立即打印同样汇总行，`exit=0`（同时验证了
   「账本即状态，重跑即续」的幂等语义）。
2. **`cw status` 显示 root closed**：`add-capitalize  closed  specs:1 evidences:1 lastVerify:pass`。
3. **`cw tree` 显示 root closed**：`add-capitalize (closed)`。
4. **events.log 完整事件链可读**：JSONL 六条，seq 1-6 严格递增、类型齐备——
   UnitCreated → SpecSubmitted（含完整 acceptance 数组与 specHash）→ VerdictSubmitted(spec-review pass)
   → EvidenceSubmitted(r1, commit dc5568f) → VerifyRan(pass, acceptanceIds=[A1,A2], reportHash)
   → VerdictSubmitted(exec-review pass, evidenceRefs=[r1])。`cw report --unit add-capitalize`
   投影出同样的证据链（spec hash、逐验收勾选、verify run 详情）。
   verify 产物落盘齐全：`evidence/add-capitalize/verify-a6e7a542…/` 下 `A1.stdout`（内容 `A1 PASS`）、
   `A2.report.json`（vitest 形状折叠报告）、总 `report.json`。

### 通过判定

**A1 PASS。** 指令清单含全部执行要素（每步给出可复制的命令与规则提示，含「你自任 reviewer——
这是信任边界」的显式声明）；spec gate 在提交时真实运行（schema + 五规则校验后才入账）；
verify 以干净 checkout 重跑双用例并通过后才推进 verified；closed 时证据链完整可 `cw report`
查阅。全程未跳步——runner 快照状态序列与账本事件一一对应。

## A3 补录攻击六路径

同一 tmp git 仓库（`/tmp/cw-m0-gate-a3/proj`，初始实现 `add()`）+ 独立账本。每个攻击一个独立
root unit，攻击者角色同时控制 operator 与 reviewer（human 模式声明的信任边界之内，测的是机器
gate 的下限）。

### 路径 1：不跑谎报——寻找「直接声明状态」命令

**攻击操作**：`cw --help` 扫描全命令面；逐一尝试状态自报类命令：`close` / `set-status` / `done` /
`mark-verified` / `resolve` / `verify --set-result pass` / `state --closed`。

**系统反应原文**：

```text
cw close --unit x => exit=1 | 未知命令: close --unit x
cw set-status --unit x --status verified => exit=1 | 未知命令: set-status --unit x --status verified
cw done --unit x => exit=1 | 未知命令: done --unit x
cw verify --set-result pass --unit x => exit=1 | 未知命令: verify --set-result pass --unit x
```

命令面清点（--help 与源码注册表 `src/handlers/index.ts` + `src/readonly/index.ts` 一致，共 9 个）：
写命令 4（create / evidence submit / review submit / verify）+ run（只读循环）+ 只读 4
（status / frontier / tree / report）。

**防线机制归因**：状态 = `deriveStatus(fold(events))` 纯投影（`src/core/fold.ts`），不存在任何
「写状态」通道。写命令只能 append 五类事件，且每类事件都锚定真实事实：EvidenceSubmitted 的
commit 经 `git cat-file -e '<commit>^{commit}'` 真实存在性校验；VerifyRan 只能由 verify 在干净
checkout 重跑后写入（fail 也如实入账）；VerdictSubmitted 只是审查意见，状态推进要求 verdict 与
证据链同时满足（closed = spec 过审 ∧ verify pass 覆盖全部验收 ∧ exec-review pass）。

**判定：被拒。** 无声明通道。

### 路径 2：echo ok 当验收命令

**攻击操作**：unit `echo-ok`，spec 的 A1（core, e2e-real）command 填 `echo ok`（rule③ 只查
首 token 可执行，`echo` 合法，spec 入账）；A2 用真 unit 脚本做对照。真实现 commit 后走 verify。

**系统反应原文**（verify）：

```text
A1 fail
A2 pass
verify unit "echo-ok" result=fail (pass=1 fail=1 manual=0)
cw verify: unit "echo-ok" 有 1 条验收失败：
  A1: 验收 A1 产物解析失败：e2e-sh 适配器 parse 失败：…/A1.stdout 无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）。脚本须输出 "^A<id> (PASS|FAIL)" 标记行（期望出现验收 A1 的标记）
verify-exit=1
```

（red-phase）：

```text
cw verify --red-phase: unit "echo-ok" 有 1 条验收无区分力（在父 commit 3f0736f… 上也通过 / 命令成功但产物无有效用例）：
  A1: … 无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）…
red-phase-exit=1
```

**防线机制归因**：双杀。e2e-sh 适配器 parse 侧拒绝「标记缺失 + exit 0」的产物（`src/testrun/e2e-sh.ts`，
无区分力假命令在 parse 层即抛错）；红阶段在父 commit 树上重跑，`judgeRedPhase` 判定
`parseError ∧ commandExit∈{null,0}` 为无区分力（`src/verify/red-phase.ts`）。同时 fail 的
VerifyRan 也入账（`cw status` 显示 `lastVerify:fail`、状态停在 spec-frozen），打回依据可审计。

**判定：被拒。** verify exit 1 + red-phase exit 1 双杀原文如上。

### 路径 3：sed 伪造输出（验收命令内注入）

**攻击操作**：unit `sed-inject`，A1（core, e2e-real）command 注入
`bash -c 'pwd; ls -a "$CW_HOME"; echo A1 PASS; sed -i "s/pass/TAMPERED/g" <真实 CW_HOME 绝对路径>/evidence/sed-inject/*/* 2>/dev/null; true'`
——同时携带隔离探针（pwd / ls CW_HOME）、真标记输出（echo A1 PASS）、对历史产物的绝对路径
sed 篡改。两轮 verify。

插曲（如实记录）：第一次提交的裸多语句形态 `pwd; ls …` 被 spec gate rule③ 当场拦截——
`rule③: A1 (e2e-real) command 首 token "pwd;" 在 PATH 不可解析`——改 `bash -c` 包裹后才入账
（这也顺带证明 rule③ 对 command 首 token 的真实校验）。另一次执行失败：GNU sed 语法
`sed -i 's/…/…/'` 在 macOS BSD sed 下报错（被 `2>/dev/null` 吞掉），改 BSD 语法
`sed -i "" 's/…/…/'` 后重试成功（unit `sed-inject2`）。

**系统反应原文**（round 1，A1.stdout 即命令视角的世界）：

```text
/private/var/folders/…/T/cw-verify-checkout-HepzWF/ws    ← pwd：一次性干净 checkout，非工作区
.
                                                          ← ls -a "$CW_HOME"：隔离的空 mkdtemp 目录
..
A1 PASS
```

round 2（round 1 产物已存在，sed 真实命中历史文件）：round 2 verify 自身 `A1 pass / A2 pass`
exit 0；round 1 的 `report.json` 被改为 `"status": "TAMPERED"`（历史文件确实可被绝对路径改写）；
但账本内 round 1 VerifyRan 的 reportHash `ce87bdf3…` ≠ 被篡改文件现算 hash `057f92f6…`
——篡改可审计发现。

**防线机制归因**：三重。
(1) 执行环境隔离：验收子进程 cwd = 一次性 clone 的干净 checkout（`src/verify/checkout.ts`，含
porcelain 干净性自证），`CW_HOME` 被替换为一次性 mkdtemp（`src/verify/run.ts` 纪律①）——命令经
环境变量/相对路径发现不了真实产物。
(2) 时序隔离：判定输入（本轮 `A1.stdout`）在命令进程退出后由 cw 管道 `writeFileSync` 写入
（`runOne`），命令运行时该文件不存在——攻击者无法改写「自己这一次」的判定输入。
(3) hash 审计：VerifyRan.reportHash 锚定 report.json，产物被事后篡改即与账本失配。

**边界记录**（按任务要求如实区分）：「伪造外部产物」不可能影响判定（上述三重）；但
「让脚本真输出 PASS」等同正常通过——本轮 echo A1 PASS 是命令真实输出，判定 pass 属正确行为，
这不是漏洞而是判定语义（验收通过的唯一定义就是标记行真实产生）。历史产物文件的 OS 级改写
技术上可行（无沙箱），其影响面仅限审计回放，且被 hash 链覆盖。

**判定：被拒。** 攻击未影响任何一轮判定结果；篡改痕迹可审计发现。

### 路径 4：提交假产物文件

**攻击操作**：unit `fake-artifact`，真实现 + 真 spec；手写假产物 `fake-fail.log`
（内容伪造为 `A1 FAIL` / `验收脚本崩溃（这是攻击者手写的假产物日志）` / `A2 FAIL`），
`cw evidence submit --kind build --commit <hash> --run-id atk4-r1 --file fake-fail.log`，随后 verify。

**系统反应原文**：

```text
unit "fake-artifact" 的 build 证据已入账（runId atk4-r1，产物 1 个，seq 21）。   ← 提交成功（仅记元数据）
A1 pass
A2 pass
verify unit "fake-artifact" result=pass (pass=2 fail=0 manual=0)               ← 判定与假文件内容相反
verify-exit=0
```

**防线机制归因**：`--file` 提交只记 paths + sha256 元数据（`src/handlers/evidence-submit.ts`），
判定完全出自 verify 的干净 checkout 重跑——假文件写 FAIL，真重跑 pass，结果与假文件内容相反。
反向（假文件写 PASS、实现真坏）由路径 2 的 fail 案例对偶覆盖：真跑挂了就是 fail，与任何手写
文件无关。

**判定：被拒。** 假文件入账不产生任何判定效力。

### 路径 5：spec 冻结后改弱验收

**攻击操作**：unit `fake-artifact` 已走到 verified（spec 含 A1 core e2e + A2 unit，verify pass
acceptanceIds=[A1,A2]）后，二次提交删除 A1 的弱 spec（仅剩 A2 unit；五规则形状上仍合规——
rule② 逐 core 条检查、无 core 即不触发，rule⑤ 有 unit 即满足）。

**系统反应原文**（关键状态变化）：

```text
== 提交前状态 ==            unit: fake-artifact / status: verified   （specs: 55e17f88928c acceptance=2）
== 二次提交弱 spec ==        unit "fake-artifact" 的 spec 已入账（specHash 4a70460413f2…，seq 23）
== 提交后状态 ==            unit: fake-artifact / status: created    （specs: 55e17f88928c + 4a70460413f2）
```

账本留痕（events.log 内该 unit 的 SpecSubmitted×2）：

```text
seq=19 specHash=55e17f88928c… acceptance=[('A1','e2e-real',True), ('A2','unit',False)]
seq=23 specHash=4a70460413f2… acceptance=[('A2','unit',False)]
```

旧 verify 记录（VerifyRan result=pass, acceptanceIds=[A1,A2], reportHash）原样留在账本，事件序
可辨其对应旧 spec。补一次 spec-review pass 后状态才回到 verified。

**防线机制归因**：`deriveStatus` 的 spec-frozen 判定要求「最后一条 spec 之后」存在 spec-review
pass（`verdictSeqs[i] > lastSpecSeq`）——重新提交 spec = 打回重审，旧 pass verdict 失效，状态
回退 created。不存在静默替换：新旧 spec 以各自 hash 并存于账本，任何读账本者（runner / status /
report）看到的都是弱 spec 待重审。

**边界记录（如实）**：重新过审后，verified 判定是集合包含式——旧 pass VerifyRan 的
acceptanceIds [A1,A2] ⊇ 弱 spec 的 [A2]，故不强制重跑 verify 即回 verified。这是设计内语义
（verify 覆盖判定按验收 id 集合），且攻击者的最小路径仍需一次新的 spec-review pass verdict：
「验收强不强」的守门人是 reviewer（canon 声明的信任边界，human 模式自任 reviewer），机器 gate
只锁形状与留痕。若 reviewer 被攻陷，系统如实记录谁在何时放行了什么（seq 23/24 双事件）——
可追责，不可抵赖。

**判定：被拒（无静默通过）。** 状态回退 + 强制重审 + 双 spec 留痕，与预期防线完全一致。

### 路径 6：verify 前篡改工作区代码

**攻击操作**：unit `tamper-ws`，完整 spec（A1 e2e + A2 unit）+ 真实现 commit，先跑基线 verify
（pass）。然后篡改工作区 `src/index.js`（`add` 直接 `return 99999`，不 commit），重跑 verify。

**系统反应原文**：

```text
== 工作区脏状态 ==            M src/index.js
== 直接跑验收命令（工作区）==   A1 FAIL    workspace-e2e-exit=1      ← 若 verify 用工作区必挂
== 篡改后 cw verify ==         A1 pass / A2 pass  result=pass (pass=2 fail=0)   tampered-verify-exit=0
== verify 后工作区 ==          M src/index.js（仍是篡改状态，未被采用也未被复原）
```

篡改后 verify 结果与基线逐字一致（pass=2 fail=0），产物 report 的 cases 与基线相同。

**防线机制归因**：verify 从账本 build 证据取 commit hash，`cleanCheckout` 在一次性 mkdtemp 里
`git clone + checkout <commit>`（detached HEAD）并以 `git status --porcelain` 自证树干净
（`src/verify/checkout.ts`），验收命令 cwd 即该 checkout——工作区未提交改动在物理上不在场。
路径 3 round 1 的 pwd 探针（`/…/cw-verify-checkout-HepzWF/ws`）提供了同一机制的直接观察。

**判定：被拒。** 工作区篡改对 verify 结果零影响；行为等价证明（篡改使验收必挂而 verify 仍 pass）
比逐文件比对更强。

## 六路径结果一览

| # | 攻击 | 结果 | 关键证据 |
|---|------|------|---------|
| 1 | 不跑谎报（找状态声明命令） | 被拒 | 命令面 9 个全清点，候选全部 `未知命令` exit 1；状态=事件投影 |
| 2 | echo ok 当验收 | 被拒（双杀） | verify exit 1「无区分力，疑似 echo ok 类假命令」+ red-phase exit 1 |
| 3 | sed 伪造输出 | 被拒 | cwd=一次性 checkout、CW_HOME=隔离 mkdtemp（探针实录）；判定输入命令退出后才写入；历史产物篡改被 reportHash 失配发现 |
| 4 | 提交假产物文件 | 被拒 | 假 FAIL 日志入账仅元数据，verify 干净重跑 pass（结果与假文件相反） |
| 5 | spec 冻结后改弱验收 | 被拒（无静默通过） | 状态 verified→created 回退；SpecSubmitted×2 双 hash 留痕；须新 spec-review 才推进 |
| 6 | verify 前篡改工作区 | 被拒 | 工作区跑验收 A1 FAIL 而 cw verify 仍 pass（与基线逐字一致）；checkout=clone 的干净 commit 树 |

## 结论

- **A1 通过**：root closed，human 模式全流程指令闭环（spec → spec-review → build → verify →
  exec-review → closed），证据链完整可查阅。
- **A3 通过**：六条路径全部被机器 gate 拒绝或强制留痕，无静默突破。
- **M0 gate：PASS**（A1 root closed + A3 六条全部被拒/留痕）。
- 两条语义边界（弱 spec 过审后可复用旧 verify 覆盖、历史产物 OS 级可改写但 hash 可审计）已如实
  记录于对应章节，建议后续里程碑（M1 reviewer 自动化 / verify 覆盖策略）复核是否收紧。
