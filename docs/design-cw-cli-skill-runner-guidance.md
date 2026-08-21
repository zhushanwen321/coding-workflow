# cw-cli skill：runner 模式默认路由改造设计

> 一句话结论：cw-cli SKILL.md 把「手动逐步交证据」教成了默认路径、「runner 自动调度」写成了可选捷径，导致 agent 在多 unit 任务里手动替代 runner 干活；本设计把模式分流提到决策链最上游，让 runner 成为多 unit 任务的默认路径，手动流程退为单 unit 调试 / 降级路径。

- **S（情境）**：cw 2.0 提供两种使用模式——手动逐步交证据（create → evidence → verify → review）与 runner 自动调度（`cw run --root <id> --spawn pi`，内部循环 frontier → 派发 pi 进程 → 证据回收 → 重算直到 root closed）。cw-cli skill 是 agent 使用 cw 的唯一教学入口（随 `@zhushanwen/coding-workflow` npm 包发布，symlink 到 `~/.agents/skills/cw-cli`）。
- **C（冲突）**：2026-08-20 session-trace 开发 session（pi session `01a01fda-caa8-7ebc-8cd4-4db98745056a`，xyz-agent 仓 feat-trace-view）中，用户明确说「走 cw-cli 模式进行开发」，agent 完整读了 SKILL.md，结果用主 agent + 29 次手动 subagent 派发完成了 6 个 unit 的 cw 流程——账本操作全部合规，但全程没选 runner。用户事后点破：「我记得 cw-cli 不是应该是 cw-cli 内部 spawn pi 进程吗？」
- **Q（问题）**：为什么 agent 读完了 skill 却不选 runner？如何让后续 agent 在多 unit 任务上默认走 runner？
- **A（答案）**：根因是 skill 的信息架构——手动流程占据主体篇幅与 Self-Check，runner 只有约 15 行且被「不想逐步手动时」的措辞定位成捷径。改造方案 = 重构文档结构，把「模式分流」立为决策点，runner 提为多 unit 默认路径。

## 0. 层声明与受众

- 当前层：技术方案（skill 文档信息架构改造）；下一层产物：SKILL.md 的具体编辑任务清单（§5）。
- 受众：会用 cw CLI、但不了解本 skill 写作背景的开发者 / agent。
- 本设计只改 `skills/cw-cli/SKILL.md` 一个文件（纯文档，无代码改动）；pi-cw skill 侧的配套改造在 xyz-agent 仓另行设计（见 §2.4 交叉引用）。

## 1. 背景与目标

### 1.1 系统是什么

cw 2.0 是「agent 工作的 CI」：事件账本 + 证据 gate + 机器验证。两种使用模式：

| | 手动模式 | runner 模式 |
|---|---|---|
| 入口 | agent 逐条 bash 调 `cw create / evidence submit / verify / review submit` | `cw run --root <id> --spawn pi` 一条命令 |
| 谁调度 | agent 自己判断下一步 | runner 循环按 frontier 就绪维度自动派发 |
| 谁执行 | agent 自己或它派的 subagent | runner spawn 的无头 pi 进程（`pi --model <m> -p @brief`，见 `src/runner/spawn/pi.ts`） |
| spec / 审查 | agent 手写 spec、自派 reviewer | designer / reviewer / developer 角色由 runner 分别 spawn，spec-review 强制独立 reviewer（mx-1） |
| worktree | 不隔离（agent 在当前工作区干活） | 每 unit 独立 worktree + 分支，集成期 merge 回流 root（`src/runner/worktree.ts` / `integrate.ts`） |
| 死锁恢复 | agent 自己想办法 | 打回代数 / flake 连挂 / 契约回炉超阈值自动转人工（stderr escalation + exit 1） |

### 1.2 设计目标（从使用者体验倒推）

- G1：agent 面对「多 unit 编码任务（≥2 个 unit 或需并行）」时，默认选择 `cw run --spawn pi`，而不是手动逐 unit 编排。
- G2：agent 面对「单 unit 调试 / 学习流程 / runner 不可用」时，知道手动流程是为此存在的降级路径。
- G3：agent 选择 runner 后能正确使用：会后台运行、会监控 escalation、知道 manual 型验收的语义、知道转人工出口。
- G4：用户说「走 cw-cli 模式」时，agent 的理解与用户心智（= runner 自动推进）一致。

in scope：`skills/cw-cli/SKILL.md` 的结构与措辞。out of scope：cw 引擎行为变更；pi-cw skill / cw-tool extension 的改造（另一个项目的设计文档）；AGENTS.md 的全局路由规则（可作为后续配套，非本设计交付物）。

## 2. 现状与问题分析

### 2.1 真实失败案例（session `01a01fda`，2026-08-20）

用户指令：「阅读文档……完后走 cw-cli 模式进行开发」。agent 实际行为序列（session 记录可查）：

1. 读完 SKILL.md 全文（267 行）后，直接「建 cw 树并提交前两个可并行 unit 的 spec」——**模式选择的决策点从未出现**；
2. 全程手动：`cw create` × 6、手写 spec.json、`cw evidence submit` / `cw verify` / `cw review submit` 逐 unit 手动调；
3. 用主 agent 的 subagent 工具派发 29 个 reviewer/dev（cw 要求 reviewer 身份，agent 正确地派了独立 subagent——但这正是 runner 内建的角色 spawn）；
4. 后果：15 小时 session、root spec 迭代 7 次（e2e-sh 标记行契约、干净 checkout 缺 node_modules 两条教训）、29 个 subagent 0 个显式 close。

值得注意的是该 session 的自审环节也没发现模式问题：用户问「是否符合 cw-cli 的执行说明」，agent 用「手动流程的合规性」做基准给出了 B+ 评分，直到用户明确点破 runner 才意识到。**同一份 skill 既误导了执行，也误导了复盘**——说明问题在文档结构，不在 agent 一时的疏忽。

### 2.2 文档结构测量（当前 SKILL.md，267 行）

| 证据 | 现状 | 效果 |
|------|------|------|
| 「什么时候该用」决策表 | 只区分「用 CW / 不用 CW」四行 | 模式分流（手动 vs runner）在决策点上不存在 |
| 主体篇幅 | 「手动流程」5 步约 100 行，含 spec.json 示例、gate 规则表、命令逐条讲解 | 手动流程 = 文档事实上的「主路径」 |
| runner 章节 | 约 15 行，位于手动流程**之后**，首句「不想逐步手动时，用 runner 自动推进」 | runner 被定位为「懒人捷径」，不是多 unit 默认路径 |
| Self-Check（标 [MANDATORY]） | 只列手动 5 步（spec gate / spec-review / build / verify / exec-review） | 强制清单再次锚定手动为正统 |
| frontmatter description | 「入口：bash 调 cw 命令（create → evidence submit → verify 等），按返回的 stdout 文本推进全流程」 | 主语是 agent 自己，暗示手动驱动 |

### 2.3 根因分析

**根因：skill 的信息架构与 cw 2.0 的产品定位不一致。** cw 2.0 里 runner 是承载完整编排智能的组件（frontier 维度、角色 spawn、死锁转人工、worktree 集成），手动命令面是账本的操作原语；但 skill 把操作原语教成了主流程，把编排组件写成了附注。agent 的行为是文档结构的忠实映射：读到的「主路径」是手动 5 步，于是手动执行；决策表没有模式分流，于是不分流。

两个加重因素（非根因，但解释了为什么没有任何纠偏信号）：

1. **runner 的能力优势在 skill 里不可见**。runner 的 designer 任务书（`src/runner/brief.ts`）直接内置了 session 用 7 次 spec 迭代换来的两条教训——e2e-sh 标记行契约（"stdout 从哪产出 `<验收id> PASS` 标记行？"）与干净 checkout 自含 install（"verify 在一次性工作区重跑，没有提交者本机的全局依赖与环境"）。skill 完全没提这件事，agent 无法得知「走 runner = spec 一次写对的概率更高」。
2. **上游 skill 的措辞错配**。pi-cw skill 三处称 cw-cli 为「单 agent 模式」（"能单 agent 线性走完的任务……走 cw-cli skill 单 agent 模式"），agent 读到的信号是「cw-cli = 我自己开车」。（该问题归 pi-cw 侧改造，见 xyz-agent 仓 `docs/todo/pi-cw-cw2-adaptation.md`。）

### 2.4 用户心智错配

用户说「走 cw-cli 模式」时的预期是 runner（"cw-cli 内部 spawn pi 进程"），skill 教出来的是手动。**改造后的 skill 必须让「走 cw-cli 模式」的默认解读 = 多 unit 走 runner**，否则文档与用户心智持续冲突。

## 3. 解决方案

### 3.1 终态（使用者视角）

场景 A（多 unit 任务）：用户对 agent 说「走 cw-cli 模式开发 X」（X 含 3 个以上可拆单元）。agent 读 skill → 命中模式分流表 → 判断「≥2 unit」→ 走 runner 路径：建 root + 子 unit、提交 spec、然后 `cw run --root <id> --spawn pi` 后台运行，期间用 `cw status` 观察，escalation 出现时处理或上报，root closed 后汇报。agent 不手动派 dev/reviewer subagent。

场景 B（单 unit 调试）：agent 在 runner 流程外单独验证某条验收命令是否过 gate → 命中分流表「单 unit 调试」→ 走手动流程（现行 5 步内容，原样保留）。

场景 C（manual 验收）：任务含必须人工确认的 GUI 验收。agent 从 runner 章节了解到：manual 型验收免机器验证、verify 直接跳过并自动并入覆盖（`src/verify/run.ts` / `src/runner/loop.ts`）——若需要强制人工验收点，应把该验收声明为 e2e 级、command 用「检查人工勾选文件」的 gate 脚本（未勾选则 FAIL），而不是声明为 manual 型。

### 3.2 候选方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|---------------|--------------|------|
| **方案 1：结构重构（推荐）**——决策表后紧跟模式分流表；runner 章节提到手动流程之前并扩写（循环语义 / 角色 spawn / worktree / escalation / manual 验收语义 / 后台运行与监控）；「手动流程」改名为「手动流程（单 unit 调试与降级路径）」；Self-Check 拆双路径；description 改写 | 文档结构与 cw 2.0 组件定位一致：runner 是编排层，手动命令是账本原语。新增模式只改分流表一行 | 重写约 40% 内容（runner 节从 15 行扩到约 60 行，其余为移动与改名） | 低：纯文档；风险点是扩写内容的准确性——所有运行时断言须与 `src/runner/` 源码逐条核对（本设计 §3.3 已核对） |
| 方案 2：最小补丁——决策表加一行 + 一句 [MANDATORY]「多 unit 必须 runner」 | 差：100 行手动流程的篇幅惯性仍在；session 教训证明 agent 自审时都不会回看 15 行的 runner 节，加一行表难以对抗整体结构 | 最低（~10 行改动） | 高：大概率高估效果，等于没改 |
| 方案 3：拆两个 skill（cw-cli-manual + cw-runner） | 中：路由更硬，但 skill 发现层按 description 竞争，两 skill 描述必然大面积重叠，触发不稳定；用户「走 cw-cli」的心智要重训 | 高：发布两个 skill、处理发现竞争 | 中：触发不确定引入新失败模式 |

**推荐方案 1**。理由：问题本质是信息架构，不是缺一行规则；方案 2 是对症状下药（session 自审已证明「有一节讲 runner」不足以让 agent 在决策点想起它）；方案 3 引入的发现层复杂度大于收益。

若用方案 2，§2.1 的场景会复现：agent 读完 skill，注意到手动流程是主体，分流表一行被「什么时候该用 CW」的语境吸收（该行回答的是「用不用」，不是「用哪个模式」），继续手动。

### 3.3 关键决策与权衡

- **D1：分流判据用「unit 数 ≥2 或需并行」，不用任务规模主观词**。判据必须机器可判（agent 建树前数得出来），「复杂任务」这类词会重新引入自由裁量。深度上限 2（根 + 叶）内的多 unit 全部适用 runner；超过 2 层的树 cw 2.0 不支持，skill 需明说此边界（超出时拆成多个 root 分别 run，或先人工降层）。
- **D2：runner 扩写内容的边界 = 使用必需的运行时语义，不复制引擎文档**。入选标准：agent 不用就会踩坑的语义。清单（均已对照源码核实）：① 循环 = frontier → 批次派发 → 等退出 → 证据回收 → 重算，直到 root closed 或仅剩转人工（`src/runner/loop.ts`）；② 角色 spawn 与独立 reviewer 强制（mx-1，designer 任务书不含自审步骤）；③ 每 unit 独立 worktree + 集成 merge 回流（`worktree.ts` / `integrate.ts`）；④ manual 型免机器验证自动并入覆盖（`verify/run.ts`、`loop.ts`）；⑤ 转人工出口：specReviewDeadlock（默认打回 10 代）/ specContractDeadlock（回炉 ≥2 代）/ flakeReview（连挂 ≥2）→ stderr + 无其他可派发时 exit 1；⑥ `cw run` 前台阻塞长跑、Ctrl-C 后重跑从投影续接——实操上应用后台方式运行并定期 `cw status` 观察；⑦ 模型链：developer / designer 走 `CW_AGENT_MODEL`（缺省 `xiaomi-token-plan-cn/mimo-v2.5-pro`）；reviewer 走 `--reviewer-model` > `CW_REVIEWER_MODEL` > 回落 developer 同款（`cw run` CLI 面无 `--model` flag——实施时修正：原文「--model / CW_AGENT_MODEL / 默认」是 pi 适配器内部的 resolvePiModel 三级解析链，不是 run 的命令面）。✅ 以上 7 条均已读源码核实（2026-08-21，cw 2.0.0 dist；⑦ 按 `src/handlers/run.ts` / `src/runner/spawn/pi.ts` 实测修正）。
- **D3：手动流程内容保留，除事实性修复**。问题在位置与定性，不在教学结构；但实施核对（E6）发现两处命令照文档执行会 exit 1（spec-review 缺必填 `--role reviewer`（mx-3）；exec-review 缺必填 `--evidence-refs`（rv-2））及三处过时（verify 红阶段 flag 方向实为 `--no-red-phase`（默认执行）；spec gate 表只列 ①-⑥ 实为九规则；「两个适配器」实为四个），实施时一并修复（见文末「实施修正记录」）。「session 验证了可操作性」的说法不成立——session 是靠 exit 1 错误文案现场自救补的参数，不是文档准确。
- **D4：description 两模式并陈，消除手动暗示**。改为「…两种模式：多 unit 任务用 runner 自动调度（`cw run --spawn pi`），单 unit 调试用手动逐步交证据（create → evidence → verify）…」。description 是 skill 触发层面的第一印象，与正文分流表口径一致。
- **D5：Self-Check 拆双路径**。runner 路径判据 = root closed + 无未处置的转人工清单 + `cw report --root <id>` 验收覆盖无 ✗；手动路径维持现 5 条。防止「runner 跑完了但一半单元转人工没人管」被当成完成。

## 4. 验收

> 全部在真实 pi session 验证（skill 的消费场景就是 agent 读 skill），非单测非文档走读。实施方式：coding-workflow 仓改完 SKILL.md 后无需重新发版即可测——`~/.agents/skills/cw-cli` 是指向 npm 安装目录的 symlink，但本地仓改动要等发版才生效；测试期可用 `XYZ_EXTENSION_PATHS` 或直接改 npm 目录下的副本模拟（以实际测试环境为准，实施时确认最快的生效路径）。

- **场景 1（回溯 G1/G4，核心场景）**：开一个全新 pi session，给它一个 ≥3 unit 的真实编码任务（例：「走 cw-cli 模式开发 Y」，Y 选自 xyz-agent 或 coding-workflow 仓的真实小特性，需拆 3+ unit），观察：agent 是否在不加任何提示的情况下选择 `cw run --root <id> --spawn pi` 并后台运行；全程是否不手动派 dev/reviewer subagent。通过标准 = agent 首轮行动即建树 + 启动 runner，且能说出 escalation 出现时的处理路径。
- **场景 2（回溯 G2）**：全新 session 给单 unit 任务（例：「给 cw 的 frontier 输出加 --json 之外的一个只读小改动并走 CW 验证」）。通过标准 = agent 走手动流程且不启动 runner。
- **场景 3（回溯 G3，manual 语义）**：全新 session 给含人工 GUI 验收的多 unit 任务。通过标准 = agent 不把这些验收声明为 manual 型后放任 runner 自动并入覆盖，而是采用 gate 脚本方案或显式说明人工验收点在 runner 之外。
- **场景 4（回溯 G1，复盘视角）**：全新 session 里粘贴 §2.1 的失败案例摘要，问「这个 session 符合 cw-cli skill 吗」。通过标准 = agent 的首次回答即指出模式选择错误（应走 runner），而非只对齐手动流程做合规评分。

## 5. 下一层拆分

按 SKILL.md 的编辑单元拆（每个编辑单元独立可验：改完直接重读对应章节检查）：

| # | 编辑单元 | 内容 | justification |
|---|---------|------|---------------|
| E1 | frontmatter description | 按 D4 改写 | skill 触发层第一印象，独立可见效 |
| E2 | 决策表 + 新增模式分流表 | 「什么时候该用」表后紧跟分流表（判据按 D1），加 [MANDATORY]「多 unit 任务用 runner，禁止手动逐 unit 编排替代」 | 决策链最上游，是 G1 的主承载 |
| E3 | runner 章节提前 + 扩写 | 移到「手动流程」之前；按 D2 七条清单扩写 | runner 从捷径变为默认路径的核心改动 |
| E4 | 「手动流程」改名 | 标题改「手动流程（单 unit 调试与降级路径）」，加一段「何时该用手动」 | 内容不动（D3），只改定位 |
| E5 | Self-Check 拆双路径 | 按 D5 | 完成判据防漏 |
| E6 | 事实核对 | 全文命令面 / 默认值 / 语义与 cw 2.0.0 `src/` 逐条核对（重点：D2 七条） | skill 的权威性和 cw 版本绑定，防文档漂移 |

实施顺序：E2 → E3 → E4 → E5 → E1 → E6（先结构后措辞，E6 最后兜底）。全部在一个 commit 或按编辑单元拆 commit 均可，无依赖冲突（单文件）。

待验证检查点（实施时确认）：① 场景 1 前确认测试环境 skill 生效路径（npm 目录副本 vs 发版）；② D2 第⑥条「后台运行」的具体写法按消费方 harness 而定（pi 的 bash-async background 模式），skill 里只写「后台运行 + 定期 cw status」，不写死具体工具名——cw 是 agent-agnostic 包。

## 实施修正记录（2026-08-21，实施时对照 src/ 发现并同步修正）

1. **D3「原样保留」与 E6 矛盾**：手动流程两处命令照抄必 exit 1——spec-review 缺 `--role reviewer`（`src/handlers/review-submit.ts`，mx-3 起 spec-review 的 role 必填且必须 reviewer）；exec-review 缺 `--evidence-refs`（rv-2 起必填 ≥1 已入账 runId）。D3 已改写为「内容保留，除事实性修复」。教训：写「原样保留」前应先核对内容是否仍与实现一致——skill 写于 mx/rv 波次之前，后续波次改了命令面没回写 skill。
2. **D2 ⑦ 模型链原文不准确**：`cw run` CLI 面无 `--model` flag（`src/handlers/run.ts:2`）；原文三级链是 pi 适配器内部解析（`src/runner/spawn/pi.ts` resolvePiModel）。实际面 = developer 走 `CW_AGENT_MODEL`（缺省 mimo）、reviewer 走 `--reviewer-model` / `CW_REVIEWER_MODEL` > 回落 developer 同款。D2 ⑦ 已改写。
3. **测试生效路径已确认**（§4 待验证检查点 ①）：`~/.agents/skills/cw-cli` symlink 直指 npm 安装目录（`~/.nvm/versions/node/v24.11.1/lib/node_modules/@zhushanwen/coding-workflow/skills/cw-cli`），直接编辑 npm 目录下的 SKILL.md 副本即对新 session 生效；正式生效走 quick-release 发版（本次实施走发版）。
4. E6 兜底核对补充修复：spec gate 表补全 ⑦⑧⑨（含 pytest 禁 `-q`/`--quiet` 及前缀缩写、vitest/playwright 的 `--reporter=json` 等号形态唯一幂等等契约）；适配器节改四适配器（vitest / e2e-sh / pytest / playwright，后两者需显式 `runner` 声明）；命令一览补 `report --root`、`run --reviewer-model` / `--max-spec-rejects`、`review submit --role` / `--evidence-refs`；环境变量表补 `CW_REVIEWER_MODEL`；转人工四出口阈值全部源码核实（specReviewDeadlock 默认 10 代 / specContractDeadlock 回炉 ≥2 代 / flakeReview 连挂 ≥2 / spawn 连续 2 次 TIMEOUT）；verify 超时默认值核实（unit 600000ms / e2e 1800000ms，`src/verify/run.ts` 常量）；前置检查补「`--spawn pi` 需 PATH 有 pi」。

## 附：交叉引用

- 事故 session：pi session `01a01fda-caa8-7ebc-8cd4-4db98745056a`（T005-T007 含该 session 的自审与改进提案原文）
- pi-cw / cw-tool 侧配套改造设计：xyz-agent 仓 `docs/todo/pi-cw-cw2-adaptation.md`
- 相关源码锚点：`src/runner/loop.ts`（调度循环与转人工）、`src/runner/brief.ts`（designer 任务书内置契约）、`src/runner/spawn/pi.ts`（pi 无头 spawn 形态）、`src/verify/run.ts`（manual 免机器验证）
