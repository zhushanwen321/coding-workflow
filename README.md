# coding-workflow

Agent-agnostic CLI for the Coding Workflow (CW) engine — a state machine that keeps AI coding agents on track through a `create → plan → dev → review → test → retrospect → closeout` pipeline.

CW 不假设调用方有任何特定 agent harness 的能力（无 skill 加载、无 workflow 引擎）。agent 只需通过 CLI 调用，按返回的 `nextAction.guidance` 推进。guidance 内嵌完整阶段提示词（spec / plan / execute 方法论）。

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
# 1. 建 topic
cw create --slug my-feature --objective "add login page"
# → 返回 nextAction.action=plan + guidance（含 spec 提示词）

# 2. 按 guidance 产出 plan.json，提交
echo '{"format":"lite","objective":"...","waves":[...],"testCases":[...]}' \
  | cw plan --topicId <topicId>
# → plan gate 通过后 nextAction.action=dev

# 3. 逐 Wave 实现 + commit，提交
cw dev --topicId <topicId> --tasks '[{"waveId":"W1","commitHash":"abc123"}]'
# → 全部 Wave committed 后 nextAction.action=review

# 4. 做 code review，提交报告路径
cw review --topicId <topicId> --reviewPath .xyz-harness/my-feature/review.md
# → review gate 通过后 nextAction.action=test

# 5. 跑测试，提交结果
cw test --topicId <topicId> --cases '[{"caseId":"U1","actual":{"text":"..."}}]'
# → 全部 testCase passed 后 nextAction.action=retrospect

# 6. 写复盘报告，提交路径
cw retrospect --topicId <topicId> --retrospectPath .xyz-harness/my-feature/retrospect.md
# → nextAction.action=closeout

# 7. 归档
cw closeout --topicId <topicId>
# → nextAction.action 为空，流程结束
```

## 命令参考

### 状态变更 action（经状态机，写 gateHistory）

| action | 必需参数 | 可选参数 | 说明 |
|--------|---------|---------|------|
| `create` | `--slug`, `--objective` | `--workspace` | 建 topic，锁 lite 单轨 |
| `plan` | `--topicId` | stdin 或 `--planJsonFile` | 提交 plan.json，解析 waves + testCases |
| `dev` | `--topicId`, `--tasks` | — | 提交 wave commit（渐进式，可多次调用） |
| `review` | `--topicId` | `--reviewPath` | 提交 code review 报告路径（developed → reviewed） |
| `test` | `--topicId`, `--cases` | — | 提交测试结果（渐进式，CW 机器重算 pass/fail） |
| `retrospect` | `--topicId`, `--retrospectPath` | — | 提交复盘报告路径 |
| `closeout` | `--topicId` | — | 归档 topic，流程终态（evidence 自动生成） |
| `replan` | `--topicId` | stdin 或 `--planJsonFile` | dev/review/test 阶段追加 wave（append-only，回退到 planned） |

### 只读查询（不经状态机）

| 命令 | 参数 | 说明 |
|------|------|------|
| `status` | `--topicId` | 查单个 topic 进度快照 |
| `list` | — | 列出当前 workspace 全部 topic |

### 通用参数

- `--workspace <path>`：workspace 根路径（默认 `process.cwd()`），决定 `_cw.json` 落盘位置
- JSON 参数（`--tasks`, `--cases`）支持两种传法：命令行 flag 或 stdin pipe，二选一
- 路径参数同时接受 camelCase 和 kebab-case（如 `--reviewPath` 和 `--review-path` 等效）

## 输出格式

所有输出为 stdout JSON，exit code 语义：

| exit code | 含义 |
|-----------|------|
| 0 | 正常（含 gate fail，结果在 stdout） |
| 1 | guard 拒绝 / 参数错误 / topic 不存在 |
| 2 | 未预期的内部异常 |

返回结构（以 plan 为例）：

```json
{
  "topicId": "cw-2026-07-11-my-feature",
  "status": "planned",
  "gatePassed": { "plan": true },
  "nextAction": {
    "action": "dev",
    "guidance": "plan gate 通过。下一步：按 Wave 实现 + TDD...\n\n[execute 阶段]...",
    "waves": [{ "id": "W1", "committed": false }],
    "alternatives": [{ "action": "replan", "guidance": "如需追加 Wave..." }]
  }
}
```

gate fail 时 `nextAction.action` 指回当前 action（retry），并附 `mustFix` / `taskResults` / `caseResults` 说明失败原因。

`nextAction.alternatives` 列出当前状态下同样合法的其他 action（如 plan/dev 阶段的 `replan`）。`action` 是主推荐路径，`alternatives` 是补充——agent 按场景选择，不必每次都走 `action`。

## 数据存储

- 状态库：`~/.cw/<encoded-cwd>/_cw.json`（per-cwd 隔离，文件锁 + 原子写）
- 可通过 `CW_HOME` 环境变量覆盖根目录（必须是绝对路径）
- 交付物目录：`<workspacePath>/.xyz-harness/<slug>/`（plan.json / retrospect.md 等，由调用方写入，CW gate 读盘校验）

## 状态机

```
created → planned → developed → reviewed → tested → retrospected → closed
              ↑                |          |
              └──── replan ────┘          │
                    （dev/review/test 阶段追加 wave，回退到 planned）
```

lite 单轨，无 tier 字段。guard 只做线性防跳步（`checkLinear`），GuardErrorCode 仅 `illegal_transition`。gate 熔断：同一 action 连续 fail 5 次后 guidance 换熔断文案（不阻断，只告警）。

## 开发

```bash
npm run check    # tsc --noEmit 类型检查
npm run build    # tsc 编译到 dist/
npm test         # vitest run（110 个测试：单测 + 真实子进程 e2e）
npm run lint     # eslint src/ tests/
```

### 源码结构

```
src/
├── types.ts            # 领域类型（Topic/Wave/TestCase/NextAction 等）
├── path-encoding.ts    # cwd → 安全目录名编码
├── state-machine.ts    # TRANSITIONS + checkLinear + buildNextAction + gate 熔断
├── store.ts            # JSON 文件持久化（文件锁 + 原子写）
├── plan-parser.ts      # plan.json 解析（typebox schema 校验）
├── gate.ts             # 各 action 的 gate 检查 + GitValidator
├── actions.ts          # 8 个 action handler + gateAdvance 深函数 + CwParams 联合类型
├── dispatch.ts         # 统一入口：guard → action handler → buildNextAction
├── cli.ts              # CLI 入口（argv 解析 + stdin + dispatch + exit code）
└── prompts/            # 阶段提示词（spec/plan/execute），整合进 guidance 返回
```

engine 职责边界：只防跳步 + 最基础结构校验（format=lite + waves≥1 + cases≥1 + commit 存在 + judgeByExpected）。质量约束（覆盖率阈值、E2E 双层、Wave 依赖无环等）全部交回 prompts 方法论约束，engine 不做。

## License

MIT
