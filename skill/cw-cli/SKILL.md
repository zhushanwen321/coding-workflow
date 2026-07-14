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

## 推进流程（按 nextAction 驱动）

每次 `cw` 调用返回 `nextAction`：

```json
{
  "topicId": "cw-2026-07-11-xxx",
  "status": "planned",
  "nextAction": {
    "action": "dev",            // 下一步该调的 action；为空 = 流程结束
    "guidance": "plan gate 通过。下一步：...\n\n[execute 阶段]...",  // 含完整方法论
    "waves": [{ "id": "W1", "committed": false }],    // dev/test 带进度
    "testCases": [{ "id": "U1", "status": "pending" }],
    "alternatives": [{ "action": "replan", "guidance": "如需追加 Wave..." }]  // plan/dev 阶段：同样合法的可选 action
  }
}
```

**ALWAYS 按 `nextAction.action` 调下一次 `cw`**。`action` 为空（undefined）= 流程结束（closed 终态）。

`alternatives` 是当前状态下**同样合法**的可选 action（不是错误处理路径）。`action` 是主推荐，`alternatives` 是补充——当场景需要时（如 dev 中途发现 plan 要追加 Wave）走 `alternatives`，不必每次都走 `action`。

| nextAction.action | 你要做的 | cw 命令 |
|-------------------|---------|---------|
| `plan` | 读 guidance 的 spec 提示词，明确范围后产出 plan.json，提交 | `echo '<planJson>' \| cw plan --topicId <id>` |
| `dev` | 读 guidance 的 execute 提示词，按 Wave 实现 + TDD + commit，提交 | `cw dev --topicId <id> --tasks '[{"waveId":"W1","commitHash":"<sha>"}]'` |
| `review` | 读 guidance 的 review 提示词，做 5 维度代码审查 + plan 覆盖核对，产出 review.md | `cw review --topicId <id> --reviewPath <path>` |
| `test` | 读 guidance，跑测试，提交结果 | `cw test --topicId <id> --cases '[{"caseId":"U1","actual":{"text":"<结果>"}}]'` |
| `retrospect` | 写复盘报告，提交路径 | `cw retrospect --topicId <id> --retrospect-path <path>` |
| `closeout` | 归档 topic | `cw closeout --topicId <id> --evidence "<证据>"` |
| `replan` | dev 阶段发现要追加 Wave 或调整未 committed 的 plan 项时 | `echo '<planJson>' \| cw replan --topicId <id>` |
| `undefined` | 流程结束 | 无 |

## gate fail 时怎么办

gate fail 时 `nextAction.action` **指回当前 action**（retry），不是下一阶段。看返回里的失败原因字段：

| 场景 | fail 原因在哪 | 怎么修 |
|------|-------------|--------|
| plan/review/retrospect/closeout gate fail | 顶层 `mustFix` | 修 mustFix 列出的问题，重调同一 action |
| dev gate fail（commit 不真实/缺失） | `taskResults[].reason` | 修该 Wave 的 commit，重调 `cw dev` |
| test gate fail（结果 != 预期） | `caseResults[].failureReason` | 修代码或修测试，重跑，重调 `cw test` |

修完后重调同一 action（渐进式：已成功的项不重跑）。**照 nextAction 走不会撞 illegal_transition**——fail 时它指回自己，不会指向下一阶段。

## 修改 plan.json（replan）

plan 不是一次性的。status∈{planned, developed, reviewed, tested}（plan 通过后的任何阶段）时，`nextAction.alternatives` 会带 replan 提示。以下场景调 `cw replan`：

- dev 中途发现需要**追加新 Wave**（plan 漏了某块改动）
- 调整**未 committed** 的 Wave（改 changes/dependsOn、删残留 Wave）
- 调整**未 passed** 的 testCase
- test 阶段发现 **expected 值需修正**（如 rename 后 testId 失效导致全 fail，或 plan 预期值设错）

```bash
echo '<新版完整 plan.json>' | cw replan --topicId <id>
```

replan 接收**完整的新 plan.json**（不是增量 patch），内部解析校验 + append-only 安全校验。

**append-only 约束**（不可违反，违反则 replan 抛错 + mustFix）：

| 不可动的项 | 原因 |
|-----------|------|
| 已 committed 的 Wave（删/改 changes/dependsOn） | 已有 commit 锚定，改了会让 commit 与 plan 脱节 |
| 已 passed 的 testCase（删/改 expected 等语义字段） | expected 是判定基准，改了会让「已 passed」失效 |

未 committed/passed 的可删可改（清理残留的合法机制）。

**replan 后的状态变化**：status 回退到 `planned`（即使之前已 developed），需重新走 dev。新增的 Wave 要重新 commit。已 committed 的 Wave 保留不动（progressive）。

**replan gate fail 时**（append-only 违规）：返回 mustFix 列出违反的项，修正后重调 `cw replan`。

## 前置检查

[MANDATORY] 启动 CW 前：

- **`cw` 命令可用**：`which cw` 能找到。未安装 → `npm install -g @zhushanwen/coding-workflow`
- **git 仓库已初始化**：`git rev-parse --git-dir` 能跑通（dev/test 需要真实 commit）
- **workspace 可写**：交付物（plan.json / retrospect.md）落在 `<cwd>/.xyz-harness/<slug>/`

## 数据存储（cwd 隔离机制）

- 状态库：`~/.cw/<encoded-cwd>/_cw.json`
- topicId 格式：`cw-{date}-{slug}`
- 跨 session 接续：调 `cw list` 找 topicId，调 `cw status --topicId <id>` 看当前进度，再按 nextAction 继续

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
