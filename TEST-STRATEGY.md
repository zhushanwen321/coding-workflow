# 测试策略

> **always-current**。记录**测试策略**（金字塔/边界/门禁/约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；coding-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 现状速览

| 维度 | 值 | 来源 |
|---|---|---|
| 测试框架 | vitest ^3.0.0 | package.json devDependencies |
| 测试数量 | 801 passed（45 文件） | `npm test` 实跑（会随开发增长，以实跑为准） |
| 覆盖率工具 | 无（未配 c8/istanbul） | package.json 无 coverage 脚本 |
| Mock 框架 | 零（无 vi.fn / 无 mock 库） | tests/ 全量 grep 无 mock 调用 |
| 运行命令 | `npm test` → `vitest run` | package.json scripts.test |

> **数字口径**：801/45 是会随开发增长的基线，不是定数。旧文档（AGENTS.md/README/PRODUCT）各自记的 1380/464/393/743 互相打架且已过时，一律以 `npm test` 实跑为准。

测试文件清单（`tests/` 目录，45 个 `.test.ts`）：

### 单元（纯函数，零 IO）

| 文件 | 用例数 | 职责 |
|---|---|---|
| `state-machine.test.ts` | 16 | wave 状态机：`nextWaveStatus` / `guardWave` / `isWaveTerminal` |
| `slice-state-machine.test.ts` | 23 | slice（PlanningUnit）状态机：`nextPlanningStatus` / `guardPlanning` |
| `feature-state-machine.test.ts` | 16 | feature 状态机 + dispatch 层状态流转 |
| `epic-state-machine.test.ts` | 26 | epic 状态机 + dispatch 层状态流转 |
| `gates.test.ts` | 45 | wave gate 纯函数：design-review / test / exec-review / retrospect 各 gate 的 pass+fail |
| `slice-gates.test.ts` | 37 | slice design-review gate（techChoices/split/DAG/layerSpecific） |
| `feature-gates.test.ts` | 39 | feature design-review gate（FR-AC 强引用 3 gate + split） |
| `epic-gates.test.ts` | 27 | epic design-review gate（split 结构 + layerSpecific 5 字段） |
| `freeze.test.ts` | 23 | append-only 不变量校验：`checkFreeze` / `checkFreezeFeatureSpec`（abandoned 条目不可删/不可改核心字段） |
| `replan.test.ts` | 6 | 影响面计算纯函数：`computeImpact`（aborted/preserved/pendingRebuild） |
| `spec-schema.test.ts` | 9 | FeatureSpec 校验纯函数 `validateFeatureSpec` |
| `parse-vitest-output.test.ts` | 12 | vitest 输出解析纯函数（parseVitestCounts / parseFailedTestNames） |
| `replan-review.test.ts` | 13 | replan 审视引导模板 `buildReplanReviewText` |
| `guidance.test.ts` | 53 | guidance 子系统纯函数：schema-injector / prefix-builder / failure-hint / cross-layer / build-guidance |
| `guidance-planning-templates.test.ts` | 18 | 三层 ACTION_SCHEMA 基建 + planning 静态方法论模板 |
| `planning-guidance-snapshot.test.ts` | 31 | 三层 PlanningUnit guidance 段落结构快照 |
| `subagent-guidance.test.ts` | 25 | subagent 分级表 + buildSubagentGuidance 集成 |
| `guidance-gates-spec.test.ts` | 17 | C1-C6 增强回归：ActionResult.children / handoff FR-AC / layerSpecific schema 注入 / retrospect optional / duplicateSplitSlug gate |
| `readonly-handoff.test.ts` | 18 | `renderHandoff` 纯函数（scope=self，接 WorkUnitRecord 不读 fs） |
| `list-enhance.test.ts` | 22 | cw list 增强：跨 cwd/分页/分组/模糊匹配/--long |

### 集成（dispatch / handler / store / 真实 git 子进程）

| 文件 | 用例数 | 职责 |
|---|---|---|
| `dispatch-e2e.test.ts` | 8 | wave 完整生命周期（dispatch 串联 8 步）+ 非法跳步 → CwEngineError |
| `handler-guidance.test.ts` | 18 | wave 10 个 handler 的 guidance 接入（正常三段式 / 异常四段式 / closeout crossLayer） |
| `evidence-lifecycle.test.ts` | 7 | evidence 跨阶段填充：execute→commitHash、test→testRunResult、closeout→frozenAt |
| `store.test.ts` | 20 | CwStore DAO：save/load 往返、原子写、findChildren、事务回滚、损坏文件抛错 |
| `repo-meta.test.ts` | 7 | collectRepoMeta + CwJsonFile schemaVersion 写侧标记 / repoMeta 回填（真 git 子进程） |
| `git-extract.test.ts` | 4 | extractChangedFiles 失败上下文（真 git 子进程，note 不丢 stderr） |
| `parse-abandon-markers.test.ts` | 10 | parseAbandonMarkers + extractCommitMessage（真 git commit trailer） |
| `abandon-parent-items-input.test.ts` | 16 | ADR-0010 跨层跨时机 abandonParentItems 通道（plan/replan input append-only 合并） |
| `feature-replan-spec.test.ts` | 18 | feature replan：spec 条目 abandoned 标记 + freeze 接入 + addedSpecItems 拆分重建 + 级联 abort |
| `slice-replan-cascade.test.ts` | 19 | slice replan 级联影响面：computeImpactCascade + cascadeAbortUnit/cascadeAbortChildren |
| `evidence-rollup.test.ts` | 8 | slice evidence rollup（wave closeout/abort → childDelivery） |
| `rollup-planning.test.ts` | 9 | PlanningUnit 三层 closeout/abort + 级联函数内部 rollup |
| `feature-design-validate.test.ts` | 6 | feature design 的 spec 结构校验：畸形 spec 被 validateFeatureSpec 拦截 → ok=false |
| `epic-retrospect.test.ts` | 22 | epic retrospect 验收 7 gate（allWavesClosed / childUnitEvidenceComplete / deliveryVerdict 等） |
| `feature-retrospect.test.ts` | 18 | feature retrospect 验收 7 gate |
| `handoff-scope.test.ts` | 10 | renderHandoff scope=upstream/full（父链+子树）+ size warning |

### e2e（真实子进程跑 `dist/cli.js` 或经 dispatch 跑完整链路）

| 文件 | 用例数 | 职责 |
|---|---|---|
| `cli.test.ts` | 26 | cw CLI 子进程接入：create wave / 缺参数 exit 1 / design `--input @file.json` 管道 / unit not found |
| `e2e-handoff.test.ts` | 3 | handoff 端到端：五段式纯文本 + 缺 `--unitId` exit 1 + 不存在 unitId exit 1 |
| `feature-dispatch-e2e.test.ts` | 17 | feature 完整链路（dispatch 串联：create→…→closeout + child slice 推进） |
| `slice-dispatch-e2e.test.ts` | 8 | slice 完整链路（dispatch 串联 + child wave 推进） |
| `epic-dispatch-e2e.test.ts` | 17 | epic 完整链路（dispatch 串联 + child feature/slice/wave 全链推进） |

> 用例数取自 `npm test` 实跑的 per-file 统计；随开发增长，以实跑为准。

辅助文件（`tests/helpers/`）：

| 路径 | 作用 |
|---|---|
| `tests/helpers/env.ts` | wave 测试基建：`createCwEnv`（tmp 目录 + CW_HOME 隔离 + 真实 CwStore + stub CwDeps）、`makeStubDeps`、wave unit 工厂 + 合法产物工厂（testCase/task/file/contract/judgment/retrospectData）、`commitWithFiles`（造 git commit 验证 extractChangedFiles） |
| `tests/helpers/git.ts` | `setupGitRepo(repoDir)`：在 tmp 目录初始化真实 git 仓库 + 非空初始 commit（统一 user.email/name + README） |
| `tests/helpers/slice-env.ts` | slice 测试基建：slice unit 工厂 + 合法 SlicePlan 条目工厂（techChoice/interface/dataModel/errorSpec/split）+ slice 阶段推进 helper（setupToSlicePlanning / setupToSliceDesignReviewed / setupSliceWithClosedWaves / advanceWaveToClosed） |
| `tests/helpers/feature-env.ts` | feature 测试基建：feature unit 工厂 + 合法 FeatureSpec/Plan/Judgment/RetrospectData 工厂 + feature 阶段推进 helper（经 dispatch 推进到各状态） |
| `tests/helpers/epic-env.ts` | epic 测试基建：epic unit 工厂 + 合法 epic Split/Plan/Judgment/RetrospectData 工厂 + epic 阶段推进 helper |

> **注意**：无 `tests/helpers/e2e.ts`、无 `tests/helpers/plan.ts`。e2e 子进程测试（`cli.test.ts` / `e2e-handoff.test.ts`）在文件内联 `runCwCli` / `createCwCliEnv` / `parseStdout`，dispatch-e2e 测试经 `dispatch()` 跑完整链路（进程内，不 spawn 子进程）。

## 测试金字塔与边界

| 层 | 测什么 | 不测什么 | 对应文件 |
|---|---|---|---|
| 单元（纯函数） | 无副作用的判定与计算：状态机（`guardWave`/`guardPlanning`/`nextWaveStatus`/`nextPlanningStatus`）、gate 纯函数（`src/rules/gates/*`）、append-only 校验（`src/rules/freeze.ts` 的 `checkFreeze*`）、影响面计算（`src/rules/replan.ts` 的 `computeImpact`）、guidance 子系统、vitest 输出解析 | 不碰文件系统、不碰 git、不碰 store | state-machine / *-state-machine / gates / *-gates / freeze / replan / spec-schema / parse-* / guidance* / readonly-handoff / list-enhance / replan-review |
| 集成（dispatch / handler / store） | 走完整 dispatch 路径：`loadWorkUnit → guard → handler（按 scope 路由）→ store 变更`，验证状态流转 + store 落盘 + gate 通过/失败 + guidance 接入 + evidence/rollup；CwStore 用真实 tmp 文件系统；git 走真实子进程 | 不 spawn 子进程跑真实 `cw` CLI（dispatch-e2e 经 dispatch 跑，进程内） | dispatch-e2e / *-dispatch-e2e / handler-guidance / evidence-* / rollup-* / store / repo-meta / git-extract / parse-abandon-markers / abandon-parent-items-input / feature-replan-spec / slice-replan-cascade / *-retrospect / feature-design-validate / handoff-scope |
| e2e（子进程 CLI） | 真实 `spawnSync` node 子进程跑 `dist/cli.js`，`CW_HOME` 指向 tmp 子目录（per-cwd 隔离），cwd 绑 workspaceDir。覆盖 CLI 入口到归档的关键链路 + 只读命令（handoff）的端到端可用性 | 不 mock 任何东西——入口/状态机/store/git 全部真实 | cli / e2e-handoff |

**三层职责切分原则**：单元层保证判定逻辑正确（机器重算/gate 校验的核心防线）；集成层保证 handler 编排与 store 读写正确（覆盖每个 handler 的正常 + 异常路径 + 跨层 rollup/级联）；e2e 层保证 CLI 入口到归档的整条链路在子进程层不断裂。集成层不重复单元层的纯逻辑断言，e2e 层不重复集成层的 handler 细节——只验证「端到端跑得通」。

**dispatch-e2e vs 子进程 e2e 的区分**：`*-dispatch-e2e.test.ts` 经 `dispatch()` 在进程内跑完整多链生命周期（epic→feature→slice→wave 全链推进），聚焦「dispatch 编排跨层正确串联」；`cli.test.ts`/`e2e-handoff.test.ts` 才是真正的子进程 e2e（spawn `dist/cli.js`），聚焦「CLI 入口真实可用」。两者互补，不重复。

## 覆盖率门禁

| 项 | 现状 |
|---|---|
| 覆盖率阈值 | 无显式阈值（项目未配 c8/istanbul，CI 不卡覆盖率） |
| 门禁机制 | 靠集成层测试覆盖每个 handler 的正常 + 异常路径；靠 RB 基线守护核心不变式 |
| 新增 action 约定 | 必须加对应 dispatch 测试（项目约定，非 CI 强制） |
| CI 集成 | `npm test`（= `vitest run`），全绿即放行 |

**为什么不卡覆盖率数字**：CW 的价值是机器验证（test gate 机器校验、gate 机器校验、append-only 机器守卫）。这些核心不变式由 RB 基线（见下）守护，比覆盖率百分比更直接——一条 RB 失败就是事故，覆盖率 100% 不能替代。

## Mock 与测试数据约定

| 边界 | 约定 |
|---|---|
| 禁 mock（核心） | store / git 都用真实实现。**mock 掉验证逻辑（gate 纯函数、guard、`checkFreeze*`、GitValidator）就失去测试意义**——CW 的价值就是机器验证 |
| stub CwDeps（允许） | `CwDeps` 是依赖注入接口（`gitValidator`/`testRunner?`/`fileExists`/`workspacePath`/`clock`，`src/handlers/types.ts:61`），用 `env.ts` 的 `makeStubDeps` 构造手写 stub 对象（非 mock 框架）：gitValidator 始终 true、testRunner 返回固定 passed、fileExists 始终 true、clock 固定 `STUB_NOW`。这是外部依赖注入接口，不是 CW 内部代码 |
| 真实 store | `CwStore` 写入 tmp 目录的真实文件系统（`mkdtempSync`），不 stub 读写、不走 InMemoryStore |
| 真实 git | `tests/helpers/git.ts` 的 `setupGitRepo()` 用 `execFileSync("git", ...)` 在 tmp 目录初始化真实 git 仓库 + 非空 commit；`env.ts` 的 `commitWithFiles()` 造指定文件的 commit 验证 execute 的 `extractChangedFiles` |
| 测试数据 | 合法产物工厂在 `tests/helpers/{env,slice-env,feature-env,epic-env}.ts`：按层构造能过 gate 的 input（wave: testCase/task/file/contract；slice: techChoice/interface/dataModel/errorSpec/split；feature: FR/AC/BC + split；各层 judgment/retrospectData）。通过参数（`overrides` / `childUnitIds` / `splitSlugs`）控制差异 |
| tmp 目录 | 每个测试独立 tmp 目录（`mkdtempSync`），测试间无状态共享；`CW_HOME` 指向 tmp 子目录实现 per-cwd 隔离，cleanup 还原 |
| git user 统一 | `setupGitRepo` 统一 `user.email=cw-test@test.com` / `user.name=CW Test`；`commitWithFiles` 用 `test@cw.local`/`cw-test` |

## E2E 测试编写指南

> e2e 子进程测试聚焦 `cli.test.ts` + `e2e-handoff.test.ts`（真实 spawn `dist/cli.js`）；多链生命周期 e2e 拆到 `tests/*-dispatch-e2e.test.ts`（经 dispatch 进程内跑）。

### 文件放哪、怎么命名

| 场景 | 文件 | 命名约定 |
|---|---|---|
| 子进程 CLI 入口接入（create/缺参数/管道/not found） | `tests/cli.test.ts` | W8 / 后续编号 |
| 单个只读命令端到端 | `tests/e2e-<command>.test.ts` | `e2e-handoff`（后续 e2e-status / e2e-list 按需） |
| 多链生命周期（经 dispatch 跑完整层链） | `tests/<layer>-dispatch-e2e.test.ts` | feature/slice/epic 各一 |
| 共享基建 | `tests/helpers/{env,slice-env,feature-env,epic-env}.ts` | — |

**拆分原则**：一个文件聚焦一个层或一组同类命令，独立 `beforeAll`/`beforeEach` 隔离环境。子进程 e2e 共享一个 `CwCliEnv`（`beforeAll` 建一次），dispatch-e2e 每个 `beforeEach` 建 `CwEnv`。

### 执行方式

```bash
npm run build            # 子进程 e2e 跑 dist/cli.js，改完 src/ 要先 build
npm test                 # 全量（含所有 e2e / dispatch-e2e）

# 单独跑某个 e2e 文件
npx vitest run tests/cli.test.ts

# 跑全部 dispatch-e2e（跨层生命周期）
npx vitest run tests/*-dispatch-e2e.test.ts
```

**关键**：子进程 e2e 依赖 `dist/cli.js`（`npm run build` 产物）。改了 `src/` 不 build 直接跑子进程 e2e 会测旧代码——CI 和本地都要先 build。`cli.test.ts` 的 `createCwCliEnv()` 在启动时检查 `dist/cli.js` 是否存在，不存在直接 throw。

### 子进程 e2e 共享基建（`cli.test.ts` / `e2e-handoff.test.ts`）

写子进程 e2e 测试**必须复用**这些内联 helper（当前在 `cli.test.ts` 定义，`e2e-handoff.test.ts` 复制精简版），不要每次重写 `spawnSync`：

| helper | 作用 | 何时用 |
|---|---|---|
| `createCwCliEnv()` | 创建独立隔离环境（tmp workspace + 独立 CW_HOME tmp + git 初始 commit），检查 `dist/cli.js` 存在，返回 `CwCliEnv` | `beforeAll` 调一次 |
| `disposeCwCliEnv(e)` | 清理两个 tmp 目录 | `afterAll` 调一次 |
| `runCwCli(args, e, options?)` | 真实子进程跑 `dist/cli.js`，cwd 自动绑 `e.workspaceDir` | **所有** cw 命令调用都走这个 |
| `parseStdout(result)` | 解析 stdout 为 JSON，校验 exitCode=0 + stdout 非空 | 期望命令成功的断言 |

**`runCwCli` 的 cwd 约定**：第二参数是 `CwCliEnv`（含 `workspaceDir`），cwd 自动绑 `workspaceDir`。CLI 默认 `workspacePath=process.cwd()`，子进程 cwd 必须等于 workspaceDir，否则 `encodeCwd(workspaceDir)` 与 db 落盘路径错位，跨子命令读写失败。需要覆盖 cwd 时用 `options.cwd`。

### dispatch-e2e 共享基建（`tests/helpers/*.ts`）

dispatch-e2e 测试经 `dispatch({ action, unitId, input }, deps)` 在进程内跑完整链路，复用各层 helper 的阶段推进函数：

| helper | 作用 | 出处 |
|---|---|---|
| `createCwEnv()` / `env.cleanup()` | tmp + CW_HOME + 真实 CwStore + stub CwDeps | env.ts |
| `setupToFeaturePlanning` / `setupToFeatureDesignReviewed` / `setupToFeatureExecuting` / `setupFeatureWithClosedSlices` | feature 经 dispatch 推进到各状态（含 child slice 全链 closed） | feature-env.ts |
| `setupToSlicePlanning` / `setupToSliceDesignReviewed` / `setupSliceWithClosedWaves` | slice 推进到各状态（含 child wave 全链 closed） | slice-env.ts |
| `setupToEpicClarified` / `setupToEpicPlanning` / `setupToEpicDesignReviewed` / `setupToEpicExecuting` / `setupEpicWithClosedFeatures` | epic 经 dispatch 推进到各状态（含 child feature/slice/wave 全链 closed） | epic-env.ts |
| `advanceWaveToClosed` / `advanceChildSlicesToClosed` / `advanceChildFeaturesToClosed` | 单个 child unit 走完整生命周期到 closed | slice-env.ts / feature-env.ts / epic-env.ts |

### 编写模板（子进程 e2e）

```typescript
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupGitRepo } from "./helpers/git.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

interface CwCliEnv { workspaceDir: string; cwHome: string; env: Record<string, string>; commitHash: string; }
interface CliResult { exitCode: number; stdout: string; stderr: string; }

function runCwCli(args: string[], e: CwCliEnv, options: { input?: string; cwd?: string } = {}): CliResult {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    env: { ...process.env, ...e.env, PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd: options.cwd ?? e.workspaceDir,
    input: options.input,
    timeout: 30000,
  });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function createCwCliEnv(): CwCliEnv {
  if (!existsSync(CLI_PATH)) throw new Error(`dist/cli.js 不存在，请先 npm run build`);
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-cli-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-cli-home-")));
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome, env: { CW_HOME: cwHome }, commitHash };
}

let e: CwCliEnv;
beforeAll(() => { e = createCwCliEnv(); });
afterAll(() => { disposeCwCliEnv(e); });

describe("create wave happy path", () => {
  it("返回 status=created + nextAction.guidance 非空", () => {
    const r = runCwCli(["create", "wave", "--slug", "w1", "--objective", "test"], e);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out.status).toBe("created");
    expect(out.unitId).toBe("wave:w1");
  });
});
```

### 各 action 的输入传递方式

推进 action 一律 `--unitId <id>` 路由（create 例外，靠 `--layer` + `--slug`）。input payload 从 `--input @file.json`（`@` 是「从文件读」的约定标记，可省略）或 stdin（非 TTY 时）读 JSON（`src/cli.ts` 的 `readInput` / `buildParams`）：

| action | flag（必填/常用） | input payload（`--input` / stdin） | 出处 |
|---|---|---|---|
| `create` | `--layer <wave\|slice\|feature\|epic>` + `--slug` + `--objective`（可选 `--parent` / `--basedOnParent`） | 无（参数走 flag） | cli.ts buildParams create 分支 |
| `design` | `--unitId`（可选 `--abandonParentItems`） | wave: `{ testCases, tasks, files, contracts, clarifications? }`；slice: `{ techChoices, interfaces, dataModels, errorSpecs, split, clarifications? }`；feature/epic: `{ split, clarifications? }`（feature 可选 `spec` 容器形态） | DesignInput (handlers/types.ts:230) / DesignSliceInput (:329) / DesignFeatureInput (:368) |
| `design-review` | `--unitId` | `{ designReviewJudgment }`（layerSpecific 按层 6/6/6/5 字段） | DesignReviewInput (handlers/types.ts:242) |
| `execute` | `--unitId`；wave 需 `--commitHash` | wave: `{ commitHash }`（changedFiles 由 cw 从 commit 提取，agent 无需传）；slice/feature/epic: 无 input（按 plan.split 自动下沉子 unit） | ExecuteInput (handlers/types.ts:247) |
| `test` | `--unitId` | `{ testJudgment }`（wave 专属） | TestInput (handlers/types.ts:257) |
| `exec-review` | `--unitId` | `{ execReviewJudgment }`（wave 专属） | ExecReviewInput (handlers/types.ts:262) |
| `retrospect` | `--unitId` | `{ retrospectData }`（PlanningUnit 含 deliveryVerdict + childUnitIdsEvidence + splitFulfillment） | RetrospectInput (handlers/types.ts:267) |
| `closeout` | `--unitId` | `{ summary?, artifacts? }` | CloseoutInput (handlers/types.ts:272) |
| `replan` | `--unitId` + `--abandonedIds` + `--note`（或走 `--input`/stdin；可选 `--abandonParentItems`） | `{ abandonedIds, note }`（feature 可加 `addedSpecItems`） | ReplanInput (handlers/types.ts:280) |
| `abort` | `--unitId`（可选 `--reason`） | `{ reason? }`（可空） | AbortInput (handlers/types.ts:306) |
| `tree` / `status` / `list` / `handoff` / `frontier` | `--unitId`（list 可用 `--all`/`--layer`/`--grep`/`--limit`/`--offset`/`--long`；handoff 可用 `--scope`；frontier 用 `--root`） | 无（只读，不经 dispatch、不写 store） | cli.ts READONLY_QUERIES |

**ID 格式约定**：
- unitId：`<scope>:<slug>`（如 `wave:auth-w1`），子 unit slug = `${parent.slug}::${split.slug}`（`::` 分隔，如 `slice:auth::w1`）。出处 `src/core/workunit.ts`（id 格式）
- abandonedIds：WavePlan/SlicePlan/FeatureSpec 条目的 `WorkUnitItem.id`（如 `TC1`/`IF1`/`FR1`），replan 废弃后 status 改 `abandoned`（append-only 不删）

## 分支路径覆盖清单

写新测试时，对照这个清单确认关键分支都测到：

| 分支类型 | 示例 | 涉及文件 |
|---|---|---|
| happy path（一次过） | wave 8 步全链、各层 dispatch-e2e 全链 | dispatch-e2e / *-dispatch-e2e |
| progressive（多次调用追加） | design 多次 append clarifications + 写条目 | dispatch-e2e / *-dispatch-e2e |
| gate fail → 不改 status（可 retry） | design-review gate fail / test gate fail | gates / *-gates / handler-guidance |
| circuit breaker（连续 5 次 fail 换文案） | failureCount 派生 + 熔断文案 | guidance（failure-hint） |
| 非法状态（guard 拒绝） | created 直接 execute → CwEngineError(illegal_transition) | state-machine / *-state-machine / dispatch-e2e |
| append-only 违反 | replan 改 abandoned 条目核心字段 → freezeViolations | freeze / replan / feature-replan-spec |
| 级联 abort（replan 影响面） | parent 废弃条目 → child.basedOnParent 命中 → child abort | replan / slice-replan-cascade |
| 跨层 rollup | child wave closeout/abort → parent childDelivery 刷新 | evidence-rollup / rollup-planning |
| 只读查询 | handoff（self/upstream/full）/ list 分页模糊 / status | e2e-handoff / handoff-scope / list-enhance / readonly-handoff |

## 不可回退基线（Regression Baseline）

> coding-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### RB-1 test gate 机器校验  [机器重算防线]

- **用例来源**：`tests/gates.test.ts`（test gate 组：`commitExists` / `testsAllPass` / `testCasesExecuted` / `testReferencesDesignReview`）+ `tests/dispatch-e2e.test.ts`（test action 端到端：gate fail 不改 status）
- **断言**：wave 的 test action 跑 4 个 gate（`src/rules/gates/test.ts`），全部机器校验，不信任 agent 声明：
  - `commitExists`（test.ts:44）：`--commitHash` 必须真实存在（经 `CwDeps.gitValidator.exists` 校验，commit hash 是 git 产出，agent 无法谎报）
  - `testsAllPass`（test.ts:79）：CW 经 `CwDeps.testRunner.run` 跑测试套件一次，按返回的 `TestRunResult.passed` 判定
  - `testCasesExecuted`（test.ts:212）：design-review 阶段声明的 testCases 必须在 testJudgment 里被覆盖
  - `testReferencesDesignReview`（test.ts:117）：testJudgment 的对照项必须引用 design-review judgment 的 tradeoff/risk id
- **破坏即**：agent 谎报测试结果通过——CW 核心防线（test gate 机器校验）失效。任一 gate 回退到「信任 agent 声明」即事故
- **关联约束**：NFR（test gate 机器重算）

### RB-2 guard 防跳步  [状态机防线]

- **用例来源**：`tests/state-machine.test.ts`（wave guard 测试组）+ `tests/slice-state-machine.test.ts` / `tests/feature-state-machine.test.ts` / `tests/epic-state-machine.test.ts`（PlanningUnit guard 测试组）+ `tests/dispatch-e2e.test.ts`（E2：create 后直接 dispatch execute → CwEngineError）
- **断言**：非 `transition.from` 中的 status 调 action → `GuardVerdict { ok: false, code: "illegal_transition" }`（实现见 `src/rules/state-machine.ts`：`guardWave` :151 / `guardPlanning` :348，查 `WAVE_TRANSITIONS`(:64) / `PLANNING_TRANSITIONS`(:292) 表）。guard fail → dispatch 抛 `CwEngineError`（exit 1，不可恢复）。`GuardErrorCode` 仅 `illegal_transition`（单重 guard，无纵深防御）
- **破坏即**：agent 跳过 plan / execute / test 直接 closeout，状态机约束形同虚设
- **关联约束**：NFR S-2

### RB-3 replan append-only + 影响面  [历史不可篡改防线]

- **用例来源**：`tests/freeze.test.ts`（`checkFreeze` / `checkFreezeFeatureSpec` 全分支）+ `tests/replan.test.ts`（`computeImpact`）+ `tests/feature-replan-spec.test.ts` / `tests/slice-replan-cascade.test.ts`（级联 abort 集成）
- **断言**：
  - 已 abandoned 的 WavePlan/SlicePlan/FeatureSpec 条目不可物理删除、不可改核心字段（`expected`/`steps`/`path`/`definition`/`signature` 等）、不可复活 status（实现见 `src/rules/freeze.ts`：`checkFreeze` :141 / `checkFreezePlanning` / `checkFreezeFeatureSpec`，违规返回 `FreezeViolation[]`）
  - replan 旁路不改 status，但 append 一条 `statusHistory`（from=to=current, action="replan"），历史流 append-only（`src/handlers/replan.ts`）
  - parent replan 废弃条目 → child.basedOnParent 命中 → child 级联 abort（`computeImpact` / `computeImpactCascade`，实现见 `src/rules/replan.ts`）
- **破坏即**：agent 通过 replan 撤销已交付的 commit 或篡改已废弃条目的 expected，让 plan 与 git 历史 / 测试断言脱节
- **关联约束**：NFR C-2

### RB-4 store 事务原子性 + 跨层链路跑通  [持久化与端到端防线]

- **用例来源**：`tests/store.test.ts`（事务回滚 + 原子写 + 损坏文件抛错）+ `tests/dispatch-e2e.test.ts` / `tests/feature-dispatch-e2e.test.ts` / `tests/slice-dispatch-e2e.test.ts` / `tests/epic-dispatch-e2e.test.ts`（四层各自经 dispatch 跑通 create→…→closeout 全链）+ `tests/cli.test.ts` / `tests/e2e-handoff.test.ts`（子进程 CLI 端到端）
- **断言**：
  - CwStore 内存事务：`fn` 在深拷贝副本上操作，正常→原子落盘，异常→丢弃副本 ROLLBACK 不污染磁盘（实现见 `src/store/cw-store.ts` 的 `transaction` 方法）。store.json 损坏 → load 抛错（不静默吞）
  - 四层各自经 dispatch 跑通 `create → design → design-review → execute → [test → exec-review →] retrospect → closeout` 全链（PlanningUnit 6 步 / wave 8 步），最终 `status=closed`，evidence.frozenAt 写入；epic→feature→slice→wave 跨层下沉（execute 按 split 创建子 unit）+ closeout 跨层回溯（crossLayer ascend）端到端验证
  - 子进程层：`dist/cli.js` create/design（`--input @file.json` 管道）/handoff 端到端可用，缺参数 → exit 1，unit not found → exit 1 + CwEngineError 语义
- **破坏即**：CLI 入口 / 状态机 / store 任一环节断裂（事务不回滚导致脏数据，或某层跨链下沉/回溯断裂），agent 无法完成或无法正确推进编码任务
- **关联约束**：NFR V-1

### RB-5 契约级加固防线  [guidance 正确性 + 输入防线 + 幂等]  [from: cw-guidance-hardening §execution-plan]

- **用例来源**：`tests/handler-guidance.test.ts`（schema 取 nextAction + replan 透传 + 终态无 schema）+ `tests/cli.test.ts`（unknown flag / per-command help / input 校验）+ `tests/validate-input.test.ts`（12 schema × 27 入口）+ `tests/cli-params.test.ts`（白名单表）+ `tests/test-cwd-e2e.test.ts`（--testCwd 实际生效）+ `tests/gates.test.ts`（retrospect key 防御 + 报告两段）+ `tests/e2e-handoff.test.ts`（handoff schema 例外）
- **断言**：
  - guidance 的 schema 段与命令段同指 nextAction（create 后显示 design 的 clarifications 字段）；handoff 路径保持当前 action 取值；终态无 schema 段；replan 后 guidance 含 design 的 schema 段
  - 重复 create 同 slug（非空态）→ no-op 返回 existing + `idempotent: true`，store 不被覆盖；aborted/closed 终态 → guidance 含「重建请用新 slug」；created 空态允许覆盖
  - `cw test --testCwd <dir>` 的 runner 实际 cwd = 指定目录（fixture 写 process.cwd() 断言）
  - unknown flag → CwError exit 1 + 合法 flag 列表；`{}` input → CwError 非 crash exit 2；retrospect gate 失败报告含期望全集 + 缺失子集两段且无垃圾 key
- **破坏即**：agent 照 guidance 走拿到错参数结构（被迫读源码）；重复 create 静默抹进度；--testCwd 静默失效回退根目录跑全量；垃圾 key 让 retrospect gate 无法一次通过
- **关联约束**：NFR O-2/O-3，ADR-0012
