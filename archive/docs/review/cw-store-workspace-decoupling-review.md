# 对抗式审查报告：cw store 归属与 workspace 解耦设计

> **审查对象**：`docs/cw-store-workspace-decoupling.md`
> **审查依据**：tech-design skill `review/rubric-design-doc.md`（对抗式清单）
> **审查日期**：2026-08-07
> **审查方式**：文档引用的事实全部 `read`/探针独立复测核实，未臆断；只报告不修复

## Summary

**6 must-fix, 5 suggestions.**

**总体判定**：方案 A（store 归一化下沉 cw-cli 内部 + workspace 用 show-toplevel + testCwd 保持相对仓库根 + 迁移冲突即停）**方向正确、直击根因**，P0-10 判定通过——归属/执行位置的概念拆解成立，G1/G2/G3/G5 因果链有实测探针支撑，决策 4（testCwd 不改绝对路径）的论证自洽。**但文档不能直接进入实施**：P0-11 有 2 处关键事实失真（testCwd 现状契约概括、ADR-0008「成熟迁移模式」）+ 1 处行号偏移；P0-12 有 3 个规格缺口（迁移 N 发现与归属算法、迁移并发互斥、S1/S2 版本耦合），其中「迁移发现归属」缺失会导致静默丢任务树，与 G1 直接冲突。

### 对抗式三问判定

| 三问 | 判定 | 依据 |
|---|---|---|
| **P0-10 方案是否真解决根因** | **通过** | §2.5 根因（归属 vs 执行位置混淆）→ §3 方案 A 的因果链成立：store-key=common-dir（归属归位）+ workspace=show-toplevel（执行位置归位）结构性消除耦合，非表象修补。G1/G2/G3/G5 可达（探针复测支撑）；G4 附带 §3.2 诚实说明，可接受。决策 4 论证成立：相对 testCwd + `resolve(show-toplevel, testCwd)` 在每个 worktree 解析到本 worktree 子包，与 workspace 改 show-toplevel 自洽；绝对路径存入 repo 级共享 store 跨 worktree 必错位，否决正确。决策 4 的**事实前提**有瑕疵（见 Finding 1），但不推翻决策本身 |
| **P0-11 关键事实是否正确** | **不通过** | 16 项核实：13 项准确、1 项行号偏移（schema.ts:38→实际 36）、2 项失真（plan.ts 契约概括与该字段注释/实现矛盾；ADR-0008 无迁移逻辑，「成熟迁移模式」不实）。逐条核实表见下文 |
| **P0-12 副作用/遗漏** | **不通过** | 3 个规格缺口：① 迁移「N 发现与归属」算法完全缺失（repoMeta 可缺失、旧 worktree 目录可能已删、remoteUrl 可空——归属不了就静默丢树）；② 迁移并发互斥未规格化（CwStore 锁 per-file，N→1 合并跨文件无互斥，多 worktree 并发首跑有竞态）；③ S1/S2「原子上线」无版本耦合机制（cw-tool 对 cw-cli 最低版本约束未定义，错配组合回退割裂）。S1/S2 顺序约束本身的论证（§4.1）经核实成立；只读 action 附带收益断言经核实成立（见下文专项判定） |

## 关键事实逐条核实表（P0-11）

| # | 文档引用 | 核实方式 | 结果 |
|---|---|---|---|
| 1 | `src/cli.ts:645-700` constructCwDeps 4 关注点绑 workspacePath | read cli.ts | ✅ **已核实准确**。函数实际跨 645-701（return 在 700）；store(647)/gitValidator(648-664)/testRunner(665-691)/fileExists(692-697) 逐一核对，4 关注点确实全部绑同一 `workspacePath` |
| 2 | `src/cli.ts:654` gitValidator `git cat-file -e <hash>^{commit}` cwd=workspacePath | read cli.ts | ✅ **已核实准确**（spawnSync cat-file 在 653，`cwd: workspacePath` 绑定在 654，引用落点正确） |
| 3 | `src/cli.ts:669` testRunner `resolve(workspacePath, testCwd)` | read cli.ts | ✅ **已核实准确**（669 行 `resolve(workspacePath, unit.plan.testCwd)` 逐字命中；且同行有 `isAbsolute` 分支放行绝对路径——见 Finding 1） |
| 4 | `src/cli.ts:696` fileExists `resolve(workspacePath, ref)` | read cli.ts | ✅ **已核实准确** |
| 5 | `src/cli.ts:1060-1061` workspacePath 解析（parsed.workspace ?? process.cwd()） | grep -n | ✅ **已核实准确**（1060 `const workspacePath =` + 1061 三元表达式） |
| 6 | `src/store/schema.ts:130-132` getCwJsonPath | grep -n | ✅ **已核实准确**（声明在 130，函数体至 132，`join(getCwHome(), encodeCwd(cwd), "store.json")` 与文档引用逐字一致） |
| 7 | `src/store/schema.ts:38` RepoMeta 定义 | grep -n | ⚠️ **行号偏移**。`export interface RepoMeta` 声明实际在 **36** 行，38 行是首个字段 `remoteUrl: string;`。字段清单（remoteUrl/branch/worktreePath/headCommit）本身准确 |
| 8 | `src/guidance/templates/wave.ts:58` testCwd 契约「如 `packages/auth`」 | sed -n 58p | ✅ **已核实准确**（58 行逐字含「如 `packages/auth`…否则 cw 在仓库根跑会跑错目录。单包项目可不填（缺省 = 仓库根）」） |
| 9 | `src/core/plan.ts:74` testCwd 字段 | grep -n + read | ✅ 行号准确（字段在 74）；⚠️ **但 73 行字段注释为「相对 workspacePath 或绝对路径。缺省=workspacePath」**——明确允许绝对路径且锚定 workspacePath 而非「仓库根」，与文档「现状契约已是相对仓库根的相对路径」概括矛盾（Finding 1） |
| 10 | `src/store/cw-store.ts:88/143/166` lockPath/renameSync/acquireLock | read cw-store.ts | ✅ **已核实准确**（88 `this.lockPath = this.dbPath + ".lock"`、143 `renameSync(this.tmpPath, this.dbPath)`、166 `private acquireLock()` 逐字命中） |
| 11 | `src/cli.ts:747` runReadonly 用 workspacePath | read + grep | ✅ **已核实准确**（747 `await runReadonly(action, parsed, workspacePath)`；runReadonly 内 829 行 `new CwStore(workspacePath)`；附带收益断言成立，见专项判定） |
| 12 | cw-tool 探测 git-common-dir 取 dirname 传 --workspace（§2.3） | read `~/Code/xyz-agent-workspace/main/extensions/cw-tool/src/cw-runner.ts` | ✅ **已核实准确**（cw-runner.ts:96-110 `detectRepoWorkspace` 用 `--path-format=absolute --git-common-dir` 后 `path.dirname(gitCommonDir)`；:164 `args.push("--workspace", workspace)`。**附带发现**：:225 只读 action 不传 --workspace） |
| 13 | ADR-0045 存在且内容如文档所述 | read `~/Code/xyz-agent-workspace/main/docs/architecture/adr/0045-cw-store-repo-level-keying.md` | ✅ **已核实准确**。ADR-0045 确实记录「repo 级键控 + dirname(commonDir) 当 --workspace」，且自认「dirname = repo 主工作目录…是真实目录（git 操作安全）」——文档对其「方向半对、实现错位」的三点批评与 ADR 原文吻合；ADR 甚至预留了引擎层根治（v5）路线，文档「Superseded」定性公允 |
| 14 | §3.2「cw-cli 曾做过 v1 schema 迁移（ADR-0008），有成熟迁移模式」 | read ADR-0008 + grep src/ + git log -S migrate | ⚠️ **部分不准**（Finding 2）。ADR-0008（`docs/adr/0008-v1-schema-version-and-repometa.md`）只加 schemaVersion+repoMeta 字段，读侧明确不做版本校验（schema.ts:24 注释），**本身无迁移逻辑**；历史另有两次 1:1 路径迁移（b9bef2b `~/.v1`→`~/.cw`、0fb1f83 `_v1.json`→`store.json`），但迁移代码已被 34a6635 移除，当前 src/ 零迁移代码（`grep -il migrat src/` 空）；且历史迁移均为 1:1 rename，与本案 N→1 合并+冲突即停不同类 |
| 15 | 探针 P-object-store / P-toplevel / P-common-dir-bare / P-dirname-harmful / P-absolute | 审查者独立复测（本项目 worktree + mktemp 构造普通 repo/linked worktree） | ✅ **全部复测命中**。本项目：common-dir(absolute)=`.bare`，show-toplevel=`fix-cw-cwd-worktree`（根与 src 子目录一致），dirname(.bare)=`coding-workflow-workspace` 容器，`git cat-file -e main^{commit}` 成功。普通 repo（git init）：裸命令根返回相对 `.git`、子目录返回 `../../.git`（撞名/分叉风险属实），`--path-format=absolute` 全场景稳定绝对。linked worktree 裸命令返回绝对 |
| 16 | §2.3 实测证据：`~/.cw/` 有 `__...__fix-cw-config-json` store、当前 worktree 无 store | ls ~/.cw/ | ✅ **已核实准确**（`__Users__zhushanwen__Code__coding-workflow-workspace__fix-cw-config-json` 存在，无 `fix-cw-cwd-worktree` 对应目录；容器级 `__...__coding-workflow-workspace` 也不存在，与「容器级 store 为空」一致） |

### 专项判定：§3.3「只读 action 附带收益」断言（P0-12 任务指定核查点）

**断言成立。** 只读路径确实经过归一化点：`runReadonly`（cli.ts:829）`new CwStore(workspacePath)` → CwStore 构造（cw-store.ts:87）`this.dbPath = getCwJsonPath(cwd)` → 方案 A 把归一化下沉进 `getCwJsonPath` 后，只读 action 自动走 common-dir store，无需额外机制。dispatch 路径的 `getUnitScope`（cli.ts:791 `new CwStore(workspacePath)`）同理。附带发现（不影响断言，影响 S1 实施细节）：`cw list --all` 的聚合（src/readonly/cross-cwd.ts:42）是 `readdirSync(CW_HOME)` 目录扫描、**不经过 getCwJsonPath**——`.legacy` 归档形态与 list --all 的交互需在设计中说明（见 Suggestion 3）。

### 专项判定：§4.1「S1/S2 必须原子上线」论证（P0-12 任务指定核查点）

**论证本身成立但不充分。** 成立部分：S1 先上而 S2 未改时，cw-tool 仍传 `dirname(common-dir)`=workspace 容器，cw-cli 从容器 probe common-dir 必然失败（git 向上查找 `.git`，容器 `coding-workflow-workspace/` 及其父目录均无；审查者实测该容器非 git 目录）→ fallback 容器 per-cwd → 与现状同样坏，文档推理正确。不充分部分：「同一批次发布」无机制保障——cw-tool 与 cw-cli 是两个 npm 包，用户可独立升级，**版本错配组合（新 cw-tool + 旧 cw-cli）会回退到 per-cwd 割裂**，文档未定义 cw-tool 对 cw-cli 的最低版本约束或能力探测（Finding 6）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| MUST_FIX | §3.3 决策 4（引 `src/core/plan.ts:74`） | P0-11 事实 | 「testCwd 现状契约已是相对仓库根的相对路径」失真。plan.ts:73 字段注释明确写「相对 workspacePath **或绝对路径**。缺省=workspacePath」，且实现 cli.ts:669 有 `isAbsolute` 分支**放行**绝对路径——现状契约允许绝对路径，锚定 workspacePath 而非仓库根。wave.ts:58 guidance 示例确实是相对路径（该引用准确），但仅凭它不能概括「现状契约」。失败模式：认知懒惰——用有利于论证的部分证据概括整体契约，导致改动量漏算：按失真前提只需「guidance 补一句文案」，实际需要**在 design/replan 校验层新增拒绝绝对 testCwd 的机器检查**，否则旧契约下合法存入的绝对 testCwd 在共享 store 时代跨 worktree 必炸（正是决策 4 自己要防的 bug） | 改写前提为「guidance 示例与缺省语义相对仓库根，但类型契约与实现允许绝对路径」；§4.1 S1 改动清单补「design/replan 入参校验：testCwd 禁止绝对路径」；§4.2 文件地图补对应校验落点 |
| MUST_FIX | §3.2 推荐理由 3（引 ADR-0008） | P0-11 事实 | 「cw-cli 曾做过 v1 schema 迁移（ADR-0008），有成熟迁移模式」不实。ADR-0008 只加 schemaVersion+repoMeta 字段且读侧不做版本校验，无迁移逻辑；历史迁移（b9bef2b、0fb1f83）均为 1:1 路径 rename 且代码已被 34a6635 移除，当前 src/ 零迁移代码。本案 N→1 合并 + 跨 store 外键 + 冲突即停是**无先例的新问题**，「成本可控」论证基座部分落空。失败模式：认知懒惰——用「曾经做过迁移」的模糊记忆替代对迁移难度量级的核实 | 如实改写为「历史仅有 1:1 路径 rename 迁移（代码已移除），N→1 合并无成熟模式可复用，迁移按全新工程估算成本」；§3.2 方案 A 成本评估相应上调或补充依据 |
| MUST_FIX | §2.3 演进 1、附录（引 `src/store/schema.ts:38`） | P0-11 事实 | 行号偏移：`export interface RepoMeta` 声明实际在 schema.ts:**36**，38 是 `remoteUrl` 字段行。字段清单准确，属低严重度偏移，但 rubric 纪律「错一处即 P0」 | 改为 `src/store/schema.ts:36`（或 `:36-48` 覆盖全部字段） |
| MUST_FIX | §3.3 决策 7（迁移） | P0-12 遗漏 | **迁移的「N 发现与归属」算法完全缺失**。决策 7 只说「cw-cli 启动时检测旧路径 store，合并到新路径」，但未回答：如何发现属于本 repo 的 N 个旧 store？`~/.cw/` 下是全局所有项目的 store 混放，归属判定线索 repoMeta 可缺失（schema.ts:26 repoMeta 可选）、worktreePath 指向的目录可能已删除（worktree 合并后清理是常态，无法再从该路径 probe git 反查 common-dir）、remoteUrl 可为空（纯本地 repo）。归属不了 → 旧 store 永远孤立 → **静默丢任务树**，与 G1 直接冲突。失败模式：方案只设计了「找到 N 之后怎么合并」，漏了「怎么找到 N」这个前置问题，且该问题有硬边界（已删 worktree 不可 probe） | §3.3 决策 7 补归属算法：repoMeta 匹配优先级（worktreePath probe→remoteUrl→？）、无法归属 store 的显式清单输出 + 人工指定通道（如 `cw migrate-store --from <oldStoreDir>`）；V-migrate 检查点补「repoMeta 缺失」「worktree 目录已删」两个用例 |
| MUST_FIX | §3.3 决策 7 + §4.2（迁移并发） | P0-12 遗漏 | **迁移并发互斥未规格化**。bare repo 多 worktree 并发调 cw 是递归编排的常态（多 wave-agent 并行），启动时检测迁移会被多个进程同时触发。CwStore 现有锁是 per-store-file 的（lockPath 随 dbPath），N→1 合并跨 N 个旧文件 + 1 个新文件，无跨文件互斥：两进程并发首跑可交错合并 → unit 重复/归档交错/一方读到半合并状态。「幂等」只覆盖串行重跑，不覆盖并发首跑。文档 §4.2 提到「迁移须尊重现有文件锁 + 原子写机制」但那是单文件写语义，不解决跨文件合并的互斥 | 迁移持 new store 的 lockPath（或专用 `<newStore>.migrate.lock`）做 repo 级迁移互斥，锁内完成 N 读 + 合并 + 写 + 归档；V-migrate 补并发迁移用例（两进程同时触发，断言串行化） |
| MUST_FIX | §4.1（S1/S2 原子上线） | P0-12 遗漏 | **S1/S2「原子上线」缺版本耦合机制**。cw-tool（`@zhushanwen/pi-cw-tool`）与 cw-cli（`@zhushanwen/coding-workflow`）是两个独立 npm 包，用户可独立升级：新 cw-tool（S2，停止传 --workspace）+ 旧 cw-cli（无 S1，无内部归一化）→ cw 用 `process.cwd()` per-cwd → **回退到 bash/cw-tool 割裂**（G2 倒退）；反向组合（旧 cw-tool + 新 cw-cli）文档已论证不更坏，但正向组合未分析。「同一批次发布」是流程愿望不是机制 | §4.1 补版本契约：cw-tool 声明对 cw-cli 的最低版本依赖（dependencies/peerDependencies 或安装期检查），或 cw-tool 运行时探测 cw-cli 归一化能力（如 `cw version` 门控）不满足则保留旧 --workspace 行为兜底 |
| SUGGESTION | §3.3 决策 3 + §4.2 | P1（接口规格） | **解耦后 `--workspace` flag 语义未显式定义**。S1 后 bash 用户仍可传 `--workspace`：它影响 store-key probe 基准、执行位置基准、还是两者？§4.1 的失败分析隐式假设「probe 基准 = --workspace 值」，成立但未明写。若 --workspace 继续兼任两角色，原耦合 bug 以轻量形式残留；建议显式定义：--workspace 仅指定 probe/执行基准，store-key 恒为 probe 结果的 common-dir，非 git 目录时降级链写清楚 | §3.3 增决策条：--workspace 的后向语义 + probe base（--workspace 值 ?? process.cwd()）+ 降级链（probe 失败 → show-toplevel 失败 → fallback 原值） |
| SUGGESTION | 探针清单 P-absolute | P0-13 探针纪律 | P-absolute 标 ✅ 但自述「普通 repo 行为已知」——bare 半实测、普通 repo 半是推断未实测，标 ✅ 不符合准则 7 的诚实标注（「已测」与「推断」混标）。审查者已独立复测普通 repo 行为为真（git init 根返回 `.git`、子目录返回 `../../.git`、absolute 全场景稳定），断言本身成立 | 拆为两行或标注「普通 repo 半已复测（审查轮）」；后续文档断言统一区分「已测/推断」 |
| SUGGESTION | §4.1 S3 + §3.3 决策 7 | P1-2 拆分 justification | S3 独立于 S1 的 justification 弱（直觉是迁移依赖 S1 归一化落地后才有「新路径」可迁入，但文档未明说为何不同步）；另 `.legacy` 归档与 `cw list --all`（cross-cwd.ts 目录扫描，不经 getCwJsonPath）的交互未说明——归档是文件改名（`store.json.legacy`）还是目录改名？前者 list --all 自动跳过，后者扫描到无 store.json 目录需确认静默跳过 | 补一句 S3 依赖 S1 的说明；明确归档形态 + 验证 list --all 对归档目录的行为 |
| SUGGESTION | §3.3 决策 6 | P1-6 减法与代价 | 拒绝「缓存 common-dir」的代价未权衡：单次 cw 写 action 调用至少 2 次 `new CwStore`（cli.ts:647 constructCwDeps + :791 getUnitScope）+ 1 次 show-toplevel probe = ≥3 次 git spawnSync（每次数 ms-数十 ms）。进程内一次性缓存（非跨进程持久缓存）不引入准则 7 的运行时断言风险，拒缓存的理由（防 clever 机制）对该形态过强 | 权衡后明示选择：接受每次调用 3 次 git spawn（写明代价），或允许进程内 memoize（写明为何不构成 clever 机制） |
| SUGGESTION | §1 G4 | P1（目标措辞） | G4「不破坏普通 repo…行为一致」与迁移语义有张力：普通 repo 从子目录调用的存量用户，其 per-cwd 子目录 store 会被合并进 repo 级 store——这是**行为变化**（子目录隔离消失）。§3.2 的诚实说明已部分覆盖（「影响所有 cw-cli 用户含纯 bash 用户」），但 G4 措辞仍读作「零变化」 | G4 改为「普通 repo 迁移后单 store 语义一致，子目录调用的 per-cwd 隔离随迁移合并消失（显式行为变化，迁移保证数据不丢）」 |

## 通过项记录（抽样）

| 检查项 | 判定 | 证据 |
|---|---|---|
| P0-1 四段骨架 | 通过 | §1 背景目标（SCQA+G1-G5+In/Out scope）/§2 现状问题（§2.1-2.5，根因 §2.5）/§3 解决方案（终态+对比+决策）/§4 下一层拆分（S1-S3+文件地图+检查点）齐全 |
| P0-2 无 delta 链 | 通过 | 全文无「vN/参见上版/Rxx」引用，自包含可读 |
| P0-3 结论先行 | 通过 | 文首「一句话结论」+ SCQA 开篇；§2.1/§2.2/§2.5/§3.1 首句均为该章结论（加粗） |
| P0-7/8/9 方案对比 | 通过 | §3.2 四方案（A/B/C/D），每方案评长期架构+短期成本+风险三维度，明确推荐 A 并给三点理由 + 方案 B 终态反例推演 |
| P0-13 运行时断言附探针 | 通过（除 P-absolute 标注瑕疵，见 Suggestion） | 探针清单 9 条全部标 ✅/⛔ 状态，关键断言（object store 共享、dirname 有害、absolute 硬约束）均有本项目实测 |
| P0-14 物理数据流图 | 通过 | §2.4 当前（割裂）vs 理想（统一）两张物理数据流图，store.json 物理位置（`~/.cw/<encoded>/`）标出 |
| P0-15 错误恢复指引 | 通过 | §3.1 失败路径表 4 场景均配具体恢复动作（降级提示语、`cw migrate-store`、`--resolve <id>=<keep>` 重跑、commit 校验失败指向 bare repo 确认） |
| P1-4 决策 alternatives | 通过 | 决策 1-7 每条记录被否方案 + 理由 + 证据指针 |

## 审查过程说明

- 本文档只报告不修复：未修改被审文档、未写代码、未改 cw 源码
- 所有事实核实基于当前 worktree（`fix-cw-cwd-worktree`）源码实际行号（grep -n/read 为准，非手数）
- 运行时探针（git common-dir/show-toplevel/cat-file/普通 repo 相对返回）由审查者在本项目 worktree + `mktemp` 构造的普通 repo/linked worktree 独立复测，非引用文档结论
- cw-tool 侧事实（dirname 逻辑、--workspace 透传、ADR-0045 内容）核实于 `~/Code/xyz-agent-workspace/main/`（跨项目只读）

---

## 补遗：cw-tool 侧对照审查（第二轮）

第一轮（kimi）修订定稿后，cw-tool 侧（xyz-agent）对引擎层设计文档做对照审查，补充 2 条建议，均已 read 源码核实属实并采纳修订：

| # | 建议 | 核实 | 采纳 |
|---|---|---|---|
| R2-1 | 存量相对 testCwd 的迁移 rebase 未覆盖——旧契约相对 testCwd 基准是「建任务时的 cwd」（非仓库根），旧 cwd 若是子目录，迁移后基准变 repo 根会漂移 | 属实。`plan.ts:74` 注释「相对 workspacePath 或绝对路径」+ `cli.ts:669` `resolve(workspacePath, testCwd)` 确认旧基准=workspacePath | ✅ 决策 4 补 ④ + 决策 7 合并规则补「存量 testCwd rebase」（相对按旧 cwd rebase 到相对 repo 根；绝对转换或标记人工）+ S3/V-migrate 补用例 |
| R2-2 | 决策 7「同 id 同 status 自动去重」有 replan 死角——replan 是 from=to（status 不变）但 append statusHistory + 改 plan，同 status 单边 replan 会静默丢 plan | 属实。`status.ts:49,54-55` 确认 replan from=to | ✅ 决策 7 去重判据从「同 status」细化为「statusHistory 一致/前缀→合并取长者；分叉→即停」+ S3/V-migrate 同步 |

两轮审查（kimi 第一轮 + cw-tool 侧第二轮）共 8 条 must-fix 级发现，前 6 条（第一轮）采纳，R2-1/R2-2（第二轮）**因第三轮减法决策而 moot**。

---

## 补遗 2：减法决策——不迁旧 store（第三轮）

用户审查两轮修订后做减法决策：**不迁旧 store**（决策 7 改为「弃用，不迁移」）、版本 **minor + 弃用 warning**（决策 9）、**只做 cw-cli 侧**（S2 留 xyz-agent）。理由：单人项目、存量任务可弃，迁移（归属/并发/仲裁/rebase）是纯兼容复杂度，准则 8 减法优先。

影响前轮发现：
- **R2-1（存量 testCwd rebase）→ moot**：不迁就不 rebase，决策 4 ④ 已删。
- **R2-2（statusHistory 去重判据）→ moot**：不合并 N→1 就没有去重场景。
- 第一轮 MF-4（迁移归属算法）/MF-5（迁移并发互斥）→ moot：决策 7 不迁，归属/互斥规格删除。
- 第一轮 MF-1（testCwd 机器校验）/MF-2（ADR-0008 如实）/MF-3（行号）/MF-6（S1/S2 版本契约）→ **仍适用**，保留。

文档当前状态：方案 A（归一化下沉 cw-cli + workspace=show-toplevel + testCwd 收紧 + 弃用 warning），不迁，决策 1-9，S1（cw-cli）+ S2（cw-tool 协调需求）。
