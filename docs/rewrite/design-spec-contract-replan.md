# mx-5 设计：验收命令契约设防与 verify 阶段回炉

> **一句话结论**：M4 三场 gate 失败的共同土壤是「验收命令的输出契约在 spec 冻结时无机器把关、verify 阶段无回 spec 通道」——mx-5 在生产侧加一条确定性 gate 规则拦得住的拦死（规则⑨，允许恰为 json 的 reporter 值以兼容存量夹具幂等语义），拦不住的给一条自动回炉通道（解析失败连挂 2 次转 designer 修 spec，复用独立 reviewer 再审环；回炉 2 代转人工防活锁），配合 reviewer 任务书对抗式改版与 developer 改名。本文档经对抗式审查 round1（4 must-fix 全部修复：回炉防活锁独立预算、规则⑨禁令清单实测校准、解析失败信号源勘误、mx5-1 领地收敛），审查报告 `.tmp/mx5-design-review-round1.md`。
>
> **层声明**：当前层 = 波次设计（mx-5 立项），下一层 = 可实现的技术方案（接口 / 数据模型 / 错误规格），按「接口先行」最严格档设计，不跨到实现计划层。
>
> **受众假设**：会用 cw 但不了解 M4 gate 细节的开发者。本文自包含：所有背景在 §1-2 给足，证据锚点附路径，无需对话上下文。

## 1. 背景目标

**SCQA 开篇**：

- **S（情境）**：cw 2.0 的 M4 里程碑用「真实 pi 后端无人干预全链」做终验（gate），同一个 md-reader 靶子连跑三场。
- **C（冲突）**：三场全部未收敛（root 永远等不到全树 closed）。三跑机制层 6/7 判定达标，但 leaf-app 死于：spec 里 5 条验收有 3 条的命令**写得无法被机器读出结果**（构建实际成功仍判 fail），连挂 2 次被误判为「测试随机挂」停派 builder，在场的 builder 又因模型请求挂死超时，死局到 max-idle 收场。
- **Q（问题）**：三场直接死因各异（打回误杀 / 真分歧触顶 / 契约违反×误判×挂死），但土壤同一——**验收命令与 testrun 适配器之间的输出契约，在 spec 冻结时没有任何机器检查；verify 失败后也没有任何「退回 designer 修 spec」的通道**。mx-3 修的是 verdict 信任（消费侧），mx-4 修的是打回预算（参数），生产侧从未设防。
- **A（答案）**：mx-5 五件事——①spec gate 规则⑨（确定性契约检查，入账前拒绝）②解析失败分类 + 连挂回炉通道（漏网的自动退回 designer，复用独立 reviewer 再审）③reviewer 任务书对抗式改版（契约核对 + 反例追问）④builder→developer 改名 ⑤统一语言词条回写。

**系统是什么**（受众补认知，30 秒版）：cw 是「agent 工作的 CI」。工作拆成 unit 树，每个 unit 的完成定义 = 一组**验收**（含 `command` 命令行）；designer 写 spec（含验收）→ 独立 reviewer 审 → 冻结 → developer（原 builder）写代码 → `cw verify` 把账本里的 commit 检出到一次性工作区**自己重跑验收命令**，结果由 **testrun 适配器**从命令产物里解析判定。统一语言见 [CONTEXT.md](../../CONTEXT.md)。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | 契约违反在入账前被机器拒绝 | designer 提交带 `--reporter=verbose` 的验收命令，`cw evidence submit --kind spec` 当场 exit 1 并给出可操作恢复文案——而不是 40 分钟后在 verify 阶段反复撞墙 |
| G2 | 漏网契约问题自动回炉 | 机器静态拦不住的形态（如 e2e 命令不输出标记行）连挂 2 次后，runner 自动派 designer 修 spec（任务书内嵌解析失败原文），修好的新 spec 照旧过独立 reviewer 审查——不再烧 developer、不再误判 flake |
| G3 | reviewer 对抗式审查契约 | reviewer 审 spec 时逐条核对命令契约并反例追问「无实现时必挂吗」，三跑那种「A3 区分力较弱……不构成阻塞，pass」不再出现 |
| G4 | 术语统一 | 角色名 developer；flake / 打回代数 / 停派 / 验收命令契约 / 解析失败成为 CONTEXT.md 一等词条 |

**Scope**：

- **In**：G1-G4 全部；TIMEOUT 结算文案在停派态下的诚实化（小改）；测试套件与文档同步。
- **Out（显式不做，记档）**：并行多 reviewer + 指定项目 agent.md 加载（未来 TODO，用户已记档）；pi 请求级超时/心跳（pi 侧基础设施，不在本仓库）；TIMEOUT 后停派优先级**重估**（行为变更，本波只做文案诚实化，重估列观察项）；验收命令语义级静态分析（bash AST 等——§3.2 论证为什么不需要）。

## 2. 现状与问题分析

### 2.1 三跑死亡现场（全部为镜像实测原文）

证据库：`.xyz-harness/m4-gate3-evidence/`（gitignore 内长期保留），报告 `docs/rewrite/acceptance/m4-gate3-report.md`。

**现场一：构建成功了，验收判 fail。** leaf-app 冻结 spec 的验收 A3 = `pnpm install --silent && pnpm build`（type e2e-real）。verify 干净重跑的实际输出（`verify-b62e0340…/A3.stdout`）：

```
vite v5.4.21 building for production...
✓ 6 modules transformed.
✓ built in 78ms        ← exit 0，构建成功
```

判定（同目录 A3.stderr）：`无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）……判 fail`。原因：e2e-sh 适配器要求 stdout 含独立标记行 `<验收id> PASS|FAIL`，`pnpm build` 永远不会输出 `A3 PASS`——**这条验收实现写得再对也过不了**。

**现场二：测试全绿，验收判 fail。** 验收 A2 = `npx vitest run --reporter=verbose tests/close.spec.ts`（type unit）。cw 的 vitest 适配器执行时会自动追加 `--reporter=json` 并对 stdout 整体 JSON 解析；命令里已有的 `--reporter=verbose` 与之并存，stdout 变成「人类可读文本 + JSON」混合体，解析报 `Unexpected token 'R', "\n RUN v1.6."…`。而 developer（builder）本地用 `--reporter=json` 单独跑同一测试文件：3/3 全绿、纯 JSON——**测试代码是对的，挂的是冻结命令里那个 flag**。

**现场三：reviewer 看到症状放行。** 三跑 leaf-app spec v3 的 reviewer pass 意见（账本 seq19 原文）：「……A3 区分力较弱（仅 build exit 0）和 A5 mock 边界说明可补充，但不构成阻塞。pass。」该 reviewer 的 session 全程 0 次接触任务书 §6「机器 gate 硬约束清单」——清单里白纸黑字写着这两条规则。

**现场四：约束传导断链。** 靶子任务书 §6 明确警告「e2e 标记行精确格式」「unit 命令 cw 会自动追加 --reporter=json」；但 root designer 写给 leaf-app 的子任务书只转述了第 3 条（测试名含验收 id），丢掉了恰好被违反的第 1、2 条（`/tmp/m4-gate3/…/md-reader/.cw-spawn/leaf-app.brief.md` 实测）。

**现场五：误判连环。** A3 连挂 2 次 → flake 启发式判「疑似随机挂」停派 builder（rv-5 机制）→ 在场 builder 模型请求挂死 30 分钟被判 TIMEOUT（结算行写「可重派」，但停派态下不兑现）→ 死局。

**对照实验**（同场同机制同模型）：leaf-renderer 的 designer 写了 `pnpm build && echo "A3 PASS"`、vitest 裸命令——契约合规，其 builder 4 轮迭代后全绿 closed。**唯一的差别就是 spec 命令契约质量。**

### 2.2 物理数据流：一条验收命令的完整生命周期与三个失守点

```text
designer 写 spec.json ──▶ ① spec gate 八规则（规则③只查「首 token 在 PATH 可解析」）
   command: "npx vitest run --reporter=verbose tests/x.spec.ts"
        │                    ★ 失守点 A：适配器输出契约零检查（--reporter=verbose 通过）
        ▼
spec 冻结（hash 入账）──▶ reviewer spec-review（审语义：覆盖度/断言强度）
        │                    ★ 失守点 B：契约核对不在 reviewer 任务书清单里（现场三）
        ▼
developer 实现 + commit ──▶ cw verify（干净 checkout 重跑）
        │
        ├─ adapter.translate：自动追加 --reporter=json（不剥离已有冲突 flag）
        ├─ 执行命令，stdout 落盘
        ├─ adapter.parse：JSON.parse 整段 stdout ──▶ 解析失败折叠成 fail case
        ▼
VerifyRan{result: fail} ──▶ 投影消费侧（frontier 重算）──▶ flakeReview：e2e 连挂 ≥2 计数
        │                    ★ 失守点 C：连挂计数不区分「解析失败」（确定性挂）与
        ▼                      「断言失败」（真测试挂）——A3 两连挂被当 flake（现场五）
停派 builder，转人工 ◀── 无「退回 designer 修 spec」通道（builder 失败只能自己迭代）
```

三个失守点 A/B/C 分属三个环节（入账 gate / 审查 / 投影消费），任何一个补上都拆掉三跑死局的一环；mx-5 三个主力交付（规则⑨ / 回炉通道 / reviewer 改版）分别打 A / C / B。

### 2.3 为什么既有修复打不到这里

mx-3（role=reviewer 强制 + 打回代数计数）修的是 **verdict 信任层**——谁有资格宣布审查结论；mx-4（预算 2→10）修的是**参数层**——给真分歧更多轮次。三跑证明这两层工作正常（9/9 verdict 合规、2 代全过审）。但验收命令契约是**生产侧输入质量**问题：spec 的 command 字段进了冻结 hash，verify 忠实执行忠实解析，每一层都「按设计工作」，死的却是全链——这是设计空洞，不是实现 bug。

**「验证手段」的概念澄清**（三跑复盘高频混淆）：cw 的 testrun 适配器支持 ts/py，指的是**解析测试框架的机器可读产物**（vitest→JSON、pytest→`-v` 条目行、e2e-sh→标记行、playwright→JSON），不是对命令文本做语言级静态校验。本案命令语法完全合法，bash AST 查不出问题——问题在命令与适配器的**输出契约**，是 cw 自己定义的协议，自然能（也应该）由 cw 自己的确定性规则检查。

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1 · designer 提交带毒命令（G1，入账即拒）**：

```
$ cw evidence submit --kind spec --unit leaf-app --file spec.json
spec gate 拒绝（规则⑨: 验收命令契约）:
  - 验收 A2: unit/integration 型命令含 "--reporter"（值=verbose）。vitest/playwright
    适配器由 cw 自动追加 --reporter=json，混用其他 reporter 会破坏产物解析
    （实测形态：stdout 混入人类可读文本，JSON.parse 失败，验收恒判 fail）。
    恢复动作：删除该 flag——cw 会自动追加正确的 reporter。
  （多缺口全列，不短路；其余规则照常）
exit 1
```

**场景 2 · 漏网契约问题自动回炉（G2，e2e 静态拦不住的形态）**：e2e 型命令静态无法证明它会不会输出标记行（标记可能在脚本内、可能条件执行），规则⑨不硬拦 e2e（诚实边界，见 §3.3-D1）。漏网后果：verify 第 1 次解析失败 → developer 迭代 → verify 第 2 次仍解析失败 → fold 投影新维度 `specContractBroken` → runner 派 **designer**（任务书内嵌两轮解析失败原文 + 恢复指引）→ designer 修 spec（如补 `&& echo "A3 PASS"` 或改走脚本）→ 新 SpecSubmitted 入账 → **独立 reviewer 再审（复用现有环，spec-frozen 仍只由 reviewer pass 驱动）** → developer 重派。全程无人工。

**场景 3 · reviewer 对抗式审查（G3）**：reviewer 任务书新增「验收命令契约核对」清单（逐条按 type 对照适配器输出要求）与反例式追问句式（「这条验收在无实现时必然挂吗？换一个实现还能过吗？」），输出格式升级为 must-fix / suggestion / info 三级 + 显式 verdict。三跑的 A3（`pnpm build` 裸命令、无标记产出）在该清单下第一问即暴露。

**失败路径恢复指引**：规则⑨拒绝 → 文案给出删 flag 的具体动作；回炉触发 → designer 任务书带机器错误原文；回炉 2 次仍解析失败 → 与打回代数同样按上限转人工（防 designer-developer ping-pong，见 D2）。

### 3.2 多方案对比

**D1 · 生产侧设防：规则⑨怎么做**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|------|--------------|---------|------|
| **1. spec gate 规则⑨（拒绝制，推荐）** | 契约是 cw 自定义协议，入账前确定性检查与规则③（PATH 可解析）同性质、同层位；错误信息在 designer 工作现场（写 spec 时）而非 40 分钟后 | 一条规则 + 测试 | 误伤存量合法用法——需枚举合法 flag 集（见 D1 形状） |
| 2. translate 防御性剥离（消费侧容错） | cw 偷改用户命令，掩盖 spec 错误；「忠实执行」语义被破坏 | 低 | 静默修改命令 = 审计面撒谎（与 cw 哲学冲突） |
| 3. 语义级命令分析（bash AST 等） | 过度工程：本案不需要语法正确性，需要的是 cw 私有协议检查；AST 也证明不了「会不会输出标记行」 | 高 | 高成本低收益 |

推荐 **方案 1**。方案 2 被否的理由独立成条：**cw 不静默改命令**——命令是冻结证据的一部分，改了就与账本 replay 不一致。被否方案反例：若用方案 2，§2.1 现场二的 A2 会被「修好」（verbose 被剥离），但 spec 账本里的命令与实际执行的不一致，红阶段/审计/人对账全部失真。

**规则⑨形状**（按 `AcceptanceItem.runner` 路由，缺省按 type 推导后的最终路由；值提取兼容 `--reporter=json` 与 `--reporter json` 两种形式）：

- vitest / playwright 型：命令中所有 `--reporter` 取值必须**恰为 `json`**（与 cw 自动追加值一致——存量测试夹具刻意写 `-- --reporter=json` 命中 translate 的 includes 幂等检查，属合法形态，实测 u5b/fx2/fx4/fx5/wt5 等 6+ 文件依赖此语义，禁 `verbose` 等其他值即保全它们）；另禁 `--outputFile`（实测该 flag 把 JSON 重定向到文件、stdout 无 JSON，解析必挂——审查探针实测形态）
- pytest 型：禁 `-q` / `--quiet`（审查探针实测：`-q` 与适配器追加的 `-v` verbosity 相抵、条目行消失、全 pass exitCode=0 仍解析失败——「同 flag 幂等」只对同 flag 成立，反义词 flag 是真冲突）；**禁令须覆盖短选项合写形态**（`-qq`/`-vq`/`-qqq` 等——pytest 短选项可连写，token 精确枚举抓不到，检查算法须对短选项簇逐字符展开或等价正则，round2 补）；其余适配器追加 flag（`--tb=no`、`-p no:cacheprovider`）与命令自带同值幂等，不设禁
- e2e-sh / manual 型：**不设静态规则**（无法静态证明标记行产出），靠 D2 回炉 + D3 reviewer 清单兜底——机器只拦确定性可判的，这是诚实边界而非遗漏
- 禁令清单是**单一事实源内的可扩展枚举**：新冲突形态（未来适配器扩容/新 flag）出现时在规则⑨一处追加，禁止散落

**D2 · verify 阶段回炉：通道形态**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|------|--------------|---------|------|
| **1. 解析失败结构化 + 新 frontier 维度（推荐）** | 分类进入事件（唯一真相源），投影/派发/审计全链可见；复用 specFixPending 派发形态与 reviewer 再审环，零新信任机制 | 中：事件字段 + fold + frontier + loop 四处 | 事件结构演进需向后兼容旧账本 |
| 2. 仅把解析失败从 flake 计数排除 + escalation 文案改人工指引 | 最小改动 | 低 | 零人工口径下仍死局（只是死得明白）——不解决 G2 |
| 3. 复活 1.x 通用 replan 命令 | 通用但过宽：replan 权限大到可废整树（1.x 语义），防作弊面翻倍 | 高 | 与「没有声明状态的命令」哲学冲突 |

推荐 **方案 1**。**信号源勘误（对抗审查 round1 MF4 修正）**：解析失败信号**已结构化存在**——`AcceptanceRunResult.parseError/reason`（`src/verify/run.ts`）与落盘产物 `<id>.report.json` 顶层 `{parseError: true, reason}`（三跑 `A3.report.json` 实读核实）；`EvidenceReport.cases` 元素只有 id/name/status，**不动 testrun 四适配器**。改动收敛为两处：

```ts
// 1) src/handlers/verify.ts：提交 VerifyRan 时从 AcceptanceRunResult.parseError 提取
// 2) src/events/types.ts —— VerifyRanPayload 增可选字段（旧账本缺字段 = 无解析失败，兼容）
export interface VerifyRanPayload {
  // …既有五字段不动…
  /** 本次 verify 中产物解析失败的验收 id（适配器无法从产物读出判定：
      vitest JSON 非法 / e2e-sh 无标记行）。result 仍为 "pass"|"fail" 不变，
      此字段只用于投影分类——解析失败是确定性挂，不计入 flake 连挂。 */
  parseFailedAcceptanceIds?: string[];
}
```

投影与派发语义：

- 连挂计数（frontier 消费侧）维持语义不变，但**输入排除 parseFailedAcceptanceIds**（解析失败 ≠ 随机挂——三跑 A3 误判源）
- 新投影计数：同一 spec 版本（同一 specHash 周期内）解析失败连续 ≥2 → frontier 新维度 `specContractBroken` → DISPATCH_SHAPE 映射 designer 修复形态（复用 specFixPending 的任务书模板，内嵌全部解析失败原文 + 规则⑨式恢复指引）
- 新 spec 入账即清零**解析失败连挂计数**（与 flake 连挂的 spec 周期语义对齐；注意清的是连挂计数，见下）
- **防活锁（独立预算，不能复用打回代数——对抗审查 round1 MF1 修正；round2 补清零语义）**：既有 `specReviewFailCounts` 只数 role=reviewer 的 **fail verdict**，而回炉环里 reviewer 对每版新 spec 的裁定是 **pass**——代数恒不增长；且 `specReviewDeadlock` 只在 created 态分支判定，回炉中的 unit 处于 spec-frozen 态进不了该组。因此新增独立计数 **回炉代数**：每发生一次「解析失败连挂 ≥2 → 新 SpecSubmitted」计 1 代，**≥2 代转人工**（新停派语义 `specContractDeadlock`，在 spec-frozen 态分支判定，与 flakeReview 同构）。**回炉代数累计不清零**（同打回代数语义——防活锁依赖累计；新 spec 入账只清零连挂计数，绝不清代数，实现者不得类推清零）。同时说明：每次 VerifyRan fail 都会喂活 max-idle 判定，若无此上限，无限回炉下 max-idle 也收不了场——该上限是死局兜底而非锦上添花
- **frontier 并存序**：`specContractBroken` 插入 GROUP_ORDER 于 `flakeReview` 之前（同为 spec-frozen 态停派类，契约回炉优先于随机性判定——解析失败分类正确时 flakeReview 根本不会同场触发，序仅作防御性定义）。与 `integrationDrift` 的真实互斥机制（round2 勘误）：集成路径（integrate.ts）产生的 VerifyRan **不带 parseFailedAcceptanceIds**（mx5-1 的字段提取只在 handlers/verify.ts 常规 verify 路径），回炉计数显式排除 integrate 产生的 runId——根 unit 集成期的解析失败走 rv-4 集成处置链，不进契约回炉通道
- `verify` 的 pass/fail 判定本身**零变化**：解析失败的 case 照旧判 fail（伪造成本 ≥ 干活成本原则不动），分类只影响「谁来接手」

**D3 · reviewer 任务书对抗式改版**

| 方案 | 长期架构合理性 | 短期成本 | 风险 |
|------|--------------|---------|------|
| **1. 单 reviewer + 契约清单 + 反例追问（推荐，本波）** | 清单进机制生成的任务书模板（不再依赖 root designer 转述——三跑现场四的断链根除）；维度可被账本审计（verdict comment 结构化） | 低（brief.ts 模板） | 单 reviewer 严格度方差仍在（role=reviewer 解决身份不解决严格度） |
| 2. 并行多 reviewer 按维度拆分 + 聚合 | 维度隔离、严格度方差被平均掉；用户已明确为未来方向 | 高（spawn 编排、聚合去重、成本×N） | 本波引入过重，且 G2 回炉已兜住漏网 |

推荐**本波方案 1**，方案 2 已记 TODO（用户 2026-08-19 指示）。清单内容（依据 ~/Code 五项目对抗审查 skill 调研共性，契约一致性 4/4 项目共有）：

1. **验收命令契约逐条核对**：unit/integration 型逐条问「命令是否 vitest 兼容（无 --reporter，install 带 --silent）」；e2e 型逐条问「stdout 从哪产出 `<id> PASS` 标记行？命令里指得出来吗？」
2. **覆盖度**：brief 要求逐条映射到验收（既有）
3. **区分力反例追问**：每条验收问「无实现时它必然挂吗？换一个实现它还过吗？」（三跑 A3「仅 exit 0」在该问下暴露）
4. **契约（contracts）一致性**：跨 unit 接口与冻结 hash 对照（既有，强化措辞）
5. **干净 checkout 可执行性**：依赖是否全在 package.json、命令是否自带 install

输出格式约定写进任务书：问题按 must-fix / suggestion / info 分级列出，pass 时对每条核对项显式说「核过无问题」（禁止含糊——三跑「不构成阻塞，pass」形态的针对性反制）。

**D4 · builder→developer 改名**（用户已拍板）：直接改，不做兼容别名。影响面（对抗审查 round1 补全）：src 角色字符串与 DISPATCH_SHAPE（loop.ts）、`src/runner/spawn/types.ts` 角色类型、`src/runner/spawn/human.ts` 指令文案、`src/handlers/review-submit.ts` 的 `VERDICT_ROLES` 枚举、`src/runner/brief.ts` 模板、cli 帮助文本、dispatch 命令表、spawn 产物文件名（`<unitId>.<role>.*` 后缀随角色变）、runner 日志、AGENTS/CONTEXT 文档、测试断言。`--role` 枚举迁移：新写入只收 `developer`（reviewer/designer/human 不变），旧值 `builder` 不再收——历史账本 `role=builder` 事件零语义消费已核实（fold.ts 与 frontier.ts 均只比对 `reviewer`），重放不受影响（⛔实施期门：全量 grep `builder` 出处清单入基线，逐处归因）。

**D5 · 统一语言回写**：CONTEXT.md 增六词条——验收命令契约 / 解析失败 vs 断言失败 / 打回代数 / 停派 / flake（升一等词条）/ developer（改名同步）。AGENTS.md 同步角色词与规则⑨计数（「八规则」→「九规则」全文勘误）。

**D6 · TIMEOUT 结算文案诚实化**（小，附带）：`loop.ts` 的 TIMEOUT 结算行「可重派（连续 2 次后转人工）」在该 unit 处于停派态时改述真实行为（「该 unit 当前处于 X 停派态，本次超时不触发重派；恢复动作：……」）。实现注记（对抗审查 round1）：该文案出自 `describeExit`，停派态分支需要把停派态作为输入传入——是签名级小改而非纯文案替换；顺带修复 `brief.ts` 现存的「连续 2 次」过时文案（与 rv-4 MAX=1 / mx-4 预算语义已不一致）。**只改文案不改优先级行为**——行为重估（超时后重估停派）列观察项，理由：D2 落地后解析失败不再触发停派，本冲突面已大幅收窄，先观察再决定是否需要行为变更。

### 3.3 关键决策与权衡

- **「机器拦确定性、reviewer 审语义、回炉兜漏网」三层自洽**：规则⑨拦得住的（flag 冲突）零容忍；拦不住的（标记行产出）不硬编——静态证明不了就不假装能证明，由 reviewer 清单（人审）+ 回炉（漏网后自动返工）闭环。每层职责单一，无重复检查。
- 探针（已测 ✅，对抗审查 round1 实跑）：①三跑镜像中解析失败信号**已结构化在场**——`AcceptanceRunResult.parseError`（`src/verify/run.ts` L85-110）与 `<id>.report.json` 顶层 `{parseError:true}`（`A3.report.json` 实读）；②pytest `-q` 与 `-v` verbosity 相抵致条目行消失、全 pass exitCode=0 仍解析失败（真实 pytest 8.3.0 探针）；③vitest `--outputFile` 把 JSON 重定向到文件、stdout 无 JSON（真实 vitest 探针）——②③是规则⑨禁令清单的实证依据；④存量测试夹具（u5b/fx2/fx4/fx5/wt5 等 6+ e2e 测试文件）刻意写 `-- --reporter=json` 并断言 exit 0——规则⑨「允许恰为 json 值」保它们零翻红，u5 锁定的 includes 幂等语义保持不变。
- 探针（实施期门 ⛔）：规则⑨对当前全量测试套件的零误伤验证（全量测试 + 构造合法/非法 spec 对照提交）；回炉代数投影的账本重放一致性（旧账本无新字段路径）。
- **回炉触发阈值取 2 而非 1**：解析失败也可能是环境性（如 checkout 内 install 网络抖动）——第 1 次给 developer 正常迭代机会，第 2 次才定性为 spec 问题。与 flake 连挂阈值 2 对齐，心智一致。回炉**代数**上限同样取 2：三跑实证 designer 修一次命令的成功率不低（leaf-renderer 对照组两代内过审），2 代仍修不好基本可判 spec/brief 层有更深问题，转人工比继续烧 pi 配额合理。
- **为什么不把解析失败映射成 flakeReview 的「处置指引改一下」**：那只是把死法说清楚，尸体还在原地。G2 要的是自动回炉。

## 4. 验收（真实场景，逐场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | 毒命令入账即拒 | 真实账本环境（隔离 CW_HOME tmp 目录）手工构造三跑 leaf-app v3 同款 spec（A2 带 `--reporter=verbose`、A3 裸 `pnpm build`）与合规对照 spec，各跑 `cw evidence submit --kind spec` | 毒 spec exit 1，错误文案逐条列出 A2 的 flag 问题与恢复动作（多缺口不短路）；对照 spec 正常入账 | G1 |
| V2 | 回炉全链（human spawn） | 构造 e2e 验收「无标记产出」的 spec（能过规则⑨——e2e 无静态规则）→ `cw run --spawn human`，人工按任务书提示快速扮演 developer/designer → 观察第 2 次 verify 解析失败后 runner 改派 designer、任务书含两轮解析失败原文 → 新 spec 入账 → reviewer 环照常 | 账本出现 parseFailedAcceptanceIds 事件字段；frontier 出现 specContractBroken；designer 任务书含机器错误原文；回炉后连挂计数清零、**代数不清零**；flakeReview **未**触发（解析失败不计连挂） | G2 |
| V2b | 防活锁出口（round2 补） | 在 V2 基础上再走一轮完整回炉（第 2 次「连挂 ≥2 → 新 spec」） | frontier 出现 `specContractDeadlock`；runner 停派出声（escalation 文案含 2 代回炉与恢复指引）；此后不再派发该 unit 任何 role | G2（死局兜底） |
| V3 | reviewer 放行率复测 | 用改版任务书重放三跑 leaf-app v3 spec 给真实 pi reviewer spawn（同一冻结 spec 原文作审查输入）；因单次 LLM verdict 有方差，**独立 spawn 跑 3 次** | ≥2 次 verdict 为 fail 且 comment 含 A3 标记行问题（对照三跑 pass 反例）；输出含分级清单 | G3 |
| V4 | 改名与词条回归 | `npm run check:all && npm test && npm run lint` 全绿；`grep -rn "builder" src/ tests/ AGENTS.md CONTEXT.md` 零残留（archive/ 除外）；CONTEXT.md 六词条存在 | 全绿 + 零残留 | G4 |
| V5 | 既有语义回归 | mx-3/mx-4/mx-2 套件（代数计数、预算 10、适配器路由）不红；u5 锁定的 translate includes 幂等语义保持（存量夹具 `-- --reporter=json` 形态零翻红——round1 实证 6+ 文件依赖）；打回代数/预算/deadlock 判定与 mx4 套件输出一致 | 全绿 | 不回归 |
| V6 | 真实 pi 全链（里程碑 gate 层，四跑观察项） | M4 gate 四跑（本波完成后另行调度）：同靶子重跑，观察 leaf-app 形态 | 契约违反入账前被拒或漏网后回炉收敛；「构建成功仍判 fail」形态消失 | G1+G2+G3 终验 |

投入说明：V1/V4/V5 机器判定（分钟级）；V2+V2b 用 human spawn 走真实 dispatch 全链（约 15 分钟）；V3 三次独立 pi spawn（约 6 分钟）；V6 是里程碑 gate 级投入（约 70 分钟真实 pi），不阻塞本波交付——本波「真实场景」验收由 V1-V3（含 V2b）承担，V6 是波后观察。testable：全部场景有可机检断言（exit code / 账本字段 / 文案 grep / frontier JSON）。

## 5. 下一层拆分（实施路径）

| unit | 内容 | 文件领地 | 依赖 | 验收载体 |
|------|------|---------|------|---------|
| mx5-1 | 规则⑨ + `VerifyRanPayload.parseFailedAcceptanceIds` 提取（信号源 = 既有 `AcceptanceRunResult.parseError`，**testrun 四适配器零改动**——round1 MF4 勘误后收敛） | `src/gates/spec-rules.ts`、`src/events/types.ts`、`src/handlers/verify.ts` | 无 | V1 + V5 |
| mx5-2 | 解析失败周期计数 + 回炉代数计数与 `specContractDeadlock` 转人工（防活锁独立预算——round1 MF1）+ frontier `specContractBroken` 与 GROUP_ORDER 展示序 + DISPATCH_SHAPE designer 映射 + 回炉任务书模板（内嵌错误原文）+ D6 文案 | `src/readonly/frontier.ts`、`src/runner/{loop,brief}.ts` | mx5-1 | V2 |
| mx5-3 | reviewer 任务书对抗式清单 + 输出分级格式 | `src/runner/brief.ts`（reviewer 模板） | 无 | V3 |
| mx5-4 | developer 改名（机械全量，含 VERDICT_ROLES / spawn 文件名 / help / dispatch 表） | src/tests/AGENTS/CONTEXT 全部 `builder` 出处 | 无 | V4 |
| doc-4 | 统一语言六词条 + 规则计数勘误（八→九） | `CONTEXT.md`、`AGENTS.md` | mx5-1 定型 | V4 |

拆分理由：mx5-1 与 mx5-3/mx5-4 无文件交集可并行（≤3 并行上限内：mx5-1 + mx5-3 先行，mx5-4 随后）；mx5-2 消费 mx5-1 的事件字段必须串行；文档收口最后。每 unit 走「验收基线先行入 git → developer 实现 → 独立 verifier」既有流程（docs/rewrite/orchestration.md）。

**待验证检查点（设计阶段不确定，实施期核）**：①回炉任务书复用 specFixPending 模板时「fail comment 全文内嵌」字段的取数路径（解析失败原文在 VerifyRan 关联产物与账本 payload，不在 VerdictSubmitted——与现有 specFixPending 输入源不同）；②DISPATCH_SHAPE 新维度的 in-flight 缓派交互（specContractBroken 触发时同 unit 在飞 developer spawn 的处置——设计意图：等结算后转派 designer，不杀在飞）；③`--role builder` 拒绝后的错误文案迁移指引（D4 配套，指向 `--role developer`）。
