# 测试策略

> **always-current**。记录**测试策略**（金字塔/边界/门禁/约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；coding-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 现状速览

| 维度 | 值 | 来源 |
|---|---|---|
| 测试框架 | vitest ^3.0.0 | package.json devDependencies |
| 测试数量 | 608 passed \| 1 skipped（29 文件） | `npm test` 实跑 |
| 覆盖率工具 | 无（未配 c8/istanbul） | package.json 无 coverage 脚本 |
| Mock 框架 | 零（无 vi.fn / 无 mock 库） | tests/ 全量 grep 无 mock 调用 |
| 运行命令 | `npm test` → `vitest run` | package.json scripts.test |

测试文件清单（`tests/` 目录）：

| 文件 | 层 | 用例数 | 职责 |
|---|---|---|---|
| `cli-error.test.ts` | 单元 | 4 | CLI 错误处理 |
| `cli-params.test.ts` | 单元 | — | `buildParams` 参数构造 |
| `pure-functions.test.ts` | 单元 | 25 | 纯函数（judgeByExpected / 熔断 guidance 等） |
| `types-new.test.ts` | 单元 | — | 类型验证（typebox schema） |
| `plan-parser.test.ts` | 单元 | — | plan.json / dev-plan.json / test.json 解析 |
| `state-machine.test.ts` | 单元 | — | checkLinear / computeNextStatus / computeGatePassed |
| `stats.test.ts` | 单元 | 39 | compute* 评估指标 |
| `store.test.ts` | 集成 | 51 | store DAO（真实 tmp 文件系统） |
| `gate.test.ts` | 集成 | 52 \| 1 skipped | gate 检查（devCheck / tddPlanCheck / testCheck 等） |
| `dispatch.test.ts` | 集成 | 63 | dispatch 层全 handler 测试 |
| `e2e.test.ts` | e2e | 6 | 主链路 happy path（E1-E4：全链跑通 / 渐进式 dev / 非法跳步 / replan） |
| `e2e-clarify.test.ts` | e2e | 5 | clarify action（pending/resolved/progressive/不阻断 plan/非法状态） |
| `e2e-review-fix.test.ts` | e2e | 5 | review_fix loop（带 issues/修复/完整 loop/3 轮熔断/非法 issueId） |
| `e2e-test-fix.test.ts` | e2e | 5 | test_fix loop（失败/修复/完整 loop/5 轮熔断/非法 caseId） |
| `e2e-assess.test.ts` | e2e | 5 | assess（单次/progressive/defect/非法状态/缺 defect） |
| `e2e-readonly.test.ts` | e2e | 6 | stats/status/list 只读子命令 |
| `e2e-init.test.ts` | e2e | 6 | init 基建诊断（空目录/补齐 ready/骨架态/骨架闭环自洽/create 引导接线 ×2） |
| `e2e-gate-fail.test.ts` | e2e | 3 | gate fail retry / 5 次熔断 / fail 后重试成功 |
| `expected-multi-mode.test.ts` | 集成 | 27 | expected 多模式（exact/exit_zero/script）：judgeByExpected 分支、tddPlanCheck schema+沙箱、handleTest 执行 |

> 用例数取自 `npm test` 实跑的 per-file 统计；标「—」的文件用例数未逐项核对，以实跑为准。

辅助文件：

| 路径 | 作用 |
|---|---|
| `tests/helpers/git.ts` | `setupGitRepo(repoDir)` 在 tmp 目录初始化真实 git 仓库 + 非空 commit；`commitFile(...)` 造指定文件的 commit |
| `tests/helpers/plan.ts` | `makeValidPlanJson` / `makeValidDevPlanJson` / `makeValidTestJson` / `makeValidClarifyJson` 构造函数 |
| `tests/helpers/e2e.ts` | E2E 共享基建：`runCli` / `parseStdout` / `createE2eEnv` + 阶段推进 helper（`setupToDeveloped` 等，见下文「E2E 编写指南」） |

## 测试金字塔与边界

| 层 | 测什么 | 不测什么 | 对应文件 |
|---|---|---|---|
| 单元（纯函数） | 无副作用的判定与计算：`types.ts` 的 `judgeByExpected`、`stats.ts` 的所有 `compute*` 函数、`state-machine.ts` 的 `checkLinear` / `computeNextStatus` / `computeGatePassed`、`plan-parser.ts` 的解析、`cli-params` 的 `buildParams` | 不碰文件系统、不碰 git、不碰 store | pure-functions / stats / state-machine / plan-parser / types-new / cli-params / cli-error |
| 集成（dispatch） | 走完整 dispatch 路径：`loadTopic → guard(checkLinear) → handler → store 变更`，验证状态流转 + store 落盘 + gate 通过/失败 | 不 spawn 子进程、不跑真实 `cw` CLI | dispatch / store / gate |
| e2e（子进程） | 真实 `spawnSync` node 子进程跑 `dist/cli.js`，`CW_HOME` 指向 tmp 子目录（per-cwd 隔离）。覆盖**全部 13 个 action 的关键分支路径**：主链路 happy path + clarify/review_fix/test_fix/assess 各自的 loop + turn 上限熔断 + 非法状态 + 只读子命令 + gate fail/circuit breaker | 不 mock 任何东西——入口/状态机/store/git 全部真实 | e2e-* |

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

## E2E 测试编写指南

> E2E 层的真实子进程测试拆分到 `tests/e2e-*.test.ts` 系列文件，共享基建在 `tests/helpers/e2e.ts`。
> 这里的约定覆盖「写在哪、怎么写、怎么跑」三个问题。

### 文件放哪、怎么命名

| 场景 | 文件 | 命名约定 |
|---|---|---|
| 主链路 happy path（create→...→closeout 全链跑通） | `tests/e2e.test.ts` | E1 / E2 / E3 / E4（保留原有编号） |
| 单个 action 的分支路径（loop / 熔断 / 非法 / 只读） | `tests/e2e-<action>.test.ts` | `e2e-clarify` / `e2e-review-fix` / `e2e-test-fix` / `e2e-assess` / `e2e-init` / `e2e-gate-fail` |
| 只读子命令聚合 | `tests/e2e-readonly.test.ts` | stats / status / list 合并一文件 |
| 共享基建（不许直接复制到测试文件） | `tests/helpers/e2e.ts` | — |

**拆分原则**：一个文件聚焦一个 action 的分支路径（或一组同类只读命令），独立 `beforeAll` 隔离环境。不要把所有 E2E 塞进一个文件——单文件超 ~500 行时拆。新增 action 的 E2E 测试时，新建 `e2e-<action>.test.ts`，不要往 `e2e.test.ts` 加。

### 执行方式

```bash
npm run build            # 必须！E2E 跑 dist/cli.js，改完 src/ 要先 build
npm test                 # 全量（含所有 e2e-*.test.ts）

# 单独跑某个 E2E 文件
npx vitest run tests/e2e-assess.test.ts

# 跑全部 E2E（排除单元/集成层）
npx vitest run tests/e2e*.test.ts
```

**关键**：E2E 依赖 `dist/cli.js`（`npm run build` 产物）。改了 `src/` 不 build 直接跑 E2E 会测旧代码——CI 和本地都要先 build。`tests/helpers/e2e.ts` 的 `createE2eEnv()` 会在启动时检查 `dist/cli.js` 是否存在，不存在直接 throw。

### 共享基建（`tests/helpers/e2e.ts`）

写 E2E 测试**必须复用**这些 helper，不要内联 `spawnSync`：

| helper | 作用 | 何时用 |
|---|---|---|
| `createE2eEnv()` | 创建独立隔离环境（tmp workspace + CW_HOME + git 初始 commit），返回 `E2eEnv` | 每个 `describe` 的 `beforeAll` 调一次 |
| `disposeE2eEnv(e)` | 清理 tmp 目录 | `afterAll` 调一次 |
| `runCli(args, e, options?)` | 真实子进程跑 `dist/cli.js`，cwd 自动设为 `e.workspaceDir` | **所有** cw 命令调用都走这个 |
| `parseStdout(result)` | 解析 stdout 为 JSON，校验 exitCode=0 | 期望命令成功的断言 |
| `setupToDeveloped(e, slug)` | 一行走到 developed（create+plan+tdd_plan+dev） | 测 review / review_fix 前 |
| `setupToReviewed(e, slug)` | 走到 reviewed（+review 无 issue） | 测 test / test_fix 前 |
| `setupToTested(e, slug)` | 走到 tested（+test 全 pass） | 测 retrospect / closeout 前 |
| `setupToClosed(e, slug)` | 走到 closed（完整链路） | 测 assess 前 |

**`runCli` 的 cwd 约定**：第二参数是 `E2eEnv`（不是裸 `env`），cwd 自动绑 `workspaceDir`。CLI 默认 `workspacePath=process.cwd()`，子进程 cwd 必须等于 workspaceDir，否则 `encodeCwd(workspaceDir)` 与 db 落盘路径错位，跨子命令读写失败。需要覆盖 cwd 时（如 init 诊断不同目录）用 `options.cwd`。

### 编写模板

新 E2E 文件的标准骨架：

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type E2eEnv,
  createE2eEnv,
  disposeE2eEnv,
  parseStdout,
  runCli,
  setupToReviewed,       // 按目标阶段选 import
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => { e = createE2eEnv(); });
afterAll(() => { disposeE2eEnv(e); });

describe("E<编号><action>: <场景描述>", () => {
  it("<具体断言>", () => {
    // 1. 用阶段 helper 推进到目标阶段
    const { topicId } = setupToReviewed(e, "<unique-slug>");
    // 2. 跑被测 action
    const result = parseStdout(runCli(["<action>", "--topicId", topicId], e, {
      input: JSON.stringify(/* stdin payload */),
    }));
    // 3. 断言 status / nextAction / gatePassed
    expect(result.status).toBe("...");
    expect((result.nextAction as Record<string, unknown>).action).toBe("...");
  });
});
```

### 各 action 的输入传递方式

不同 action 的参数从不同渠道传入（CLI 层 `buildParams` 决定）：

| action | stdin（`options.input`） | flag（`args` 数组） |
|---|---|---|
| `clarify` | clarifyJson（对象或数组） | `--topicId` |
| `plan` | planJson（dev-plan.json） | `--topicId` |
| `tdd_plan` | testJson（test.json） | `--topicId` |
| `replan` | planJson（默认）/ testJson（`--test` 时） | `--topicId` / `--test` / `--testJsonFile` |
| `dev` | — | `--topicId` / `--tasks '[...]'`（JSON 字符串） |
| `review` | issues 数组（可选，无 stdin=空=无问题） | `--topicId` / `--reviewPath`（可选，不传=fileCheck pass） |
| `review_fix` | fixes 数组 `[{issueId,commitHash,resolution}]` | `--topicId` |
| `test` | — | `--topicId` / `--cases '[...]'`（JSON 字符串，含 `{caseId,actual}`） |
| `test_fix` | fixes 数组 `[{caseId,commitHash,resolution}]` | `--topicId` |
| `retrospect` | retrospectData（可选 JSON） | `--topicId` / `--retrospect-path` |
| `closeout` | — | `--topicId` |
| `assess` | — | `--type` / `--notes` / `--score` / `--defect`（全 flag） |
| `init` | — | 无参数（诊断 `process.cwd()`，用 `options.cwd` 覆盖测试目录） |

**ID 格式约定**（写 fix/case 引用时要对应）：
- review 的 issueId：cw 自增分配 `R1` / `R2`...（按已存在数量 +1）。首轮提交 N 条 issue → `R1`..`R{N}`
- test 的 caseId：来自 tdd_plan 阶段 test.json 的 `testCase.id`（测试代码自定，如 `E1` / `E2`）
- assess 的 assessmentId：cw 自增 `AS1` / `AS2`...

### expected 值约定

expected 是判别联合（`type` 字段必填），3 种判定模式：

| type | 结构 | 判定 | 适用 |
|---|---|---|---|
| `exact` | `{ "type": "exact", "text": "..." }`（可选 `url`） | `expected.text` 与 `actual.text` 精确 === | 单元测试断言值 |
| `exit_zero` | `{ "type": "exit_zero" }` | CW 跑 testRunner，exit 0→pass | 布尔/状态断言、命令整体成功 |
| `script` | `{ "type": "script", "path": ".cw/judge-E1.sh" }` | CW 跑脚本，exit 0→pass | 复杂判定（正则/JSON/多字段） |

阶段 helper 用 `makeValidTestJson()` 造 test.json，其 `expected` 固定值（exact 模式）：
- case `E1` → `expected = { "type": "exact", "text": "expected-output" }`
- case `E2` → `expected = { "type": "exact", "text": "real-output" }`

测 test pass 时 `actual.text` 必须精确匹配（`judgeByExpected` 精确 ===，无 trim/容差）；测 test fail 时传任意不匹配值（如 `"wrong-output"`）。exit_zero/script 模式由 `handleTest`（W3）跑命令/脚本回填 `actual.exitCode`，测试时构造对应 `actual` 即可（见 `tests/expected-multi-mode.test.ts`）。

### 分支路径覆盖清单

写新 E2E 时，对照这个清单确认关键分支都测到：

| 分支类型 | 示例 | 涉及文件 |
|---|---|---|
| happy path（一次过） | E1 全链、阶段 helper | e2e.test.ts |
| loop（review_fix / test_fix 修复后重跑） | E6c / E7c | e2e-review-fix / e2e-test-fix |
| turn 上限熔断（强制跳阶段） | E6d（review 3 轮→test）/ E7d（test 5 轮→retrospect） | e2e-review-fix / e2e-test-fix |
| progressive（多次调用追加） | E5c（clarify）/ E8b（assess AS1/AS2/AS3） | e2e-clarify / e2e-assess |
| gate fail → retry | E11a（plan format 错）/ E11c（修后重试成功） | e2e-gate-fail |
| circuit breaker（连续 5 次 fail 换文案） | E11b | e2e-gate-fail |
| 非法状态（guard 拒绝） | E5e / E8d → stderr 含 `illegal_transition` | 各 e2e-* 文件 |
| 非法参数（handler throw） | E6e（issueId 不存在）/ E7e（caseId 不存在）/ E8e（缺 defect） | 各 e2e-* 文件 |
| 只读子命令 | E9（stats / status / list） | e2e-readonly |
| 基建诊断 | E10（init 空目录 / ready / 骨架态） | e2e-init |

## 不可回退基线（Regression Baseline）

> coding-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### RB-1 judgeByExpected 机器重算  [from: cw-cli-extract]

- **用例来源**：`tests/pure-functions.test.ts` judgeByExpected 测试组 + `tests/expected-multi-mode.test.ts`（exact/exit_zero/script 三模式全覆盖）
- **断言**：CW engine 按 `expected.type` 机器重算，不信任 agent 声明。三模式都是**确定性机器重算**：
  - **exact**：`expected.text` 与 `actual.text` 必须**精确 ===**，任何 fuzzy / trim / substring 容差都会破坏机器重算（实现见 `src/types.ts:114-177`）
  - **exit_zero**：CW 跑 testRunner 命令一次，按 exit code 判定（0→passed，非 0→failed）。exit code 是机器产出，agent 无法谎报
  - **script**：CW 跑 `expected.path` 脚本，按 exit code 判定。脚本自包含，agent 不参与判定
- **破坏即**：agent 谎报测试结果通过——CW 核心防线（机器重算 test gate）失效。三模式中任一回退到「信任 agent 声明」即事故
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

- **用例来源**：`tests/e2e.test.ts` E1（主链路）+ `tests/e2e-*.test.ts` 系列（全部 13 action 的分支路径，共 38 个 E2E 测试）
- **断言**：`create → plan → tdd_plan → dev → review → test → retrospect → closeout` 全链真实子进程跑通，最终 `status=closed`，evidence 写入；各分支路径（clarify / review_fix / test_fix / assess loop、turn 上限熔断、gate fail/circuit breaker、非法状态/参数、只读子命令、init 诊断）端到端验证
- **破坏即**：CLI 入口 / 状态机 / store 任一环节断裂，或某个 action 的分支路径在子进程层断裂，agent 无法完成或无法正确推进编码任务
- **关联约束**：NFR V-1
