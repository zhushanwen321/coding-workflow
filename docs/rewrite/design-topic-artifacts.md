# cw spawn 产物收口设计（fx-4：topic 目录）

> **一句话结论**：spawn 过程产物（brief/stdout/stderr）从 unit worktree 迁到 `~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/`，worktree 纯化为「只有 agent 业务产出与 commit」的 git 工作区——`add -A` 卷产物（fx-4）by construction 消失，`clean -fd` 的 `-e` 补偿参数整体删除。
>
> **层声明**：当前层 = 技术方案；下一层 = 实现计划（§5 单波拆分）。不跨到测试用例粒度。
> **输入依据**：M3 终验观察①（m3-gate-report.md §5.2：`.cw-spawn` 6 文件被 `add -A` 卷入 commit 随 merge 进 root 分支）；u5b-e2e flaky 探针铁证（`clean` 删真产出后 `add -A` 卷产物的双害同源现场）；落盘点全景盘点（§2.1）。P1-P4 决策经用户 2026-08-17 拍板（推荐方案全采纳）。

## 1. 背景目标

**spawn 过程产物与 agent 业务产出物理分离——worktree 只承载 git 语义的东西，观察 agent 的日志归 `~/.cw`，账本与证据链零改动。**

- **S（情境）**：M3 后每个 unit 有独立 worktree，agent 在其中干活并 commit；runner 把派发产物（任务书 brief、agent stdout/stderr）写在 worktree 内的 `.cw-spawn/`。
- **C（冲突）**：`.cw-spawn/` 是 untracked，agent 侧行为惯例（brief 任务书只教 `git commit`、协调协议甚至明令禁 `add -A`——但无任何机器 gate 约束 agent 不这么干）会把 `.cw-spawn` 卷进 commit——M3 终验现场：`cw-root/md-reader` 分支含 6 个 `.cw-spawn` 产物文件，用户回流主分支时会带出这些文件。flaky 探针还展示了第二形态：`clean -fd` 删掉真产出的同时 `add -A` 卷入产物（双害同源）。
- **Q（问题）**：过程产物该落在哪，才能与 agent 的 git 语义彻底解耦？
- **A（答案）**：`~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/`——按 run 归档的过程产物目录，spawn 契约显式传 `artifactDir`，适配器不再从 workdir 推导产物路径。本文展开。

### 1.1 目标（从使用者视角倒推）

- **G1' 产出纯净**：agent 在 worktree 的 `git add -A` 只会卷入自己的业务产出——任何 cw 自身文件（brief/stdout/stderr）物理上不在 worktree。
- **G2' 清理极简**：worktree reset 语义回到裸 `reset --hard + clean -fd`（`-e .cw-spawn` 补偿删除），worktree 内不存在任何「cw 想保护的东西」。
- **G3' 审计自包含**：spawn 日志按 run 归档永久保留（与 evidence 同级审计资产）；agent 提交的原文（spec / build --file / unit brief）copy 进 evidence，证据链可重读原文——不依赖 commit 树可达或 worktree 存活。
- **G4' 零回归**：账本、evidence 布局、CW_PROJECT_DIR 锚定、human 转人工路径、verify 语义全部不变。

### 1.2 scope

- **in scope**：spawn 产物落点迁移（topic 目录 + artifactDir 契约）、`clean -e` 补偿删除、原文副本入 evidence（spec / build --file / unit brief 三类）、场景 4 反向断言补测试、worktree.ts 头注释 v2 旧口径修正（偏离审查 #3）。
- **out of scope**：账本 schema 与事件类型（零变更）；`~/.cw/<encoded-cwd>/events.log` 与 evidence 既有 `evidence/<unitId>/<runId>/` 布局（不变；新增 `attachments/` 子目录为纯增量）；`~/.cw-worktrees/` 布局与回收语义（不变）；`/tmp` 的 verify mkdtemp（用后即清，不需收口）；topic 目录的自动清扫（永久保留，P2 拍板——不引入新清扫复杂度）。

## 2. 现状与问题分析

### 2.1 落盘点全景（2026-08-17 盘点）

| # | 位置 | 内容 | 生命周期 | 评价 |
|---|------|------|---------|------|
| 1 | worktree 内 `.cw-spawn/` | brief/stdout/stderr（loop.ts writeBriefFile、human.ts 指令落盘、pi.ts artifactPaths、lifecycle mkdir/open） | 随 worktree 回收销毁 | **唯一污染源**（fx-4） |
| 2 | `~/.cw/<encoded-cwd>/events.log` | 账本 | 永久 | 归位正确 |
| 3 | `~/.cw/<encoded-cwd>/evidence/<unitId>/<runId>/` | verify 产物 | 永久 | 归位正确 |
| 4 | `~/.cw/<encoded-cwd>/evidence/<rootId>/integrate-<runId>/` | 集成产物 | 永久 | 归位正确 |
| 5 | `~/.cw-worktrees/<encoded-cwd>/<unitId>/` | unit git 工作区 | 延迟回收+孤儿清扫 | 混入 #1，不纯 |
| 6 | `/tmp/cw-verify-checkout-*` / `cw-verify-env-*` | verify 一次性 clone / CW_HOME 隔离 | 用后即清 | 零残留，不需动 |
| 7 | worktree 内 spec.json 等产物本体 | evidence submit 只记 sha256 不 copy | 随 reset 丢失 | **审计断点**（spec 原文只剩账本 hash，§3 P3 顺手修） |

### 2.2 根因

`.cw-spawn/` 的位置继承自 M1 共享 cwd 时代（产物放项目 cwd 下，`-e` 排除还不存在）；M2/M3 把 agent 工作区迁进 worktree 时产物路径跟着 workdir 走（「自动跟随」曾被当作零改动优点），但 worktree 是 **git 语义的工作区**——里面任何 untracked 文件都活在 `add -A` 与 `clean -fd` 的火力范围内。过程产物放在 agent 的 git 工作区里，等于把观察日志放在被观察者的手术台上。

### 2.3 已具备机制（不重复设计）

- `AgentSpawnRequest` 契约（types.ts）：加一个必填字段的接缝现成；
- `CW_HOME` env 覆盖链（getCwHome）：topic 作为其子目录天然继承测试隔离，无需新 env；
- append 语义（lifecycle `openSync(path, "a")`、human flag "a"）：迁位置不改语义；
- `encodeCwd`：topic 的项目层 key 与账本/worktree 同体系。

## 3. 解决方案

### 3.1 终态数据流

```
项目 cwd                                ——纯 git 锚点，cw 零写入（不变）
~/.cw-worktrees/<encoded-cwd>/<unitId>/ ——纯 git 工作区：只有 agent 业务产出与 commit
~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>[-N]/
        <unitId>.<role>.brief.md / .stdout / .stderr   ——spawn 过程产物（新，文件名沿用现有形态）
~/.cw/<encoded-cwd>/events.log          ——不变
~/.cw/<encoded-cwd>/evidence/<unitId>/attachments/<sha256>.<原文件名>   ——原文副本（新，纯增量）
~/.cw/<encoded-cwd>/evidence/<unitId>/<runId>/…        ——verify 产物（不变）
/tmp/cw-verify-*                        ——不变
```

### 3.2 方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：topic 目录收口**（推荐，用户拍板） | ✅ 工作区/日志语义归位；fx-4 by construction 消失；`-e` 补偿删除；按 run 归档的审计结构 | 中：spawn 契约加字段 + 四处落点改 + ~30 处测试断言迁移 | 低：全部路径经显式契约传递 | ✅ |
| B：worktree 内预置 `.gitignore`（`.cw-spawn`） | ❌ 治标：产物仍在 git 工作区（`git status` 仍见、嵌套 ignore 污染用户仓库内容——`.gitignore` 本身会被 `add -A` 卷入 commit 变成产出污染的新形态） | 低 | 中：ignore 文件自身进 commit；agent 若删 ignore 即失效 | ❌ |
| C：brief 任务书禁 `add -A`（教精确路径） | ❌ 纯约定：agent 不照抄就破（fx-3 R5 教训：文字约定对 print 模式 agent 不充分，机器 gate 才可靠）；且精确路径模板需要 renderBrief 知道 agent 将改哪些文件（不可知） | 低 | 高：防线在提示词层，零机器保证 | ❌ |

**B 的失败形态**（若采用）：预置的 `.gitignore` 是 worktree 内 tracked 文件，agent 首次 `add -A && commit` 就把它卷进产出 commit——回流主分支后用户的仓库多出一个 cw 写的 ignore 文件；且它只能挡 `.cw-spawn`，挡不住未来任何新产物形态。

**C 的失败形态**（若采用）：M3 终验现场 builder 自发使用了 `git add -A`——brief 任务书并未教它（模板只写 `git commit`，协调协议甚至明令禁 `add -A`），说明这是 agent 侧行为惯例；提示词层约束对真实 agent 行为是概率性的（fx-3 R5 教训：文字约定不充分，机器 gate 才可靠），与「机器检查 gate」的产品哲学相悖。

### 3.3 关键决策

**D1 topic 路径：`~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/`（P1 拍板：带 encoded 层），冲突递增后缀。** `<encoded-cwd>` 与账本/worktree 同 key（归属排查一眼对应，跨项目零歧义）；`<runTs>` 格式 `YYYYMMDD-HHmmss`（runLoop 启动时刻本地时间）；`<rootId>` 即 slug。一次 run 一个 topic 目录：同 run 重派沿用 append（stdout/stderr 的「历次输出不覆盖」承诺不变）；跨 run 重跑 = 新目录。**秒级碰撞策略**：runTs 精度为秒——同 rootId 先后两次 run 在同一秒内启动（秒级收束后立即重跑、时钟回拨）会得到同名目录，静默 append 会违反「跨 run = 新目录」承诺；故创建时 `existsSync` 探测，已存在则追加 `-2`、`-3`… 递增后缀直到唯一（确定性、无并发窗口——同一 root 并行 runLoop 已被单进程口径禁止，探测时无并发写者）。位于 CW_HOME 内，测试隔离沿用 `CW_HOME` 覆盖，**不新增 env**。

**D2 spawn 契约：`AgentSpawnRequest` 加必填 `artifactDir: string`，topic 目录即值。** 目录内布局为**扁平**：文件名沿用现有形态 `<unitId>.<role>.brief.md|stdout|stderr`（仅父目录从 worktree/.cw-spawn 换为 topic 目录——文件名零变化，断言迁移只换前缀）。归属分工：brief 由 runner（loop 的 writeBriefFile）写入 artifactDir，**覆盖写语义不变**（brief 内容随投影变化，append 会拼接出多版本任务书）；stdout/stderr 由适配器产生——pi.ts 经 lifecycle 的 `openSync(path, "a")` append（重派历次输出累积），human.ts 指令落盘与占位 stderr 同源。适配器只从 `req.artifactDir` 拼自己的产物文件名，不感知 topic 全局布局；lifecycle 零改动（本就只管传入路径）。`workdir` 字段语义不变（纯 agent 工作区）。

**D3 worktree 纯化：`clean -fd` 回归裸形态，`-e .cw-spawn` 删除。** worktree 内不再有任何 cw 产物（D2 迁走后 by construction 成立）；若 agent 自行创建 `.cw-spawn`（旧习惯），它就是普通 untracked，被清是正确语义。`resetWorktree` 错误文案同步。

**D4 原文副本入 evidence（P3 拍板扩展：三类一致）：`evidence/<unitId>/attachments/<sha256>.<原文件名>`。** 三个写入点统一布局、以内容 hash 命名天然幂等去重（同内容重复提交零增长）：① `evidence submit --kind spec`——spec 原文（此前只存账本 specHash，本体随 reset 丢失即审计断点）；② `evidence submit --kind build --file`——产物原文（submitBuild 只校验 commit 存在与文件可读、**不校验文件在该 commit 树内**，untracked 产物随 clean 丢失与 spec 同构断点——「build 本体在 commit 树里」的旧论据不成立，故一并 copy）；③ `cw create --brief`——unit 原始 brief 副本（账本 `UnitCreated.briefRef` 是路径引用，文件本体是 designer 在父 worktree 写的 untracked、随 clean/reclaim 丢失留下死路径）。账本零变更（paths/sha256/briefRef 字段不动，副本是纯增量审计资产）。

**D5 生命周期：topic 目录永久保留（P2 拍板）。** 与 evidence 同级审计资产；体积量级：M3 终验实测 stdout 数百字节/个（9 spawn 全程 KB 级），主要变量是 pi 长跑（30min 上限）的单文件 stdout——按「每次 run MB 级、机械盘时代可忽略」评估，不做自动清扫（worktree 回收有 debug 窗口权衡，topic 日志没有「现场被破坏」问题，保留无损）。人工清理口径：整个 topic 目录删除不影响账本重放（账本事件不引用 topic 路径——已核实五类 payload 无 spawn 产物路径通道）。

**D6 转人工指引跟随。** human 指令的 `cat "<briefPath>"` 自动跟随（briefPath 指向 topic 内绝对路径）；「干活 cd worktree、提交 CW_PROJECT_DIR 前缀」双路径结构不变；escalation/idle 文案的 stdout 路径跟随 topic，且「（历次运行的完整输出）」措辞改为「本次 run 的历次输出」——per-run 归档后跨 run 历史在旧 topic 目录（`~/.cw/topic/<encoded-cwd>/` 下按 runTs 可查），不再同文件累积。

## 4. 验收（真实场景）

**改动规模：中（接口字段 + 落点迁移 + 断言迁移）——多场景真实验证。**

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|---------|
| 1 | **产出纯净（G1'）** | 真实 git 项目 + human 模式全链（或 fake adapter 双 builder）跑至 unit closed | agent 的 evidence commit 树（`git show --stat`）不含任何 `.cw-spawn` 路径；worktree 内不存在 `.cw-spawn` 目录 |
| 2 | **清理极简（G2'）** | worktree 预置 tracked 脏 + untracked 文件（含手工伪造 `.cw-spawn/x`）→ 重派 | porcelain 为空（无 `-e` 例外条款——伪造的 `.cw-spawn` 一并被清）；已 commit 产出保留 |
| 3 | **产物可达与归档（G3'/审计）** | 同 run 内同 unit 重派两次 → 跨 run 再跑一次（间隔 ≥1 秒）；再构造同秒重跑（碰撞策略） | topic 目录内 stdout 为本 run 历次 append（两次内容都在）；第二次 run 落**新** topic 目录；同秒重跑触发 `-2` 后缀（三目录并存，零静默混卷）；三类原文副本（spec / build --file / unit brief）均可在 attachments 下按 hash 重读且与原文逐字节一致 |
| 4 | **human 接管 + 反向断言（G4' + 偏离审查 #1）** | 转人工：人按指引 cat brief（topic 路径）、cd worktree 改码 commit、内联前缀提交；反向：故意**不带前缀**跑 `cw create` 写命令 | 正向：事件写项目账本、循环推进；反向：`~/.cw/` 出现 `<encoded-worktree>` 分裂空账本目录（证明内联前缀是必要锚定——设计文档 design-worktree-isolation.md §4 场景 4 承诺、wt-2 未执行的断言在此补齐） |
| 5 | **全链终验复跑** | M3 gate 同款靶子流程（真实 pi） | root closed；所有派发产物在 topic 目录；root 分支 commit 树零 `.cw-spawn`；全量测试绿（以实跑为准） |

## 5. 下一层拆分（实现计划）

**单波承载（P4 拍板）：unit fx-4。** 改动面强耦合（契约字段与落点迁移不可拆），拆波反而要写两遍迁移测试。

| 项 | 内容 |
|---|---|
| 契约 | `spawn/types.ts` +`artifactDir`；`SpawnResult` 注释更新 |
| 落点 | `store/project.ts` +topicDir 路径函数（含冲突递增）；`loop.ts`（runLoop 启动建 topic、writeBriefFile 迁 topic、派发点传 artifactDir、escalation/idle 文案含措辞更新）；`pi.ts`/`human.ts` artifactPaths 改源 |
| 纯化 | `worktree.ts` resetWorktree 删 `-e`（+头注释 v2 旧口径修正，偏离审查 #3） |
| 原文副本 | `handlers/evidence-submit.ts`（spec + build --file 两处 copy）；`handlers/create.ts`（brief copy） |
| 测试 | topic 布局/append/跨 run/同秒碰撞四组新测试 + 场景 1-4 条款 + 场景 4 反向断言 + 既有断言迁移。迁移面实测口径：`.cw-spawn` 代码引用 88 处/16 文件（wt2×18、wt1×10、wt3×9 等），其中两类性质分开——**路径迁移**（断言目标换成 topic 前缀）与**语义反转重写**（wt1 B5/wt3 的 `-e .cw-spawn` 保留断言 → 产物必须被清）；另 14 个测试文件手写 `AgentSpawnRequest` 字面量须补 `artifactDir` 必填字段（TS 编译强制）。flaky 修复后的 u5b-e2e 强屏障（等派发行）不受影响，但其场景内的 `.cw-spawn` 路径断言属迁移面 |
| 波外不动 | integrate.ts、verify/、core/、events/、cli.ts、账本/evidence 既有布局 |

**待验证检查点（实施期）**：① 同秒碰撞策略的实测（同 rootId 同秒两次 run → `-2` 后缀；不同 rootId 同秒 → rootId 不同天然不撞）；② human 指引中 topic 绝对路径在含空格项目路径下的引号形态（复用 wt-2 双引号规则，测试覆盖）。

## 修订记录

- 2026-08-17 v1（fcd90d6）：初版（P1-P4 拍板形态）。
- 2026-08-17 v1.1（本版）：对抗审查修复（报告 /tmp/design-review-fx4-v1.md，3 MF + 7 S）——布局统一为扁平（文件名零变化）；runTs 秒级碰撞补 `-N` 递增后缀策略；D4 扩为三类原文副本（build 不 copy 的旧论据经核实不成立：submitBuild 不校验 --file 在 commit 树内；brief 同构断点一并纳入）；`add -A` 归因修正为 agent 侧惯例；brief 覆盖写归属澄清；escalation「历次运行」措辞口径；scope 与迁移面实测数字（88 处/16 文件 + 14 文件字面量补字段）。
