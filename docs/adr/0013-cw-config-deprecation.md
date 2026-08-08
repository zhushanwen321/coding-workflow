# ADR 0013: 废弃 cw.config.json + 删除 orchestration 死配置 + testRunner.cwd 下沉为 per-wave testCwd

## 状态

Accepted — 2026-08-09

## 背景

`cw.config.json`（由 `CwConfig` 接口 + `loadCwConfig` 函数定义的项目级配置文件）承载三个字段，逐一核查后发现**全部是死配置或错位配置**：

1. **`orchestration`（parallelTargets / scheduling / 递归指令载体）完全无人消费**：
   - cw-runner（`pi-cw` 透传层）不读取、不透传 orchestration 段；
   - 5 个 `agent.md`（cw-tool 各阶段提示词）不依赖 cw-cli 的 orchestration 编排段；
   - `pi-cw` skill 自行 hardcode 编排逻辑，不经此配置；
   - **最关键**：recursive-parallel 调度链路已于 2026-08-04 全回退（见 [ADR-0011](./0011-recursive-parallel-scheduling.md)「回退」章节），orchestration 配置的唯一潜在消费者随之消失，自此成为纯死代码。
2. **`testRunner.cwd` 是 project-level 单值**：`loadCwConfig` 读出的 cwd 对整个项目所有 wave 生效。但 monorepo 多包项目里，不同 wave 的 `testCommand` 可能要在不同子包目录（`packages/auth`、`packages/core`）执行，单值 cwd 覆盖不了这种 per-wave 差异。
3. **`command` / `model` 早是死字段**：无任何代码读取。

唯一配套使用者 **cw-tool** 的 `agent.md` 已明确不依赖 cw-cli 的 orchestration 编排段——cw.config.json 没有真正的运行时消费者。

## 决策

### TC1：orchestration 直接删除（非下沉 per-topic 持久化）

- **决策**：删除 `orchestration` 配置项及其全部消费链路（`CwConfig` 字段 / `loadCwConfig` 读取 / guidance 渲染段 / handler 注入 / readonly 聚合渲染）。不做下沉到 per-topic 或 per-wave 持久化。
- **为什么**：recursive-parallel 回退后 orchestration 已是 dead code，下沉产出的持久化字段仍无人消费，是纯维护负担。直接删除才能让配置层与实际消费对齐。
- **备选**：下沉为 per-topic 可选字段保留扩展余地——被否，无消费者，保留即死配置。
- **后果**：`src/handlers/types.ts` 删 orchestration 字段；`src/guidance/{cross-layer,subagent-guidance}.ts` 删并行/递归渲染；`src/cli.ts` 删 orchestration guidance 段；`src/readonly/render.ts` 删 orchestration 渲染；`src/handlers/{closeout,internal,epic/*,feature/*,slice/*}.ts` 删 crossLayer orchestration 注入。
- `[from: /tmp/cw-config-cleanup-design.md TC1]`

### TC2：testRunner.cwd 下沉为 per-wave `WavePlan.testCwd`

- **决策**：把「测试执行目录」从 project-level `testRunner.cwd` 下沉为 per-wave 的 `WavePlan.testCwd`（`src/core/plan.ts`）。执行期 `testRunner.run` 的 cwd 取 `unit.plan.testCwd`：缺省回退 `workspacePath`（单包项目 = 仓库根）；相对路径相对 `workspacePath` resolve；绝对路径直用。
- **为什么**：目录配置应与 `testCommand` 同处一层（都是 wave 的执行属性）。per-wave 粒度才能表达 monorepo 多包测试目录差异。
- **备选**：保留 project-level cwd + 新增 per-wave 覆盖（双轨）——被否，双轨配置契约更复杂且 project-level 值无独立价值。
- **后果**：`src/core/plan.ts` `WavePlan` 增 `testCwd?`；`src/cli.ts` `constructCwDeps` 的 testRunner.cwd 改读 `unit.plan.testCwd`（保留 testRunner deps 注入机制不变，仅换 cwd 来源）；`src/handlers/design.ts` / `replan.ts` 透传 testCwd。
- `[from: /tmp/cw-config-cleanup-design.md TC2]`

### TC3：testCwd 可选（非必填）

- **决策**：`WavePlan.testCwd` 为可选字段（`testCwd?: string`），缺省即 `workspacePath`。
- **为什么**：`workspacePath` 是架构默认（单包项目测试就在仓库根跑）。强制必填违背最小必要原则，会给占多数的单包项目平添无意义字段。
- **备选**：必填 + design 阶段强制提示——被否，单包项目无此需求。
- **后果**：单包项目 wave design 可不填；monorepo 多包项目由 design guidance（`src/guidance/templates/wave.ts`）提示必须填。
- `[from: /tmp/cw-config-cleanup-design.md TC3]`

### TC4：cw.config.json 整体废弃（CwConfig 接口 + loadCwConfig 函数 + 文件约定全删）

- **决策**：删除 `CwConfig` 接口、`loadCwConfig` 函数及「项目根 cw.config.json 文件约定」。
- **为什么**：TC1 删除 orchestration、TC2 把 testRunner.cwd 下沉后，cw.config.json 再无有效字段（command/model 早是死字段）。整体废弃是对「配置契约与消费者长期脱节」的修正，而非局部修补。
- **备选**：保留空文件约定向后兼容——被否，空契约无意义且误导（让用户以为配置有效）。
- **后果**：`src/cli.ts` 删 `loadCwConfig`；`src/handlers/types.ts` 删 `CwConfig` 接口。
- `[from: /tmp/cw-config-cleanup-design.md TC4]`

### TC5：废除 `--testCwd` CLI flag

- **决策**：移除 `cw test --testCwd` CLI flag（从 `src/cli-params.ts` 白名单与 `src/cli.ts` 解析中删除）。调试期改 testCwd 统一走 handler：design progressive（design 阶段补）或 replan `testCommandOnly` 旁路（executing 在途 wave 补 testCwd，不触发重做 design-review）。
- **为什么**：维持「所有 plan 字段改动必经 design/replan handler 并 append statusHistory」不变量。`--testCwd` flag 绕过 handler直接改执行参数，破坏 plan 可追溯性。
- **备选**：保留 flag 但写 statusHistory——被否，flag 旁路 handler 会绕过 input 校验（typebox testCwd 非空校验）与 replan 旁路语义。
- **后果**：`src/cli-params.ts` test action 白名单移除 `--testCwd`；`src/handlers/replan.ts` 的 `testCwd` 旁路（`testCommandOnly` 路径）成为唯一在途修改入口。
- `[from: /tmp/cw-config-cleanup-design.md TC5]`

## 后果

- **正向**：
  - 配置层架构干净，无 dead code 与无消费者字段；
  - monorepo 多包项目的测试目录问题由 per-wave testCwd 解决；
  - cw-cli guidance 不再产出 orchestration 空转输出，agent 不再被无意义段误导。
- **负向 / 兼容**：
  - **存量项目的 `cw.config.json` 被静默忽略（不报错）**——文件存在但不再被读取。原 `testRunner.cwd` 需求由 per-wave `testCwd` 承接，受影响项目需在 wave design 阶段补填 testCwd。
  - cw-tool 运行时零影响（其 agent.md 不依赖 orchestration / testRunner 配置）；仅 cw-tool 侧文档（`design-v4.md` / `SKILL.md:92`）提及 cw.config.json 的描述需后续同步——非阻塞，列为后续清理项。

## 关联

- **前置**：[ADR-0011](./0011-recursive-parallel-scheduling.md)（recursive-parallel-scheduling，2026-08-04 并行调度链路全回退）—— recursive 回退后 orchestration 失去唯一潜在消费者，成为死配置，是本 ADR TC1 删除决策的直接前置。
- **设计文档**：`/tmp/cw-config-cleanup-design.md`（slice: cleanup-cw-config，techChoices TC1-TC5）。
- **代码落地**：
  - TC2 / TC3：`src/core/plan.ts`（`WavePlan.testCwd?`）、`src/cli.ts`（testRunner.cwd 取 `unit.plan.testCwd`）、`src/handlers/{design,replan}.ts`（testCwd 透传）、`src/handlers/types.ts`（`DesignInput.testCwd` / `ReplanInput.testCwd`）、`src/handlers/validate-input.ts`（testCwd 非空校验）、`src/guidance/templates/wave.ts`（testCwd 提示）。
  - TC1 / TC4：`src/handlers/types.ts`（删 `CwConfig` + orchestration 字段）、`src/cli.ts`（删 `loadCwConfig` + orchestration guidance 段）、`src/guidance/{cross-layer,subagent-guidance}.ts`、`src/handlers/{closeout,internal,epic/*,feature/*,slice/*}.ts`、`src/readonly/render.ts`。
  - TC5：`src/cli-params.ts`（test 白名单删 `--testCwd`）、`src/handlers/replan.ts`（`testCwd` 旁路为唯一在途修改入口）。
  - 测试：删除 `tests/recursive-orchestration.test.ts`（orchestration 死配置回归测试随实现删除）。
