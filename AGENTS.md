# coding-workflow (cw)

> 2.0 重写后的实态描述（2026-08-18 doc-1 重写；进行中波次以 docs/rewrite/ledger.md 为准）

**agent 工作的 CI**：把超出单个 LLM agent 上下文半径的编码任务分解为可验证单元（unit），用机器证据（而非 agent 的声明）判定「完成」。实现形态 = 事件账本 + fold 投影状态机 + runner 循环派发 + 验收级机器验证。npm 包 `@zhushanwen/coding-workflow` 2.0.0，agent-agnostic：engine 不依赖任何 agent harness 能力（无 skill 加载、无 workflow 引擎），agent 只需通过 bash 调 `cw` 命令。统一语言（概念词典 / 数据布局 / 环境变量）见 [CONTEXT.md](./CONTEXT.md)。

## 常用命令

```bash
npm run check:all   # tsc 类型检查（check：src；check:tests：tests）
npm test            # vitest run（pretest 自动先 build；83 文件 674 用例，以实跑为准）
npm run lint        # eslint src/ tests/
npm run build       # tsc 编译到 dist/
```

测试是真实环境的：零 mock 框架，真实事件账本 + tmp 目录 + 真实 git/子进程。不要在测试里引入 mock 框架。

## 核心约定（2.0 实态，均附 src 锚点）

- **9 命令面 = 4 写 + 1 跑 + 4 只读**（`src/cli.ts` 帮助文本 / `src/dispatch.ts` 命令表）：
  - 写：`create`（建 unit，深度上限 2：根 + 叶）、`evidence submit`（spec / build 两类证据）、`review submit`（spec-review / exec-review 结论）、`verify`（干净重跑验证）
  - 跑：`run`（runner 调度循环，`--spawn human|pi`）
  - 只读：`status` / `frontier` / `tree` / `report`
- **事件账本 + fold 投影**：唯一真相源 = append-only JSONL `events.log`，五类事件（UnitCreated / SpecSubmitted / VerdictSubmitted / EvidenceSubmitted / VerifyRan，`src/events/types.ts`）；写入走文件锁短事务（读末 seq → seq+1 → 追加 + fsync，`src/store/events-log.ts`）。**状态不存储只计算**：`status = fold(events)` 纯函数投影，四态 `created → spec-frozen → verified → closed`（`src/core/fold.ts`）——没有「声明状态」的命令，只有「交证据」的命令，补录结构性不可能。
- **spec gate 十二规则**（`src/gates/spec-rules.ts`，多缺口全列不短路）：① 验收非空；② core 用例自身 type 必须为 e2e 级；③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 附非空保真说明；⑤ 至少一条 unit 级用例；⑥ split 不得自引用；⑦ 验收 id 字符集（`ACCEPTANCE_ID_RE`，与 e2e-sh marker 同源）；⑧ runner 显式声明必须在 `knownAdapterTypes()` 集合内；⑨ 验收命令契约——按最终适配器路由检查冲突 flag：vitest / playwright 的 `--reporter` 值若出现必须恰为 `json` 且禁 `--outputFile`，pytest 禁 `-q` / `--quiet`（含 `-qq` / `-vq` 等短选项合写），e2e / manual 无静态规则（诚实边界，漏网走回炉通道）；⑩ `layer: "topic"` 条目要求 spec.split 非空——叶子/无子节点声明 topic = 条目永无执行点的真空，fail 级拒入账（al-3）；⑪ unit 层条目 command 纯词法命中全量回归形态（无文件参数的 `vitest run` / 全仓 test·lint script）→ 入账继续 + stderr 成本警告，wrapper 封装显式不枚举、误杀面由 reviewer 第六维语义审兜底（al-3）；⑫ 全部非 manual 型条目 command 路径逃逸词法拦截（command 含 `.cw-worktrees` 子串，或目录选择词法族 `cd` / `-C` / `--dir` / `--prefix` / `--root` 后随剥引号以 `/` 或 `~` 开头的 token，含 `-C/abs` 紧贴与 `--dir=/abs` / `--prefix=/abs` / `--root=/abs` 等号紧贴形态），fail 级拒入账——逃逸使 verify 绑定执行瞬间工作区状态而非账本 commit，漏报面由 reviewer 第五维语义审兜底（lv-1）。验收 type 五枚举：`unit | integration | e2e-real | e2e-mock | manual`。
- **verify 三道 gate**（`src/handlers/verify.ts` + `src/verify/`）：红阶段（测试区分力检查，新测试打到实现前基线树必须挂；默认执行，`--no-red-phase` 逃生口——rv-4 已交付）→ 名字级比对（验收 id 词边界匹配重跑产物用例名，非计数启发式，`src/verify/name-match.ts`）→ 干净 checkout 重跑（账本 commit 检出到一次性工作区 + 独立 CW_HOME，系统自己复跑，`src/verify/checkout.ts` / `src/verify/run.ts`）。exit 语义：`0` 全过；`1` 有 fail（fail 也入账留审计）；`2` 环境错误（不入账）。
- **testrun 四适配器**（`src/testrun/registry.ts`）：`vitest` / `e2e-sh` / `pytest` / `playwright`，统一折叠为 EvidenceReport；`AcceptanceItem.runner` 显式声明优先，缺省按 type 推导（unit/integration→vitest、e2e 级→e2e-sh）。合法值单一事实源 = `knownAdapterTypes()`。
- **runner 循环**（`src/runner/loop.ts`）：每轮对投影重算 frontier 就绪维度并派发（维度见 `src/readonly/frontier.ts`：specReady / specReviewPending / specFixPending / specReviewDeadlock / missingChildren / integrationDrift / integrationReady / specContractBroken / specContractDeadlock / flakeReview / buildDrift / buildReady / execReviewReady）；等待 spawn 期间零锁；Ctrl-C 后重跑 `cw run` 从投影续接。转人工停派共五类：连续 TIMEOUT 封顶 / spec 打回活锁（`specReviewDeadlock`）/ e2e flake 连挂（`flakeReview`）/ 解析失败回炉活锁（`specContractDeadlock`）/ buildDrift 缓慢进展（本 spec 周期内 build 证据 ≥K 且无 pass verify → 停派转人工，账本态跨 run 持久；K 默认 5 经 `--max-build-attempts` 注入，只读命令恒用默认）。verify 回炉通道（mx5-2）：spec-frozen 单元验收解析失败连挂 ≥2 → `specContractBroken` 派 designer 回炉修 spec 的验收命令契约（任务书内嵌逐轮解析失败原文，新 spec 照旧过独立 reviewer 再审）；回炉代数 ≥2 → `specContractDeadlock` 转人工停派（防 designer-developer 回炉活锁；解析失败不计入 flake 连挂）。e2e-sh「零标记行 + exit≠0」自 lv-3 起归解析失败（脚本崩溃/环境断链走回炉修 spec，原 no-markers 整体 fail 形态废止）。每 unit 独立 git worktree + 独立分支（双空间命名 `cw-root/<rootId>` 与 `cw/<rootId>/<unitId>`，`src/runner/worktree.ts`）；spawn 过程产物（brief/stdout/stderr）落 run 级 topic 目录 `~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>/`。内部节点集成 = 确定性代码不派 agent（`src/runner/integrate.ts`：merge 子树 → 干净重跑受影响验收 → 契约两道比对），连续 fail 达上限停止自动重派、转派 designer 处置契约漂移（上限 MAX=1 首败即转——rv-4 已交付，mergeFailures 结构化入报告与处置任务书）。exec-review 必须携带 `--evidence-refs`，合法集 = 该 unit 已入账 EvidenceSubmitted ∪ VerifyRan 的 runId（`src/handlers/review-submit.ts`）。单次 spawn 超时可经 `--spawn-timeout-ms` / `CW_SPAWN_TIMEOUT_MS` 调大（缺省 30min，`src/runner/loop.ts` 的 `AGENT_SPAWN_TIMEOUT_MS`）。
- **异源 reviewer 派发**（mx-1 已交付，commit 59cca38）：spec-review verdict 一律由独立 reviewer spawn 提交（designer 任务书不含任何 review submit 步骤）——frontier 维度 `specReviewPending`（待审，派 reviewer）/ `specFixPending`（fail 后修 spec，派 designer）/ `specReviewDeadlock`（打回代数 ≥ 预算转人工——默认 10 代，`cw run --max-spec-rejects` 可注入更紧值；按代数计数（mx-3）：同条 SpecSubmitted 后多条 fail 只计 1 代，重提不清零）；reviewer 模型链 `--reviewer-model` / `CW_REVIEWER_MODEL` > 回落 developer 同款；`cw review submit --role`：spec-review verdict 必填且必须为 reviewer（缺/错 exit 1 拒绝，mx-3 入账层强校验），exec-review 的 role 可选自报（审计载体非信任边界）；无 in-flight reviewer 时新入账的 spec-review verdict 触发 stderr 抢答警告；reviewer 任务书自 lv-3 起注入审查上下文（当前代数 + 最近 3 代打回意见），打回代数 ≥3 起 stderr 逐代出声中间档提示。设计 v1.1 见 `docs/rewrite/design-independent-review.md`。

## TypeScript 规范

- 禁止 `any`，用 `unknown` 或具体类型
- 独立数据源并行请求用 `Promise.allSettled`
- 穷尽性检查用 `const _exhaustive: never = action`

## 测试规范

- 零 mock：真实事件账本 + tmp 目录 + 真实 git 子进程（`tests/fixtures/` 提供共享夹具）
- 测试文件按 unit / 波次命名（`tests/u1-*.test.ts`、`tests/wt-*.test.ts`、`tests/rv*.test.ts`、`tests/mx2-*.test.ts` 等），与 `docs/rewrite/acceptance/` 的验收基线一一对应
- e2e 测试用子进程跑真实 `cw` CLI 命令，走完整 dispatch 路径（不直接调 handler）
- 开发期每波次走「验收基线先行入 git → developer 实现 → verifier 独立验收」流程，见 [docs/rewrite/orchestration.md](./docs/rewrite/orchestration.md)

## CI 约定

- 仅一个 workflow：`.github/workflows/release.yml`，由 `v*` tag push 或手动 `workflow_dispatch`（支持 dry-run 输入）触发；Node 20，跑 `npm ci → npm run build → npm test → npm pack --dry-run → npm publish --provenance`（permissions：`contents: read` + `id-token: write`）
- 无 PR / push 触发的 CI workflow——类型检查与测试在本地跑（见「常用命令」）

## 文档索引

| 文档 | 内容 |
|------|------|
| [CONTEXT.md](./CONTEXT.md) | 2.0 统一语言（核心概念 / 9 命令面 / 环境变量 / 数据布局）——权威术语源 |
| [docs/rewrite/ledger.md](./docs/rewrite/ledger.md) | 重写状态账本（M0-M4 各 unit 状态 / 里程碑 gate / 事件流水）——进行中波次的唯一权威 |
| [docs/rewrite/orchestration.md](./docs/rewrite/orchestration.md) | 重写期协调机制（验收基线防篡改 + developer/verifier 分工） |
| [docs/rewrite/acceptance/](./docs/rewrite/acceptance/) | 各 unit 验收基线（`<unit>-acceptance.md`）与 verifier 报告 / 里程碑 gate 报告 |
| [docs/rewrite/design-worktree-isolation.md](./docs/rewrite/design-worktree-isolation.md) | M3 每 unit 独立 worktree 设计（D1-D6） |
| [docs/rewrite/design-topic-artifacts.md](./docs/rewrite/design-topic-artifacts.md) | fx-4 spawn 产物 topic 目录收口设计（P1-P4） |
| [docs/rewrite/design-independent-review.md](./docs/rewrite/design-independent-review.md) | mx-1 异源 reviewer 派发设计 v1.1（D1-D8，已实现交付） |
| [docs/rewrite/design-spec-contract-replan.md](./docs/rewrite/design-spec-contract-replan.md) | mx-5 验收命令契约设防与 verify 回炉设计（D1-D6：规则⑨ / 回炉通道 / reviewer 对抗清单 / developer 改名 / 词条回写） |
| [.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md](./.xyz-harness/cw-endstate-architecture/design-rewrite-architecture.md) | canon 主设计（§3.3 八决策 D1-D8；该目录被 .gitignore 的 `.xyz-harness/*` 规则忽略，磁盘存在不入 git） |
| [DESIGN-LOG.md](./DESIGN-LOG.md) | 设计历史索引（主题台账 / ADR 索引） |
| [archive/](./archive/) | 1.x 全量归档（旧 src/tests/docs + ARCHITECTURE/PRODUCT/NFR/TEST-STRATEGY/DESIGN-LOG 等根级文档），仅历史参考，不再维护 |
