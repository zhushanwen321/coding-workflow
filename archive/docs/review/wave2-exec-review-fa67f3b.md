# Exec-Review: wave 2 (delete-orchestration-config) — commit `fa67f3b`

**范围**：fa67f3b（主体 21 文件 +156/-774）+ 2c3deda（testfix）。删除 orchestration 死配置整链 + 废弃 cw.config.json（CwConfig/loadCwConfig）。

**结论先行**：功能正确、删除干净度整体高（serial 路由 + 三档委派文案完整保留，tsc clean、929/930 tests pass）。**needs-followup**：发现 1 个 must-fix——stage 模板的 `dispatchGuidance` 字段在唯一消费者被删后成为死配置残留（4 处），且注释仍描述已删除的 recursive 行为，与本 wave「删死配置」目标及 ADR-0013「无 dead code」自述矛盾。

## 验证矩阵

| 关注点 | 结论 | 证据 |
|---|---|---|
| types.ts：OrchestrationMode + CwDeps.orchestration 删除 | 干净，无残留 | diff 全删 type + field；src/ 无 `orchestration`/`OrchestrationMode` 残留引用 |
| execute.ts（slice/feature/epic）descend 简化 | 正确 | `firstChildId===undefined?undefined:descend`，serial 行为不变 |
| closeout.ts（root wave + slice/feature/epic）ascend 简化 | 正确 | `parentUnitId?ascend:undefined`，serial 行为不变 |
| cross-layer.ts：recursive 抑制分支删除 | 干净 | serial 路由（sibling→ascend via store.findChildren）完整；OrchestrationMode import 删除 |
| subagent-guidance.ts：serial 三档保留 + recursive 段删除 | 干净 | 「建议/按需/不建议委派」逐字保留；dispatch/续 turn/ChildLayer/BuildSubagentGuidanceOpts 全删；签名 3→2，8 处调用点全同步（subagent-guidance.test.ts 23 pass） |
| render.ts：store 死参级联清理 | 干净 | renderHandoffSelf/Brief/NextStepSection/buildGuidanceForScope/buildCurrentGuidanceForScope 删 store+orchestration；renderHandoffSelf body 确认零 store 引用；Upstream/Full 正确保留 store（祖先/子树遍历）；renderHandoff 全部 caller（cli.ts + tests）已改 |
| cli.ts：CwConfig/loadCwConfig/constructCwDeps 注入删除 | 干净 | constructCwDeps 不再引用 `config`；testRunner.run（wave1 per-wave testCwd）不受影响；src/ 无 loadCwConfig/CwConfig 残留（仅 ADR-0013 + tests 的 `.not.toContain` 断言引用） |
| internal.ts + 3 *-internal.ts 透传 | 一致 | orchestration 线程全部切除，buildSubagentGuidance 全 2 参；childLayer 残留：无 |
| 2c3deda testfix | 合规 | wave1 模板「纯 testCommand」→「纯 testCommand/testCwd」后断言对齐（wave.ts:133 已含新串），非掩盖真实问题 |

## 维度评分

### readability: 4/5（良好，小瑕疵）
- 整体删除干净，注释同步更新（execute/closeout 的 G5 recursive 注释已替换为 serial 描述，cross-layer 路由注释准确）。
- 扣分项：stage 模板 4 处 `dispatchGuidance` 注释仍描述「recursive 模式渲染为...」/「G5：recursive 模式 wave 是叶子...」，引用已删除行为，误导后续读者（见 ISSUE 1）。

### architecture: 4/5（良好）
- crossLayer 正确降级为纯 serial 导航（descend/sibling/ascend），subagent-guidance 三档保留，Upstream/Full 保留 store 遍历判断正确，testRunner cwd 与 config 解耦到位。
- 扣分项：dispatchGuidance 死字段残留 + ADR 文件归属错误，使「代码契约 / ADR 自述 / 实际代码」三者未完全对齐（见 ISSUE 1、ISSUE 2）。

### codeSmells

| severity | 位置 | 问题 |
|---|---|---|
| major | 见 ISSUE 1（4 处） | dispatchGuidance 死字段 + 误导注释残留 |
| minor | 见 ISSUE 2（2 处） | ADR-0013 把 CwConfig 删除错归到 types.ts |

## 详细问题

### ISSUE 1 [major / must-fix]：stage 模板 `dispatchGuidance` 死字段残留 + recursive 误导注释

subagent-guidance.ts 是 `template.dispatchGuidance` 的唯一消费者（recursive 续 turn 段）。本 commit 删除了该段，但模板侧的字段定义与 2 处实例化值被遗漏，现在**零消费者**——恰好是本 wave 要清除的「无消费者死字段」类别。

- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/src/guidance/templates/wave.ts:35` — `WaveStageTemplate.dispatchGuidance?: string` 接口字段，注释「续 turn 指导（recursive 模式渲染为 subagent 调度段的「【续 turn】」行；serial 不渲染）」
- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/src/guidance/templates/wave.ts:118` — `WAVE_CLOSEOUT_TEMPLATE.dispatchGuidance` 值，注释「G5：recursive 模式 wave 是叶子，closeout 后该结束——不自己 ascend/sibling（steer 负责唤醒父）。」
- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/src/guidance/templates/planning/index.ts:34` — `PlanningStageTemplate.dispatchGuidance?: string` 接口字段，同 recursive 注释
- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/src/guidance/templates/planning/execute.ts:26` — `PLANNING_EXECUTE_TEMPLATE.dispatchGuidance` 值，注释「G1 + G5：recursive 模式续 turn 指导...」

**为何 must-fix**：
1. 违反本 review 验收标准 #9「死参残留 / 注释残留误导」——`dispatchGuidance` 是死字段，4 处注释均描述已删除的 recursive 行为，是教科书级误导注释。
2. 自相矛盾：本 wave 目标即「删死配置」，却留下死配置；ADR-0013 正向自述「配置层架构干净，无 dead code 与无消费者字段」被此残留证伪。
3. ADR-0013 TC1 决策明确「不做下沉持久化、直接删除」——保留 dispatchGuidance 作为 forward-compat 与该决策相悖，无保留理由。
4. 无运行时风险（optional 字段、零读取），但属契约/一致性问题。

**建议**：删 `dispatchGuidance` 接口字段（2 处）+ 2 处实例化值 + 配套注释。删除后重跑 `npm run check:all` 与 `npm test` 应仍绿（零消费者，纯删除）。

### ISSUE 2 [minor / suggestion]：ADR-0013 把 `CwConfig` 删除错归到 `types.ts`

CwConfig 接口始终定义在 `src/cli.ts`（git 证实 `fa67f3b^:src/cli.ts:524`），types.ts 从未持有。ADR 两处错归：

- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/docs/adr/0013-cw-config-deprecation.md:52`（TC4 后果）：「`src/handlers/types.ts` 删 `CwConfig` 接口」
- `/Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-config-json/docs/adr/0013-cw-config-deprecation.md:79`（关联 代码落地 TC1/TC4）：「`src/handlers/types.ts`（删 `CwConfig` + orchestration 字段）」

**正确归属**：types.ts 删 `OrchestrationMode`（type）+ `CwDeps.orchestration`（field）；cli.ts 删 `CwConfig`（interface）+ `loadCwConfig`（function）。

**为何 minor**：删除真实发生（非虚构），仅文件归属错误。后续读者据 ADR 追溯改动会在错误文件查找。验收标准 #8「ADR 与代码一致，无虚构」的边缘 case。低优先，可与 ISSUE 1 一并修。

## overallVerdict: `needs-followup`

1 个 must-fix（ISSUE 1，dispatchGuidance 死字段 + 误导注释残留）+ 1 个 suggestion（ISSUE 2，ADR 文件归属）。

## followupActions

1. [high] 删 stage 模板 `dispatchGuidance`：`wave.ts`（接口字段 + WAVE_CLOSEOUT_TEMPLATE 值）、`planning/index.ts`（接口字段）、`planning/execute.ts`（PLANNING_EXECUTE_TEMPLATE 值）+ 配套 recursive 注释。
2. [low] 修 ADR-0013:52 与 :79，CwConfig 归属改为 `src/cli.ts`，types.ts 改为「删 OrchestrationMode + CwDeps.orchestration 字段」。
3. [verify] 两项改完跑 `npm run check:all` + `npm test`，预期仍 929 green（纯删除 + 文档订正，无逻辑变更）。
