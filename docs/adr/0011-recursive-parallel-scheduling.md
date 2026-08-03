# ADR 0011: Recursive 并行调度（parallelTargets + scheduling + 文件冲突 gate）

## 状态

Accepted — 2026-08-03

## 背景

前序分支 `feat-recursive-problem-solving`（PR #6，落地见
[recursive-cw-enhancements-design-report](../recursive-cw-enhancements-design-report.md)）已交付
recursive 模式的**数据底座**：

- **C1**：`ActionResult.children`（含 `dependsOn`，供递归调度器拓扑排序消费）
- **C2**：`cw frontier` 只读命令（BFS 调度基建，返回非终态节点 + blocked/dependsOn/
  lastStatusHistoryAction）
- **C3-C6**：handoff FR/AC、layerSpecific schema 注入、retrospect optional、duplicate-split-slug gate

但**导航机制仍是串行 DFS**，消费不了这批数据：

1. **crossLayer 单值串行**：`crossLayer.descend` 在 execute 下沉时指向
   `childUnitIds[0]`（split 声明顺序首个）；`computeCrossLayerAfterCloseout` 的 sibling 分支
   用 `.find()` 取首个**非终态**兄弟。无论 execute 还是 closeout，agent 跟 `crossLayer` 只能
   一次推进一个目标。
2. **三层 closeout 硬编码 ascend**：`slice/feature/epic` 的 closeout handler（`slice/closeout.ts`、
   `feature/closeout.ts`、`epic/closeout.ts`）当前硬编码 `crossLayer = { kind: "ascend" }`，
   **从不走兄弟路由**（见各文件头注释「crossLayer 用 ascend，不走兄弟路由」）。
   `wave` closeout 才有 sibling/ascend/undefined 三态路由。
3. **并行无调度器**：`childUnitIds[]`、`Split.dependsOn[]`、`ChildInfo[]` 数据都预留了，
   `dispatch` 主流程却不消费 frontier/拓扑排序——算不出「就绪批次」。
4. **跨 wave 无文件冲突防护**：`src/rules/gates/design-review.ts` 没有任何 gate 检查兄弟
   wave 的 `plan.files` 交集。并行 wave execute 会真实产生同文件 git 冲突
   （两个 subagent 同时改 `src/foo.ts`），无机器检查拦截。
5. **递归指令无载体**：`subagent-guidance`（`src/guidance/subagent-guidance.ts`）是单 action
   委派建议表（mandatory/optional/forbidden 三档），无全局递归拓扑指令，也不区分 pi/非 pi
   环境。

这 5 点共同导致：feature/slice/wave 多兄弟无法并行推进，递归 subagent 树也无法落地——
即使数据底座（C1/C2）已就绪。

设计文档 `/tmp/cw-recursive-parallel-design.md` 经 **4 轮 worker→reviewer 审查循环**
（导航机制发散态、crossLayer/parallelTargets 一致性不变式、孤儿 parent 降级、跨 wave
文件冲突纳入范围），无 critical/major 遗留。

## 决策

**把 recursive 模式从「串行 DFS 导航」升级为「并行批次调度 + 递归指令载体」**，分 6 个
改动点，全部保持向后兼容（新增可选字段，`undefined` 时退化为现有串行行为）。

1. **`parallelTargets` 字段（`CwNextAction` 扩展，`src/handlers/types.ts`）**

   新增可选字段 `parallelTargets?: Array<{ unitId, action, satisfiedDependencies? }>`，
   语义为「当前 parent 下一批可同时推进的子 unit 集合」（execute 下沉 / closeout 回溯时填）。

   **与 `crossLayer` 并存**（不替换为数组，向后兼容现有 agent/测试/guidance 渲染）：
   - `crossLayer` 是「跨层方向」（descend/sibling/ascend），单值语义
   - `parallelTargets` 是「并行批次」，扁平 target 列表

   **一致性规则**（所有填 `parallelTargets` 的地方必须遵守，消除导航信号自相矛盾）：
   - `parallelTargets` 非空时 → `crossLayer.kind` 为 sibling（closeout）/ descend（execute），
     且 `crossLayer.targetUnitId === parallelTargets[0].unitId`（crossLayer 锚定首元素）
   - `parallelTargets` 空/undefined 时 → `crossLayer` 退化为 ascend / undefined
     （closeout 场景）或指向首个 child 的 descend（execute 场景）

   **核心不变式**：closeout 场景下，`crossLayer.kind` 不允许是 `sibling` 当 `parallelTargets`
   为空——即使原 `computeCrossLayerAfterCloseout` 因「非终态兄弟」返回 sibling，只要
   parallelTargets 为空（该兄弟被依赖阻塞），守卫必须降级为 ascend，避免指向死胡同。

2. **`core/scheduling.ts` + `hierarchy.isDependencySatisfied`（`src/core/scheduling.ts`、`src/core/hierarchy.ts`）**

   新增 `computeReadyChildren(parentUnitId, store)`：伪 Kahn 算法（无内存状态，每次从 store
   重算），返回该 parent 下一批「未终态且依赖全终态」的 child（按 split 声明顺序，不重排）。

   从 `hierarchy.ts` 抽 `isDependencySatisfied(dependsOn, store)` 共享函数——
   `scheduling`（局部导航）与 `frontier`（全局诊断）复用同一依赖判定，从源头消除重复实现。

   **保守降级**：`load(parent) === null`（孤儿 unit，parent record 不在 store）时直接返回空数组
   `[]`，不崩溃。这让现有「孤儿 parent」的三层 closeout 测试（feature/slice dispatch-e2e）
   恒走 ascend 分支，与原硬编码 ascend 行为等价。

3. **跨 wave 文件冲突 gate（`src/rules/gates/design-review.ts`：`noSiblingWaveFileConflict`）**

   wave design-review 阶段新增 gate：当前 wave 的 `plan.files[].path` 与兄弟 wave
   （同 parent slice，已 design-reviewed 之后）的 `plan.files[].path` 取交集，有交集则 gate fail。

   **纯函数 gate + handler 注入兄弟数据**：gate 本身保持零 IO（接收 `myFiles` + `siblingFiles`），
   wave design-review handler 负责从 `deps.store.findChildren` load 兄弟 wave plan.files 注入。
   维持 rules 层零 IO 不变量。

   **判定粒度**：按 path 字符串完全匹配，不做目录前缀包含判定（误报率高）。修复路径：
   agent 调整 files 划分，或在 parent slice 的 split 声明 dependsOn 串行化。

4. **三层 execute + wave/三层 closeout 并行回溯**

   - **execute（三层同构）**：填 `parallelTargets`（全部就绪 child）+ crossLayer 绑定
     `parallelTargets[0]`（兜底：无就绪 child 时退回 `childUnitIds[0]`）。
   - **wave closeout**：保留 `computeCrossLayerAfterCloseout` 三态返回值（被测试依赖），
     追加 `computeParallelSiblingsAfterCloseout` 算就绪兄弟集合；**发散态守卫**——
     `crossLayer.kind === "sibling"` 但 `parallelTargets` 为空（兄弟非终态但全被依赖阻塞）时
     降级为 ascend，回 parent 等待，不指向死胡同。
   - **三层 closeout（从硬编码 ascend 改为探测就绪兄弟）**：closeout 后用
     `computeParallelSiblingsAfterCloseout` 探测就绪兄弟——有则 `crossLayer = sibling`
     （指向首个就绪兄弟）+ `parallelTargets` 非空；无则 `crossLayer = ascend`（回 parent）。
     epic 顶层无 parent 走 undefined 分支（行为不变）。

5. **guidance 并行段（`src/guidance/build-guidance.ts`）**

   `buildNormalGuidance` 新增 `parallelTargets` 参数，**阈值 2**（`PARALLEL_TARGETS_MIN`）：
   2+ 项时追加「## 并行调度」段（位于「subagent 调度」之前），列出所有 target 的
   `unitId` + `action` + `cw <action> --unitId <id>` 命令；<2 项或 undefined 时不渲染
   （最小信息原则，避免噪声）。

6. **递归指令载体（全局 `AGENTS.md` 模板 + cw 触发信号）**

   - **全局 `AGENTS.md`**：新增「递归子 agent 编排模板」段（通用，不 for cw 单独）——
     编排规则：递归指令必须传递（子 subagent task 含「遵循 AGENTS.md 递归模板」引用）、
     递归终止、并行 fan-out、依赖协调、上下文隔离。
   - **cw guidance 触发信号**（`src/guidance/templates/planning/execute.ts` 的 `constraint`）：
     execute 模板加「【递归下沉】」段，提示「execute 本身是编排决策（主 agent 完成，不委派
     ——与 `PLANNING_RULES.execute = forbidden` 一致），下沉到子层后，子层的后续 action
     （从 clarify 开始）适合委派递归 subagent，若 parallelTargets 有多个目标则并行 fan-out」。

   **cw 保持 agent-agnostic**：只给信号（触发提示 + parallelTargets 数据），不感知 pi/非 pi
   环境、不替 agent 做 fan-out 决策。

## 替代方案

考虑过但不选：

1. **把 `crossLayer` 改成数组，不新增 `parallelTargets`**——被否决。破坏性变更：现有 agent /
   测试 / guidance 渲染都消费 `crossLayer` 单值，改数组会破坏全部下游。且语义不同——
   `crossLayer` 是「跨层方向」（descend/sibling/ascend），`parallelTargets` 是「并行批次」，
   混在一起会模糊方向语义。

2. **用真正的 Kahn 算法（维护入度计数器）**——被否决。cw 无内存调度状态，每次
   `cw <action>` 是独立进程，不能跨调用维护入度。改用「从 store 重算」的伪 Kahn——
   每次扫描所有 child 判断依赖是否全终态，结果等价于 Kahn「当前入度为 0 的节点集合」。
   O(n²) 在典型拆分（3-8 child）下完全可接受。

3. **三层 closeout 保持硬编码 ascend，不改 sibling/ascend 双分支**——被否决。这会让并行
   能力止步于 wave 层（只有 wave closeout 有 sibling 路由），feature/slice 兄弟仍无法横向
   推进。改造后三层 closeout 与 wave closeout 语义一致（先 sibling 后 ascend），并行能力
   延伸到所有层。

4. **废弃 `computeCrossLayerAfterCloseout`，统一用 `parallelTargets` 驱动 wave closeout**——
   被否决（方向 B）。该函数的 sibling/ascend/undefined 三态语义被 wave closeout handler 和
   测试依赖，改返回结构破坏面大。选方向 A：保持原函数不变，新增并行函数返回数组，守卫负责
   协调两者、消除发散态。

5. **跨 wave 文件冲突 gate 不做，靠事后 exec-review 兜底**——被否决。并行 wave execute 会
   **真实**产生同文件 git 冲突（两 subagent 同时改 `src/foo.ts`），事后兜底成本高（需 replan
   重建）。前置 gate 在 design-review 阶段拦截，提示 agent 调整 files 划分或声明 dependsOn
   串行化，成本低且符合「早发现」原则。

## 后果

**正面**：
- feature/slice/wave 多兄弟可并行推进（`parallelTargets` 输出就绪批次），递归 subagent 树
  有了数据驱动（pi 环境可 fan-out，非 pi 退化串行）
- `crossLayer.targetUnitId` 语义更正确：从「split 声明顺序首个 child」变为「首个就绪 child」
  （依赖链场景下两者不同——声明的 childUnitIds[0] 可能正被依赖阻塞，旧的会导向死胡同）
- 依赖判定逻辑集中到 `isDependencySatisfied` 一处，`scheduling` 与 `frontier` 复用，消除重复
- 跨 wave 文件冲突有前置机器检查，并行 execute 不会静默产生 git 冲突
- 递归指令有载体（AGENTS.md 模板 + cw 触发信号），且 cw 保持 agent-agnostic

**负面 / 注意**：
- **`crossLayer.targetUnitId` 语义变更**（轻微破坏性）：从「split 声明顺序首个 child」变为
  「首个就绪 child」。依赖链场景下两者不同。现有 execute 测试的 split 无 dependsOn，所有
  child 就绪，`parallelTargets[0]` 恰好 = `childUnitIds[0]`，故现有测试碰巧仍过——但语义
  已变，新增回归测试锁定新语义（断言 `targetUnitId !== A` 当 A 被依赖阻塞）
- **wave closeout sibling 测试需改造**：`tests/handler-guidance.test.ts:442-462` 构造孤儿
  parent + 非终态兄弟，发散态守卫会把 sibling 降级为 ascend，原 sibling 断言破裂——
  已改造为补建 parent record（消除孤儿态），让真实 sibling 路径被覆盖
- **三层 closeout 从硬编码 ascend 改为 sibling/ascend 双分支**：现有三层 closeout 测试都是
  孤儿 parent（parent record 不在 store），保守降级让 parallelTargets 恒空、恒走 ascend 分支，
  故无一破裂；但 sibling 分支的新行为需新增测试补齐
- **wave design-review 新增文件冲突检查**：兄弟 wave `plan.files` 交集会 gate fail，
  可能影响依赖「兄弟 wave 改同文件」的现有 wave 测试（若有）——本次实际改造未发现此类测试
- **`parallelTargets` 是新增可选字段**，向后兼容：`undefined` 时退化为现有串行行为，
  不破坏现有 `ActionResult` / `CwNextAction` 消费者

## 关联

- **前序**：[ADR-0010](./0010-cross-layer-abandon-parent-items.md)（跨层 abandon parent items
  声明能力，同属 cw-1-0-lifecycle-redesign 主题）
- **前序设计报告**：[recursive-cw-enhancements-design-report.md](../recursive-cw-enhancements-design-report.md)
  （`feat-recursive-problem-solving` 分支，落地 C1 `ActionResult.children` + C2 `cw frontier`，
  本 ADR 是其后续——C1/C2 提供数据底座，本 ADR 提供导航/调度/并行消费）
- **设计文档**：`/tmp/cw-recursive-parallel-design.md`（4 轮 worker→reviewer 审查，无
  critical/major 遗留；本次实施按其 §6 实施顺序 S1-S9 落地）
- **代码落地**：`src/core/scheduling.ts`（`computeReadyChildren`）、`src/core/hierarchy.ts`
  （`isDependencySatisfied`）、`src/handlers/types.ts`（`parallelTargets` 字段）、
  `src/guidance/cross-layer.ts`（`computeParallelSiblingsAfterCloseout`）、
  `src/rules/gates/design-review.ts`（`noSiblingWaveFileConflict`）、
  `src/guidance/build-guidance.ts`（并行调度段渲染）、
  `src/guidance/templates/planning/execute.ts`（递归下沉触发信号）
