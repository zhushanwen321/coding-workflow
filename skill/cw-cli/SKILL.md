---
name: cw-cli
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the cw CLI state machine. 唯一入口：bash 调 `cw create`，
  之后按返回的 nextAction.guidance 驱动全流程（create→plan→dev→test→retrospect→closeout）。
  guidance 内嵌完整阶段提示词（spec/plan/execute 方法论），不需读外部文档。
  Not for pure planning without CW. Not for design-only.
---

# CW CLI（编码流程编排器）

> **唯一入口：`cw create`。** 不需要记忆任何 action 列表。
> create 之后，CLI 返回的 `nextAction.guidance` 携带完整阶段提示词（如何做 spec / 如何写 plan / 如何 execute），
> agent 按 guidance 一步步推进，直到 `nextAction.action` 为空（流程结束）。

## 核心铁律

[强制] **只暴露一个入口**：agent 不需要知道有哪些 action，只需调 `cw create`，后续全靠 `nextAction` 驱动。

[强制] **guidance 是唯一导航**：每次 `cw` 调用返回的 `nextAction.guidance` 含完整方法论（不只是"下一步调什么"，还包括"怎么做"——如何明确 spec、如何写 plan、如何 TDD 执行）。按 guidance 走，不自决下一阶段。

[强制] **通过 bash 调 `cw` 命令**：agent 用 bash 工具执行 `cw <action> [flags]`，读 stdout 的 JSON。不假设有 tool 注册机制（CW 是 agent-agnostic CLI）。

[强制] **不绕过状态机**：不调 CW 就无法推进状态。跳过某阶段直接调后面的 action → guard 拒绝（illegal_transition）。

## 唯一入口

```bash
cw create --slug <kebab-case-slug> --objective "<一句话业务目标>"
```

返回 JSON 含 `topicId` + `nextAction`。**记下 topicId**，后续所有调用都要传。

### 运行环境（评估分组维度，可选）

`cw create` 会自动注入运行环境元数据（agent + llm + cwVersion），用于评估指标按分组对比。默认值 `Pi / GLM-5.2`，覆盖日常场景。

切环境时两种覆盖方式（优先级：命令行 > env.json > 默认值）：

```bash
# 方式 1：命令行参数（临时覆盖）
cw create --slug <slug> --objective "<obj>" --agent "Claude Code" --llm "Sonnet-4.5"

# 方式 2：env.json（持久默认，与 _cw.json 同目录）
# ~/.cw/<encoded-cwd>/env.json
{ "agent": "Claude Code", "llm": "Sonnet-4.5" }
```

cwVersion 始终从 package.json 自动读取，不可手动指定。

## 推进流程（按 nextAction 驱动）

每次 `cw` 调用返回 `nextAction`：

```json
{
  "topicId": "cw-2026-07-11-xxx",
  "status": "planned",
  "nextAction": {
    "action": "tdd_plan",       // 下一步该调的 action；为空 = 流程结束
    "guidance": "plan gate 通过。下一步：...\n\n[tdd_plan 阶段]...",  // 含完整方法论
    "waves": [{ "id": "W1", "committed": false }],
    "testCases": [{ "id": "U1", "status": "pending" }],
    "alternatives": [{ "action": "replan", "guidance": "如需修改计划..." }]
  }
}
```

**ALWAYS 按 `nextAction.action` 调下一次 `cw`**。`action` 为空（undefined）= 流程结束（closed 终态）。

`alternatives` 是当前状态下**同样合法**的可选 action（不是错误处理路径）。`action` 是主推荐，`alternatives` 是补充——当场景需要时（如 dev 中途发现 plan 要追加 Wave）走 `alternatives`，不必每次都走 `action`。

### 9 阶段流程

```
create → clarify → plan → tdd_plan → dev → review → test → retrospect → closeout
```

| nextAction.action | 你要做的 | cw 命令 |
|-------------------|---------|---------|
| `clarify` | 探索技术系统 + 澄清需求/技术 spec + 记录 ADR（advisory，可跳过） | `echo '<clarifyJson>' \| cw clarify --topicId <id>` |
| `plan` | 明确范围后产出 **dev-plan.json**（只含 waves），提交 | `echo '<devPlanJson>' \| cw plan --topicId <id>` |
| `tdd_plan` | 写测试代码（红灯）+ **test.json**（testCases + expected），提交 | `echo '<testJson>' \| cw tdd_plan --topicId <id>` |
| `dev` | 按 Wave 写实现让测试转绿，commit，提交 | `cw dev --topicId <id> --tasks '[{"waveId":"W1","commitHash":"<sha>"}]'` |
| `review` | 做 code review，产出 review.md + 结构化问题清单（stdin） | `echo '<issuesJson>' \| cw review --topicId <id> --reviewPath <path>` |
| `review_fix` | 修复 review 发现的 issue，提交修复审计 | `echo '<fixesJson>' \| cw review_fix --topicId <id>` |
| `test` | 跑测试，提交 actual 结果 | `cw test --topicId <id> --cases '[{"caseId":"U1","actual":{"text":"<结果>"}}]'` |
| `test_fix` | 修复 test 失败的 case，提交修复审计 | `echo '<fixesJson>' \| cw test_fix --topicId <id>` |
| `retrospect` | 写复盘报告（retrospect.md）+ 结构化回顾数据（retrospectData），提交 | `echo '<retrospectDataJson>' \| cw retrospect --topicId <id> --retrospect-path <path>` |
| `closeout` | 归档 topic，返回 evidence（coverage + gateHistory） | `cw closeout --topicId <id>` |
| `replan` | 修改计划（--plan 改 dev-plan / --test 改 test.json） | `echo '<devPlanJson>' \| cw replan --topicId <id> --plan` 或 `cw replan --topicId <id> --test --testJsonFile <path>` |
| `undefined` | 流程结束 | 无 |
| `assess`（人工） | closeout 后提交交付质量评估（post-closeout，不在 nextAction 导航里） | `cw assess --topicId <id> --type quality --score 4 --notes "..."` |

> **`assess` 是 post-closeout 人工评估**，**不进 nextAction 导航**——流程主链路在 closeout 后即结束（`nextAction.action` 为空）。
> 设计者手动调 `cw assess` 记录交付质量数据，可多次调用（progressive，不改 status）。详见下文「post-closeout 评估（assess）」。

### clarify 阶段 + ADR 机制

create 之后、plan 之前。澄清需求/技术 spec，记录关键决策。**advisory——不强制**，清晰需求可直接 plan（plan 的 gate 不依赖 clarify）。

**流程**：判断清晰度 → 探索技术系统（读代码）→ 形成预判 + 推荐 → 向用户提问 → 记录到 cw → 如有 ADR 则双写。

**提问两类**：
- `requirement`：需求 spec 澄清，阻塞业务用例的逻辑歧义
- `technical`：技术 spec 澄清，涉及选型/架构/关键 ADR

**呈现方式**：简单问题用 AskUserQuestion（选项式，批量 1-4 个）；复杂方案产出 md/html，`presentationPath` 记录路径。

**禁止空问**：每条 clarifyJson 必须含 `assessment`（探索背景 + 预判）。空问 = 转嫁探索成本给用户。

**ADR 双写**（克制使用，多数 session 0-1 个）：
只有同时满足①难以逆转②没有上下文会让人觉得意外③真实取舍，才记 ADR。任一缺失则跳过。
- agent 写 `docs/adr/{id}-{title}.md`（人可读，git tracked）
- `cw clarify` 带 `adr.projectPath`，cw 校验文件存在后写入 `topic.adrs`（结构化数据）

**clarifyJson 格式**：

```jsonc
// 单条（pending，向用户提问前记录）
{ "kind": "technical", "topic": "状态存储方案",
  "assessment": "当前 store.ts 用 JSON + flock（见 store.ts:222），并发写锁竞争明显...",
  "question": "状态存储维持 JSON 还是迁移 SQLite？",
  "options": [{"id":"A","label":"维持JSON","tradeoff":"零依赖，并发弱"},
              {"id":"B","label":"迁SQLite","tradeoff":"并发好，引入原生依赖"}],
  "recommendation": "B" }

// 提问 + 回答 + ADR（一次闭环）
{ ...同上, "answer": "选 B",
  "adr": { "title":"状态存储迁移SQLite", "context":"...", "decision":"用better-sqlite3",
           "alternatives":["JSON+flock"], "consequences":"新增原生依赖",
           "projectPath":"docs/adr/0001-sqlite.md" } }

// 批量（数组，一次记录多条）
[{ ... }, { ... }]
```

**渐进式**：每次提问/拿到答案就调一次 `cw clarify`（参考 dev 阶段 progressive 模式）。全 resolved 后 nextAction 切到 `plan`。

### 文件拆分：dev-plan.json + test.json

CW 的计划阶段产出**两个文件**：

| 文件 | 提交阶段 | 内容 |
|------|---------|------|
| dev-plan.json | plan | format + objective + waves（dev 规划） |
| test.json | tdd_plan | testCases（测试用例 + expected）+ 可选 testRunner |

**向后兼容**：旧版 plan.json（同时含 waves + testCases）仍可提交给 `cw plan`，CW 自动提取 testCases。

### retrospect 结构化数据（retrospectData）

retrospect 阶段产出两个文件：

| 产物 | 给谁读 | 内容 |
|------|--------|------|
| retrospect.md | 人（自由格式复盘叙述） | 含上下文和思考过程 |
| retrospectData | 机器（结构化 JSON，从 stdin 传入） | knownRisks + processIssues |

agent 只填 `knownRisks` + `processIssues`，`derived` 段由 cw 自动从执行数据派生（不填，填了也会被覆盖）：

```jsonc
{
  "knownRisks": [
    { "severity": "high", "area": "并发写入", "description": "flock 未压测", "unverified": true }
  ],
  "processIssues": ["plan 没考虑 git diff-tree 性能"]
}
```

retrospectData 可选——不提供也能 gate pass（向后兼容），但建议提供（评估数据来源）。

## gate fail 时怎么办

gate fail 时 `nextAction.action` **指回当前 action**（retry），不是下一阶段。看返回里的失败原因字段：

| 场景 | fail 原因在哪 | 怎么修 |
|------|-------------|--------|
| plan/tdd_plan/retrospect/closeout gate fail | 顶层 `mustFix` | 修 mustFix 列出的问题，重调同一 action |
| review 发现 issue（issues 非空） | `reviewIssues` | 进 review_fix：修代码 → `cw review_fix` → 复查 |
| dev gate fail（commit 不真实/缺失） | `taskResults[].reason` | 修该 Wave 的 commit，重调 `cw dev` |
| test gate fail（结果 != 预期） | `caseResults[].failureReason` | 进 test_fix：修代码 → `cw test_fix` → 重跑 test |

## issue tracking + fix loop

review 和 test 阶段各有独立的 **fix loop**——发现问题 → 修复 → 复查，不回退到 dev。

### review fix loop

```
echo '[{"severity":"must-fix","description":"...","file":"src/x.ts:1"}]' | cw review --topicId <id> --reviewPath <path>  → CW 指向 review_fix
echo '[{"issueId":"R1","commitHash":"<sha>","resolution":"..."}]' | cw review_fix --topicId <id>  → CW 指向 review（turn 2 复查）
echo '[]' | cw review --topicId <id> --reviewPath <path>  → 无新问题，进 test
```

- 最多 3 轮（REVIEW_TURN_LIMIT）。达上限强制进 test，guidance 标注未修复的 must-fix。
- review_fix 的 commitHash 只记录审计，不校验真实性。

### test fix loop

```
cw test --topicId <id> --cases '[...]'  → U1 failed → CW 指向 test_fix
echo '[{"caseId":"U1","commitHash":"<sha>","resolution":"..."}]' | cw test_fix --topicId <id>  → CW 指向 test（重跑）
cw test --topicId <id> --cases '[{"caseId":"U1","actual":{"text":"正确值"}}]'  → U1 pass → 进 retrospect
```

- 最多 5 轮（TEST_TURN_LIMIT）。达上限强制进 retrospect（打破死循环），在复盘中记录未通过原因。
- test_fix 的 commitHash 只记录审计，不校验真实性。
- expected 写错 → 调 `cw replan --test --testJsonFile <path>`（不是代码 bug）。

## 修改计划（replan）

status∈{planned, tdd_inited, developed, reviewed, tested} 时可调 `cw replan`。支持两种模式：

### --plan：修订 dev-plan（追加/调整 wave）

```bash
echo '<newDevPlanJson>' | cw replan --topicId <id> --plan
```

### --test：修订 test.json（追加/调整 testCase / 修正 expected）

```bash
cw replan --topicId <id> --test --testJsonFile <testJsonFilePath>
```

### 同时修订两个文件

```bash
echo '<devPlanJson>' | cw replan --topicId <id> --plan --test --testJsonFile <testJsonPath>
```

**append-only 约束**（不可违反，违反则 replan 抛错 + mustFix）：

| 不可动的项 | 原因 |
|-----------|------|
| 已 committed 的 Wave（删/改 changes/dependsOn） | 已有 commit 锚定，改了会让 commit 与 plan 脱节 |
| 已 passed 的 testCase（删/改 expected 等语义字段） | expected 是判定基准，改了会让「已 passed」失效 |

未 committed/passed 的可删可改。新增 wave / testCase 总是允许的（append-only 的核心操作）。

**replan 后的状态变化**：status 回退到 `planned`，需重走 tdd_plan → dev → review → test。已 committed 的 Wave 保留不动（progressive），dev 阶段只做新增的 wave。test 全量重跑（防回归）。

## post-closeout 评估（assess）

closeout 后（status=closed），设计者可手动调 `cw assess` 提交交付质量评估。**不在 nextAction 导航里**——流程主链路在 closeout 后即结束，assess 是人工触发的数据追加。

**特点**：
- progressive：可多次调用，每次追加一条评估记录（AS1, AS2...），不改 status（始终 closed）
- 不走 gate 机制（不写 gateHistory），纯数据追加
- 不进任何 guidance（closeout 的 nextAction 不提 assess）

**四种评估类型**（`--type`）：

| type | 用途 | 必填字段 |
|------|------|---------|
| `quality` | 代码质量评估（结构/类型安全/可读性） | notes（+ 可选 score 1-5） |
| `test` | 测试质量评估（覆盖率/有效性/边界） | notes（+ 可选 score 1-5） |
| `stability` | 稳定性评估（并发/异常/资源） | notes（+ 可选 score 1-5） |
| `defect` | 缺陷登记（校准 review 召回率的核心） | notes + `--defect`（severity/area/rootCause/foundInReview） |

**缺陷登记**（`type=defect`）是评估体系的核心——`foundInReview` 标记该缺陷在 review 阶段是否已被发现，积累后可算 review 召回率 = review 发现的缺陷 / 总缺陷。

```bash
# 简单评估
cw assess --topicId <id> --type quality --score 4 --notes "代码结构清晰，类型安全到位"

# 缺陷登记（校准核心）
cw assess --topicId <id> --type defect --notes "并发场景下数据丢失" \
  --defect '{"severity":"major","area":"store.ts","rootCause":"边界遗漏","foundInReview":false}'
```

**`--defect` 字段说明**：

| 字段 | 说明 |
|------|------|
| `severity` | 缺陷严重度：`blocker` / `major` / `minor` |
| `area` | 涉及的模块/功能区域（如 "store.ts"） |
| `rootCause` | 根因分类（如 "边界遗漏" / "类型错误" / "需求理解偏差"） |
| `foundInReview` | review 阶段是否已发现该问题。`true`=review 抓到但没修干净 / `false`=review 完全漏了 |

## 前置检查

[MANDATORY] 启动 CW 前：

- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow`
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（dev/test 需要真实 commit）
- **workspace 可写**：交付物（plan.json / retrospect.md）落在 `<cwd>/.xyz-harness/<slug>/`

## 项目文档基建诊断（cw init，可选）

`cw create` 之前可先调 `cw init` 检测项目文档基建。这是 topic 之前的只读诊断命令，**不进状态机**（无 topic，与 status/list/stats 同级）。

[OPTIONAL] **何时调用**：首次在某个项目用 CW 时，或 `cw create` 的 guidance 提示文档基建未就绪时。已有完整文档的项目可跳过。

```bash
cw init
# → JSON：{ docRoot, mainConfig, docs: [...], ready }
```

**返回结构**：

```jsonc
{
  "docRoot": "/path/to/project",
  "mainConfig": "AGENTS.md",       // 或 "CLAUDE.md"，缺失为 null
  "ready": true,                    // 必备文档全 ok 且无 stale
  "docs": [
    {
      "name": "主配置（必备）",
      "level": "必备",
      "status": "missing",          // ok | missing | skeleton | stale
      "path": "AGENTS.md",
      "detail": "缺失（必备）",
      "skeleton": "# {项目名}\n..."  // status=missing 时附带骨架内容
    }
  ]
}
```

**文档分级与状态**：

| 级别 | 文档 | status 含义 |
|------|------|------------|
| 必备 | AGENTS.md（或 CLAUDE.md）、README.md、CONTEXT.md | missing/skeleton/stale 影响 ready |
| 推荐 | ARCHITECTURE.md、PRODUCT.md、NFR.md | 不影响 ready，按需补齐 |
| 可选 | TEST-STRATEGY.md、DESIGN-LOG.md | 不影响 ready |

状态：`ok`=已沉淀 / `missing`=缺失（附骨架）/ `skeleton`=含 ASCII 占位符未沉淀 / `stale`=ARCHITECTURE/NFR 非骨架但模块名或验证标识符与源码漂移。

**补齐流程**（agent 收到 init 结果后）：
1. 看 `docs` 数组，筛出 `status !== "ok"` 的必备项
2. 向用户确认是否补齐（[MANDATORY] 不自动覆盖已有文档，只补缺失项）
3. 用 `skeleton` 字段的内容，通过 write 工具创建文件到 `docRoot` 路径
4. 补齐后可重跑 `cw init` 验证 `ready=true`

**绝不覆盖已有文档**——cw init 只扫描报告，不碰文件系统。

## 数据存储（cwd 隔离机制）

- 状态库：`~/.cw/<encoded-cwd>/_cw.json`
- 运行环境配置：`~/.cw/<encoded-cwd>/env.json`（可选，agent+llm 默认值覆盖）
- topicId 格式：`cw-{date}-{slug}`
- 跨 session 接续：调 `cw list` 找 topicId，调 `cw status --topicId <id>` 看当前进度，再按 nextAction 继续

## 只读查询命令（不触发状态变更）

| 命令 | 用途 |
|------|------|
| `cw status --topicId <id>` | 查看单个 topic 进度快照（status/gatePassed/waves/testCases） |
| `cw list` | 列出当前 cwd 下所有 topic |
| `cw stats --topicId <id>` | 评估指标（复杂度分桶/过程效率/杠杆健康度），数据从 gateHistory 派生 |

`cw stats` 输出 JSON，含三类指标：
- **complexity**：waves 数 + 文件数 → simple/medium/complex 分桶
- **efficiency**：首次正确率、早期拦截率（dev+test fail 占比）、dev/test 重试次数
- **leverHealth**：CW 各机制 gate（TDD 红灯/commit 锚定/机器重算等）的最终状态

[强制] **cwd 隔离**：CW 按 `process.cwd()` 隔离 topic，不同 cwd 路径对应不同的 `_cw.json`。以下场景会导致 `topic not found`：

| 场景 | 原因 | 修复 |
|------|------|------|
| 跨 worktree | `feat-xxx/` 和 `main/` 是不同 cwd | 在创建 topic 的 worktree 下调 cw |
| 跨子目录 | `project/` 和 `project/src/` 是不同 cwd | 回到创建 topic 时的目录 |
| 跨 session | 不同 bash 调用的 cwd 可能不同 | 用 `cw list` 确认当前 cwd 下有哪些 topic |
| **符号链接路径** | `process.cwd()` 解析 symlink 返回**物理路径**（Node.js 标准行为）。通过符号链接进入目录（如 `cd ~/Stock/proj`，实际指向 `~/Code/proj-workspace/main`）与通过真实路径进入，`encodeCwd` 产出不同的 `_cw.json`，topic 互不可见 | 始终用同一种路径访问同一项目；排查时 `node -p "process.cwd()"` 确认实际解析的路径 |

**设计意图**：per-cwd 隔离保证不同项目/worktree 的 topic 互不干扰。这不是 bug，是特性。

**符号链接的额外说明**：`~/Stock/stock-portfolio-service → ~/Code/stock-portfolio-service-workspace/main` 这类符号链接在 multi-worktree 项目中常见。shell 的 `$PWD` 保留逻辑路径（`~/Stock/...`），但 `process.cwd()` 返回物理路径（`~/Code/...`），两者 `encodeCwd` 结果不同。macOS 的 `/tmp → /private/tmp` 同理。

**排查步骤**：`topic not found` 时，先 `cw list` 看当前 cwd 下有没有 topic。如果没有，说明 cwd 不对——`node -p "process.cwd()"` 确认实际路径，回到创建 topic 时的路径再调。

## 失败模式

- **illegal_transition**（跳阶段）：没按 nextAction 顺序走。看 `cw status` 确认当前 status，按 nextAction 重来
- **gate 反复 fail**：同一 action 连续 fail 5 次后 guidance 换熔断文案（不阻断，建议找用户人工审查）
- **topic not found**：cwd 不对（跨 worktree/子目录/session）。修复：`cw list` 看当前 cwd 下有哪些 topic，回到创建 topic 时的目录调 cw

## Self-Check

[MANDATORY] 以下全部满足才算 CW 流程走完：

- [ ] 从 `cw create` 开始，没有绕过状态机
- [ ] 每次 `cw` 调用后读 `nextAction`，按它的 `action` 调下一次
- [ ] dev 阶段所有 Wave committed（nextAction.waves 全 committed=true）
- [ ] test 阶段所有 testCase passed（nextAction.testCases 全 status=passed）
- [ ] closeout 后 `nextAction.action` 为空（终态）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [强制] | 流程不可逾越的边界（机器层强制） | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
