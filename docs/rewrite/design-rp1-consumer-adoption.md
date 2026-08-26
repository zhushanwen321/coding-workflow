# gate/pipeline 域消费方接入设计（rp-1：跨项目 release 验证统一账本）

> **当前层 → 下一层**：技术方案层（接入契约 + manifest 形态 + 各项目改造模式）→ 实施波次拆分层（§5 的 w1-w4）。不设计到各 skill 的逐行改写。
> **口径前提**：gate/pipeline 域六命令（`cw gate wrap/query/stats`、`cw pipeline run/status`、`cw ci-judge`）已随 feat-release-pipeline 分支交付，**npm 发布待分支合并后下一版本**（一致性审查 C1 修正：npm 2.2.0 发布早于本分支合入，不含 gate 域——早期「已随 2.2.0 发布」表述系推断错误）。当前消费依赖 dev-link 本地构建（`.agents/skills/dev-link/use-link.sh`）。引擎侧设计 canon 见 [design-release-pipeline.md](./design-release-pipeline.md)（其 rp-1 即本文）。本文自包含复述消费方现状，无需回读该文。

**一句话结论**：用「三层分离」承接异构 release 流程——**wrap 命令无关层**吸收工具链差异（Node/Python 一视同仁）、**manifest 项目自持层**吸收流程差异（`.cw-pipeline.json` 随项目仓版本化）、**skill 副作用编排层**保留发布动作（merge/publish/deploy 不进账本）——分四波落地（cw dogfood → xyz-agent → pi-ext/zcode → Python 三项目修复后接入），全程不回到已腐过的「全局共享 skill」模式。

## 1. 背景目标

**SCQA**

- **S（情境）**：cw 2.2.0 交付了 gate/pipeline 域：确定性 check 经 `cw gate wrap` 获得内容寻址缓存（键 `(check, baseSha, scope)`，同内容重复验证 hit 跳过）+ 记账闭合（「跑了但没记账」结构性不存在）；`.cw-pipeline.json` 声明的验证步骤可断点续跑（`cw pipeline run` 中断后同命令续接）。
- **C（冲突）**：引擎零消费方。9 个项目的 release skill（pr-cr-fix / merge）全部未接入——各 skill 的 Gate/阶段仍是裸跑命令，验证结果落在互不相识的临时格式（`.review/premerge-result` key=value / `coverage.json` / `metrics.json` / `quality.json`）。同时各项目 release 流程差异显著：发布媒介 4 类（npm / Electron 双线 / Docker / systemd 部署 / Release zip）、check 工具链 2 条（Node: tsc+eslint+vitest / Python: ruff+pytest+mypy）、版本策略 5 种（npm version / changeset / VERSION 文件 / pyproject / 插件级 release.js）。
- **Q（问题）**：怎么设计接入方案，让异构 release 流程都能吃到统一验证账本的收益（零重复验证 / 断点续跑 / 产物格式统一），且接入成本与项目差异成正比、不重蹈「全局共享 skill 目录腐掉悬空」的覆辙？
- **A（答案）**：三层分离，见一句话结论。

**系统是什么**：消费方是各项目仓内两个 skill 构成的发布管线——`pr-cr-fix`（第一棒：8 维 review + 修复 + 多道 Gate + 开 PR）与 `merge`（第二棒：pre-merge-check → PR 合并 → 版本 bump → 发布 → 交付物验证 → 清理）。每个项目各持一份 skill 副本（`.agents/skills/` 或 `.pi/skills/`），是 xyz-agent 原始模板的复制演化体或独立编写体。cw 的 gate 域是这些 skill 中「确定性验证步骤」的新承载——本文设计的就是这层承接关系。

**关键概念**（首现定义）：

- **确定性 check**：无副作用、同输入同输出的验证命令（typecheck/lint/test/coverage/metrics/registry 查询）。是 gate 域的合法入账对象。与之相对的**副作用动作**（merge/publish/deploy/bump/tag）永不入账。
- **接入点**：skill 正文或其引用脚本中「裸跑确定性命令」的位置。接入 = 把裸跑换成 `cw gate wrap --check <名> --base <ref> --scope <路径>... -- <原命令>`。
- **悬空引用**：skill 引用的外部脚本路径已不存在。现存 3 例（dag-executor / stock-dag-plugins / stock-portfolio-service 引用已消失的 `~/.agents/skills/merge-worktree/stages/*.sh`）。

**设计目标**（从使用者体验倒推——使用者 = 各项目发布流程里的 agent 与人）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | dogfood 闭环 | cw 自身 release：pr-cr-fix Gate-3a 验过的 check，merge 阶段 1 同内容**零重跑**（全 hit），发布总耗时可见下降 |
| G2 | 跨阶段零重跑 | xyz-agent：pr-cr-fix 阶段 1.1 的 static gate（typecheck×3 + lint）与 merge 阶段 pre-merge-check 对同内容只真实执行一次 |
| G3 | 工具链无关 | Python 项目（ruff/pytest）与 Node 项目（tsc/eslint）的接入方式同构——同一套 wrap 契约，无工具链特判 |
| G4 | 断点续跑 | merge 验证序列中断（会话切换/超时）后，重跑同命令从投影续接，已 pass 步骤不重做 |
| G5 | 产物格式统一 | skill 消费方读 `cw gate query --json` 替代解析 `.review/premerge-result`（key=value）与散置 JSON——验证事实单一 schema |
| G6 | 验证/副作用边界 | 发布动作（gh pr merge / npm version / deploy 脚本 / gh release create）**不进** manifest 与账本——skill 保留全部副作用编排权 |

**in-scope**：接入契约（wrap 包装模式、check 命名、scope 声明纪律）、manifest 在 release 流程中的角色、各项目改造面清单与波次、悬空 skill 的处置定位。
**out-of-scope**：gate/pipeline 域引擎侧任何变更（已交付冻结）；skill 的 review 维度 / 执行通道 / 调档机制（与验证承载正交，不动）；metrics-gate.py 等 check 脚本内部逻辑重写（仅包装不重写）；cw 仓之外的项目内 CI workflow 改造。

## 2. 现状与问题分析

### 2.1 引擎实态（已交付，本文的消费基础）

六命令可用（**经 dev-link 本地构建**：npm 最新 2.2.0 不含 gate 域，发布待本分支合并后下一版本）：

| 命令 | 语义 |
|------|------|
| `cw gate wrap --check <名> --base <ref> [--scope <路径>]（可重复声明） [--run-id <id>] [--timeout-ms <n>] -- <命令>` | check 包装执行：miss 真实执行 / hit 跳过但产出完整 report；exit 0 pass 含命中 / 1 fail / 2 环境错误不入账 |
| `cw gate query [--check <名>] [--base <ref>] [--json]` | 只读查缓存 pass 条目（消费方机器读入口） |
| `cw gate stats` | durationMs 聚合 |
| `cw pipeline run [--manifest <路径>] [--base <ref>]` | 按 manifest 顺序执行，断点续接 |
| `cw pipeline status` | 步骤三态 ✓/✗/pending |
| `cw ci-judge <run-id> --base <prBase> [--already-rerun]` | CI flaky/真回归判定 |

数据落 `~/.cw/<encoded-cwd>/gate-events.log`（per-cwd 独立账本）+ `gate-artifacts/<check>/<runId>/report.json`。

### 2.2 消费方实态（9 项目实地调研，2026-08-25）

**merge skill 差异全景**（9 项目 9 份，md5 全不同）：

| 项目 | 发布媒介 | check 工具链 | 版本策略 | 阶段数 | 验证产物格式 | 辅助脚本形态 |
|------|---------|-------------|---------|--------|-------------|-------------|
| xyz-agent | Electron DMG + npm 双线（`v*`/`npm-*` tag） | tsc×3 + eslint + vitest | pnpm version + changeset（npm 线） | 9（0-7+1.5+4N） | `.review/premerge-result`（key=value marker） | 项目仓 `scripts/` 8 个 + skill `scripts/` 7 个 + pr-cr-fix `scripts/` 4 个 py |
| tai-ji | 同 xyz-agent（**同体仓库**，package.json name 均为 xyz-agent） | 同左 | 同左 | 同左 | 同左 | 同左（整仓复制） |
| xyz-pi-extensions | npm 多包 | pnpm -r typecheck/lint/test | changeset | 8 | premerge-result | skill 内联命令为主 |
| zcode-plugin | npm（合并与发布**解耦**，发版 optional） | node --test + check-sync/pack | 插件级 release.js + `<plugin>@<ver>` tag | 7 | `.review/quality.json` | 项目仓 `scripts/` 5 个 js |
| coding-workflow | npm 单包 | tsc + eslint + vitest + build | npm version | 7 | 无文件落点（exit code + npm view） | skill 根 `merge-helpers.sh` + `cleanup-worktree.sh`（自包含） |
| llm-simple-router | npm + Docker GHCR/ACR + Release | tsc + eslint + vitest + build | workspace 根 + 子包 | 7+1 | 无文件落点 | `.pi/skills/merge/` 5 脚本 + `--from N` 断点 |
| dag-executor | Docker 部署（碳服务器） | ruff + pytest + tsc(frontend) | pyproject.toml | 8 | 无 | **悬空**：引用已不存在的 `~/.agents/skills/merge-worktree/`（8 行引用，其中 6 种 stages 阶段脚本） |
| stock-dag-plugins | Release zip | ruff + pytest | VERSION 文件 | 8 | 无 | **悬空**（6 行引用） |
| stock-portfolio-service | systemd 部署 | ruff + pytest + mypy + lint-imports | pyproject.toml | 7 | 无 | **悬空**（2 行）+ 本地 hooks |

**pr-cr-fix skill 差异**（5 项目）：Gate 编号体系同源（xyz-agent 8 gates → tai-ji 同构 → pi-ext 砍到 3 → zcode 合一为 quality-gate.js → cw 独立 6 gates）；`metrics-gate.py` 在 xyz-agent/tai-ji/cw 三项目持有**同源演化体**（md5 已分叉——F4 的又一实证）；`coverage-gate.py` 内部自跑 `vitest --coverage` 产 lcov 再解析（非纯检查器），且其 `changed_packages()` 本身按 `git diff base...HEAD` 只对 src/ 有改动的包执行（内层已是包级增量）。

**skill 同源性**：xyz-agent 为原始模板——tai-ji 整仓复制（100% 同体）、pi-extensions 简化、zcode 重写；cw 与 llm-simple-router 独立编写。无任何同步机制，每次演化各自分叉。

### 2.3 真实失败模式

| # | 失败模式 | 实证 | 后果 |
|---|---------|------|------|
| F1 | 引擎零消费 | 9 项目 skill 中 `gate wrap`/`pipeline`/`ci-judge` 关键词 grep 零命中 | 2.2.0 的缓存/续跑/统一格式收益全部未兑现；closeout 报告明载 rp-1 deferred 待拍板 |
| F2 | 悬空引用 | `~/.agents/skills/merge-worktree/` 目录已不存在，3 个 Python 项目 merge skill 引用其 6-7 个阶段脚本 | 这 3 个项目的 merge skill **当前就是坏的**——按 SKILL.md 执行会 ENOENT |
| F3 | 产物格式分叉 | 同为「pre-merge 验证结果」：xyz-agent 系用 `.review/premerge-result`（key=value marker），zcode 用 `quality.json`，cw 无文件落点 | 消费方（merge skill 读 pr-cr-fix 产物）每项目各写一套解析；coverage-gate 假 pass 事故的温床（空报告 `all(空)==True` 判 pass，[HISTORICAL 2026-08-21]） |
| F4 | 同源双份维护 | tai-ji ≡ xyz-agent 逐字相同（含 description 自述「仅用于 xyz-agent 项目」） | 同一逻辑两处修——验证承载若继续留在 skill 正文，每次分叉都再分叉一次 |

### 2.4 根因分析

**双根因**：

1. **验证事实无一等承载**（F1/F3 的根子）：skill 正文混载了两种正交职责——**副作用编排**（合并/发布/清理，本就该是 skill）与**验证事实存储**（check 结果的格式、落点、读取方式，本不该是 skill）。验证事实被固化进 skill 后随复制而分叉（F3），永远无法跨会话/跨 skill 复用（F1）。把验证事实交给账本、skill 只剩编排职责——**本设计解决此根**。
2. **skill 无分发/更新机制**（F2/F4 的根子）：skill 是逐仓手工复制体，无版本化分发通道——外部脚本目录消失即悬空（F2），同体仓库各自演化即漂移（F4）。本设计**不解决此根**（D7 仅止痛：悬空修复为自包含；tai-ji 同体问题记档检查点 4）；验证承载换到 wrap 命令行后，wrap 行本身仍是每项目一份的重复配置面，其漂移风险由 D5-⑤ 的三要素一致性纪律约束，分叉伤害从「整份 skill」缩小到「单行命令」。

差异的正确承接（工具链→命令通道、流程→manifest、业务→skill）正是根因 1 的解法；根因 2 的彻底解法（skill 分发机制）超出本设计 scope，显式记档。

### 2.5 物理数据流（现状 → 终态）

**现状**（以 xyz-agent 一次发布为例）：

```
pr-cr-fix 阶段 1.1（会话 A）
  bash scripts/pr-pre-merge.sh --skip-tests     # 裸跑 tsc×3 + eslint
  → .review/premerge-result（key=value，会话散文引用）
merge 阶段 pre-merge-check（会话 B，可能换 agent）
  bash .agents/skills/merge/scripts/pre-merge-check.sh
  → 又全量裸跑 tsc×3 + eslint（不知道会话 A 刚跑过，无 diff 则纯浪费）
  → 结果只有 exit code，无跨会话可查记录
```

**终态**：

```
pr-cr-fix 阶段 1.1（会话 A）
  cw gate wrap --check typecheck --base origin/main --scope ... -- <tsc 命令>
  → [miss] 真实执行 → GateCheckRan 入账 + report 落 gate-artifacts/
merge 阶段 pre-merge-check（会话 B）
  同一 wrap 命令 → [hit] scope 未变跳过执行（0 成本）
  → GateCacheHit 入账 + 复用 report（消费方读 cw gate query --json）
  改了 scope 内文件 → 自动 [miss] 重跑
```

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景一：cw 自身 dogfood（G1）**

```bash
# feature worktree 内，merge skill 阶段 1（改造后）
# scope 按 D5-④ 审查：命令定义（package.json）+ 配置 + 依赖锁必列
$ cw gate wrap --check typecheck --base origin/main \
    --scope src/ --scope tests/ --scope tsconfig.json --scope tsconfig.test.json \
    --scope package.json --scope package-lock.json -- npm run check:all
[hit] typecheck @ 4b1c2ef (base 08d9ef0)：命中 #12（0.0s），report 已产出
# —— pr-cr-fix 的 Gate-3a 刚验过同一内容，四件套全部 hit，发布前验证从 ~4min 降到 ~0

$ cw gate wrap --check test --base origin/main \
    --scope src/ --scope tests/ --scope vitest.config.ts \
    --scope package.json --scope package-lock.json -- npm test
[miss] test @ 4b1c2ef：scope 内 2 文件变更（tests/w4-*.test.ts）→ 执行 96s → pass
# —— 测试是 scope 敏感的，改了测试文件就真重跑；没改就 hit
```

**场景二：xyz-agent 跨阶段（G2）**

```bash
# pr-cr-fix 阶段 1.1（static gate 原样保留语义，承载换 wrap）
$ cw gate wrap --check typecheck-extensions --base origin/main \
    --scope extensions/ --scope tsconfig.json --scope package.json \
    --scope pnpm-lock.yaml -- npx tsc --noEmit -p extensions
[miss] ... → pass
$ cw gate wrap --check lint --base origin/main \
    --scope packages/ --scope extensions/ --scope eslint.config.* \
    --scope package.json --scope pnpm-lock.yaml -- pnpm run lint
[miss] ... → pass
# merge 阶段 pre-merge-check.sh 内部对同内容再验 → 全部 [hit]（0 成本，report 链完整）
# 注意 check 名与 base ref 两 skill 必须逐字同（D5-⑤），否则静默全 miss
```

**场景三：Python 项目（G3，悬空修复后）**

```bash
# dag-executor backend
$ cw gate wrap --check lint --base origin/main --scope backend/ --scope pyproject.toml -- ruff check backend
[miss] ... → pass
$ cw gate wrap --check test --base origin/main --scope backend/ --scope pyproject.toml -- pytest backend/tests
[miss] ... → pass
# 与 Node 项目零形态差异——同一 wrap 契约
```

**失败路径**（带恢复指引）：

```bash
# check fail（fix 也入账留审计；fail 永不进缓存候选）
$ cw gate wrap --check lint --base origin/main --scope src/ -- npm run lint
[miss] lint @ abc1234：执行 8.1s → FAIL（exit 1）
入账 GateCheckRan（result=fail）。恢复动作：修复后重跑同一命令即可，query 只认 pass。

# 环境错误（超时等，不入账）
错误：check 执行超过 1800000ms 上限。恢复动作：确认命令可跑通后 --timeout-ms 调大重试；
常态超时应拆小 check 粒度（如 typecheck 按包拆）而非放大超时。

# base ref 未 fetch
错误：base ref 无法解析。恢复动作：先 git fetch，或 --base <已知 sha> 显式指定。
```

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A. 三层分离**（推荐）：wrap 命令无关层 + manifest 项目自持层 + skill 副作用编排层。各项目只改「裸跑 check → wrap」的接入点，manifest 可选声明，skill 结构不动 | 高：差异被分层吸收——工具链差异死在 wrap 的 argv 通道（无引擎改动），流程差异活在各项目 manifest（随仓版本化），副作用差异留在 skill（本就该项目各异）。验证事实从 skill 正文抽走后，F3/F4 的分叉伤害结构性缩小 | 中：每项目 1-3 个接入点替换 + scope 声明审查；无中心化基建要维护 | scope 声明不完备可致假命中（诚实边界，防线 = 声明纪律 + scope 缺省仓根的保守缺省） | ✅ |
| B. 统一 skill 模板：重写 9 项目 skill 为同构参数化模板（一份骨架 + 项目 config），check 全走 wrap | 中低：模板本身又是一个「中心化共享物」——9 个项目的发布媒介/版本策略差异远超模板参数化能力（Electron 双线 vs systemd 部署 vs changeset 多包），参数面爆炸；且模板升级分发仍无机制（F4 换个形态复发） | 高：9 份 skill 重写 + 每项目回归验证 | 大版本迁移风险集中爆发；模板「看似统一」掩盖真实业务差异 | ❌ 若用 B，§2.2 的 xyz-agent（9 阶段双发布线）与 dag-executor（Docker+碳服务器）要么塞进同一参数模型互相污染，要么模板分叉成多份——统一性是假的 |
| C. 全局共享脚本复活：重建 `~/.agents/skills/` 下的共享 merge/gate 脚本，各项目引用 | 低：该模式已实证腐掉（F2——目录消失 3 项目悬空，且无版本化无锁）；全局脚本不随项目仓版本化，升级即全量冒险 | 低（短期） | 悬空复发是时间问题；与「流程定义是项目资产」的 D6 裁决冲突 | ❌ 若用 C，§2.3 的 F2 只是换个日期重演 |
| D. wrap 下沉 package.json scripts 层：原命令挪 inner script（如 `"check:cw": "cw gate wrap ... -- tsc"`），skill 正文零改动 | 中：check 定义随仓版本化更彻底、任何调用方自动走账本 | 中：需重构 scripts 层 + 嵌套 npm run exit 传递多一层 | 惊奇面大：裸跑 `npm run check` 隐式写账本（调试时难关断）；`run_step bash -c` 形态不覆盖；缓存键三要素（D5-⑤）散进 scripts 更难统一核对 | ❌（记档备选）若用 D，§3.1 场景一的「故意改 scope 内文件验证失效方向」变成先改 package.json 才能触发——调试闭环变长；但仓级版本化优势真实，若未来 skill 正文维护痛点升级可重评 |

**推荐 A 的核心理由**：A 是让「差异的正确归属」成立的方案——工具链差异归命令通道、流程差异归项目 manifest、业务差异归 skill。B/C 试图消灭差异（统一模板/共享脚本），D 试图消灭接入面（下沉 scripts），而差异本身不是病，把差异塞错层才是。对账：A 同样引入仓外依赖（全局 `cw` CLI）——与 C 的差异在于 cw 经 npm 版本化发布且有 semver 纪律，但守卫不可省（见 D9）。

### 3.3 关键决策与权衡

**D1：接入点 = 命令级替换（skill 正文/脚本内的单条裸跑命令 → wrap 包装），非脚本级替换（整体改写 pre-merge-check.sh）（选定）**
- **采用**：逐条命令替换。xyz-agent 的 `pr-pre-merge.sh` 内 `run_step "typecheck:extensions" bash -c '...'` 结构天然适配——每个 run_step 换成一条 wrap 调用，check 名 = `typecheck-extensions` 等带连字符名。cw 的 merge skill 阶段 1 四件套同理（4 条 wrap）。脚本骨架（参数解析/marker 写出/互斥校验）保留不动。
- **marker 双轨策略（迁移契约，第二轮审查 MF-3 修正）**：`.review/premerge-result` 由脚本骨架末尾**无条件写出**（`write_result_marker`），run_step 换 wrap 后 **miss/hit 全路径照产**（marker 值反映 wrap 三态 exit，恒新鲜——pr-status.sh 迁移期读到的是当前值，无 stale 问题）。「不重产」仅指**内层命令产物**（coverage.json / metrics.json——hit 路径内层不执行则不产出，其消费方是切换重点）。消费方规则：① 新增消费点一律读 `cw gate query --json`；② 存量消费方（pr-status.sh 的 marker 读取、pr-pre-merge.sh 的 `--test-result` 前置校验读 coverage.json、review 维度 B 的 metrics.json 读取）在 w2 清点清单并按波次切换（前置校验类改查 `cw gate query`）；③ marker 停写单列为收尾步骤（见 §5 收尾验收锚）。
- **被否**：脚本级整体替换（把 pre-merge-check.sh 改写为薄壳 + manifest）——改写面大、丢掉脚本内已验证的逻辑（如 `--skip-tests` 与 `--test-result` 互斥校验），且第一阶段没必要引入 manifest 依赖；接入即停写 marker（骨架直接拆）——存量消费方 pr-status.sh 立刻踩空，迁移无缓冲期。
- **证据**：`scripts/pr-pre-merge.sh` L53-59 的互斥校验、L174-181 的 run_step 结构（命令与流程控制已分离）；`write_result_marker` 由骨架两处调用且注释明言「供 pr-status.sh 读取」（存量消费方实证）；cw merge skill 阶段 1 四条命令独立可替换。
- **效果**：G1/G2 的改造成本降到「每 check 一行」；skill 演化兼容（骨架不动）；A3 验收有明确的双轨判据。

**D2：manifest 分两档 + 同项目多流程按 manifest 文件名区分——散装 wrap 起步、验证步骤 ≥3 且有续跑诉求才声明 manifest（选定）**
- **采用**：接入深度按项目自选：**档 1 散装 wrap**（命令级替换，无 manifest，吃 G1/G2 缓存收益）；**档 2 manifest 化**（验证步骤声明 manifest 走 `cw pipeline run`，额外吃 G4 断点续跑）。档位判据 = 该项目 merge 验证序列的长度与中断频率（llm-simple-router 已有自制 `--from N` 断点，是档 2 的明确候选）。
- **档 2 多流程区分（机制层，本轮补充）**：pipeline 身份 = manifest 文件名去扩展名（`pipelineIdOf()`），`--manifest` 接受任意路径、缺省 `<cwd>/.cw-pipeline.json`。同项目多流程放多份 manifest，命名约定 `.cw-pipeline.merge.json` / `.cw-pipeline.release.json`——fold 按 `(pipeline, manifestSha256, step)` 分组取最新，不同 manifest 的断点进度互不干扰；manifest 内容变更即新 sha 新分组（防假进度，与缓存键同哲学）。**zcode 的「合并与发布解耦」是首个多 manifest 用户**（merge/release 双流程双文件）。边界形态：同名+同内容 manifest 在同 cwd 内共组——无害（步骤定义逐字节相同，进度本就该共享）。
- **档位隔离语义（第二轮审查 MF-1 披露，引擎实态）**：档 1 与档 2 是**两个缓存隔离的世界**：① pipeline cache 步骤的 check 名硬编码为 `pipeline:<pipelineId>:<step>`（`src/pipeline/run.ts` L117，防与用户手跑撞名的设计）——与散装 wrap 的裸名（`typecheck`）**永不相通**，跨档位零复用；② pipeline 已 pass 步骤的跳过是**流程定义级**（per manifestSha256 投影）而非内容级——不看 headSha、不跑 scope diff，cache 声明的 wrapCheck 只对未 pass 步骤执行。推论：**档 2 不可作为每次 merge 的常驻执行入口**——第二次 merge（新 PR、同 manifest）会全部投影跳过 = 零验证假 pass；③ 命令面无进度重置通道（pipeline 身份 = 文件名恒定，新实例只能换文件名——缓存身份随之换）。**档 2 的正确用法 = 单次发布/验证会话内的断点续接**（长验证序列中断后同命令续接），流程声明文件随仓常驻、执行入口按会话手跑。
- **check 命名空间语义**：check 名是项目内命名空间——跨流程**同名 = 有意共享**缓存（pr-cr-fix 与 merge 都写 `typecheck`，这是 D5-⑤ 一致性纪律的正面目的：错配是事故、同名是设计）；流程私有检查起独立名（如 xyz-agent npm 线的 `typecheck-npm-ext`）即天然隔离。**注意：该语义只适用于散装 wrap 之间**——pipeline 域的 `pipeline:` 前缀强制隔离（见上条）。
- **manifest 间声明一致性（S-5）**：流程增多后同一语义 check 在多个 manifest 各声明时，command 与 scope 必须逐字同（D5-⑤ 的 manifest 版）——接入时跨 manifest grep 同名步骤核对；漂移的伤害 = 各自缓存浪费 + 命令定义分叉（F4 换形态复发）。
- **cwd 作用域提示**：账本 keyed by cwd——feature worktree 与 main worktree 是不同账本。跨 skill 命中发生在同 cwd 内（两 skill 同在 feature worktree 执行，即 A1/A2 的场景形态）；跨 worktree 本就 HEAD 不同、scope diff 判定天然不误命中。设计不依赖跨 worktree 复用，也不承诺。
- **被否**：一刀切全上 manifest——强制所有项目先写 manifest 才能接入，把「想吃缓存收益」的门槛抬到「先重构验证序列」；一刀切全散装——断点续跑收益（G4）永远拿不到；**配置收口全局目录**（如 `~/.cw/configs/<项目>.json` 运行时引用）——流程定义离开项目仓即不随 git 版本化、不进 PR review，scope 漂移跨目录不可见（D5 防线拆半），且与 F2 悬空事故结构同类（2026-08-25 讨论裁决，记档防复提）。
- **证据**：llm-simple-router merge.sh 的 `--from N` 自制断点（需求实证）；gate 域 wrap 与 pipeline 是独立命令（档 1 无档 2 依赖）；`src/pipeline/manifest.ts` `pipelineIdOf()`（L121-125，文件名去扩展名）+ `src/handlers/pipeline.ts` `DEFAULT_MANIFEST`（缺省 `<cwd>/.cw-pipeline.json`）；fold 三元组分组（`src/pipeline/run.ts` latestStepRun 注释）。
- **效果**：接入成本与项目需求成正比（Q 的直接回答）；G4 由真实需要的项目先行；新流程挂载（如未来 nightly 验证）= 新增一份 manifest 文件，零机制新增；zcode 解耦场景被档 2 原生覆盖。

**D3：coverage-gate 封装 = 外层单 check 包装（scope = 被测源 + 配置），不做内部拆分（本波选定）**
- **采用**：`cw gate wrap --check coverage --base ... --scope <各包 src/> --scope vitest 配置 -- python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ...`。coverage-gate.py 内部多包遍历 + lcov 解析 + vitest 执行**不重写**，整体作为一个 check。
- **实态修正（对抗审查 M2 核实）**：coverage-gate.py 的 `changed_packages()` 本身就是包级增量——只对 `git diff base...HEAD` 中 src/ 有改动且带 vitest.config.ts 的包跑 vitest，无改动包直接 pass。因此单 check 粒度的真实 miss 代价 ≈ 改动包 coverage + 全量 diff 解析，**并非全量重跑**。
- **supersession 记录**：引擎 canon（design-release-pipeline.md §5 rp-1）原设想「coverage-gate 按包 scope 缓存改造（多 scope 形态实战）」——本设计经实态调研**撤销**该设想：按包拆分的缓存收益（未改包 hit）与内层增量机制重叠，增量收益趋近零；且 lcov 跨包合并判定（增量 ≥80% 全局口径）拆开后无法各自复现整体判定。两文冲突处以本节为准。
- **被否**：按包拆分（每包一个 coverage check）——收益与内层增量重叠近零，代价是改造 coverage-gate.py 参数面 + 拆散全局增量判定；内层增量机制上提到 wrap scope 层——引擎侧改动，out-of-scope。
- **证据**：coverage-gate.py `changed_packages()`（L114 起：git diff 过滤 `/src/` + package.json/vitest.config.ts 存在性校验）；三处整体 coverage.json 写出（L268/344/352）。
- **效果**：记账/格式统一（coverage.json 纳入 report 单一 schema）+ 同 HEAD 重跑提速（会话中断恢复场景）。**诚实定位**：本 check 的缓存收益是「同内容重跑 + 记账」，不含跨 skill 零重跑——merge 侧 `--skip-tests` 模式不复查 coverage，跨阶段场景不存在。

**D4：合一脚本的拆分判据 = 缓存收益密度（zcode 的 quality-gate.js 本波不拆）（选定）**
- **采用**：合一脚本（zcode `quality-gate.js` 内含测试+覆盖率+复杂度）整体包装为单 check，同 D3 逻辑。拆分（node --test 单独 wrap、覆盖率单独 wrap）仅在「测试耗时占大头且改动频繁」的真实痛点出现后做。
- **被否**：接入时一律拆到最细粒度——拆分要求改写脚本内部结构（quality-gate.js 是单入口合一设计），改造面与收益不成比例。
- **证据**：zcode pr-cr-fix 的 quality-gate.js 单入口设计（subagent 调研：NODE_V8_COVERAGE ratchet 40→80 内嵌）。
- **效果**：zcode 接入成本可控（1 个 check 包装）；「拆分换缓存粒度」成为可后补的优化而非前置门槛。

**D5：scope 声明纪律 = 逐 check 六条审查清单 + 缓存键四处一致性（选定）**
- **采用**：每项目接入时对每个 check 跑一遍声明审查（生态等价物自行映射：Rust 的 Cargo.lock、Go 的 go.sum 等）：① 构建配置（tsconfig.json / vitest.config / eslint.config / pyproject.toml）必须在 scope；② 依赖锁（package-lock / pnpm-lock / uv.lock 等）必须在 scope；③ 被测源码目录必须在 scope；④ **命令定义文件必列**——`npm run X` 形态的 wrap 必列根与相关 workspace 包的 package.json（改 scripts 定义不在任何 scope = 同 HEAD 假命中）；Python 直调命令列其 tool 配置所在文件；⑤ **命令本体必列**——被 wrap 的仓内脚本文件自身（coverage-gate.py / metrics-gate.py / quality-gate.js 等）必须在 scope（反例：单独 commit 修脚本的误判 bug，src/ 无改动 → hit 复用修复前的错误 pass）；⑥ **缓存键四处一致性**——项目内全部 wrap 调用的 check 名、base ref、**scope 声明序列（逐元素逐序）**三处逐字一致（统一 `origin/main`），接入时 grep 本项目全部 wrap 行核对。**scope 顺序敏感**：`gateCacheKey` 对 scope 做 `JSON.stringify`，元素集合相同但顺序不同 = 不同键 = 静默全 miss（MF-2）；check 名或 base 写法不一致同样静默全 miss（G1/G2 无声落空，不报错）。
- **base 窗口语义与内外正交（S-1/S-2）**：base ref 字符串一致不保证 sha 一致——`origin/main` 前移（fetch 后）即全体 miss（canon D3 by construction，安全方向但收益落空）。miss 排查第一步 = 对照 `git rev-parse origin/main` 与 `cw gate query` 输出的 baseSha。外层 wrap base（缓存键）与内层脚本 base（增量归因口径）是正交概念，推荐同源——**w1 实现已统一 origin/main**（metrics-gate 内层随 wrap 化同步改写，一致性审查 C7 记档）。
- **check 命名约束（S-3）**：check 名直接作产物目录段（`gate-artifacts/<check>/<runId>/`），含 `/` 会嵌套目录、含 `..` 路径逃逸——接入契约统一小写连字符风格 `[a-z0-9-]`（typecheck / lint / test / build / metrics / typecheck-extensions 均合规）。
- **爆炸半径声明（诚实边界）**：机器无法静态证明 scope 完备性。假命中 = 该跑没跑（漏检），暴露条件 = 「scope 外改动恰好引入缺陷」与「下游门不覆盖该 check」共现。下游门盘点：cw 侧 release.yml 只兜底 build/test，**lint 与 metrics 无任何下游兜底**（直进 main 无捕获）——故 D8-canary 安全带选 lint 作对照；xyz-agent 侧 PR CI 兜底面更宽但同理。防线 = 清单纪律 + canary 观测，不承诺零假命中。
- **被否**：scope 全部缺省仓根（零增量收益，G1/G2 落空）；引擎侧加 scope 完备性静态分析（引擎改动，out-of-scope）；「漏网可被后续发现」的乐观表述（无机制支撑，已删——发现机制就是 canary 与下游门，写明到哪道门为止）。
- **证据**：design-release-pipeline.md D3 诚实边界；cw `check:all` = `npm run check && npm run check:tests`（scripts 定义真实影响命令行为——第④条实证）；lint/metrics 不在 release.yml 的实地事实。
- **效果**：假命中风险收敛为「接入时一次性五条人工审查 + dogfood 期 canary 观测」，爆炸半径写明到具体下游门。

**D6：发布动作边界 = 副作用与外部状态查询均不入账（重申并收紧引擎侧裁决）（选定）**
- **采用**：`gh pr merge` / `npm version` / deploy 脚本 / `gh release create` / changeset 写入——全部留在 skill，不进 manifest、不进 wrap。**交付物验证类查询（`npm view` / `gh release view` / `curl health`）也排除出 wrap 范围**：wrap 无「不缓存」通道（无 --no-cache flag），此类查询验证的是**外部状态**（registry/远端服务），同 HEAD 重查会 hit 复用陈旧 pass（如 npm unpublish 72h 窗口内重查即假 pass）——留 skill 裸跑吃 exit code 判定。
- **被否**：交付物查询 wrap 化（本设计初稿「可 wrap 但不声明 cache」的表述）——「不声明 cache」机制不存在，表述不成立，已修正；把发布步骤声明进 manifest 换「全流程断点续跑」——破坏「工具只验证与记账，不替人发布」边界，且发布动作幂等性无保证。
- **证据**：wrap 命令面无 cache 控制 flag（CONTEXT.md 命令速查 / `src/gate/wrap.ts` 实态）；npm unpublish 72h 窗口的陈旧性风险；zcode 的 optional 发版决策（人工门禁）证明发布序列含语义判断，机器化有害。
- **效果**：G6 成立且更干净（账本只含文件系统内容寻址可判定的 check）；zcode 的「合并与发布解耦」由「manifest 只管验证、发布留 skill」天然支持。

**D7：悬空 skill 处置 = 先修复为自包含，gate 接入作为后续独立波（选定）**
- **采用**：3 个 Python 项目（dag-executor / stock-dag-plugins / stock-portfolio-service）的 merge skill 先重写为自包含（参照 cw 的 merge-helpers.sh 自包含模式，把已消失的 stages/*.sh 语义内联或复制进项目内），恢复可用性；gate 接入排 w4（最后）。
- **被否**：跳过修复直接在悬空 skill 上叠加 gate 接入——在坏地基上盖楼，接入验证无法归因（skill 本身跑不通 vs wrap 问题）；用 gate 接入「顺便」重写整个 skill——一次改动混两个目的，回滚面不可分。
- **证据**：F2 实证（7/6/2 处悬空引用）；cw merge skill 的自包含两脚本形态（merge-helpers.sh + cleanup-worktree.sh，动态定位 `.bare/`）是可复制的目标形态。
- **效果**：修复与接入解耦，各自可验收可回滚。

**D8：dogfood 先行 = cw 自身是第一接入点（选定）**
- **采用**：w1 先改 cw 仓自己的 merge skill（阶段 1 四件套）+ pr-cr-fix skill（Gate-3a 四件套 + Gate-1.5 metrics）为 wrap。cw 无 PR CI（本地验证是唯一质量门），重复验证（Gate-3a 与 merge 阶段 1 完全重叠）是现成的 F1 实例。
- **被否**：直接从 xyz-agent 开始（设计文档原定的 A1b 现场）——xyz-agent 接入面大（4 道 gate + coverage-gate），首接入翻车归因难；cw 既是 wrap 实现者又是消费者，dogfood 是最低成本的设计自证。
- **证据**：cw merge skill 阶段 1 与 pr-cr-fix Gate-3a 的四件套完全同构（check:all/lint/test/build）；subagent 调研结论「cw 是天然 dogfood 入口」。
- **风险与兜底（对抗审查补全）**：cw 无 PR CI 同时意味着——在唯一质量门上首发热缓存层，假命中无 PR 期兜底；真实下游门是 merge 后 tag 触发的 release.yml（build/test），**lint 与 metrics 不在其中**（假命中漏网即直进 main，无捕获）。安全带：w1 起 merge 阶段 1 保留一条不 wrap 的 canary 命令（选 lint——正是无下游兜底者），dogfood 期每轮对照 wrap 结果与 canary 裸跑结果（A1-③ 判据）。撤除条件（S-4 具体化）：连续 3 次 dogfood 对照一致 + 一次完整真实发布 release.yml 绿 + npm view 版本在——三条件齐后撤除并在 DESIGN-LOG 记档风险接受（撤除后 lint 回到无下游兜底基线，靠 D5-⑥ 纪律维持）。
- **效果**：G1 先行兑现；w1 的经验（scope 声明、check 命名）成为 w2 的模板。

**D9：接入含仓外 CLI 依赖守卫——每项目阶段 0 加 cw 存在性/版本前置检查，失败出声转人工，禁止静默回退（选定）**
- **采用**：接入后各项目验证步骤依赖仓外共享物 `cw`（结构上与 F2 同类——仓外路径，仓外物变动即坏）。每项目接入时在 merge skill **阶段 0** 与 pr-cr-fix **阶段 0（第一棒，同样依赖）**两处加守卫（一致性审查 C3 补记第一棒）：`command -v cw` 存在性 + **能力检查 `cw --help 2>&1 | grep -q "gate wrap"`**（一致性审查 C2 修正：版本阈值 ≥2.2.0 在两个真实状态下都判反——npm 2.2.0 实无 gate 域、dev-link 2.1.0 实有，**版本号与能力不对齐，能力探测是唯一可判真形态**），失败时 stderr 出声转人工并给恢复动作（npm 安装含 gate 域版本 / 仓工作区内 use-link.sh 切本地构建）。先例对齐：pr-cr-fix 对 fallow 已有存在性检查 + 安装指引的守卫模式。
- **被否**：静默回退裸跑——「验证是否入账」变得不可判定，破坏记账闭合的可信前提（比缺账本更糟的是账本时有时无）；不设守卫——cw 未安装/dev-link 切旧版时 merge 阶段直接 ENOENT 崩在中途。
- **证据**：F2 结构同类性（§3.2 方案 C 被否论证的诚实对账：A 引入的仓外依赖靠 npm semver + 本守卫缓解）；pr-cr-fix skill 的 fallow 守卫先例。
- **效果**：仓外依赖的风险面有显式防线；§3.2 对 C 的否决论证与 A 自身的依赖结构对账成立。

**D10：ci-judge 接入 = merge skill 的 CI 等待失败分支（选定；第二轮审查 MF-5 补全）**
- **采用**：ci-judge 的消费方接入点 = 各项目 merge skill 的「等待 CI」阶段失败分支：CI 失败时调 `cw ci-judge <run-id> --base <prBase>`——flaky → 引擎自动 `gh run rerun --failed` 恰一次后继续等待；真回归 → 输出归属证据链，进各项目的回滚阶段（cw 的 4.5 / xyz-agent 的对应处理）。w2 主锚 = xyz-agent merge 阶段 3（post-merge CI 等待）失败分支；cw 自身 w1 可选锚 = 阶段 4（release.yml watch）失败分支。无 CI 面的项目不适用（Python 三项目的 CI 形态在 w4 修复时重估）。
- **被否**：CI 失败时人工盲判（现状 F5）——flaky 与真回归不分，盲修或全量重跑；自动接入无失败分支锚定（每轮 CI 都跑 ci-judge）——成本无谓且无判定输入。
- **证据**：canon D7（决策树 + rerun 恰一次 + 两轮 flaky 出声转人工）；引擎 canon 明言消费方接入归 rp-1（本文）；`--already-rerun` flag 支持「外部已 rerun 过」的幂等调用。
- **效果**：六命令面全部有消费方锚点；F5（CI 失败无判定）在 w2 兑现。验收编号注：本文 A-x 与 canon design-release-pipeline.md 的 A-x 编号独立（本文 A5 = Python 接入，canon A5 = ci-judge 判定），跨文引用需带文限定。

### 3.4 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败降级 |
|----|-----------|------|------|---------|
| GP-r1 | wrap 包装 `npm run check:all` 等复合 script 的缓存语义（script 内部多 tsc 进程，exit 语义正确传递） | cw 仓真实跑 miss→hit→scope 内变更→miss 四连 | ⛔ w1 首项 | 复合 script exit 传递异常 → 拆为单命令 wrap（tsc 直调） |
| GP-r2 | pr-cr-fix → merge 跨 skill 同内容 hit（两 skill 在同一 cwd 下账本共享 + 缓存键三要素逐字一致） | cw 仓两 skill 顺序执行，断言 merge 阶段全 hit；同时 grep 两 skill 的全部 wrap 行，断言 check 名、base ref、scope 序列（逐元素逐序，顺序敏感）三处完全相同（任何错配 = 静默全 miss，必须显式断言而非等它发生） | ⛔ w1 | 隔离失败（如 cwd 不一致）→ 检查 skill 的 cd 纪律，账本 keyed by cwd；三要素错配 → 统一为 `origin/main` + D5-⑤ 命名纪律 |
| GP-r3 | Python 工具链 wrap（ruff/pytest 作为 check 命令的 exit/report 语义） | 临时 Python 仓真实跑 miss→hit | ⛔ w4 前 | 不适用（无降级，直接修） |

## 4. 验收（真实场景，非单测）

改动规模：大（跨 4 波多项目 skill 改造）。全部用真实项目仓 + 真实发布流程验证。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| A1（G1，w1，**档 1 形态**） | cw 仓真实 dogfood：pr-cr-fix → merge 全流程 | 在 cw 仓开真实 feature：① pr-cr-fix 走到 Gate-3a（wrap 化后）；② 连续走 merge skill 到阶段 1（散装 wrap）；③ 对照 D8-canary | ① Gate-3a 各 check miss 真实执行且入账；② merge 阶段 1 四件套对同内容**全 hit**（输出 [hit] + 0 执行耗时），`cw gate query --json` 可查全部条目；③ canary 裸跑 lint 与 wrap lint 判定一致 |
| A2（G2，w2） | xyz-agent 跨阶段零重跑 | xyz-agent 仓开真实 feature：① pr-cr-fix 阶段 1.1 static gate（wrap 化）；② merge 阶段 pre-merge-check | ② 对同内容全 hit；故意改 scope 内一个文件后重验 → 该 check miss 真实重跑（失效方向正确） |
| A3（G5，w2——迁移对象全在 xyz-agent 系，w1 的 cw 无 marker 系统无对象） | 产物格式统一（双轨迁移） | 改造后 skill 的消费点 | ① 新增消费点全部读 `cw gate query --json`（grep 验证无新增 marker 解析）；② w2 交出存量消费方清单（pr-status.sh / `--test-result` 前置校验 / review 维度 B）并完成切换或给出切换波次；③ marker 停写列入收尾步（双轨判据对齐 D1） |
| A4（G4，档 2 项目，**单次验证会话内**） | 断点续跑（含多流程独立进度） | llm-simple-router（或 cw）声明 manifest（验证步骤清单），`cw pipeline run` 跑到中途中断（Ctrl-C），**同一次验证会话内**重跑同命令续接；zcode 双 manifest 变体：`.cw-pipeline.merge.json` 与 `.cw-pipeline.release.json` 各自中断后续接 | 已 pass 步骤不重做（viaCache/投影跳过）；`cw pipeline status` 三态正确；双 manifest 变体两 pipeline 身份进度互不串。**负面断言（MF-1）**：第二次全新验证会话（新 HEAD）直接跑 `pipeline run` 必须先确认投影状态——同 manifestSha256 下旧 pass 步骤会被跳过，正确用法是新会话换 manifest 文件名或接受跳过语义（D2 档位隔离语义） |
| A5（G3，w4） | Python 工具链同构接入 | dag-executor（悬空修复后）merge 验证序列 wrap 化：ruff / pytest 两条 wrap | miss→hit 行为与 Node 项目完全一致（同一套命令契约，无工具链特判分支） |
| A6（G6，负面） | 副作用不入账 | 任一接入项目走完整发布流程（含 gh pr merge / npm version / deploy） | gate-events.log 中**只有** GateCheckRan/GateCacheHit/PipelineStepRan 三类事件，无任何发布动作条目；发布失败回滚（如 cw 阶段 4.5）不受账本状态影响 |
| A7（D7，w4 前置） | 悬空修复 | 按重写后的 dag-executor merge skill 走一次真实合并（不接 gate） | 全程无 ENOENT；原 stages/*.sh 六种语义（init/local-check/pr-merge/**post-merge-ci**/release/cleanup）有等价承接 |

每个场景的通过标准都是可观察的真实输出（wrap 的 [hit]/[miss] 行为、query 返回、事件类型枚举），非抽象断言。

## 5. 下一层拆分

实施路径（四波，依赖序）：**w1 cw dogfood → w2 xyz-agent → w3 pi-ext/zcode → w4 Python 修复+接入**。每波独立可验收、可回滚（回滚 = revert skill/脚本改动，账本数据无害残留——gate-events.log 是 append-only 事实，不回滚）。

| 波次 | 内容 | justification | 验收锚 |
|------|------|---------------|--------|
| w1 | cw 仓自身接入（**纯档 1**，档 2 不进 w1——D2 档位隔离语义下绑定 merge 常驻入口 = 第二次发布假 pass）：merge skill 阶段 1 四件套 + pr-cr-fix **PR 提交协议静态三件套**（仅阶段 1 首次开 PR 执行；3c 明确跳过 Step 1 不重复验证；Gate-1 本体是 PR URL 校验不可 wrap）/Gate-1.5（metrics）/Gate-3a（四件套+metrics 终值）换 wrap；**worker 静态自检豁免 wrap**（一致性审查 C8 记档：隔离 worktree = 不同 cwd 不同账本，跨账本无缓存收益，且是快速预检非主 gate——w2 模板化时同样豁免）；探针 GP-r1/GP-r2；D8-canary（不 wrap 的 lint 对照）；阶段 0 加 D9 守卫（merge 与 pr-cr-fix 两处）；可选：D10 ci-judge 接阶段 4 失败分支 | 最低成本的设计自证（cw 既是实现者又是消费者）；cw 无 PR CI，重复验证是现成 F1 实例；w1 产出的 scope 声明清单与 check 命名成为后续波的模板 | A1、A3、GP-r1/2、A4（若档 2） |
| w2 | xyz-agent 接入（原 rp-1 主体）：`scripts/pr-pre-merge.sh` 的 run_step 结构逐条 wrap 化（typecheck×3 / lint / test×3）；merge skill 的 pre-merge-check.sh 同步；coverage-gate.py 外层单 check 包装（D3）；metrics-gate.py wrap 化；**legacy 产物消费方适配**（D1 清单：`--test-result` 前置校验改查 `cw gate query`、review 维度 B 的 metrics.json 读取路径、hit 路径 legacy 产物不重产的消费点核对） | 设计文档 A1b 预定现场；静态 gate（typecheck/lint）是缓存收益最高的 check（跑得慢、改动少）；coverage 是最难一块，放第二波有 w1 经验垫底 | A2、A3 |
| w3 | xyz-pi-extensions（Gate-3a 一道，改造面最小）+ zcode-plugin（quality-gate.js 单 check 包装，D4；**档 2 多 manifest 试点**——调用契约：双 manifest 文件随仓常驻作流程声明，`pipeline run` 仅在单次验证会话内手跑续接，**不绑定每次 merge 的常驻入口**，D2 档位隔离语义） | 两项目接入面中等且形态互补（一个纯终验、一个合一脚本+解耦流程），验证「接入成本与项目差异成正比」的承诺与多流程区分机制 | A2 变体（跨阶段 hit，档 1）、A4 双 manifest 变体（会话内）、A6 |
| w4 | Python 三项目：先修复悬空（重写为自包含，D7）→ ruff/pytest wrap 接入（GP-r3） | 修复先行解耦（D7）；Python 工具链接入验证 G3（工具链无关承诺） | A7、A5、A6 |

**文件改动地图**（w1 锚点，后续波类推）：

- 改：`.agents/skills/merge/SKILL.md`（阶段 1 四条命令 → 四条 wrap 命令 + 失败恢复指引）；`.agents/skills/pr-cr-fix/SKILL.md`（Gate-1 静态/Gate-1.5/Gate-3a 的命令替换）；不改 `merge-helpers.sh` / `cleanup-worktree.sh`（编排逻辑零改动）。
- 新（可选，档 2）：`.cw-pipeline.json`（cw 仓验证步骤声明：typecheck/lint/test/build/metrics）。
- w2 锚点：xyz-agent `scripts/pr-pre-merge.sh`（run_step 内命令替换）、`.agents/skills/merge/scripts/pre-merge-check.sh`（同步）、pr-cr-fix SKILL.md（Gate-1a/3a 命令替换）。
- 不改：cw 引擎全部源码（`src/gate/` / `src/pipeline/` 冻结）；各 skill 的 review 维度/执行通道/调档机制段落。

**新项目接入 checklist（S-7，第 10 个项目剧本）**：① merge skill 阶段 0 加 D9 守卫（cw 存在性/版本）；② 盘点 merge + pr-cr-fix skill 内全部裸跑确定性命令（含脚本内 run_step 形态）；③ 逐 check 过 D5 六条审查（生态等价物自行映射：Rust → Cargo.toml/Cargo.lock、Go → go.mod/go.sum）；④ D5-⑥ 全仓 grep 一处一致性核对（check 名/base/scope 序列）；⑤ 可选档 2 manifest（记住档位隔离语义：会话内续接用，不绑常驻入口）；⑥ D10 ci-judge 接 CI 等待失败分支（有 CI 面的项目）；⑦ A6 负面验证（副作用不入账）。w1 的 cw 接入产出可作为参照实现。

**收尾验收锚（S-8，w4 后独立收尾步，非永久 TODO）**：D1-③ marker 停写的验收判据 = ① 存量消费方清单清零（pr-status.sh / `--test-result` 前置校验 / review 维度 B 全部切 `cw gate query --json`）；② 骨架 `write_result_marker` 调用拆除；③ grep 全仓无 `.review/premerge-result` 新增读取。三判据齐 → 收尾步完成可验收。

**待验证检查点（诚实标注）**：

1. **复合 script 的 exit 语义**（GP-r1）：`npm run check:all` 内部跑两个 tsc 进程，wrap 只看最终 exit——中间步骤失败是否总表现为非零 exit（预期是，但 npm script 的 exit 传递有历史坑）。
2. **coverage miss 频率与内层增量耗时**（D3 实态修正后）：观测 miss 频率 × changed_packages 增量耗时——若高频 miss 且增量本身耗时长，再评估内层优化（不是按包拆分——该路已被 D3 supersession 关闭）。
3. **`.review/premerge-result` 的存量消费方**：A3 要求「不再新增产生」，但存量脚本（pr-status.sh 等）读旧格式——迁移期内两格式并存还是一次性切换，w2 实施时按消费方清单定。
4. **tai-ji ≡ xyz-agent 同体的处理**：同体仓库改一份还是两份——w2 时与用户确认。若两份都改，wrap 行（check 名/scope/base）必须逐字同步，scope 漂移 = 双根因 2 的新 F3 形态；长期应在 xyz-agent 侧收敛后让 tai-ji 整仓重新同步。

5. **账本与产物无界增长（S-6 已知演化项）**：gate-events.log append-only 无清理、gate-artifacts 每次 wrap 各落 report（hit 也复制）。近期量级（事件 ~500B、report 1-2KB）不构成问题；触发条件 = 单仓事件数超阈值或 query/续接 fold 延迟可测退化——届时引入归档/冷藏 + fold 起点快照（append-only 事实不可改写），本波不实施。

**拆包 trigger 记档**：无（本设计不产生新包；gate 域引擎拆包 trigger 见 design-release-pipeline.md §5）。
