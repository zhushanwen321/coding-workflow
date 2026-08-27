# cw 发布验证管线设计（gate/pipeline 域嫁接 cw 账本心）

> **当前层 → 下一层**：技术方案层（gate 域架构 + 事件代数 + 接口/数据模型/错误规格）→ 波次 unit 拆分层（§5 的 rp-0~rp-3）。不设计到函数签名。
> **口径前提（已定）**：① 产品边界 = **同仓同包、硬隔离双域**（2026-08-24 用户拍板三选一的裁决）；② 本文全部源码锚点基于 `feat-optimize-design-dev-test-flow` 重构版实态（npm workspaces 双包 / 六类事件含 ReflectionRan / 10 命令面含 setup-agent-dir / runner.lock 先例），实施起点假设 = 该分支先合入 main、本域在其上开发（合并策略是 §5 的待验证检查点，非本文裁决项）；③ 需求现场在 xyz-agent 仓发布管线（pr-cr-fix skill → merge skill），本文自包含复述痛点与事故，无需回读任何 handoff。

**一句话结论**：把「代码写完之后」的发布验证做成 cw 仓内第二个硬隔离命令域——gate 域有**独立的账本文件**（`gate-events.log`，不进 unit 域的 `events.log`）、**独立的事件封闭代数**（无 unitId 锚）、**独立的 fold**；两域仅共享泛化后的账本心（store 的锁/seq/fsync/信封骨架）。缓存键内容寻址 `(check, base, scope)` + 记账闭合（缓存命中仍产出完整 report）从 M0 第一天内建，正面对堵 xyz-agent 的 coverage-gate 假 pass 事故形态。

## 1. 背景目标

**SCQA**

- **S（情境）**：cw 2.0 是「编码期 agent 工作的 CI」——事件账本 + fold 投影 + spec gate + verify 三道 gate + runner 派发，用机器证据判定 unit「完成」。xyz-agent 仓有一套 AI agent 驱动的发布管线：pr-cr-fix skill（8 维 review + 修复 + 多道 gate）→ merge skill（阶段 0-7：pre-merge-check → 合并 → 版本 bump → npm 发布 → release notes → 交付物验证）。
- **C（冲突）**：发布管线的验证事实产生即蒸发——进度活在 agent 会话散文里，验证结果散落在三个互不相识的临时文件格式（`.review/premerge-result` key=value / `coverage.json` / `metrics.json` 两套 JSON schema）。每个阶段每次从零自证，且已发生过一次**稳定假 pass 事故**（coverage-gate 的 OK 路径不写 report，空报告被 `all(空)==True` 判 pass）。
- **Q（问题）**：怎么让发布验证获得与编码期同级的账本保障——内容寻址缓存消重复、状态机可断点续跑、CI 失败可判定——同时不污染 cw 编码期的封闭事件代数与单一职责？
- **A（答案）**：同仓同包硬隔离双域。本文展开这个答案。

**系统是什么**：cw（`@zhushanwen/coding-workflow`）是 append-only 事件账本驱动的验证工具，一个项目目录（cwd）对应一个独立账本（`$CW_HOME/<encoded-cwd>/`）。现状只有一个问题域——**unit 域**：agent 编码任务的分解、派发、验收。本文设计第二个问题域——**gate 域**：发布管线里确定性命令（typecheck/lint/coverage/测试）的执行、缓存与判定。gate 域的执行者是确定性命令，**无 agent 参与**（与 unit 域的本质差异）。

**关键概念**（首现定义，后文复用）：

- **check**：发布管线里一个确定性验证命令的命名身份（如 `typecheck`、`lint`、`coverage`）。就是 §3.1 例子里 `cw gate wrap --check typecheck` 的那个名字。
- **缓存键**：一次 check 结果的可复用性判据 = `(check, baseSha, scope)` 三元组 + 内容比对（见 D3）。base = 比对基线 ref（如 `origin/main`），**入账时解析为 sha（baseSha），键比较的是 sha**，ref 仅作审计展示——fetch 前移 base ref 即产生新 sha，旧键查不到条目（失效 by construction）；scope = check 的输入文件集声明（路径前缀列表，如 `["packages/foo/src", "packages/foo/tsconfig.json"]`）。
- **记账闭合**（closure invariant）：无论缓存命中还是真实执行，`wrap` 都向账本追加一条事件 **且** 产出一份完整 report 产物——「这次验证发生了、结果是什么」永远有账可查。这是防假 pass 的第一约束（§2.2 事故的直接对堵）。
- **命中（cache hit）**：账本中存在同键 pass 条目且 scope 内容未变 → 跳过执行；**未命中（miss）** → 真实执行。任何解析/校验异常一律向 miss 倒（宁重跑，不假 pass）。

**设计目标**（从使用者体验倒推——使用者 = xyz-agent 发布流程里的 agent 与人）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | 验证事实一等持久化 | 每个 check 的执行结果以缓存键入账，跨会话/跨 agent `cw gate query` 可查，带产物 sha256 可复算 |
| G2 | 增量跳过 | pr-cr-fix 跑过 typecheck 后，merge 阶段的 pre-merge-check 对同内容**不重跑**——命中跳过但仍拿到完整 report（记账闭合） |
| G3 | 断点续跑 | merge 阶段 0-7 进度在账本；换 agent/换会话后 `cw pipeline run` 从投影续接，已完成步骤不重做 |
| G4 | CI 失败可判定 | `cw ci-judge` 区分 flaky 与真回归：纯 flaky 自动 `gh run rerun --failed`，疑似真回归给出归属证据链 |
| G5 | cw 内核零污染 | unit 域六类事件代数、fold、10 命令面逐字节不变；unit 域旧账本重放语义不变 |
| G6 | 产物格式统一 | 发布期散落产物中的两类（premerge-result / coverage.json）的权威出口 = 账本事件 + gate-artifacts report，schema 单一；metrics.json 显式不承接（其生产/消费链路未调研，不假设计——待消费方定型后再评估） |

**in-scope**：store 泛化、gate 域账本与事件代数、`cw gate wrap/query`、pipeline manifest 与状态机（`cw pipeline run/status`）、ci-judge、stats 计时聚合、M0-M3 波次拆分。
**out-of-scope**：unit 域任何行为变更；xyz-agent 侧 skill 改造（其接入是消费方动作，本文只定义被消费的命令契约）；pi-cw-runner / harness 集成对 gate 域的感知（gate 域是确定性 CLI，不派 agent）；非 GitHub 的 CI 平台（ci-judge 先绑定 `gh` CLI）；npm publish 等发布动作本身（工具只验证与记账，不替人发布）。

## 2. 现状与问题分析

**发布验证的全部痛点同源于一个根因：验证事实没有一等的、内容寻址的、机器可判定的持久化。**

### 2.1 使用者视角的现状（真实例子，取自 xyz-agent 仓 pr-cr-fix/merge 两 skill 实态）

一次 xyz-agent 发布实际发生：

```
agent 会话 A（pr-cr-fix skill）：
  阶段 1.1  跑 typecheck + lint（Gate-1a）→ 结果写进会话散文
  阶段 1.6  coverage-gate.py 对每个改过 src 的包全量跑 vitest --coverage → coverage.json
  ...8 维 review、修复循环...
agent 会话 B（merge skill，可能换了 agent）：
  阶段 0-1  pre-merge-check.sh 又全量跑 typecheck + lint（不知道会话 A 刚跑过）
  阶段 2-7  合并 → bump → 发布 → notes → 验证
            进度记在会话散文/handoff 文档里；中断 = 下一个 agent 重建上下文
  CI 挂了   只能人工看日志猜 flaky 还是真回归，盲修或全量重跑
```

**真实失败模式**：

| # | 失败模式 | 触发场景 | 根因归属 |
|---|---------|---------|---------|
| F1 | 重复验证 | Gate-1a 与 pre-merge-check 各跑一遍 typecheck/lint，中间无任何代码改动 | 无「此内容已验过」的可信记录 |
| F2 | 无增量 | 某包本次没改，coverage-gate 仍对它全量跑 vitest --coverage | 无 scope 级内容寻址键 |
| F3 | 假 pass（已发生的事故） | coverage-gate OK 路径不写 report → 空报告被 `all(空)==True` 判 pass（xyz-agent 仓 coverage-gate.py 文件头 [HISTORICAL 2026-08-21] 注释为权威记录） | 「跑了」与「记账」分离——OK 路径可以静默不记账 |
| F4 | 无断点续跑 | merge 阶段 0-7 进度在会话/handoff 散文里，换 agent 接手靠重建上下文 | 进度不是机器状态 |
| F5 | CI 失败无判定 | flaky 与真回归不分；「改了被测代码没改测试」的真回归若只看测试文件 git log 会被误判 flaky，白耗两轮 CI | 无历史可比对 + 归属分析缺 import 闭包 |
| F6 | 格式三样互不相识 | premerge-result（key=value）/ coverage.json / metrics.json（两套 JSON） | 事实结晶了但没有统一的账 |

### 2.2 根因分析

**根因（单一）**：发布验证事实没有一等的、内容寻址的、机器可判定的持久化——验证结果产生即蒸发（会话散文）或半蒸发（三份格式互不相识、无锁无序号无防伪的临时文件）。F1/F2/F4/F5/F6 全是它的症状；F3 是它的最危险形态（「验证通过」这件事本身可以没有证据）。

这与 cw 1.x 当年的病同源（声明推进、验证可伪造、先干活后补录），只是发病时段在「代码写完之后」。**所以账本哲学（证据非声明、append-only、状态不存储只计算）天然适用；但 cw unit 域的具体机制不直接适用**（见 2.3）。

### 2.3 cw 侧现状：unit 模型为何不能承载缓存条目

**unit 域的事件代数封闭且 unit 锚焊死在每一层——「扩展一种非 unit 的账本条目」不是小改造，是打开封闭代数。**（重构版源码锚点）：

- `src/events/types.ts`：`EventType` 是六类封闭联合（UnitCreated/SpecSubmitted/VerdictSubmitted/EvidenceSubmitted/VerifyRan/ReflectionRan），每类 payload 都有 `unitId`；
- `src/store/events-log.ts`：信封形状校验 `envelopeShapeError` 硬要求 `type ∈ 六类` ∧ `payload.unitId` 为字符串——**域概念已焊进 store 层**（本设计 D2 要解的正是这个耦合）；`validateAppend` 孤儿拒绝（一切事件须先有 UnitCreated）+ EvidenceSubmitted 幂等键 = `unitId+runId`；
- `src/core/fold.ts`：输出是 `Map<unitId, projection>`，全部事件按 unit 分桶，判别联合 + `_exhaustive: never` 穷尽检查；
- 消费方全链以 unit 为主键：status/frontier/tree/report 四个只读命令、worktree 双空间命名（`cw-root/<rootId>` / `cw/<rootId>/<unitId>`）、topic 产物目录。

把缓存条目塞进 unit 模型 = category error：unit 是「新工作的分解 + agent 派发 + spec/review 环」，缓存条目是「确定性命令的内容寻址备忘」——前者有生命周期四态，后者没有任何状态机语义。

**重构版带来的三个新事实**（本文相对旧版分析的更新）：

1. **加法先例已立**：ReflectionRan 作为第六类事件以「纯记录、不驱动状态转换、旧账本无此事件 = 无反思」的口径加入（`src/events/types.ts` 注释 + fold 的纯 push 分支）——证明事件代数的演化纪律是「append-only 加法 + 缺省重放兼容」，本设计 gate 域代数沿用同一纪律；
2. **runner.lock 先例**（`src/runner/lock.ts`，ph-i1）：跨进程互斥用「runner 层小锁文件」而非账本事件（「锁是易失进程态不是事实，入账污染重放」）——gate 域的并发互斥直接沿用此哲学；
3. **D12 包边界原则**（design-harness-integration.md）：插件包只装「该 coding-agent 进程内跑的对接物」——gate 域是 cw 自己进程内的确定性 CLI，按此原则属于核心包新命令组，不构成新包（与已拍板的产品边界一致）。

### 2.4 物理数据流（现状 → 终态）

**现状**（验证事实蒸发路径）：

```
agent 会话执行 typecheck/coverage（真实执行）
  → 结果落三处互不相识的格式：.review/premerge-result（key=value）/ coverage.json / metrics.json
  → 下一阶段（另一会话/agent）读不到可信记录 → 从零重跑
  → 进度：会话散文 + handoff 文档（人读，机器不可判定）
```

**终态**（验证事实入账路径，本设计）：

```
agent/人执行 `cw gate wrap --check typecheck --base origin/main --scope ... -- pnpm typecheck`
  → wrap 唯一入口分流（§3.1 例子）：
     miss：真实执行 + 计时 → report 产物落 $CW_HOME/<proj>/gate-artifacts/<check>/<runId>/
     hit ：跳过执行，复用来源 report（标注 hit 来源）→ 同样落完整 report
  → 两路径同构追加 gate-events.log（GateCheckRan / GateCacheHit，含 reportRef + sha256）
  → fold（gate 域投影）→ cw gate query / cw pipeline status / stats（人与 agent 同权只读）
```

关键：**「执行」与「记账」在 wrap 单入口内物理绑定**——不存在「跑了但没记账」的路径（对堵 F3）；unit 域的 `events.log` 全程不出现（对堵 G5 污染）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**（对应 G1/G2，完整交互样例）：

```bash
# 场景：xyz-agent 发布流程，pr-cr-fix 阶段已验过 typecheck，merge 阶段再验
# —— 首跑（miss）：真实执行 + 记账
$ cw gate wrap --check typecheck --base origin/main --scope packages/ -- pnpm -r typecheck
[miss] typecheck @ 9f3c2a1 (base 5e77d0e)：执行 41.2s → pass
入账 GateCheckRan #17，report: gate-artifacts/typecheck/01JXXX/report.json

# —— merge 阶段同内容再跑（hit）：跳过执行，但记账闭合
$ cw gate wrap --check typecheck --base origin/main --scope packages/ -- pnpm -r typecheck
[hit] typecheck @ 9f3c2a1 (base 5e77d0e)：命中 #17（0.0s），report 已产出
入账 GateCacheHit #18（source=#17）

# —— 只读查询（CI 脚本/agent 消费）
$ cw gate query --check typecheck --base origin/main
hit: #18 @ 9f3c2a1（pass，source=#17，41.2s）report sha256: a1b2…

# —— 代码改动后（miss）：scope 内有变更，重跑
$ echo 改动 >> packages/foo/src/x.ts && git commit -m x
$ cw gate wrap --check typecheck --base origin/main --scope packages/ -- pnpm -r typecheck
[miss] typecheck @ 4d5e6f7：scope 内 1 文件变更（packages/foo/src/x.ts）→ 执行 → pass

# —— base 前移（合并上游后）：全体失效（by construction，键含 base）
$ cw gate query --check typecheck --base origin/main   # base 已变
miss: 无 (typecheck, <新base>, packages/) 的 pass 条目
```

**失败路径**（带恢复指引，准则 6）：

```bash
# F-1 账本损坏行（外部编辑等）
$ cw gate query --check typecheck --base origin/main
错误：gate-events.log 第 23 行不是合法事件信封（路径）：type="Foo" 不在 gate 域事件枚举内。
恢复动作：并发写已被文件锁串行化，损坏通常来自外部编辑；备份后检查该行，
从损坏行起截断恢复（截断前确认无并发写入者）。   # 与 unit 域同口径文案

# F-2 缓存条目产物被删/篡改（sha256 不符）
$ cw gate wrap --check typecheck ...
[warn] #17 的 report sha256 不符（产物损坏或篡改）→ 按 miss 重跑（宁 miss 不假 pass）
[miss] typecheck @ 9f3c2a1：执行 41.2s → pass

# F-3 base ref 不存在
$ cw gate wrap --check typecheck --base origin/nonexist -- ...
错误：base ref "origin/nonexist" 无法解析（git rev-parse 失败）。
恢复动作：先 git fetch 更新远端引用，或用 --base <已知 sha> 显式指定。

# F-4 check 执行失败（fail 也入账，审计留痕；fail 永不入缓存候选）
$ cw gate wrap --check lint --base origin/main --scope src/ -- pnpm lint
[miss] lint @ 9f3c2a1：执行 12.3s → FAIL（exit 1）
入账 GateCheckRan #19（result=fail）。修复后重跑同一命令即可；
query 只认 pass 条目，fail 不会被缓存复用。

# F-5 check 执行超时（环境错误，不入账——超时无完整产物可记）
$ cw gate wrap --check coverage --base origin/main --scope packages/ -- pnpm coverage
错误：coverage 执行超过 1800s 上限（--timeout-ms 缺省 30min）。
恢复动作：确认命令本身可跑通后调大重试：--timeout-ms 3600000；
若常态超时，应拆小 check 粒度而非无限放大超时。
```

**pipeline 形态（M2 终态预览，对应 G3）**：项目根声明 `.cw-pipeline.json`（manifest：步骤名/命令/缓存 scope/gate 阈值）；`cw pipeline run` 按序执行、每步入账、中断后同命令续接（对齐 `cw run` 的「run 即 resume」哲学——不设独立 resume 命令，见 D8）；`cw pipeline status` 输出步骤清单 ✓/✗/pending。

### 3.2 方案对比

产品边界（同仓同包）已拍板，此处对比的是**该边界内的技术形态**（+ 一个被边界排除的参照项）：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. 硬隔离双域**（本设计）：store 泛化注入域描述符；gate 域独立账本文件 `gate-events.log` + 独立事件封闭集 + 独立 fold | 高：unit 域封闭代数逐字节不动；gate 域演化不触及编码期语义；两域共享的只有「锁/seq/fsync/信封骨架」这层真正难写对的机制 | 中：store 泛化（KNOWN_EVENT_TYPES / 锚校验 / validateAppend 三处迁移约百行级 + 回归；domain 参数带缺省值使 9 处调用点零改动）+ gate 域新代码（事件/fold/wrap/query） | store 泛化触碰现有核心 → GP1 golden 重放门兜底；泛化失败有降级路径（复制私有副本，记债） | ✅ **推荐** |
| B. 混入 events.log 非 unit 条目（gate 条目与 unit 条目共账本的最直白形态） | 低：打开 unit 域封闭代数——envelopeShapeError 的 unitId 锚、validateAppend 的孤儿拒绝、fold 的 unit 分桶、四个只读命令、worktree/topic 命名，每层都要回答「非 unit 事件怎么办」，且**此后每个 unit 域新特性都要带这个问题** | 中低：不泛化 store，直接放宽各层校验 | 代数污染不可逆（账本 append-only，混入了就永远在）；G5 直接落空 | ❌ 若用 B，§3.1 的 `cw status` 输出要出现「gate 条目混在 unit 树里」的寄生形态，`cw tree` 要么显示假 unit 要么加过滤特例——两域互相解释对方的事件，审查面翻倍 |
| C. 不用账本，纯 JSON 缓存文件（`.gate-cache.json`） | 低：回到 §2.2 的根因——无 append-only、无 seq、无锁、记账闭合无强制点（「命中写不写 report」又变成调用方自觉），F3 事故形态原样保留 | 最低：一个读写 JSON 的模块 | 假 pass 防线靠纪律不靠结构；并发写损坏无防护 | ❌ 若用 C，§3.1 的 F-2 场景变成「缓存文件被改坏后静默命中假结果」——事故形态与 coverage-gate 同构 |
| D. 独立仓新工具（参照项，产品边界已排除） | 中：cw 定位绝对纯；但账本心造两遍（锁的 TOCTOU/stale/空窗口语义是真正难写对的部分） | 高：双份 release/CI 基建 + 双份账本维护 | 两套账本实现行为漂移 | ❌（2026-08-24 用户拍板排除，记档） |

**推荐 A 的核心理由**：两域真正该共享的只有账本心机制（435 行里最难写对的锁与 fsync 语义），而真正不该共享的是事件代数与 fold 语义（unit 有生命周期，cache 条目没有）。A 恰好沿这条缝切：共享机制层，隔离语义层。

### 3.3 关键决策与权衡

**D1：gate 域独立账本文件 `gate-events.log`（选定）**
- **采用**：gate 域事件写 `$CW_HOME/<encoded-cwd>/gate-events.log`（与 unit 域 `events.log` 同目录、不同文件）；产物落 `gate-artifacts/<check>/<runId>/`。两账本各自有锁、各自 seq 空间、各自 fold。跨域无顺序需求（M0-M3 无跨域事务），物理分离最简。
- **被否**：混入 `events.log`（方案 B，见 §3.2）；单文件双前缀命名空间（如 type 加 `Gate/` 前缀混写）——仍要动 unit 域信封校验与 fold 的穷尽分支（`_exhaustive: never` 会对未知 type 抛错，折叠语义被牵连）。
- **证据**：unit 锚焊死层次清单（§2.3）；fold 未知事件抛错行为（`src/core/fold.ts` default 分支）；CW_HOME 项目目录隔离现成（CONTEXT.md 数据布局）。
- **效果**：G5 成立（unit 域零改动）；G1 落地有独立载体。

**D2：store 泛化为领域无关核心——域描述符注入（选定）**
- **采用**：`EventLedger` 构造签名从 `(ledgerPath)` 扩为 `(ledgerPath, domain?: LedgerDomain)`——**domain 带缺省值 = unit 域描述符**，存量 9 处 `new EventLedger` 调用点（`src/handlers/common.ts`、`src/runner/loop.ts` ×5、`src/readonly/frontier.ts`、`src/readonly/load.ts`、`src/runner/spawn/human.ts`）零改动，泛化 diff 收敛在 store 内部 + 新描述符文件。`LedgerDomain` = ① `knownEventTypes: ReadonlySet<string>`（信封校验的封闭集）；② 锚字段提取器（unit 域 = `payload.unitId`，gate 域 = 各 payload 的域内锚：`check` / `step` / `pipeline`）+ 锚字段名（错误文案用）；③ `validateAppend(type, payload, prior)` 域级不变式（unit 域 = 孤儿拒绝 + UnitCreated 唯一 + EvidenceSubmitted `unitId+runId` 幂等；gate 域 = GateCheckRan `check+runId` 幂等，**无孤儿概念**）。unit 域现有行为原样搬迁为其描述符，信封骨架（seq/ts/type/payload 形状）留在 store。锁/fsync/损坏行报错逐字不动。
- **被否**：gate 域复制一份 store 私有副本——双份锁语义实现 = 两套账本实现随时间漂移的双倍攻击面，且锁的 TOCTOU/stale/空窗口三处微妙语义漂移风险随时间发散（降级路径保留此项，见 GP1）；动态插件式注册（运行时扫描域）——无需求，减法。
- **证据**：域耦合点实存（`src/store/events-log.ts` 的 `KNOWN_EVENT_TYPES` 六类硬编码 + `envelopeShapeError` 的 unitId 硬编码 + `validateAppend` 三条 unit 规则）；泛化是「把硬编码改为构造参数」的纯重构，行为保持由 GP1 golden 重放背书。
- **效果**：G5 的另一半（共享层行为不变有机器证据）；后续第三域出现时 store 零改动（拆分条款见 §5 记档）。

**D3：缓存键 = `(check, base, scope)` + 最新 pass 条目的 scope 内容比对（选定）**
- **采用**：**入账规范**：`--base` 接受 ref（如 `origin/main`），wrap/query 解析为 sha 后以 `baseSha` 入账与比较（ref 字符串只作审计展示——fetch 前移 ref 即产生新 sha，旧条目自然查不到，「base 变即全体失效」by construction 成立）。**命中规则**：取账本中 `(check, baseSha, scope)` 相同、`result=pass`、`headSha` 最新的 GateCheckRan（记其 head 为 H'）；`git diff --name-only H'..<当前HEAD> -- <scope...>` 为空 → **命中**（scope 内容自那次 pass 以来未变，重跑必得同结果）。同一 commit 重复验证是 H'=HEAD 的退化形态（diff 恒空）——F1 与 F2 由同一条规则覆盖。**fail 不缓存**（fail 入账仅审计，永不作命中候选）。**命中附带校验**：来源条目的 report 产物 sha256 复算不符 → 当 miss 处理（F-2 路径）。**base 维度的必要性论证**（对抗审查修订）：可复用性看似已由 diff 判定完整覆盖（base 前移而 scope 未变时，diff H'..HEAD 仍为空）——但 base 前移（merge 上游）恰是 scope 外世界整体变化的时刻，也是 scope 声明不完备（诚实边界见下）最可能暴露的时刻；保留 base 维度 = 用「merge 上游后全量重跑一次」的有界成本，对冲「声明不完备在最危险时刻释放假 pass」的无界风险。防假 pass 是第一约束，选保守。
- **被否**：键直接含 headSha、只允许同 commit 命中——只消 F1 不消 F2（head 前进但 scope 未变的增量场景永远 miss）；从键中移除 base 维度（纯 diff 判定）——误伤 G2 主场景的对称面见采用栏必要性论证；mtime/内容 hash 自建文件指纹——git 已是内容寻址真相源，自建指纹是第二事实源。
- **证据**：探针 GP2 ✅ 已实测（2026-08-24，`git diff --name-only` 七连测：无改动为空 / scope 外改动不影响 scope 内结果 / scope 内改动非空 / rename 非空向 miss 倒 / 多 scope 并列 / 单文件 scope / 无前缀斜杠仍按目录前缀匹配）。**诚实边界**：scope 是调用方声明的「check 输入集」——若声明漏了真实输入（如 typecheck 漏声明根 tsconfig/lockfile），scope 外改动可能造成假命中。**防线 = 声明纪律（manifest/wrap 时 scope 必须含全部输入）+ 默认保守（scope 缺省 = 仓根，默认无增量）**；机器无法静态证明 scope 完备性，这是显式承认的边界而非遗漏。**环境维度同此边界**：node 版本/工具链/机器差异不是文件，任何 scope 都覆盖不到——跨环境（如本地 → CI）复用同键条目可能假命中；主场景是同一环境链内复用（本地 pr-cr-fix → 本地 merge），跨环境复用由调用方自判（缓存键暂不加 environment 维度——减法，出现真实跨环境需求再评）。
- **效果**：G1/G2 的核心机制；F3 的「命中校验失败向 miss 倒」方向保证假 pass 结构性偏向安全侧。

**D4：记账闭合为结构不变式——wrap 是 check 结果的唯一产生入口（选定）**
- **采用**：`cw gate wrap` 的两条终态路径（miss 执行 / hit 复用）**同构产出**：追加一条账本事件（GateCheckRan / GateCacheHit）+ 落盘一份完整 report（hit 路径 = 来源 report 复制 + `source` 标注字段，消费方不可区分「这次跑没跑」也无需区分）。闭合的机器锚点 = **固定先后序**：锁外先落产物并算 sha256（产物写失败则 wrap 整体 exit 2、事件不入账），锁内再追加事件。中途崩溃的最坏形态 = 无害孤儿产物文件（无事件引用，query 不可见）；「入账了但 report 缺失」只可能来自外部删改，由命中路径的 sha256 复算兜底向 miss 倒。store 的 append 锁事务体无外部挂点（`src/store/events-log.ts`），本设计不为其加锁内扩展点——固定序已达方向性安全。
- **被否**：命中路径只返回内存态不产出 report——§2.2 F3 事故形态（OK 路径不记账 → 空集判 pass）的直接复活；report 产出交给调用方脚本——又把闭合不变式还给纪律。
- **证据**：F3 事故权威记录（xyz-agent coverage-gate.py 文件头 [HISTORICAL] 注释）；unit 域同哲学先例（「没有声明状态的命令，只有交证据的命令」——本域翻译为「没有裸跑的 check，只有 wrap 的 check」）。
- **效果**：G2 成立的前提（跳过执行但证据链完整）；G6 的格式统一有了强制点（report schema 单一出处 = wrap）。

**D5：gate 域事件代数 = 三类封闭集（选定；schema 草案）**
- **采用**（gate-events.log 的封闭事件集，沿用 ReflectionRan 的加法纪律——未来增补只许 append-only 加法 + 缺省重放兼容）：

  | 事件 | 载荷要点 | 波次 |
  |------|---------|------|
  | `GateCheckRan` | check（锚）、baseSha（缓存键维度）、baseRef（审计展示）、scope[]、headSha、command、runId（幂等键，传入契约见 D8）、result(pass/fail)、exitCode、durationMs、reportRef、reportSha256 | M0 |
  | `GateCacheHit` | check（锚）、baseSha、baseRef、scope[]、headSha、sourceRunId（命中来源，审计链）、reportRef、reportSha256 | M0 |
  | `PipelineStepRan` | pipeline（锚）、manifestSha256（定义漂移检测）、step、headSha、runId、result(pass/fail)、viaCache?、durationMs、reportRef?、reportSha256? | M2 |

  fold（gate 域投影）= 按 check 聚合最新 pass 条目（query/hit 判定输入）+ 按 pipeline 聚合步骤最新结果（status 输入）+ durationMs 求和分组（stats 输入）。投影纯函数、无声明状态，与 unit 域同哲学。
- **被否**：每类 check 独立事件类型（TypecheckRan/LintRan…）——check 名是数据不是类型，类型爆炸且 fold 无法通用；缓存命中不单独设事件（复用 GateCheckRan 加 `cached: true` 字段）——两类事件的产生路径与语义不同（执行 vs 复用），混在一类里让「runId 幂等」与「sourceRunId 审计链」互相挤占字段语义，独立类型更诚实。
- **证据**：加法先例 ReflectionRan（`src/events/types.ts`，纯记录不驱动转换、旧账本兼容口径）；幂等键先例 EvidenceSubmitted.runId。
- **效果**：G1/G3/G6 的数据模型地基；ci-judge（M3）若需入账判定结果，按同纪律增补第四类（M3 设计定稿时定，本文不预留空类型——减法）。

**D6：pipeline manifest = 项目侧 `.cw-pipeline.json`（M2，schema 定稿在 rp-2 波次）**
- **采用**：项目仓库根声明 JSON（不用 YAML——仓内零 YAML 先例，一致性）：`{ version, steps: [{ name, command, cache?: { scope: string[] }, timeoutMs? }] }`；`pipeline run --base <ref>` 按序执行：带 cache 声明的步骤内部走 gate 缓存判定（命中即跳过执行但 PipelineStepRan 照记 `viaCache: true`）；步骤 fail 即停，重跑同命令从投影续接（已 pass 步骤不重做）。manifestSha256 入每条步骤事件，且 fold 按 `(pipeline, manifestSha256, step)` 分组取最新——manifest 改了即新分组，旧步骤记录自然不参与投影（内容寻址，与缓存键同哲学）。
- **被否**：manifest 进账本由 cw 托管——项目流程定义是项目资产（应随项目仓版本化），cw 只管执行与记账；manifest 用 TypeScript/JS 可编程配置——无需求（步骤是声明式清单），引入可执行配置 = 引入注入面。
- **证据**：run 即 resume 哲学（unit 域「Ctrl-C 后重跑 cw run 从投影续接」同语义平移）；JSON 先例（仓内 package.json/tsconfig，零 YAML）。
- **效果**：G3 落地；F4（进度散文化）根除。

**D7：ci-judge = 归属分析含 import 闭包的 flaky 决策树（M3，概念定型、细化在 rp-3）**
- **采用**：输入 = 失败 CI run（`gh run view` 拉日志）+ 本 PR 变更集。归属判定：失败测试文件 **+ 其 import 闭包**（被测模块/共享 fixture/config——只看测试文件 git log 会把「改了被测代码没改测试」的真回归误判 flaky）在本 PR 范围是否被触碰。决策树：未触碰 ∧ 上轮 pass → 纯 flaky → `gh run rerun --failed`（自动一次）；同一测试两轮 flaky → 升级确定性处理（出声转人工，不自动豁免——防 Goodhart，与 unit 域 flakeReview 同哲学）；触碰 → 真回归，输出归属证据链（哪个文件哪个 commit）。
- **被否**：纯重试无归属分析（盲 rerun 会把真回归拖成无限重试）；flaky 自动打标豁免（同 rv-5 哲学：随机性判定是语义判断，机器不自动豁免）。
- **证据**：CI 判定痛点（§2.1 F5）；unit 域 flake 连挂转人工先例（`src/readonly/frontier.ts` flakeReviewFacts）。
- **效果**：G4 落地（M3）。**待验证**：import 闭包分析的实现成本（TS 项目依赖图）——GP4 探针门，失败降级 = 归属只看「测试文件 + 手工声明的关联文件」（manifest 级声明），判定准确率降级但决策树不变。

**D8：命令面 = `cw gate wrap/query` + `cw pipeline run/status`（M3 加 `ci-judge`、`gate stats`；run 即 resume）（选定）**
- **采用**：写命令 `cw gate wrap --check <名> --base <ref> --scope <路径>... [--run-id <id>] [--timeout-ms <n>] -- <命令>`（exit 0 = pass 含命中 / 1 = check fail / 2 = 环境错误含超时，对齐 `cw verify` 三态）。**runId 契约**（对抗审查修订——幂等键必须有输入通道，对照 unit 域 `--run-id` flag 先例）：`--run-id` 显式传入时 `check+runId` 幂等（脚本化调用方重试同一提交防重复记账）；缺省 = wrap 自动生成（ulid），幂等规则不触发但产物寻址照常。`--timeout-ms` 缺省 30min，超时 = 环境错误 exit 2 不入账（超时无完整产物可记），stderr 指引调大（F-5 形态）；只读 `cw gate query --check <名> --base <ref> [--json]`；跑 `cw pipeline run [--manifest <路径>] --base <ref>`（中断后同命令续接）；只读 `cw pipeline status [--json]`；M3 加 `cw ci-judge <run-id>` 与 `cw gate stats`（计时聚合，账本 ts/durationMs fold 直出）。命令注册走 handlers 表现有机制（`src/handlers/index.ts` CommandEntry[]，setup-agent-dir 同缝）。
- **被否**：独立 resume 命令——cw 哲学「run 即续接」（账本投影自然跳过已完成步骤），多一个命令多一套语义；gate 子命令挂到独立 bin（如 `cw-gate`）——同包双 bin 无收益（产品边界内是一个工具组），且命令面分裂。
- **证据**：handlers 注册表现状（重构版 10 命令面的注册机制）；verify 三态 exit 先例（`src/handlers/verify.ts`）。
- **效果**：G1-G4 的用户触点；cw 命令面 M0-M2 从 10 扩为 14，M3 再加 2 至 16（文档同步项见 §5）。

**D9：并发互斥沿用 runner.lock 哲学，M0 不建新锁（选定）**
- **采用**：gate 域写并发 = 多个 wrap 进程同时追加 gate-events.log——由 store 既有文件锁短事务串行化（逐条追加天然安全），**不需要**域级互斥锁。pipeline run 的「同时刻单实例」诉求留 M2：若真实出现并发 run 需求，按 runner.lock 先例加 pipeline 层小锁（易失进程态文件锁，不入账），本波不建（减法）。
- **被否**：M0  preemptively 建 pipeline 锁——M0 没有 pipeline 概念，锁无挂载对象。
- **证据**：store 锁的跨进程语义（`src/store/events-log.ts` acquireLock，O_EXCL + stale 检测 + 有界重试）；runner.lock 先例（`src/runner/lock.ts`，ph-i1）。
- **效果**：M0 范围收窄；并发正确性零新机制。

**D10：M0 收窄 = wrap + query + 记账闭合，首个接入点 = xyz-agent pre-merge-check 的 typecheck/lint（选定）**
- **采用**：M0 只交付 D1/D2/D3/D4/D5（前两类事件）/D8（gate 两命令）/D9，在 cw 仓与临时真实 git 仓自证机制（验收 A1a）；xyz-agent 现场接入（pre-merge-check 调 wrap 替代裸跑 typecheck/lint）是 rp-1 的事（验收 A1b），接入当天消掉 F1。manifest/pipeline（D6）、ci-judge（D7）、stats 留给后续波次。
- **被否**：M0 连 pipeline 一起做——未验证的缓存键语义与未验证的状态机一起上，翻车时归因不清（成本与改动面成正比，同 M5 G1 哲学）。
- **证据**：痛点分层（§2.1：F1/F2 是缓存问题 → M0/M1，F4 是状态机问题 → M2，F5 是判定问题 → M3）；xyz-agent 侧归属裁决（需求侧已定：coverage 缓存 / premerge marker / CI 决策树三件由本扩展承接）。
- **效果**：M0 机制可独立验收（§4 A1a/A2/A3/A6）；xyz-agent 现场收益在 rp-1 兑现（A1b）。

### 3.4 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|----|-----------|------|------|-----------------|
| GP1 | store 泛化后 unit 域行为逐字节不变 | 存量账本 golden 重放 + 既有测试全绿 + 泛化前后同账本四只读命令输出 diff。**数据源仓内化**（rp-0 开工第一步）：用当前版 cw 在临时项目跑一段真实流程产出账本快照入 `tests/fixtures/golden-ledgers/` 入 git——历史 M4 gate 账本曾在 `.xyz-harness/`（gitignore 目录）已丢失，仓内化是防再丢的持久形态 | ⛔ rp-0 首门 | 泛化伤及旧语义 → 放弃共享，gate 域复制 store 私有副本（记债：双份锁实现，第三域出现时强制抽包） |
| GP2 | `git diff --name-only H'..HEAD -- scope` 的缓存判定语义（空=未变） | 七连测：无改动/scope 外改动/scope 内改动/rename/多 scope/单文件 scope/目录前缀匹配 | ✅ 2026-08-24 实测全过（脚本与输出归档仓内 `docs/rewrite/probes/gp2-git-diff-scope.{sh,out}`，可复跑；rename 非空向 miss 倒、目录无前缀斜杠仍匹配） | —（已过） |
| GP3 | 并发 wrap 的账本安全 | 两进程并发 wrap 同 check 不同 runId × 50 轮，断言账目无交错无丢行 + runId 幂等拒绝 | ⛔ rp-0 | 失败 → 先修 store 锁（unit 域同样受害，属存量 bug 非本域引入） |
| GP4 | TS import 闭包分析可行性与成本（ci-judge 归属前提） | 对 xyz-agent 仓真实跑一次依赖图构建，评估耗时与覆盖率 | ⛔ rp-3 首门 | 失败 → 归属降级为「测试文件 + manifest 手工声明关联文件」，决策树不变 |
| GP5 | 命中路径 report 与执行路径 report 结构同构（消费方不可区分） | 同一 check 连跑两次（miss→hit），diff 两份 report 除 source/duration 字段外逐字节一致 | ⛔ rp-0 | 失败 → 消费方契约改为显式区分两类 report（记账闭合弱化，需重审 D4） |
| GP6 | base ref 前移后旧条目全体 miss（键比较 sha 而非 ref 字符串；by construction 之外无泄漏路径） | 造 base 前移场景（模拟 fetch 后 origin/main 移动），wrap/query 以新 resolved baseSha 对全部已入账 check 断言 miss | ⛔ rp-0 | 失败 → 说明键推导有旁路，停下来重审 D3（不设降级，这是安全关键断言） |

## 4. 验收（真实场景，非单测）

改动规模：大（新命令域 + store 泛化）。以下场景全部用真实 git 仓库 + 真实账本 + 真实命令执行；xyz-agent 仓为真实接入现场。单测仅作回归辅助（探针的机器锁），不计入验收。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| A1a（G1/G2，rp-0 机制自证） | 临时真实 git 仓（或 cw 仓自身）全链：miss → hit → query → 失效 | 构造含真实可执行 check 的 git 仓（如 tsc --noEmit 小 fixture）：① 提交改动后 wrap → miss 执行 pass；② 同 HEAD 再 wrap → hit；③ query 查；④ 改 scope 外文件 → 仍 hit；⑤ 改 scope 内文件 → miss | ① 首跑真实执行且耗时 >0，GateCheckRan 入账含 report sha256；② 二跑耗时 ≈0 且仍产出完整 report（GateCacheHit 入账，sourceRunId 指向首跑）；③ query 输出 hit 与证据指针；④⑤ 失效方向正确（A3 前置形态） |
| A1b（G1/G2，rp-1 现场接入） | xyz-agent 仓真实接入 typecheck/lint 双 check：「pr-cr-fix 已验 → merge 再验」全流程 | 在 xyz-agent 仓：pr-cr-fix 阶段 wrap 两 check → merge 阶段 pre-merge-check 改调 wrap | merge 阶段对同内容零真实重跑（全 hit）但 report 链完整；query 输出可供 merge skill 消费 |
| A2（G2 闭合，负面——对堵 F3 事故形态） | 「跑了但没记账」路径结构性不存在 | 两个可断言实验：① 产物目录人为制造写失败（只读目录）→ wrap exit 2 且账本无新事件（`cw gate query` 查不到）；② 已入账条目的 report 文件人为删除 → query/wrap 对该条目 sha256 校验失败、向 miss 倒（F-2 路径） | ① 无「执行了但账本无事件」形态；② 无「入账了但 report 缺失仍命中」形态 |
| A3（G2 失效正确性，负面） | base 前移与 scope 变更两条失效路径 | ① 模拟 merge 上游（base 变）→ 全部已 pass check 跑 query；② 只改 scope 外文件（如 docs/）→ wrap；③ 改 scope 内文件 → wrap | ① 全 miss（GP6）；② hit（不重跑）；③ miss 且重跑真实执行 |
| A4（G3，M2） | pipeline 断点续跑 | xyz-agent 仓声明真实 `.cw-pipeline.json`（对齐 merge 阶段 0-7 的验证类步骤），`cw pipeline run` 跑到第 3 步 Ctrl-C → 另开会话重跑同命令 | 已 pass 步骤不重做（投影续接）；中断步骤重跑；全程 `cw pipeline status` 正确显示 ✓/✗/pending |
| A5（G4，M3） | ci-judge 真实判定 | 取 xyz-agent 仓一次真实 CI 失败（或构造：本 PR 改被测模块后跑挂的测试）跑 `cw ci-judge` | 真回归形态：输出归属证据链（被测文件 + commit）；flaky 形态（未触碰 + 上轮 pass）：执行 `gh run rerun --failed` 且只执行一次；两轮 flaky 升级出声 |
| A6（G5，负面——unit 域零污染） | unit 域回归 | 既有测试全绿 + 存量账本（fixtures + M4 gate 96 事件）在新代码四只读命令重放 | 输出与泛化前逐字节一致（GP1 的端到端形态）；gate-events.log 的存在不影响 unit 域任何命令 |
| A7（G6，rp-1 起渐进） | 产物格式统一 | xyz-agent premerge/coverage 两产物改由 wrap report 承载后，merge skill 消费方改读 `cw gate query --json` | 消费方不再读 `.review/premerge-result` 与散置 JSON；report schema 单一出处（wrap 实现） |
| A8（G1 计时，rp-3） | stats 聚合正确性 | 在 xyz-agent 仓真实账本跑 `cw gate stats`，手算账本事件的 durationMs 分组和 | stats 输出数字与手算一致；空账本输出结构化空形态而非报错 |

## 5. 下一层拆分

实施路径（四波，依赖序）：**rp-0 地基+M0 → rp-1 真实接入 → rp-2 pipeline → rp-3 ci-judge+stats**。每波独立可验收、可回滚——回滚按波分型：rp-1/2/3 是纯加法（摘除命令注册 + 删 gate/pipeline 目录即可）；rp-0 含 store 泛化，其回滚 = revert 泛化 commit（D2 的 domain 缺省值设计使 9 处调用点零改动，revert 面收敛在 store 内部与新文件）。

| unit | 内容 | justification（为什么这么拆） | 验收锚 |
|------|------|------------------------------|--------|
| rp-0 | store 泛化（D2：LedgerDomain 注入 + unit 域特化原样搬迁 + 缺省值）+ gate 域骨架（D1 账本文件/产物目录、D5 前两类事件、fold）+ `cw gate wrap/query`（D3 命中规则、D4 记账闭合、D8 三态 exit）+ 探针门 GP1（含 golden 账本仓内化第一步）/GP3/GP5/GP6 | 缓存键语义与记账闭合是本域全部价值的根，必须与后续形态隔离验证；store 泛化是唯一触碰现有代码的部分，单独成波可回滚 | A1a/A2/A3/A6，GP1-3/5/6 |
| rp-1 | xyz-agent 真实接入（M1）：pre-merge-check 的 typecheck/lint 换 wrap 承载 + coverage-gate 按包 scope 缓存改造（消费方适配） | 消费方接入是真实场景验收的主体，与 rp-0 的机器验收分离（先在 cw 仓自证（rp-0），再去 xyz-agent 实战）；按包 scope 是 D3 的多 scope 形态实战 | A1b、A7 |
| rp-2 | pipeline 域（M2）：`.cw-pipeline.json` manifest schema（D6）+ PipelineStepRan 事件 + `cw pipeline run/status` + 步骤级 viaCache | 状态机依赖缓存判定稳定后再叠加（避免两级新机制同时翻车）；manifest schema 需要 rp-1 的真实步骤清单作输入 | A4 |
| rp-3 | ci-judge（D7，含 GP4 门）+ `cw gate stats`（durationMs fold 聚合报告） | ci-judge 是独立判定器，与前两波无机制耦合；stats 是纯只读聚合放最后 | A5、A8 |

**文件改动地图**（锚点均为重构版路径）：

- **改（触碰现有代码，仅 rp-0）**：`src/store/events-log.ts`（泛化为域描述符注入；锁/fsync/损坏行报错逐字不动；`domain` 参数带 unit 域缺省值——存量 9 处 `new EventLedger` 调用点（`src/handlers/common.ts`、`src/runner/loop.ts` ×5、`src/readonly/frontier.ts`、`src/readonly/load.ts`、`src/runner/spawn/human.ts`）零改动）；`src/events/`或`src/store/`新增 unit 域描述符文件（KNOWN_EVENT_TYPES/unitId 锚/orphan+幂等规则的上移落点）；`src/cli.ts` 帮助文本 + `src/dispatch.ts` 命令表 + `src/handlers/index.ts` 注册（gate/pipeline 命令组，setup-agent-dir 同缝）。
- **新（gate 域全部为新文件）**：`src/gate/`（types.ts 事件代数 / domain.ts 描述符 / fold.ts 投影 / wrap.ts / query.ts / artifacts.ts）；rp-2 加 `src/pipeline/`（manifest.ts / run.ts）；rp-3 加 `src/gate/ci-judge.ts` / `stats.ts`。
- **文档同步（rp-0 起逐波）**：CONTEXT.md（gate 域词条 + 命令面速查扩容 + 数据布局补 gate-events.log/gate-artifacts）、AGENTS.md（「10 命令面」口径更新 + 核心约定补双域段）、README.md（定位段补「发布期 CI」一句）。
- **不改（显式声明）**：unit 域 `src/events/types.ts` 六类代数、`src/core/fold.ts`、`src/readonly/`、`src/runner/`、`src/verify/`、`src/testrun/`、`src/gates/` 全部零改动；`pi-coding-workflow-extension/` 零改动（gate 域不进 agent 进程）。

**待验证检查点（诚实标注）**：
1. **分支前提**：本文假设 `feat-optimize-design-dev-test-flow` 先合入 main，rp-0 在其上开发；若并行开发，rp-0 与该分支的 merge 冲突面集中在 `src/store/events-log.ts`（该分支已小改 KNOWN_EVENT_TYPES）——开工前需确认合并策略（用户裁决项）。
2. **scope 完备性靠声明纪律**（D3 诚实边界）：rp-1 接入 xyz-agent 时需逐 check 审 scope 声明是否含全部真实输入（tsconfig/lockfile 等），此审查无机器兜底。
3. **ci-judge 的 gh CLI 依赖**：`gh run view/rerun` 的输出形态与限流未实测（GP4 同波探针顺带验）；非 GitHub 平台是显式 out-of-scope。
4. **拆包 trigger 记档**：当且仅当第三问题域出现或 gate 域用户群与 cw 明显分离时，才把 store 抽为独立包（`@zhushanwen/event-ledger`）——现在不做（不加推测性功能）。
