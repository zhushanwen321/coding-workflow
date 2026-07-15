# coding-workflow

Agent-agnostic CLI for the Coding Workflow (CW) engine — a state machine that keeps AI coding agents on track through a `create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout` pipeline.

CW 不假设调用方有任何特定 agent harness 的能力（无 skill 加载、无 workflow 引擎）。agent 只需通过 bash 调用 `cw`，按返回的 `nextAction.guidance` 推进。guidance 内嵌完整阶段提示词（spec / plan / execute / review / retrospect 方法论）。

## 安装

```bash
# 全局安装（提供 cw 命令）
npm install -g @zhushanwen/coding-workflow

# 或临时执行（不安装）
npx @zhushanwen/coding-workflow create --slug my-task --objective "..."
```

### 本地开发

```bash
git clone https://github.com/zhushanwen321/coding-workflow.git
cd coding-workflow
npm install
npm run build
npm link
```

要求 Node ≥ 20。

## 快速上手

agent 的唯一入口是 `cw create`，后续全靠返回的 `nextAction` 驱动：

```bash
# 1. 建 topic（自动注入 RuntimeEnv: agent=Pi, llm=GLM-5.2）
cw create --slug my-feature --objective "add login page"
# → 返回 nextAction.action=clarify + guidance（含 clarify 提示词）

# 2. （可选）澄清需求，记录 ADR
echo '<clarifyJson>' | cw clarify --topicId <topicId>

# 3. 产出 dev-plan.json（waves），提交
echo '<devPlanJson>' | cw plan --topicId <topicId>
# → nextAction.action=tdd_plan

# 4. 写测试代码（红灯）+ test.json，提交
echo '<testJson>' | cw tdd_plan --topicId <topicId>
# → nextAction.action=dev

# 5. 逐 Wave 实现 + commit，提交
cw dev --topicId <topicId> --tasks '[{"waveId":"W1","commitHash":"abc123"}]'
# → 全部 Wave committed 后 nextAction.action=review

# 6. 做 code review，提交 issues（stdin 管道）
echo '<issuesJson>' | cw review --topicId <topicId> --reviewPath <review.md>
# → 无 issue → nextAction.action=test；有 must-fix → nextAction.action=review_fix

# 7. 跑测试，提交 actual 结果
cw test --topicId <topicId> --cases '[{"caseId":"U1","actual":{"text":"..."}}]'
# → 全部 passed → nextAction.action=retrospect；有 fail → nextAction.action=test_fix

# 8. 写复盘报告 + 结构化数据，提交
echo '<retrospectDataJson>' | cw retrospect --topicId <topicId> --retrospectPath <retrospect.md>
# → nextAction.action=closeout

# 9. 归档
cw closeout --topicId <topicId>
# → nextAction.action 为空，流程结束
```

## 命令参考

### 状态变更 action（经状态机，写 gateHistory）

| action | 必需参数 | 可选参数 | 说明 |
|--------|---------|---------|------|
| `create` | `--slug`, `--objective` | `--workspace`, `--agent`, `--llm` | 建 topic，注入 RuntimeEnv |
| `clarify` | `--topicId` | stdin 或 `--clarifyJsonFile` | 澄清需求/技术 spec（advisory，可跳过） |
| `plan` | `--topicId` | stdin 或 `--planJsonFile` | 提交 dev-plan.json |
| `tdd_plan` | `--topicId` | stdin 或 `--testJsonFile` | 提交 test.json（testCases + expected） |
| `dev` | `--topicId`, `--tasks` | — | 提交 wave commit（progressive，可多次调用） |
| `review` | `--topicId` | `--reviewPath`, stdin（issues） | code review，issues 从 stdin 读 |
| `review_fix` | `--topicId` | stdin 或 `--fixesFile` | 修复 review issue（issuesId + commitHash + resolution） |
| `test` | `--topicId`, `--cases` | — | 提交测试结果（CW 机器重算 pass/fail） |
| `test_fix` | `--topicId` | stdin 或 `--fixesFile` | 修复 test 失败的 case（caseId + commitHash + resolution） |
| `retrospect` | `--topicId` | `--retrospectPath`, stdin（retrospectData） | 复盘报告 + 结构化回顾数据 |
| `closeout` | `--topicId` | — | 归档 topic，流程终态 |
| `replan` | `--topicId` | `--plan` / `--test`, stdin | 修改 dev-plan 或 test.json（append-only） |
| `assess` | `--topicId`, `--type`, `--notes` | `--score`, `--defect` | post-closeout 人工评估（不进 guidance 导航） |

### 只读查询（不经状态机）

| 命令 | 参数 | 说明 |
|------|------|------|
| `status` | `--topicId` | 查单个 topic 进度快照 |
| `list` | — | 列出当前 workspace 全部 topic |
| `stats` | `--topicId` 或 `--all` | 评估指标（复杂度/效率/杠杆健康度） |
| `init` | — | 项目文档基建诊断（topic 之前，扫描缺失/骨架态/漂移） |

### `init` — 项目文档基建诊断

`cw init` 是 `create` 之前的可选基建检测命令，**不进状态机**（无 topic）。扫描项目根的长期文档，返回缺失清单 + 骨架内容，agent 按用户确认用 write 工具补齐：

```bash
cw init
# → JSON：{ docRoot, mainConfig, docs: [...], ready }
```

**文档分级**：

| 级别 | 文档 | 缺失处理 |
|------|------|---------|
| 必备 | AGENTS.md（或 CLAUDE.md）、README.md、CONTEXT.md | 附骨架字符串，建议补齐 |
| 推荐 | ARCHITECTURE.md、PRODUCT.md、NFR.md | 附骨架，按需补齐 |
| 可选 | TEST-STRATEGY.md、DESIGN-LOG.md | 附骨架，不阻断 |

**状态判定**：`ok`（已沉淀）/ `missing`（缺失，附骨架）/ `skeleton`（含 ASCII 占位符，未沉淀）/ `stale`（ARCHITECTURE/NFR 非骨架态但模块名/验证标识符与源码漂移）。

`ready=true`（必备全 ok 且无 stale）时可直接进 `create` 流程。`create` 时若必备文档未就绪，会在 `nextAction.guidance` 里引导先 `cw init`（建议不阻断）。

**绝不覆盖已有文档**——只扫描、报告、按确认补齐缺失项。

### 通用参数

- `--workspace <path>`：workspace 根路径（默认 `process.cwd()`），决定 `_cw.json` 落盘位置
- JSON 参数（`--tasks`, `--cases`）以 JSON 字符串 flag 传入；`plan`/`tdd_plan`/`clarify`/`replan` 的 JSON 从 stdin pipe 读
- 路径参数同时接受 camelCase 和 kebab-case（如 `--reviewPath` 和 `--review-path` 等效）
- issues / fixes / retrospectData 从 **stdin** 读（不是 flag）

## 输出格式

所有输出为 stdout JSON，exit code 语义：

| exit code | 含义 |
|-----------|------|
| 0 | 正常（含 gate fail，结果在 stdout） |
| 1 | guard 拒绝 / 参数错误 / topic 不存在 |
| 2 | 未预期的内部异常 |

gate fail 时 `nextAction.action` 指回当前 action（retry），并附 `mustFix` / `taskResults` / `caseResults` 说明失败原因。

`nextAction.alternatives` 列出当前状态下同样合法的其他 action（如 dev 阶段的 `replan`）。`action` 是主推荐路径，`alternatives` 是补充——agent 按场景选择。

## 状态机

```
created → planned → tdd_inited → developed → reviewed → tested → retrospected → closed
              ↑                    |       |
              └────── replan ──────┘       │
                    （planned ~ tested 阶段可调，回退到 planned）
```

lite 单轨，无 tier 字段。guard 只做线性防跳步（`checkLinear`），GuardErrorCode 仅 `illegal_transition`。gate 熔断：同一 action 连续 fail 5 次后 guidance 换熔断文案（不阻断，只告警）。

review/test 各有独立的 fix loop（发现问题 → 修复 → 复查），不回退到 dev。review 最多 3 轮，test 最多 5 轮，达上限后强制进入下一阶段或熔断。

## 评估指标

`cw stats` 输出三层评估指标（详见 [docs/metrics-design.md](./docs/metrics-design.md)）：

| 层 | 回答的问题 | 命令 |
|----|-----------|------|
| 交付质量 | "交付的东西好不好？" | `cw assess`（post-closeout 人工评估） |
| 过程效率 | "过程顺不顺？" | `cw stats --topicId <id>` |
| 杠杆健康度 | "CW 的机制起作用了吗？" | `cw stats --topicId <id>` |

`cw stats --all` 按 RuntimeEnv（agent + llm + cwVersion）分组聚合，同组内按复杂度分桶，桶内算均值。指标用法见 [docs/metrics-usage.md](./docs/metrics-usage.md)。

## 数据存储

- 状态库：`~/.cw/<encoded-cwd>/_cw.json`（per-cwd 隔离，文件锁 + 原子写）
- 可通过 `CW_HOME` 环境变量覆盖根目录（必须是绝对路径）
- RuntimeEnv 默认值：`~/.cw/<encoded-cwd>/env.json`（可选，agent + llm）
- 交付物目录：`<workspacePath>/.xyz-harness/<slug>/`（plan.json / review.md / retrospect.md 等）

## 开发

```bash
npm run check:all   # tsc 类型检查（src + tests）
npm test            # vitest run（393 个测试，含真实子进程 e2e）
npm run lint        # eslint src/ tests/
npm run build       # tsc 编译到 dist/
```

测试是真实环境的：零 mock 框架，真实 CwStore + tmp 目录 + git 子进程。

### 源码结构

```
src/
├── types.ts            # 领域类型（Topic/Wave/TestCase/Action/Status 等）
├── path-encoding.ts    # cwd → 安全目录名编码
├── state-machine.ts    # TRANSITIONS + checkLinear + buildNextAction + gate 熔断
├── store.ts            # JSON 文件持久化（flock + 原子写）
├── plan-parser.ts      # dev-plan.json / test.json 解析
├── gate.ts             # 各 action 的 gate 检查 + GitValidator
├── actions.ts          # 13 个 action handler + CwParams 联合类型
├── dispatch.ts         # 统一入口：guard → action handler → buildNextAction
├── stats.ts            # 评估指标（complexity + efficiency + leverHealth + --all 聚合）
├── cli.ts              # CLI 入口（argv + stdin + dispatch + exit code）
└── prompts/            # 阶段提示词，拼入 guidance 返回
    ├── clarify.ts      # create→plan 之间的澄清方法论
    ├── spec.ts         # spec 方法论
    ├── dev-plan.ts     # plan 阶段（dev-plan.json 格式）
    ├── tdd-plan.ts     # tdd_plan 阶段（test.json + 红灯确认）
    ├── execute.ts      # dev/test/test_fix 阶段方法论
    ├── review.ts       # review/review_fix 阶段方法论
    ├── retrospect.ts   # retrospect 阶段方法论
    └── index.ts        # 聚合 export
```

engine 职责边界：只防跳步 + 最基础结构校验 + commit 存在性 + judgeByExpected 机器重算。质量约束（覆盖率阈值、E2E 双层、Wave 依赖无环等）全部交回 prompts 方法论约束，engine 不做。

## License

MIT
