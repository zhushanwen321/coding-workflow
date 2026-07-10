# mid-detail-plan 工作摘要 — cw-cli-extract

> 来源：requirements.md / system-architecture.md / decisions.md / CONTEXT.md
> 用途：供主 agent 进入 issues / nfr / code-arch / execution 设计阶段

## 1. 不可推翻的决策清单

| 编号 | 决策 | 确认方 |
|------|------|--------|
| D-001 | CLI 协议用子命令风格（`cw create --slug X`）+ 大 JSON 字段走 stdin pipe 或 `--xxx-file` | ask_user |
| D-002 | 存储路径 `~/.cw/<encoded-cwd>/_cw.json`，env `CW_HOME` 可覆盖；pi 现有数据留在 `~/.pi/agent/cw/` 不迁移 | ask_user |
| D-003 | 产物为独立 npm 包 `@zhushanwen/coding-workflow`，bin 名 `cw`；engine + CLI 同包 | ask_user |
| D-004 | 行为等价验证：保留 engine 26 个单测原样 + 新增 CLI e2e 覆盖完整 lite 流程 | ask_user |

- D-005（nextAction.skill 原样透传）与 D-006（ADR-029 worktree cwd 防护）为 `D-可逆`，故不列入。

## 2. 本阶段设计树入口

### issues 遍历节点（从 system-architecture 4 轴扫出）
- **architecture §5 状态流转**：9 action TRANSITIONS 表、Reason 字段正交维度、8 态状态机、三重 guard（checkLinear / checkPhaseCascade / checkCacheConsistency）→ issue 候选：非法状态转换错误处理、progressive 状态回滚语义、replan 唯一回退语义验证。
- **architecture §7 模块划分**：cli.ts / protocol.ts / dispatch+actions/* / state-machine+checks+gates / store+plan-parser+types / resolveDbPath → 6 个模块各产 1 个 issue，重点：protocol 层 typebox 校验、cli 路由与 exit code 映射、resolveDbPath 改写。
- **architecture §8 系统间上下文边界**：Context Map 中 CW 与 git / 文件系统 / 调用方 agent / pi 扩展的 4 组关系 →  issue 候选：GitValidator 客户-供应商契约、JSON stdio 客户契约、pi 扩展解耦后残留引用清理。
- **architecture §10 挑战与决策**：D-A（RuntimeAdapter 不抽象）、D-D（大 JSON 传递机制）、D-E（skill 透传）、D-F（worktree 防护）→ issue 候选：单实现 interface 反模式防御、stdin 与 `--xxx-file` 参数优先级、worktree 检测阈值。

### code-arch API 入口（从 requirements UC 子命令推导）
- `UC-1 create` → `cw create --slug <kebab> --tier <lite\|mid> --objective <text> [--workspace <path>]`
- `UC-2 plan/clarify/detail` → `cw plan --topicId <id> < plan.json`（或 `--plan-json-file <path>`）
- `UC-3 dev/test` → `cw dev --topicId <id> --tasks '[{waveId,commitHash}]'` / `cw test --topicId <id> --cases '[...]'`
- `UC-4 status/list` → `cw status --topicId <id>` / `cw list [--workspace <path>]`
- `UC-6 replan` → `cw replan --topicId <id> < plan.json`

### code-arch skeleton 验证签名表
> 当前 workspace 无 engine 源码（仅有设计文档），签名表从 system-architecture §6 与 CONTEXT.md 推导；实现期需从 engine 源码（`dispatch.ts` / `types.ts` / `plan-parser.ts`）精确导出。
- `dispatch(params: CwParams, deps: ActionDeps) => ActionResult`（engine 入口，纯函数，CLI 直接调用）
- `ActionDeps = { store: CwStore; git: GitValidator; runner: GateRunner; workspacePath: string }`（真 seam，已有 mock 实现）
- `CwParams`（信封 schema）：action / topicId / slug / tier / objective / planJson / clarifyJson / detailJson / tasks / cases / replan 等；由 `protocol.ts` 定义，业务 schema 复用 `plan-parser.ts`。
- `ActionResult`：topicId / status / gatePassed / nextAction / mustFix（可选），CLI 层序列化为 stdout JSON。
- `nextAction`：{ action: string; skill?: string; guidance: string }（skill 字段原样透传，CLI 不处理）。

### execution Wave 从 code-arch 时序图推导
- **Wave 1**：工程骨架 + 包配置（package.json、tsconfig、bin=cw、零 pi 依赖声明）。
- **Wave 2**：engine 源码搬迁（state-machine / actions / checks / store / gates / plan-parser / types 原样复制，保留 26 个单测）。
- **Wave 3**：CLI 适配层（cli.ts 子命令路由、protocol.ts 参数校验与 JSON 序列化、exit code 映射）。
- **Wave 4**：存储路径参数化（`resolveDbPath` 改写为 `~/.cw/<encoded-cwd>/_cw.json`，`CW_HOME` env 覆盖）。
- **Wave 5**：StringEnum 替换（`@earendil-works/pi-ai` 的 `StringEnum` → typebox `Type.Union([Type.Literal(...)])`）。
- **Wave 6**：CLI e2e 覆盖完整 lite 流程（create → plan → dev → test → retrospect → closeout）+ replan append-only 路径。
- **Wave 7**：反模式清单验收（system-architecture §11 grep 项）+ 机器检查 gate 全绿。

## 3. 与上游的接口契约

### 3.1 grep 规则（architecture §11 反模式清单）
1. engine 运行时 import 图无 `@mariozechner/pi-coding-agent` / `@earendil-works/pi-ai`（注释除外）。
2. CLI 适配层未重复实现 engine 逻辑（dispatch/handler 直接复用，未 copy-paste 状态机/check）。
3. 未引入只有一个实现的 interface（`RuntimeAdapter` 在 MCP 落地前不创建）。
4. store/gates 行为零改动（现有单元测试全绿即证）。
5. `StringEnum`（`@earendil-works/pi-ai`）替换为 typebox `Type.Union([Type.Literal(...)])`，运行时无 pi-ai import。
6. exit code 分层契约实现：exit 0 = 程序正常（gate pass/fail 都在 stdout JSON）；exit ≥ 1 = 程序错误（stderr 人类可读）。
7. ADR-029 worktree cwd 防护逻辑搬迁（`.cw-wt/` 检测 + 拒绝 fallback）。
8. `CwParamsSchema` 信封定义在 `protocol.ts`（非 `index.ts`），业务 schema 仍 import 自 `plan-parser`（单源）。

### 3.2 Port / Seam 清单
- **ActionDeps（真 seam）**：engine 与副作用的唯一接缝；store（`node:fs`）/ git（`execFileSync`）/ runner（gate 执行）均可 mock，已有测试证明可替换。
- **CLI 协议边界（假设 seam）**：当前仅 CLI 一种实现，按 D-A 不抽象为 interface；dispatch 签名 `(params, deps) => ActionResult` 即契约。
- **存储路径解析（真 seam）**：必须脱离 `~/.pi/`；实现为纯函数 + config（`CW_HOME` env / `--workspace` flag），本轮完成一个实现。

### 3.3 不变式
- **CwTopic 聚合**：tier 写入后只读；status 按 `TRANSITIONS` 表流转；closed 终态不可逆。
- **Wave committed 不变**：`committed` 字段一旦写入非空则不可改；replan 为 append-only，已 committed 的 wave 不可删改。
- **TestCase 状态**：只能 `pending → passed/failed`。
- **状态机 TRANSITIONS**：create / plan / clarify / detail / dev / test / retrospect / closeout / replan 的 `expectedStatuses` / `nextStatus` / `progressive` / `requirePhaseComplete` 表固定（system-architecture §5）。
- **ActionResult 非空**：`nextAction` 必须返回。

### 3.4 协议约束 C-1 / C-2 / C-3
- **C-1 exit code 分层契约**：exit 0 = 程序正常（gate pass/fail 均正常返回，结果在 stdout JSON）；exit ≥ 1 = 程序错误（参数校验失败 / illegal_transition / topic not found / 内部异常，stderr 人类可读）。调用方读 JSON 判 gate 结果，不靠 exit code 区分 gate-fail。
- **C-2 存储路径完整结构**：`$CW_HOME/<encoded-cwd>/_cw.json`，默认 `~/.cw/<encoded-cwd>/_cw.json`；`encodeCwd` 规则原样继承 `path-encoding.ts`，per-cwd 隔离不可扁平化。
- **C-3 worktree cwd 防护**：`process.cwd()` 含 `.cw-wt/` 时拒绝 fallback，强制显式 `--workspace` 或 `CW_WORKSPACE_ROOT` env，防止 multi-workspace 数据隔离错误。

## 4. 相关长期约束

无。
