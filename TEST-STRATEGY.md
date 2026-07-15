# 测试策略

> **always-current**。记录**测试策略**（金字塔/边界/门禁/约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；coding-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 现状速览

| 维度 | 值 | 来源 |
|---|---|---|
| 测试框架 | vitest ^3.0.0 | package.json devDependencies |
| 测试数量 | 393 passed \| 1 skipped（11 文件） | `npm test` 实跑 |
| 覆盖率工具 | 无（未配 c8/istanbul） | package.json 无 coverage 脚本 |
| Mock 框架 | 零（无 vi.fn / 无 mock 库） | tests/ 全量 grep 无 mock 调用 |
| 运行命令 | `npm test` → `vitest run` | package.json scripts.test |

测试文件清单（`tests/` 目录）：

| 文件 | 层 | 用例数 | 职责 |
|---|---|---|---|
| `cli-error.test.ts` | 单元 | 4 | CLI 错误处理 |
| `cli-params.test.ts` | 单元 | — | `buildParams` 参数构造 |
| `pure-functions.test.ts` | 单元 | 25 | 纯函数（judgeByExpected 等） |
| `types-new.test.ts` | 单元 | — | 类型验证（typebox schema） |
| `plan-parser.test.ts` | 单元 | — | plan.json / dev-plan.json / test.json 解析 |
| `state-machine.test.ts` | 单元 | — | checkLinear / computeNextStatus / computeGatePassed |
| `stats.test.ts` | 单元 | 39 | compute* 评估指标 |
| `store.test.ts` | 集成 | 51 | store DAO（真实 tmp 文件系统） |
| `gate.test.ts` | 集成 | 52 \| 1 skipped | gate 检查（devCheck / tddPlanCheck / testCheck 等） |
| `dispatch.test.ts` | 集成 | 63 | dispatch 层全 handler 测试 |
| `e2e.test.ts` | e2e | 6 | 真实子进程跑 `cw` CLI 全流程 |

> 用例数取自 `npm test` 实跑的 per-file 统计；标「—」的文件用例数未逐项核对，以实跑为准。

辅助文件：

| 路径 | 作用 |
|---|---|
| `tests/helpers/git.ts` | `setupGitRepo(repoDir)` 在 tmp 目录初始化真实 git 仓库 + 非空 commit；`commitFile(...)` 造指定文件的 commit |
| `tests/helpers/plan.ts` | `makeValidPlanJson` / `makeValidDevPlanJson` / `makeValidTestJson` / `makeValidClarifyJson` 构造函数 |

## 测试金字塔与边界

| 层 | 测什么 | 不测什么 | 对应文件 |
|---|---|---|---|
| 单元（纯函数） | 无副作用的判定与计算：`types.ts` 的 `judgeByExpected`、`stats.ts` 的所有 `compute*` 函数、`state-machine.ts` 的 `checkLinear` / `computeNextStatus` / `computeGatePassed`、`plan-parser.ts` 的解析、`cli-params` 的 `buildParams` | 不碰文件系统、不碰 git、不碰 store | pure-functions / stats / state-machine / plan-parser / types-new / cli-params / cli-error |
| 集成（dispatch） | 走完整 dispatch 路径：`loadTopic → guard(checkLinear) → handler → store 变更`，验证状态流转 + store 落盘 + gate 通过/失败 | 不 spawn 子进程、不跑真实 `cw` CLI | dispatch / store / gate |
| e2e（子进程） | 真实 `spawnSync` node 子进程跑 `dist/cli.js`，`CW_HOME` 指向 tmp 子目录（per-cwd 隔离），验证全链路：create → plan → tdd_plan → dev → review → test → retrospect → closeout | 不 mock 任何东西——入口/状态机/store/git 全部真实 | e2e |

**三层职责切分原则**：单元层保证判定逻辑正确（机器重算的核心防线）；集成层保证 handler 编排与 store 读写正确（覆盖每个 handler 的正常 + 异常路径）；e2e 层保证 CLI 入口到归档的整条链路不断裂。集成层不重复单元层的纯逻辑断言，e2e 层不重复集成层的 handler 细节——只验证「端到端跑得通」。

## 覆盖率门禁

| 项 | 现状 |
|---|---|
| 覆盖率阈值 | 无显式阈值（项目未配 c8/istanbul，CI 不卡覆盖率） |
| 门禁机制 | 靠 dispatch 层测试覆盖每个 handler 的正常 + 异常路径 |
| 新增 action 约定 | 必须加对应 dispatch 测试（项目约定，非 CI 强制） |
| CI 集成 | `npm test`（= `vitest run`），全绿即放行 |

**为什么不卡覆盖率数字**：CW 的价值是机器验证（judgeByExpected 机器重算、gate 机器校验、append-only 机器守卫）。这些核心不变式由 RB 基线（见下）守护，比覆盖率百分比更直接——一条 RB 失败就是事故，覆盖率 100% 不能替代。

## Mock 与测试数据约定

| 边界 | 约定 |
|---|---|
| 禁 mock（核心） | store / git 都用真实实现。**mock 掉验证逻辑（judgeByExpected、checkLinear、validateAppendOnly、GitValidator）就失去测试意义**——CW 的价值就是机器验证 |
| 真实 store | `CwStore` 写入 tmp 目录的真实文件系统，不 stub 读写 |
| 真实 git | `tests/helpers/git.ts` 的 `setupGitRepo()` 用 `execFileSync("git", ...)` 在 tmp 目录初始化真实 git 仓库 + 非空 commit（devCheck 的 GitValidator 校验 nonEmpty，diff-tree 需要有内容） |
| 测试数据 | `tests/helpers/plan.ts` 提供 plan.json / dev-plan.json / test.json / clarify.json 构造函数，通过 `overrides` 参数控制差异 |
| tmp 目录 | 每个测试独立 tmp 目录（`mkdtempSync`），测试间无状态共享；`CW_HOME` 指向 tmp 子目录实现 per-cwd 隔离 |
| git user 统一 | `setupGitRepo` 统一 `user.email=cw-test@test.com` / `user.name=CW Test`，统一 README 内容 |

## 不可回退基线（Regression Baseline）

> coding-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### RB-1 judgeByExpected 精确匹配  [from: cw-cli-extract]

- **用例来源**：`tests/pure-functions.test.ts` judgeByExpected 测试组
- **断言**：`expected.text` 与 `actual.text` 必须**精确 ===**，任何 fuzzy / trim / substring 容差都会破坏机器重算的意义（实现见 `src/types.ts:82-113`）
- **破坏即**：agent 谎报测试结果通过——CW 核心防线（机器重算 test gate）失效
- **关联约束**：NFR（test gate 机器重算）

### RB-2 checkLinear 防跳步  [from: cw-cli-extract]

- **用例来源**：`tests/state-machine.test.ts` guard 测试组
- **断言**：非 `expectedStatuses` 中的 status 调 action → `GuardError(code: "illegal_transition")`（实现见 `src/state-machine.ts:181-209`，guard 已从三重砍为单重 checkLinear）
- **破坏即**：agent 跳过 plan / dev / test 直接 closeout，状态机约束形同虚设
- **关联约束**：NFR S-2

### RB-3 replan append-only  [from: cw-cli-extract]

- **用例来源**：`tests/dispatch.test.ts` replan 测试组
- **断言**：已 committed wave 的 `changes` / `dependsOn` 不可删改，已 passed testCase 的 `expected` 不可改（`validateAppendOnly` 实现见 `src/actions.ts:1342`，4 种违规检测全保留）
- **破坏即**：agent 通过 replan 撤销已交付的 commit，让 plan 与 git 历史脱节
- **关联约束**：NFR C-2

### RB-4 e2e 完整流程跑通  [from: cw-cli-extract]

- **用例来源**：`tests/e2e.test.ts` E1
- **断言**：`create → plan → tdd_plan → dev → review → test → retrospect → closeout` 全链真实子进程跑通，最终 `status=closed`，evidence 写入
- **破坏即**：CLI 入口 / 状态机 / store 任一环节断裂，agent 无法完成任何编码任务
- **关联约束**：NFR V-1
