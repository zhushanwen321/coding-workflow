# 方向 B：并行调度补位（消费侧）

> **层次声明**：本文档是方向 B 的立项设计——当前层为「并行调度消费补位」，下一层是具体实施（死锁修复 / 模板协议 / 确定性派发代码）。父文档与整体裁决见 [README](./README.md)。
>
> **重要边界**：本方向**不动 cw 引擎的调度行为**（ADR-0011 裁决：cw 保持 agent-agnostic，只提供数据视图与单值导航，调度决策归消费者——该架构理由依然成立）。所有补位发生在消费侧（xyz-agent `extensions/cw-tool`）与 pi subagent 基础设施。

**一句话结论**：并行基础设施已 100% 齐备但 0 消费——先修派发死锁（B0 硬前置），再用「模板协议批次派发」起步（B1）、以「确定性 frontier 批次派发」收尾（B2），让就绪 wave 批次真正并行推进。

## 1. 背景目标

### 系统是什么（受众补足）

cw 引擎的四层拆分里，slice 通过 `plan.split[]` 声明子 wave，每个 `Split` 有 `dependsOn: string[]` 字段（声明 wave 间依赖）。slice execute 时一次性创建全部 child wave。引擎提供：

- **`cw frontier` 只读命令**（`src/core/frontier.ts:164-265`）：递归子树扫描（DFS 前序，:268 JSDoc 自述）+ 两遍计算，返回每个非终态节点的 `blocked` / `dependsOn` / 就绪数——这就是为并行调度设计的数据源；
- **`ActionResult.children`**（`src/handlers/slice/execute.ts:72-83`）：execute 返回值携带 `{unitId, dependsOn}` 列表，注释明说「供递归调度器消费」；
- **DAG 无环 gate**（`design-review.ts:562-623` 三色 DFS 判环）与**跨 wave 文件冲突 gate**（`noSiblingWaveFileConflict`，:142-193）——并行安全网已在；
- **per-item 扇出上限**（`src/rules/gates/fan-out.ts:12-14`）：限的是**单个被继承条目最多被几个 split 继承**（slice→wave 6），**不限 slice 的 wave 数量**（实测最大 7 wave/slice）——批次规模没有引擎上界，资源约束全在消费侧。

但引擎的**导航**是刻意单值串行的（ADR-0011 回退后的行为）：slice execute 后 `crossLayer.descend` 只指向第一个 child wave（`execute.ts:95-104`）；wave closeout 后兄弟路由用 `.find()` 取第一个非终态兄弟、不查依赖是否满足（`src/guidance/cross-layer.ts:75-80`）。**这不是 bug，是「调度归消费者」的架构裁决。**

消费侧现状（xyz-agent `extensions/cw-tool/agents/`）：planning-agent.md 第 48 行「对每个子单元派 subagent（下层 planning-agent 或 wave-agent），后台启动」——并行 fan-out 靠 agent 自递归，**全文无 dependsOn / 拓扑排序字样**（grep 零命中）；派 wave-agent 的模板带 `worktree: true / fork: false`。

### 问题

**数据画像（2026-08-14 复核）**：兄弟 wave 执行区间（execute→closeout）重叠仅 **7 对 / 121 对串行（94.5% 串行）**；create→execute 中位 30.3 分钟（占 wave 总时长中位 44.3 分钟的约 2/3）——wave 在排队，不是在干活。

时间线证据（store 毫秒级时间戳，`v4-lifecycle-convergence` slice）：6 个 wave 同一秒创建；a2 execStart 02:04:32.303、tested 02:06:43.111，a5 execStart 02:06:43.467——**晚 a2 的 tested 仅 0.356 秒**；a1 execStart 02:37:58.647 在 a5 closed（02:22:30）之后。execute 阶段零重叠、秒级接续。另一个信号：design 阶段曾出现三 wave 1 秒内并行启动（01:51:06/07/07）——**LLM 有并行意愿，但没有任何协议告诉它 execute 也该分批并行，于是退化串行**。

**责任真空**：并行调度在 cw 侧实现过（ADR-0011，parallelTargets + 伪 Kahn），2026-08-04 整体回退，理由是「pi 的 recursive-split workflow 已接管」；接管者 recursive-split.js 于 2026-08-06 被删除（commit `a03664e81`）；消费侧 agent 自递归编排 2026-08-13 撞上 keep-alive/session-pending 死锁（commit `f156838a6`），verify/wrap-up 类 wave 退回线性串行。**回退的前提已失效，但回退没有跟着撤销；补位也没有发生——调度掉在两层之间的缝里。**

### 目标（G2，回溯父文档）

有依赖声明的兄弟 wave 按就绪批次推进，不再 94% 串行。

**in scope**：pi subagent 派发死锁修复（B0）；cw-tool 的 planning-agent 模板与派发逻辑（B1/B2）；引擎侧仅补 `Split.dependsOn` 的文档与模板说明（数据可发现性，不改行为）。

**out of scope**：引擎侧 parallelTargets / crossLayer 多目标改造（ADR-0011 边界）；复活 recursive-split.js workflow 宿主；pi subagent 基础设施整体重设计。

## 2. 现状与问题分析

### 2.1 能力与消费的对照表

| 能力 | 位置 | 消费现状 |
|---|---|---|
| 依赖声明 `Split.dependsOn` | `src/core/plan.ts:49` | 无 JSDoc 裸字段；planning design 模板（`templates/planning/design.ts`）全文无 dependsOn 语义说明——agent 只能从 gate fail 文案里被动学到它的存在 |
| DAG 无环校验 | `design-review.ts:562-623` | 在用（design-review 必过） |
| 就绪计算 `cw frontier` | `src/core/frontier.ts` | planning-agent 工具白名单已含 `frontier`（`cw-tool/src/index.ts` PLANNING_ALLOWED），模板也提到过它——但仅在被唤醒查进度的语境（planning-agent.md:52/:116），**从未引导在派发前用 frontier 计算就绪批次** |
| 文件冲突 gate | `noSiblingWaveFileConflict` | 在用；fail 文案已提示「在 parent slice 的 split 里声明 dependsOn 串行化」——引擎把串行化责任留给设计者声明，执行侧没人消费 |
| 批量后台派发原语 | planning-agent.md:48 | 在用（无条件全量派出，不看依赖） |

### 2.2 死锁：并行的历史死因

2026-08-13 的 handoff 记录（commit `f156838a6`）：父 subagent 第一轮派发就被杀（keep-alive 机制与 session-pending 状态的交互），子完成信号回不来，wave 卡在 created/design-reviewed 无人推进。**workaround：verify/wrap-up 类 wave 退回线性单 agent 串行模式**（commit 原文 "linear subagent mode for verify/wrap-up waves"）——这是「三次设计三次回退」的最后一环，也是 B0 必须最先做的实证理由：死锁不修，任何并行协议都会在第一次派发失败后回退。

死锁排查不从零起步：f156838a6 的 handoff 已给出具体根因假设（SessionManager 延迟落盘与 session-pending 磁盘读取的矛盾）、失败时序、必验项与最小复现设计——B0 的工作是证实或证伪该假设。

### 2.3 为什么「无条件全量派出」不等于并行

现状 planning-agent 对每个子单元全部后台派出（不看 dependsOn），看起来已经并行，但实际效果分化：design 阶段确实并行启动了；execute 阶段退化串行。原因：各 wave-agent 之间无依赖协调——被依赖方未完成时依赖方要么空转等文件、要么乱序踩踏，LLM 在经验里学到「串行最稳」，于是自发排队。**没有确定性依赖协调的并行是噪声，最终收敛回串行。**

## 3. 解决方案

### 3.1 终态（使用者视角）

一个 slice execute 后：

1. planning-agent 调 `cw frontier --root <slice>` 拿就绪批次（如 wave A/B 就绪、wave C 依赖 B 阻塞中）；
2. **同 turn 后台派出 A、B 两个 wave-agent**（`worktree: true` 各自隔离）；
3. B closeout 后，planning-agent 再次调 frontier 发现 C 已就绪，派出 C；
4. 全部子单元终态后回 slice retrospect（引擎 crossLayer ascend 已支持）。

失败路径：
- 某 wave abort → **引擎语义警示**：aborted 属终态，引擎的依赖满足判定（`frontier.ts` 中 `every(dep ∈ {closed, aborted})`）把 abort 视为「已满足」——dependsOn 它的 wave 在 frontier 中会变**就绪**，引擎不会替消费侧拦截。因此 B1/B2 的批次计算必须显式剔除「依赖含 aborted」的 wave，转交 planning-agent 决策（replan slice 重拆，或显式确认可在部分失败之上继续）——**不允许在失败的工作之上静默继续建**；
- 派发失败/子 agent 失联 → B0 修复后不应发生；若仍发生，回退动作是逐个串行重派（现状路径保留为降级模式），流程不卡死。

### 3.2 方案对比

| | 方案一：模板协议起步 + 确定性代码收尾（推荐，B1→B2） | 方案二：直接确定性代码（跳过 B1） | 方案三：引擎侧恢复 parallelTargets / 复活 recursive-split.js（否决） |
|---|---|---|---|
| 内容 | B1：planning-agent.md 写死「execute 后调 frontier、按就绪批次同 turn 全派、阻塞 wave 不派」协议（软约束）；B2：把 frontier + 拓扑分批做成 cw-tool 内确定性代码（新 tool 或派发辅助命令），模板只消费结果 | 一步做 B2 | 改引擎 crossLayer 多目标 / 恢复 workflow 宿主 |
| 长期合理性 | 高：终态为确定性批次计算，派发是否也能程序化取决于 pi extension 能力（硬前置待验证，见 D6）；B1 的运行数据为 B2 定形态 | 高：批次计算确定性；但缺实际运行数据支撑批次算法选择（批内并发上限、worktree 资源约束下的分批策略） | 低：违反 ADR-0011「调度归消费者」边界；workflow 宿主维护负担正是当初删除原因 |
| 短期成本 | B1 模板改动小时级；B2 视形态 1-3 天 | 1-3 天，但缺实际运行数据支撑批次算法选择（批内并发上限、worktree 资源约束下的分批策略） | 引擎侧改动面大且 ADR 已否 |
| 风险 | B1 阶段靠 LLM 自觉，可能部分不遵守——但这正是 B2 的数据来源 | 批次策略拍脑袋定形的返工风险 | 三次回退史已证伪；crossLayer 单值语义被测试与渲染广泛依赖 |

**推荐方案一**。B1 不是最终形态，是 B2 的探针与数据收集器。

### 3.3 关键决策与权衡

**D1：B0（死锁修复）是硬前置。**
被否：先上并行协议、死锁出现再修。理由：历史已证伪——死锁的直接后果就是退串行（f156838a6）；带着已知死锁上并行，等于重演第三次回退。

**D2：B 依赖 A 的验证底座（实施顺序 A→C→B 的理由）。**
没有独立验证的并行，只是更快地批量产出未验证代码。方向 A 落地后，每个并行 wave 自带 E2E real 锚点，并行批次的质量才有兜底。A 与 B 无代码依赖，是**质量依赖**——若 A1 实验证伪导致 A 停止，B 仍可做，但需接受「并行放大未验证产出」的风险并显式记录该决策。

**D3：批内并发上限没有引擎上界，靠消费侧自律。**
fan-out gate 限的是 per-item 继承计数（slice→wave 6），**不限 slice 的 wave 数量**（实测最大 7 wave/slice）——批次规模无 gate 约束，只受 worktree 磁盘/进程资源约束。B1 阶段用保守值（批内 ≤ 3），B2 阶段按运行数据调整。标注为待验证。

**D4：串行路径保留为降级模式。**
批次派发任一环节失败（frontier 调用失败、派发超时）→ 回退到现状逐个派发。并行是加速器不是正确性来源，正确性来源是 gate 与 review。

**D5：引擎侧只补「可发现性」。**
`Split.dependsOn` 补 JSDoc + planning design 模板补一句语义说明（「声明子单元依赖；未声明的拆分视为可并行，声明了依赖的会按 frontier 的 blocked 反映」）。这是文档级改动，不改任何调度行为，不违反 ADR-0011。

**D6：B2「确定性」的边界与硬前置。**
若 B2 只是「工具内部算批次」，**派发动作仍由 planning-agent（LLM）逐个 subagent 执行**——此时确定性主张仅覆盖「批次计算正确」，「同 turn 全派、阻塞不派」的遵守仍靠模板协议约束 LLM。要使派发本身程序化，cw-tool 需具备编程式 spawn subagent 的能力（pi extension API 是否提供，未验证）——列为 B2 硬前置：若不可行，B2 收益止于批次计算确定性，G2 的达成程度依赖 B1 协议的实际遵守率（观察数据见 V-B1/V-B2 的对照）。

## 4. 验收

| 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| V-B0 死锁不再复现 | 重放 f156838a6 记录的死锁场景（父 subagent 第一轮派发即被杀） | 子完成信号可回收，wave 状态可推进；连续 3 次复放无卡死 | G2 前置 |
| V-B1 批次推进（模板协议） | 在 xyz-agent 选一个真实 slice（3+ wave、声明 dependsOn）走 B1 协议 | 就绪 wave 的 execute 区间时间戳重叠（store statusHistory 可查）；被依赖 wave 未完成时依赖方无 execute 记录 | G2 |
| V-B2 确定性批次 | 同上场景走 B2 确定性代码 | 同 V-B1，且批次计算不依赖 LLM 判断（代码路径可单测：给定 split/dependsOn/状态 → 断言批次输出） | G2 |
| V-B3 冲突防护有效 | 构造两个并行 wave 改同一文件的 split（无 dependsOn 声明） | `noSiblingWaveFileConflict` 在 design-review 拦截（引擎已有，本场景验证并行场景下确实生效） | G2 |
| V-B4 降级不卡死 | 人为制造派发失败（kill 一个子 agent） | planning-agent 降级逐个重派，slice 最终可达 retrospect；无 wave 永久滞留 created/designing | G2 |
| V-B5 收益度量 | 对比实施前后各 10 个 closed wave 的 create→execute 中位 | 实施后显著下降（基线 30.3 分钟；预期降幅 > 30%，标注为软目标） | G2 |

## 5. 下一层拆分

| 单元 | 位置 | justification |
|---|---|---|
| B0 死锁修复 | pi subagent 基础设施（keep-alive / session-pending 交互处，xyz-agent 侧） | 硬前置；从证实/证伪 f156838a6 handoff 的根因假设（SessionManager 延迟落盘 vs session-pending 磁盘读取）起步 |
| B1 模板协议 | `extensions/cw-tool/agents/planning-agent.md`（execute 后流程改为「frontier → 就绪批次 → 同 turn 全派 → 空闲；子 closeout 后重调 frontier 补派」）+ 派发模板参数化 | 小时级改动，立刻可试；产出 B2 需要的运行数据 |
| B1' 引擎可发现性 | `src/core/plan.ts`（dependsOn JSDoc）+ `src/guidance/templates/planning/design.ts`（一句语义说明） | 文档级，随 B1 一起提交 |
| B2 确定性批次代码 | `extensions/cw-tool/src/`（frontier 结果 → 批次计算 + 派发辅助；形态实施期定：独立 tool 或 planning 工具内部逻辑） | 批次计算确定性（可单测，V-B2）；派发程序化以 D6 的能力验证为硬前置 |

**待验证检查点**：f156838a6 handoff 根因假设的证实/证伪（B0，最先做）；批内并发上限的合理值（D3）；pi extension 编程式派发（spawn subagent）能力——决定 B2 的确定性边界（D6）；B2 形态（tool vs 内部逻辑）——取决于 B1 运行中 LLM 对协议的实际遵守率。
